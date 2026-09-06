/**
 * Minimal WebExtension storage area used by unit tests.
 */

"use strict";

export class FakeStorageArea {
  #values;

  constructor(initialValues = {}) {
    this.#values = structuredClone(initialValues);
  }

  async get(keys) {
    if (typeof keys === "string") {
      return Object.hasOwn(this.#values, keys)
        ? { [keys]: structuredClone(this.#values[keys]) }
        : {};
    }
    if (Array.isArray(keys)) {
      return Object.fromEntries(keys
        .filter((key) => Object.hasOwn(this.#values, key))
        .map((key) => [key, structuredClone(this.#values[key])]));
    }
    if (keys && typeof keys === "object") {
      return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [
        key,
        Object.hasOwn(this.#values, key)
          ? structuredClone(this.#values[key])
          : structuredClone(fallback)
      ]));
    }
    return structuredClone(this.#values);
  }

  async set(values) {
    Object.assign(this.#values, structuredClone(values));
  }

  snapshot() {
    return structuredClone(this.#values);
  }
}
