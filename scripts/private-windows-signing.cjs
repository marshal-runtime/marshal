const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { sign } = require("@electron/windows-sign");

let decodedCertificatePath = null;

function configuredValue(value) {
  if (!value || /^\$\([^)]+\)$/.test(value)) return null;
  return value;
}

function resolveCertificateFile() {
  const file = configuredValue(process.env.WINDOWS_CERTIFICATE_FILE);
  if (file) return file;

  const encoded = configuredValue(process.env.WINDOWS_CERTIFICATE_BASE64);
  if (!encoded) return null;
  if (!decodedCertificatePath) {
    decodedCertificatePath = path.join(os.tmpdir(), `marshal-signing-${process.pid}.pfx`);
    fs.writeFileSync(decodedCertificatePath, Buffer.from(encoded, "base64"), { mode: 0o600 });
  }
  return decodedCertificatePath;
}

function hasSigningConfiguration() {
  return Boolean(
    resolveCertificateFile() ||
    configuredValue(process.env.WINDOWS_SIGNTOOL_PATH) ||
    configuredValue(process.env.WINDOWS_SIGN_WITH_PARAMS),
  );
}

async function signWindowsFiles(files, options = {}) {
  const uniqueFiles = [...new Set(files.map((file) => path.resolve(file)))];
  if (uniqueFiles.length === 0) return false;

  if (!hasSigningConfiguration()) {
    if (options.allowUnsigned) return false;
    throw new Error(
      "Private Windows signing is not configured. Set WINDOWS_CERTIFICATE_BASE64 (or WINDOWS_CERTIFICATE_FILE) and WINDOWS_CERTIFICATE_PASSWORD, or configure WINDOWS_SIGNTOOL_PATH/WINDOWS_SIGN_WITH_PARAMS for an HSM-backed signer.",
    );
  }

  await sign({
    files: uniqueFiles,
    certificateFile: resolveCertificateFile() ?? undefined,
    certificatePassword: configuredValue(process.env.WINDOWS_CERTIFICATE_PASSWORD) ?? undefined,
    timestampServer:
      configuredValue(process.env.WINDOWS_TIMESTAMP_SERVER) ?? "http://timestamp.digicert.com",
    description: configuredValue(process.env.WINDOWS_SIGN_DESCRIPTION) ?? "Marshal",
    website: configuredValue(process.env.WINDOWS_SIGN_WEBSITE) ?? undefined,
    signToolPath: configuredValue(process.env.WINDOWS_SIGNTOOL_PATH) ?? undefined,
    signWithParams: configuredValue(process.env.WINDOWS_SIGN_WITH_PARAMS) ?? undefined,
    hashes: ["sha256"],
  });
  return true;
}

function cleanupDecodedCertificate() {
  if (!decodedCertificatePath) return;
  fs.rmSync(decodedCertificatePath, { force: true });
  decodedCertificatePath = null;
}

module.exports = {
  cleanupDecodedCertificate,
  hasSigningConfiguration,
  signWindowsFiles,
};
