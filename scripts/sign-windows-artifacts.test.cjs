const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { selectFiles } = require("./sign-windows-artifacts.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-signing-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relative of [
    "1/win-unpacked/Marshal.exe",
    "1/win-unpacked/node-runner.exe",
    "1/win-unpacked/resources/app.asar.unpacked/copilot.exe",
    "1/Marshal-Windows-1.0.0-x64-Setup.exe",
  ]) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
  }
  return root;
}

test("staging mode signs only Marshal-owned inner binaries", (t) => {
  const files = selectFiles("staging", fixture(t))
    .map((file) => path.basename(file))
    .sort();
  assert.deepEqual(files, ["Marshal.exe", "node-runner.exe"]);
});

test("installer mode signs only shipping setup wrappers", (t) => {
  const files = selectFiles("installers", fixture(t)).map((file) => path.basename(file));
  assert.deepEqual(files, ["Marshal-Windows-1.0.0-x64-Setup.exe"]);
});
