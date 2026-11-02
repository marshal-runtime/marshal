"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { resolvePersistedPath } = require("./persisted-path-compat.cjs");

test("resolvePersistedPath prefers current data and falls back to legacy data", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-script-paths-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacy = path.join(root, "m-settings.json");
  fs.writeFileSync(legacy, "legacy");

  assert.equal(resolvePersistedPath(root, "marshal-settings.json", "m-settings.json"), legacy);

  const current = path.join(root, "marshal-settings.json");
  fs.writeFileSync(current, "current");
  assert.equal(resolvePersistedPath(root, "marshal-settings.json", "m-settings.json"), current);
});

