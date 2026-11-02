// Source-text assertions against sidecar/node-runner.cs. The .exe is a
// binary diff in git; rebuilding it from a reverted .cs file would slip
// past every TypeScript unit test. These checks pin the security-critical
// lines (NODE_OPTIONS clearing, ELECTRON_RUN_AS_NODE absence) without
// needing dotnet on the test runner.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const RUNNER_CS = fs.readFileSync(path.join(__dirname, "..", "sidecar", "node-runner.cs"), "utf8");

test('node-runner.cs clears NODE_OPTIONS to ""', () => {
  // Tier B of the Electron-fuses hardening. node-runner.exe spawns the bundled node.exe, which is
  // not protected by the enableNodeOptionsEnvironmentVariable Electron fuse
  // — clearing this env var explicitly is the only line of defense against
  // a parent env injecting --require against the bundled Node.
  assert.match(RUNNER_CS, /EnvironmentVariables\["NODE_OPTIONS"\]\s*=\s*""/);
});

test("node-runner.cs does not set ELECTRON_RUN_AS_NODE", () => {
  // The spawn target is the bundled node.exe (not Marshal-as-Node), so
  // the env var is irrelevant — but a stray setter would re-introduce a
  // LOLBin attack surface if anyone ever flipped the runAsNode fuse back.
  assert.doesNotMatch(RUNNER_CS, /ELECTRON_RUN_AS_NODE/);
});

test("node-runner.cs CreateNoWindow stays true (windowless spawn invariant)", () => {
  // The whole reason node-runner.exe exists on Windows is to wrap node.exe
  // spawns so they don't flash a console window. If a future refactor sets
  // CreateNoWindow = false, MCP children will pop visible windows on every
  // tool call.
  assert.match(RUNNER_CS, /CreateNoWindow\s*=\s*true/);
});

test("node-runner.cs reaps the child tree (kill-on-close job + stdin-EOF kill)", () => {
  // Windows does not tree-kill by default. Without these, a terminated/
  // disconnected session leaked orphaned MCP server processes that piled up
  // (hundreds of node.exe / tens of GB over multi-day sessions). The job's
  // KILL_ON_JOB_CLOSE reaps the child when the wrapper is force-killed; the
  // stdin-EOF branch force-kills the child when the parent closes the pipe.
  assert.match(RUNNER_CS, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.match(RUNNER_CS, /AssignProcessToJobObject/);
  assert.match(RUNNER_CS, /proc\.WaitForExit\(3000\)\)\s*proc\.Kill\(\)/);
});
