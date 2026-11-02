const fs = require("node:fs");
const path = require("node:path");

const { cleanupDecodedCertificate, signWindowsFiles } = require("./private-windows-signing.cjs");

function walk(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(target));
    } else if (entry.isFile()) {
      files.push(target);
    }
  }
  return files;
}

function selectFiles(mode, root) {
  const files = walk(root);
  if (mode === "staging") {
    return files.filter((file) => {
      const normalized = file.replaceAll("\\", "/");
      return /\/win(?:-arm64)?-unpacked\/(?:Marshal|node-runner)\.exe$/i.test(normalized);
    });
  }
  if (mode === "installers") {
    return files.filter((file) => /Setup.*\.exe$/i.test(path.basename(file)));
  }
  throw new Error(`Unknown signing mode "${mode}". Expected "staging" or "installers".`);
}

async function main() {
  const mode = process.argv[2];
  const root = path.resolve(process.argv[3] ?? "release");
  if (!fs.existsSync(root)) throw new Error(`Signing root does not exist: ${root}`);

  const files = selectFiles(mode, root);
  if (files.length === 0) throw new Error(`No ${mode} signing targets found under ${root}`);
  await signWindowsFiles(files);
  console.log(`Signed ${files.length} private Windows artifact(s).`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(cleanupDecodedCertificate);
}

module.exports = { selectFiles };
