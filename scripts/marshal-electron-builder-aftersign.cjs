const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { notarize } = require("@electron/notarize");

function configuredValue(value) {
  if (!value || /^\$\([^)]+\)$/.test(value)) return null;
  return value;
}

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const contentsDir = path.join(appPath, "Contents");
  const requirePrivateSigning = process.env.REQUIRE_PRIVATE_SIGNING === "1";
  const codesignIdentity = configuredValue(process.env.MACOS_CODESIGN_IDENTITY) ?? "-";
  if (requirePrivateSigning && codesignIdentity === "-") {
    throw new Error("MACOS_CODESIGN_IDENTITY is required for private macOS release signing.");
  }


  const appEntitlementsPath = path.join(__dirname, "..", "build", "marshal-entitlements.mac.plist");
  const appSignArgs = [
    "--sign",
    codesignIdentity,
    "--force",
    "--options",
    "runtime",
    "--entitlements",
    appEntitlementsPath,
  ];
  if (codesignIdentity !== "-") appSignArgs.push("--timestamp");
  appSignArgs.push(appPath);
  execFileSync("codesign", appSignArgs, { stdio: "inherit" });

  const appleApiKeyId = configuredValue(process.env.APPLE_API_KEY_ID);
  const appleApiIssuer = configuredValue(process.env.APPLE_API_ISSUER_ID);
  const configuredApiKey = configuredValue(process.env.APPLE_API_KEY);
  const encodedApiKey = configuredValue(process.env.APPLE_API_KEY_BASE64);
  let temporaryApiKey = null;
  let appleApiKey = configuredApiKey;
  if (!appleApiKey && encodedApiKey) {
    temporaryApiKey = path.join(os.tmpdir(), `AuthKey_${appleApiKeyId ?? process.pid}.p8`);
    fs.writeFileSync(temporaryApiKey, Buffer.from(encodedApiKey, "base64"), { mode: 0o600 });
    appleApiKey = temporaryApiKey;
  }

  try {
    const hasNotarizationCredentials = appleApiKey && appleApiKeyId && appleApiIssuer;
    if (requirePrivateSigning && !hasNotarizationCredentials) {
      throw new Error(
        "APPLE_API_KEY_BASE64 (or APPLE_API_KEY), APPLE_API_KEY_ID, and APPLE_API_ISSUER_ID are required for private macOS notarization.",
      );
    }
    if (hasNotarizationCredentials) {
      await notarize({
        appPath,
        appleApiKey,
        appleApiKeyId,
        appleApiIssuer,
      });
      console.log(`  afterSign: notarized ${appPath}`);
    }
  } finally {
    if (temporaryApiKey) fs.rmSync(temporaryApiKey, { force: true });
  }
};
