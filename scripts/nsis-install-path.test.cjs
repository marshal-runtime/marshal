const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const repoRoot = path.join(__dirname, "..");
const builderConfig = fs.readFileSync(path.join(repoRoot, "electron-builder.json5"), "utf8");
const installerInclude = fs.readFileSync(
  path.join(repoRoot, "build", "marshal-installer.nsh"),
  "utf8",
);
const afterPack = fs.readFileSync(
  path.join(repoRoot, "scripts", "marshal-electron-builder-afterpack.cjs"),
  "utf8",
);
const afterArtifacts = fs.readFileSync(
  path.join(repoRoot, "scripts", "marshal-electron-builder-afterallartifactbuild.cjs"),
  "utf8",
);

const genericExecutablePath = String.raw`%LOCALAPPDATA%\Programs\Marshal\Marshal\Marshal.exe`;
const concreteExecutablePath = String.raw`C:\Users\omerm\AppData\Local\Programs\Marshal\Marshal\Marshal.exe`;

test("pins the NSIS installer to the canonical per-user executable path", () => {
  // NSIS derives the uninstall GUID from appId, so pin the single Marshal identity.
  assert.match(builderConfig, /appId:\s*"com\.marshal"/);
  assert.match(builderConfig, /productName:\s*"Marshal"/);
  assert.match(builderConfig, /executableName:\s*"Marshal"/);
  assert.match(builderConfig, /oneClick:\s*false/);
  assert.match(builderConfig, /perMachine:\s*false/);
  assert.match(builderConfig, /allowElevation:\s*false/);
  assert.match(builderConfig, /allowToChangeInstallationDirectory:\s*true/);
  assert.match(builderConfig, /runAfterFinish:\s*true/);
  assert.match(builderConfig, /include:\s*"build\/marshal-installer\.nsh"/);
  assert.ok(
    builderConfig.includes('artifactName: "Marshal-Windows-${version}-${arch}-Setup.${ext}"'),
  );

  assert.match(installerInclude, /StrCpy \$INSTDIR "\$LOCALAPPDATA\\Programs\\Marshal\\Marshal"/);
  assert.match(installerInclude, /StrCpy \$installMode CurrentUser/);
  assert.match(installerInclude, /SetShellVarContext current/);

  const resolvedGenericPath = path.win32.join(
    "%LOCALAPPDATA%",
    "Programs",
    "Marshal",
    "Marshal",
    "Marshal.exe",
  );
  const resolvedConcretePath = path.win32.join(
    String.raw`C:\Users\omerm\AppData\Local`,
    "Programs",
    "Marshal",
    "Marshal",
    "Marshal.exe",
  );
  assert.equal(resolvedGenericPath, genericExecutablePath);
  assert.equal(resolvedConcretePath, concreteExecutablePath);
  assert.doesNotMatch(installerInclude, /OLD_.*_KEY/);
});

test("does not retain known non-canonical validation destinations", () => {
  const packagingSources = [builderConfig, installerInclude, afterPack, afterArtifacts].join("\n");
  assert.doesNotMatch(packagingSources, /MarshalGoalHarnessTest/);
});
