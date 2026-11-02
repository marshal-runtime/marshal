"use strict";

const assert = require("node:assert/strict");
const { describe, it, afterEach, mock } = require("node:test");
const fs = require("node:fs");
const { basename } = require("node:path");

const hook = require("./marshal-electron-builder-afterallartifactbuild.cjs");

// Real electron-builder artifactName shapes (electron-builder.json5):
//   Marshal-Mac-${version}-${arch}-Installer.dmg
//   Marshal-Windows-${version}-${arch}-Setup.exe
const ARTIFACTS = [
  "/out/Marshal-Mac-1.2.3-x64-Installer.dmg",
  "/out/Marshal-Mac-1.2.3-arm64-Installer.dmg",
  "/out/Marshal-Windows-1.2.3-x64-Setup.exe",
  "/out/Marshal-Linux-1.2.3.AppImage",
];

async function runHook() {
  const copies = [];
  mock.method(fs, "copyFileSync", (_src, dest) => copies.push(basename(dest)));
  const returned = await hook({ artifactPaths: ARTIFACTS });
  return { copies, returned: returned.map((p) => basename(p)) };
}

describe("afterAllArtifactBuild arch-suffix compat", () => {
  afterEach(() => {
    mock.reset();
  });

  it("copies only the x64 Windows installer to its arch-less name", async () => {
    const { copies, returned } = await runHook();

    assert.deepEqual(copies, ["Marshal-Windows-1.2.3-Setup.exe"]);
    assert.deepEqual(returned, copies);
  });

  it("copies nothing when no artifact carries the x64 setup suffix", async () => {
    const copies = [];
    mock.method(fs, "copyFileSync", (_src, dest) => copies.push(basename(dest)));

    const returned = await hook({ artifactPaths: ["/out/Marshal-Linux-1.2.3.AppImage"] });

    assert.deepEqual(copies, []);
    assert.deepEqual(returned, []);
  });
});
