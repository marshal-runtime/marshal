"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..");
const verifier = path.join(__dirname, "verify-brand.mjs");
const tempDirs = [];

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-verify-brand-"));
  tempDirs.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  execFileSync("git", ["add", "."], { cwd: root });
  return root;
}

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test("verify-brand passes on the current tracked tree", () => {
  const output = execFileSync(process.execPath, [verifier, "--root", repoRoot], {
    encoding: "utf8",
  });
  assert.match(output, /Brand verification passed/);
});

test("verify-brand fails closed on reintroduced retired product identifiers", () => {
  const retiredTokens = [
    ["ms-", "claw", "pilot"],
    ["Open", "Claw"],
    ["BRAND-", "COMPAT"],
  ].map((parts) => parts.join(""));
  const root = makeRepo({ "bad.ts": retiredTokens.join("\n") });

  const result = spawnSync(process.execPath, [verifier, "--root", root], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Brand verification failed/);
  retiredTokens.forEach((_token, index) => {
    assert.match(result.stderr, new RegExp(`bad\\.ts:${index + 1}`));
  });
});
