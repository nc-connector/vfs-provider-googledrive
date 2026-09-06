/**
 * Pure helpers for the path presentation used by the Google Drive provider.
 *
 * Drive item IDs are the identity of an item. VFS paths are only a reversible
 * presentation of Drive names, so callers must retain the ID from
 * the returned entry instead of deriving an ID from a path.
 */

"use strict";

const DISAMBIGUATION_SEPARATOR = "~";

function assertString(value, label) {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
}

function assertVfsSegment(segment) {
  assertString(segment, "VFS path segment");
  if (!segment || segment === "." || segment === "..") {
    throw new RangeError("VFS path segments must be non-empty and cannot be '.' or '..'");
  }
  if (segment.includes("/")) {
    throw new RangeError("VFS path segments cannot contain '/'");
  }
}

/**
 * Joins raw VFS path segments into an absolute canonical path.
 *
 * An array is accepted as a convenience, but every segment is still checked;
 * empty, dot, dot-dot, and slash-containing segments are never normalised
 * away.
 *
 * @param {...(string|string[])} segments
 * @returns {string}
 */
export function joinVfsPath(...segments) {
  if (segments.length === 1 && Array.isArray(segments[0])) {
    segments = segments[0];
  }
  for (const segment of segments) {
    assertVfsSegment(segment);
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/**
 * Splits an absolute canonical VFS path into raw path segments.
 *
 * Empty segments, trailing slashes (except the root path), and dot segments
 * are rejected rather than silently collapsed.  Drive-name escaping is kept
 * separate: use decodeDriveName() for a segment that came from Drive.
 *
 * @param {string} path
 * @returns {string[]}
 */
export function splitVfsPath(path) {
  assertString(path, "VFS path");
  if (path === "/") {
    return [];
  }
  if (!path.startsWith("/")) {
    throw new RangeError("VFS paths must be absolute");
  }

  const segments = path.slice(1).split("/");
  for (const segment of segments) {
    assertVfsSegment(segment);
  }
  return segments;
}

function encodeDriveComponent(value, label) {
  assertString(value, label);
  if (!value) {
    throw new RangeError(`${label} must be non-empty`);
  }

  // Reserve '~' for the ID suffix used by duplicate sibling names. Keep dots
  // readable except when the complete name would become a traversal segment.
  const encoded = value.replace(/[\u0000-\u001f\u007f\/%~]/gu, (character) =>
    character === "~" ? "%7E" : encodeURIComponent(character));
  return encoded === "." || encoded === ".."
    ? encoded.replaceAll(".", "%2E")
    : encoded;
}

function decodeDriveComponent(segment, label) {
  assertString(segment, label);
  if (!segment || segment === "." || segment === ".." || segment.includes("/")) {
    throw new RangeError(`${label} is not a valid encoded VFS segment`);
  }
  try {
    return decodeURIComponent(segment);
  } catch (error) {
    throw new TypeError(`${label} is not valid percent encoding`);
  }
}

/**
 * Encodes one non-empty Google Drive name as one safe VFS segment.
 *
 * '/' and '%' are encoded before the segment is joined into a path.  The
 * encoding is reversible, including names containing literal "%2F" text.
 * Empty Drive names are rejected instead of becoming an invisible path item.
 *
 * @param {string} name
 * @returns {string}
 */
export function encodeDriveName(name) {
  return encodeDriveComponent(name, "Drive name");
}

/**
 * Decodes a segment produced by encodeDriveName().
 *
 * @param {string} segment
 * @returns {string}
 */
export function decodeDriveName(segment) {
  if (segment.includes(DISAMBIGUATION_SEPARATOR)) {
    throw new RangeError("A disambiguated segment must be decoded with decodeDriveSegment()");
  }
  const name = decodeDriveComponent(segment, "Drive name segment");
  if (!name) {
    throw new RangeError("Decoded Drive name must be non-empty");
  }
  return name;
}

function assertDriveEntry(entry) {
  if (!entry || typeof entry !== "object") {
    throw new TypeError("Drive entries must be objects");
  }
  assertString(entry.id, "Drive file ID");
  if (!entry.id) {
    throw new RangeError("Drive file IDs must be non-empty");
  }
  assertString(entry.name, "Drive name");
  if (!entry.name) {
    throw new RangeError("Drive names must be non-empty");
  }
}

/**
 * Creates repeatable, collision-free segments for sibling Drive entries.
 *
 * Unique names remain readable encoded names.  Equal names receive an ID
 * suffix. '~' is escaped in real names, so a real name that already looks
 * suffixed cannot collide with a generated suffix.  The input order does not
 * affect any segment; IDs remain untouched in the returned objects.
 *
 * @param {Array<{id: string, name: string}>} entries
 * @returns {Array<object & {segment: string}>}
 */
export function createDriveSegments(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError("Drive entries must be an array");
  }

  const seenIds = new Set();
  const nameCounts = new Map();
  for (const entry of entries) {
    assertDriveEntry(entry);
    if (seenIds.has(entry.id)) {
      throw new RangeError("Drive file IDs must be unique among siblings");
    }
    seenIds.add(entry.id);
    nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  }

  return entries.map((entry) => {
    const base = encodeDriveName(entry.name);
    const segment = nameCounts.get(entry.name) > 1
      ? `${base}${DISAMBIGUATION_SEPARATOR}${encodeDriveComponent(entry.id, "Drive file ID")}`
      : base;
    return { ...entry, segment };
  });
}

/**
 * Decodes a unique or ID-disambiguated Drive segment.
 *
 * @param {string} segment
 * @returns {{name: string, id: string|null}}
 */
export function decodeDriveSegment(segment) {
  assertString(segment, "Drive segment");
  const separator = segment.lastIndexOf(DISAMBIGUATION_SEPARATOR);
  if (separator < 0) {
    return { name: decodeDriveName(segment), id: null };
  }
  if (separator === 0 || separator === segment.length - 1) {
    throw new RangeError("Invalid Drive disambiguation suffix");
  }

  const nameSegment = segment.slice(0, separator);
  const idSegment = segment.slice(separator + DISAMBIGUATION_SEPARATOR.length);
  return {
    name: decodeDriveName(nameSegment),
    id: decodeDriveComponent(idSegment, "Drive file ID suffix")
  };
}
