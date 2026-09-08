/**
 * VFS path and Drive-name mapping tests.
 */

"use strict";

import assert from "node:assert/strict";
import test from "node:test";

import {
  createDriveSegments,
  decodeDriveName,
  decodeDriveSegment,
  encodeDriveName,
  joinVfsPath,
  splitVfsPath
} from "../src/core/vfs-paths.mjs";

test("joins and splits absolute VFS paths without changing segments", () => {
  const segments = ["documents", "report%2Ffinal"];
  const path = joinVfsPath(segments);

  assert.equal(path, "/documents/report%2Ffinal");
  assert.deepEqual(splitVfsPath(path), segments);
  assert.equal(joinVfsPath(), "/");
  assert.deepEqual(splitVfsPath("/"), []);
});

test("rejects relative, empty, traversal, and slash-containing path segments", () => {
  for (const value of ["documents/report", "", ".", "..", "a/b"]) {
    assert.throws(() => joinVfsPath(value), /VFS path/);
  }
  for (const path of ["documents/report", "/documents//report", "/documents/", "/documents/.", "/documents/.."]) {
    assert.throws(() => splitVfsPath(path), /VFS/);
  }
});

test("encodes slash, percent, dot, tilde, and preserves names on round trip", () => {
  for (const name of [
    "plain.txt",
    "folder/report/final %2F 100%",
    ".",
    "..",
    "already~suffixed",
    "ümlaut"
  ]) {
    const segment = encodeDriveName(name);
    assert.equal(segment.includes("/"), false);
    assert.equal(segment.includes("~"), false);
    assert.equal(decodeDriveName(segment), name);
    assert.deepEqual(splitVfsPath(joinVfsPath(segment)), [segment]);
  }
  assert.throws(() => encodeDriveName(""), /non-empty/);
  assert.equal(encodeDriveName("report.final.pdf"), "report.final.pdf");
  assert.equal(encodeDriveName(".hidden"), ".hidden");
  assert.equal(encodeDriveName("project plan ü.txt"), "project plan ü.txt");
  assert.equal(encodeDriveName("."), "%2E");
  assert.equal(encodeDriveName(".."), "%2E%2E");
});

test("keeps duplicate siblings and Drive IDs stable with repeatable suffixes", () => {
  const entries = [
    { id: "drive/id%a", name: "report" },
    { id: "drive-id-b", name: "report" },
    { id: "drive-id-c", name: "other" }
  ];
  const first = createDriveSegments(entries);
  const reversed = createDriveSegments([...entries].reverse());
  const firstById = new Map(first.map((entry) => [entry.id, entry.segment]));
  const reversedById = new Map(reversed.map((entry) => [entry.id, entry.segment]));

  assert.equal(new Set(first.map((entry) => entry.segment)).size, entries.length);
  assert.deepEqual(reversedById, firstById);
  for (const entry of first) {
    const decoded = decodeDriveSegment(entry.segment);
    assert.equal(decoded.name, entry.name);
    if (entry.name === "report") {
      assert.equal(decoded.id, entry.id);
    } else {
      assert.equal(decoded.id, null);
    }
  }
});

test("does not collide with a real name that looks like an ID suffix", () => {
  const entries = [
    { id: "id-a", name: "report" },
    { id: "id-b", name: "report" },
    { id: "id-c", name: "report~id-a" }
  ];
  const mapped = createDriveSegments(entries);
  const segments = mapped.map((entry) => entry.segment);

  assert.equal(new Set(segments).size, entries.length);
  assert.equal(mapped.find((entry) => entry.id === "id-c").segment, "report%7Eid-a");
  assert.deepEqual(decodeDriveSegment(mapped.find((entry) => entry.id === "id-c").segment), {
    name: "report~id-a",
    id: null
  });
});

test("disambiguates Drive items from reserved virtual root segments", () => {
  const [entry] = createDriveSegments(
    [{ id: "drive-item", name: "Shared drives" }],
    { reservedSegments: ["Shared drives"] }
  );

  assert.equal(entry.segment, "Shared drives~drive-item");
  assert.deepEqual(decodeDriveSegment(entry.segment), {
    name: "Shared drives",
    id: "drive-item"
  });
  assert.throws(
    () => createDriveSegments([], { reservedSegments: "Shared drives" }),
    /Reserved segments/u
  );
});

test("rejects duplicate or missing identities rather than silently losing siblings", () => {
  assert.throws(
    () => createDriveSegments([{ id: "same", name: "one" }, { id: "same", name: "two" }]),
    /unique among siblings/
  );
  assert.throws(() => createDriveSegments([{ id: "", name: "one" }]), /non-empty/);
  assert.throws(() => decodeDriveSegment("report~"), /suffix/);
});
