// Launch Electron as a browser process.
// Clears ELECTRON_RUN_AS_NODE which may be inherited from parent Electron apps
// (e.g. VS Code, Marshal) and would otherwise force Electron into plain Node.js mode.
delete process.env.ELECTRON_RUN_AS_NODE;

const { execFileSync } = require("child_process");
const path = require("path");
const electronPath = require("electron");
const fs = require("node:fs");
const os = require("node:os");

// Reversible recovery settings are profile-local, rather than a change to the
// installed database or its data. Remove the file to return to normal startup.
const recoveryPath = path.join(
  process.env.MARSHAL_DEV_DATA_DIR || path.join(os.homedir(), ".marshal-dev"),
  "marshal-recovery.json",
);
if (fs.existsSync(recoveryPath)) {
  const recovery = JSON.parse(fs.readFileSync(recoveryPath, "utf8"));
  if (recovery.disableHeapSnapshots === true) {
    process.env.MARSHAL_DISABLE_HEAP_SNAPSHOT = "1";
  }
}

// When this launcher is invoked with an absolute Node binary, that binary's
// directory is not necessarily present in PATH. Keep it available to Electron
// children so MCP servers configured with a bare `node` command can start.
const nodeBinDir = path.dirname(process.execPath);
const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
if (!pathEntries.includes(nodeBinDir)) {
  process.env.PATH = [nodeBinDir, ...pathEntries].join(path.delimiter);
}

try {
  execFileSync(electronPath, [".", "--no-sandbox", ...process.argv.slice(2)], {
    stdio: "inherit",
  });
} catch (e) {
  process.exit(e.status ?? 1);
}
