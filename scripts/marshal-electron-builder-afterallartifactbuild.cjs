// electron-builder afterAllArtifactBuild hook — creates legacy-named copies for
// backward-compatible auto-updates from older installed builds.
//
// Arch-suffix compat: older clients look for "{Product}-Windows-{version}-Setup.exe"
// (no "-x64" arch suffix).
// TODO: Remove once all clients have updated to the arch-aware updater.
const fs = require("fs");
const path = require("path");

module.exports = async function afterAllArtifactBuild(buildResult) {
  const newArtifacts = [];
  for (const file of buildResult.artifactPaths) {
    const base = path.basename(file);
    const compatBase = base.replace("-x64-Setup.exe", "-Setup.exe");
    if (compatBase === base) continue;

    const compatPath = path.join(path.dirname(file), compatBase);
    fs.copyFileSync(file, compatPath);
    console.log(`  afterAllArtifactBuild: copied ${base} → ${compatBase} (arch-suffix compat)`);
    newArtifacts.push(compatPath);
  }
  return newArtifacts;
};
