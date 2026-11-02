const path = require("node:path");

const { cleanupDecodedCertificate, signWindowsFiles } = require("./private-windows-signing.cjs");

module.exports = async function sign(configuration) {
  const filename = path.basename(configuration.path).toLowerCase();
  if (filename !== "elevate.exe") return;

  const allowUnsigned = !process.env.CI;
  const signed = await signWindowsFiles([configuration.path], { allowUnsigned });
  if (!signed) {
    console.log(`win-sign-callback: private signer not configured; skipped ${configuration.path}`);
  }
};

process.once("exit", cleanupDecodedCertificate);
