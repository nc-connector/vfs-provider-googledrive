/**
 * MV3 change poll scheduler tests.
 */

"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import {
  ChangePollScheduler,
  DRIVE_CHANGE_ALARM_NAME,
  DRIVE_CHANGE_POLL_MINUTES
} from "../src/runtime/change-poll-scheduler.mjs";

function createAlarms(existing) {
  const calls = { get: [], create: [] };
  const listeners = [];
  return {
    calls,
    listeners,
    api: {
      async get(name) {
        calls.get.push(name);
        return existing;
      },
      async create(name, options) {
        calls.create.push({ name, options });
      },
      onAlarm: {
        addListener(listener) {
          listeners.push(listener);
        }
      }
    }
  };
}

test("registers its alarm listener during construction", () => {
  const alarms = createAlarms();

  new ChangePollScheduler({
    alarmsApi: alarms.api,
    poll: async () => undefined
  });

  assert.equal(alarms.listeners.length, 1);
});

test("creates a missing periodic change alarm", async () => {
  const alarms = createAlarms();
  const scheduler = new ChangePollScheduler({
    alarmsApi: alarms.api,
    poll: async () => undefined
  });

  assert.equal(await scheduler.reconcileSchedule(), true);
  assert.deepEqual(alarms.calls.get, [DRIVE_CHANGE_ALARM_NAME]);
  assert.deepEqual(alarms.calls.create, [{
    name: DRIVE_CHANGE_ALARM_NAME,
    options: {
      delayInMinutes: DRIVE_CHANGE_POLL_MINUTES,
      periodInMinutes: DRIVE_CHANGE_POLL_MINUTES
    }
  }]);
});

test("keeps a matching alarm without postponing it", async () => {
  const alarms = createAlarms({
    name: DRIVE_CHANGE_ALARM_NAME,
    scheduledTime: 1,
    periodInMinutes: DRIVE_CHANGE_POLL_MINUTES
  });
  const scheduler = new ChangePollScheduler({
    alarmsApi: alarms.api,
    poll: async () => undefined
  });

  assert.equal(await scheduler.reconcileSchedule(), false);
  assert.deepEqual(alarms.calls.create, []);
});

test("replaces an alarm whose period no longer matches", async () => {
  const alarms = createAlarms({
    name: DRIVE_CHANGE_ALARM_NAME,
    scheduledTime: 1,
    periodInMinutes: 10
  });
  const scheduler = new ChangePollScheduler({
    alarmsApi: alarms.api,
    poll: async () => undefined
  });

  assert.equal(await scheduler.reconcileSchedule(), true);
  assert.equal(alarms.calls.create.length, 1);
});

test("ignores unrelated alarms and waits for a matching poll", async () => {
  const alarms = createAlarms();
  let releasePoll;
  const pollStarted = new Promise((resolve) => {
    releasePoll = resolve;
  });
  let calls = 0;
  const scheduler = new ChangePollScheduler({
    alarmsApi: alarms.api,
    poll: async () => {
      calls += 1;
      await pollStarted;
      return "complete";
    }
  });
  const listener = alarms.listeners[0];

  assert.equal(listener({ name: "unrelated" }), undefined);
  const pending = listener({ name: DRIVE_CHANGE_ALARM_NAME });
  assert.equal(calls, 0);
  await Promise.resolve();
  assert.equal(calls, 1);
  releasePoll();
  assert.equal(await pending, "complete");
});

test("coalesces overlapping alarm polls", async () => {
  const alarms = createAlarms();
  let releasePoll;
  const pendingPoll = new Promise((resolve) => {
    releasePoll = resolve;
  });
  let calls = 0;
  const scheduler = new ChangePollScheduler({
    alarmsApi: alarms.api,
    poll: async () => {
      calls += 1;
      await pendingPoll;
    }
  });
  const listener = alarms.listeners[0];

  const first = listener({ name: DRIVE_CHANGE_ALARM_NAME });
  const second = listener({ name: DRIVE_CHANGE_ALARM_NAME });
  assert.equal(second, first);
  await Promise.resolve();
  assert.equal(calls, 1);
  releasePoll();
  await first;
});

test("logs and absorbs a failed alarm poll", async () => {
  const alarms = createAlarms();
  const warnings = [];
  const scheduler = new ChangePollScheduler({
    alarmsApi: alarms.api,
    poll: async () => {
      throw Object.assign(new Error("network detail"), {
        code: "drive_network_error"
      });
    },
    logger: {
      warn(event, details) {
        warnings.push({ event, details });
      }
    }
  });

  assert.equal(await alarms.listeners[0]({
    name: DRIVE_CHANGE_ALARM_NAME
  }), null);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].event, "drive.changes.poll.failed");
  assert.equal(warnings[0].details.error.code, "drive_network_error");
});

test("shares one schedule reconciliation between concurrent callers", async () => {
  let releaseGet;
  const pendingGet = new Promise((resolve) => {
    releaseGet = resolve;
  });
  const alarms = createAlarms();
  alarms.api.get = async (name) => {
    alarms.calls.get.push(name);
    await pendingGet;
    return undefined;
  };
  const scheduler = new ChangePollScheduler({
    alarmsApi: alarms.api,
    poll: async () => undefined
  });

  const first = scheduler.reconcileSchedule();
  const second = scheduler.reconcileSchedule();
  assert.equal(second, first);
  releaseGet();
  assert.equal(await first, true);
  assert.equal(alarms.calls.get.length, 1);
  assert.equal(alarms.calls.create.length, 1);
});
