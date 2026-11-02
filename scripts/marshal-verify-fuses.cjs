#!/usr/bin/env node
// Asserts the packaged Marshal binary's fuse state matches expectations.
// Usage: node scripts/marshal-verify-fuses.cjs <path-to-packaged-binary>
//
// On macOS: pass the path to Contents/MacOS/Marshal (or the .app bundle root).
// On Windows: pass the path to Marshal.exe.

const { getCurrentFuseWire, FuseV1Options, FuseState } = require("@electron/fuses");

// The 9 fuses the Electron-fuses hardening commits to. WasmTrapHandlers + any future @electron/fuses
// additions left at binary defaults intentionally.
const EXPECTED = {
  [FuseV1Options.RunAsNode]: FuseState.DISABLE,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FuseState.DISABLE,
  [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.DISABLE,
  [FuseV1Options.EnableCookieEncryption]: FuseState.ENABLE,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FuseState.ENABLE,
  [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.ENABLE,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: FuseState.DISABLE,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: FuseState.DISABLE,
  // resetAdHocDarwinSignature is intentionally absent: it is a build-time
  // directive consumed by electron-builder during packaging, not a runtime
  // fuse. It is not a member of FuseV1Options and is not returned by
  // getCurrentFuseWire(), so there is no wire state to verify here.
};

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node scripts/marshal-verify-fuses.cjs <path-to-packaged-binary>");
    process.exit(2);
  }
  const wire = await getCurrentFuseWire(target);
  let failed = false;
  for (const [fuseKey, expectedState] of Object.entries(EXPECTED)) {
    const actual = wire[fuseKey];
    if (actual !== expectedState) {
      console.error(`FAIL: fuse ${fuseKey} expected ${expectedState}, got ${actual}`);
      failed = true;
    } else {
      console.log(`OK: fuse ${fuseKey} = ${actual}`);
    }
  }
  if (failed) process.exit(1);
  console.log(`\nAll ${Object.keys(EXPECTED).length} fuses match expected values.`);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
