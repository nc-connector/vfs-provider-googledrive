/**
 * MV3 alarm lifecycle for Google Drive change polling.
 */

"use strict";

export const DRIVE_CHANGE_ALARM_NAME = "google-drive-change-poll";
export const DRIVE_CHANGE_POLL_MINUTES = 5;

function requireMethod(value, method, label) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(label);
  }
  return value;
}

function requirePeriod(value) {
  if (!Number.isFinite(value) || value < 1) {
    throw new RangeError("periodInMinutes");
  }
  return value;
}

export class ChangePollScheduler {
  #alarmsApi;
  #poll;
  #logger;
  #alarmName;
  #periodInMinutes;
  #activePoll = null;
  #scheduleOperation = null;
  #alarmListener;

  constructor({
    alarmsApi,
    poll,
    logger,
    alarmName = DRIVE_CHANGE_ALARM_NAME,
    periodInMinutes = DRIVE_CHANGE_POLL_MINUTES
  }) {
    requireMethod(alarmsApi, "get", "alarmsApi");
    requireMethod(alarmsApi, "create", "alarmsApi");
    requireMethod(alarmsApi?.onAlarm, "addListener", "alarmsApi");
    if (typeof poll !== "function" ||
        typeof alarmName !== "string" || !alarmName) {
      throw new TypeError("changePollSchedulerDependencies");
    }
    this.#alarmsApi = alarmsApi;
    this.#poll = poll;
    this.#logger = logger;
    this.#alarmName = alarmName;
    this.#periodInMinutes = requirePeriod(periodInMinutes);
    this.#alarmListener = (alarm) => {
      if (alarm?.name !== this.#alarmName) {
        return undefined;
      }
      return this.pollNow();
    };
    this.#alarmsApi.onAlarm.addListener(this.#alarmListener);
  }

  reconcileSchedule() {
    if (!this.#scheduleOperation) {
      this.#scheduleOperation = this.#reconcileSchedule().finally(() => {
        this.#scheduleOperation = null;
      });
    }
    return this.#scheduleOperation;
  }

  pollNow() {
    if (!this.#activePoll) {
      this.#activePoll = Promise.resolve()
        .then(() => this.#poll())
        .catch((error) => {
          this.#logger?.warn?.("drive.changes.poll.failed", {
            error,
            phase: "poll"
          });
          return null;
        })
        .finally(() => {
          this.#activePoll = null;
        });
    }
    return this.#activePoll;
  }

  async #reconcileSchedule() {
    const existing = await this.#alarmsApi.get(this.#alarmName);
    if (existing?.periodInMinutes === this.#periodInMinutes) {
      return false;
    }
    await this.#alarmsApi.create(this.#alarmName, {
      delayInMinutes: this.#periodInMinutes,
      periodInMinutes: this.#periodInMinutes
    });
    return true;
  }
}
