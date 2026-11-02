// Marshal-owned tooling test.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildDownloadUrl, buildShasumUrl, verifyShaSumLine } = require("./marshal-fetch-bundled-node.cjs");

test("buildDownloadUrl: macOS x64", () => {
  assert.equal(
    buildDownloadUrl("v24.14.0", "darwin", "x64"),
    "https://nodejs.org/dist/v24.14.0/node-v24.14.0-darwin-x64.tar.gz",
  );
});

test("buildDownloadUrl: macOS arm64", () => {
  assert.equal(
    buildDownloadUrl("v24.14.0", "darwin", "arm64"),
    "https://nodejs.org/dist/v24.14.0/node-v24.14.0-darwin-arm64.tar.gz",
  );
});

test("buildDownloadUrl: Windows x64 → .zip", () => {
  assert.equal(
    buildDownloadUrl("v24.14.0", "win32", "x64"),
    "https://nodejs.org/dist/v24.14.0/node-v24.14.0-win-x64.zip",
  );
});

test("buildDownloadUrl: Windows arm64", () => {
  assert.equal(
    buildDownloadUrl("v24.14.0", "win32", "arm64"),
    "https://nodejs.org/dist/v24.14.0/node-v24.14.0-win-arm64.zip",
  );
});

test("buildShasumUrl matches the dist directory", () => {
  assert.equal(buildShasumUrl("v24.14.0"), "https://nodejs.org/dist/v24.14.0/SHASUMS256.txt");
});

test("verifyShaSumLine: matching hash returns true", () => {
  const sums = `abc123  node-v24.14.0-darwin-arm64.tar.gz\nother  unrelated.zip\n`;
  assert.equal(verifyShaSumLine(sums, "node-v24.14.0-darwin-arm64.tar.gz", "abc123"), true);
});

test("verifyShaSumLine: mismatched hash throws", () => {
  const sums = `abc123  node-v24.14.0-darwin-arm64.tar.gz\n`;
  assert.throws(
    () => verifyShaSumLine(sums, "node-v24.14.0-darwin-arm64.tar.gz", "WRONG"),
    /SHA-256 mismatch/,
  );
});

test("verifyShaSumLine: missing file in SHASUMS throws", () => {
  const sums = `abc123  other.tar.gz\n`;
  assert.throws(
    () => verifyShaSumLine(sums, "node-v24.14.0-darwin-arm64.tar.gz", "abc123"),
    /not found in SHASUMS/,
  );
});
