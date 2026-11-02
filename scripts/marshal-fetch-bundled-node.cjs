#!/usr/bin/env node
// Downloads the official Node.js binary version-matched to Electron's
// bundled Node, verifies SHA-256 against the upstream SHASUMS256.txt,
// and extracts only the `node` binary into node-bin/<platform>-<arch>/.
//
// Skipped automatically when $CI is set; pipelines fetch
// via a dedicated step.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const https = require("node:https");
const { execFileSync } = require("node:child_process");

// Source of truth: package.json's `marshal.bundledNodeVersion`. Bumping
// Electron requires bumping that field in lockstep (look up with:
// ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -e "console.log(process.versions.node)").
const BUNDLED_NODE_VERSION =
  process.env.BUNDLED_NODE_VERSION ||
  require(path.join(__dirname, "..", "package.json")).marshal.bundledNodeVersion;

const TARGETS = [
  { platform: "darwin", arch: "x64" },
  { platform: "darwin", arch: "arm64" },
  { platform: "win32", arch: "x64" },
  { platform: "win32", arch: "arm64" },
];

function buildDownloadUrl(version, platform, arch) {
  const p = platform === "win32" ? "win" : platform;
  const ext = platform === "win32" ? "zip" : "tar.gz";
  return `https://nodejs.org/dist/${version}/node-${version}-${p}-${arch}.${ext}`;
}

function buildShasumUrl(version) {
  return `https://nodejs.org/dist/${version}/SHASUMS256.txt`;
}

function verifyShaSumLine(sumsContent, filename, actualHash) {
  const lines = sumsContent.split(/\r?\n/);
  for (const line of lines) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === filename) {
      if (hash === actualHash) return true;
      throw new Error(`SHA-256 mismatch for ${filename}: expected ${hash}, got ${actualHash}`);
    }
  }
  throw new Error(`${filename} not found in SHASUMS256.txt`);
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`GET ${url} -> ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function fetchOne(version, platform, arch) {
  const url = buildDownloadUrl(version, platform, arch);
  const filename = url.split("/").pop();
  const outDir = path.join(__dirname, "..", "node-bin", `${platform}-${arch}`);
  const binaryName = platform === "win32" ? "node.exe" : "node";
  // .version sentinel forces a refetch when bundledNodeVersion is bumped;
  // outDir has no version segment so existsSync alone would keep stale binaries.
  const versionFile = path.join(outDir, ".version");
  if (fs.existsSync(path.join(outDir, binaryName))) {
    const cached = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, "utf8").trim() : "";
    if (cached === version) {
      console.log(`  skip: ${platform}-${arch} (${version} already present)`);
      return;
    }
    console.log(`  refetch: ${platform}-${arch} (cached=${cached || "(none)"}, want=${version})`);
    fs.rmSync(path.join(outDir, binaryName), { force: true });
  }
  console.log(`  fetch: ${url}`);
  const [tarball, shasumsBuf] = await Promise.all([
    httpsGet(url),
    httpsGet(buildShasumUrl(version)),
  ]);
  verifyShaSumLine(shasumsBuf.toString("utf8"), filename, sha256(tarball));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, filename), tarball);
  // Tar invocation must work for every contributor regardless of which `tar`
  // they have on PATH. Two failure modes we handle:
  //  - GNU tar (Git Bash / MSYS2 / Cygwin / many Linux hosts) parses an
  //    absolute `C:\...` path as a `host:path` remote spec and fails with
  //    "Cannot connect to C: resolve failed". We sidestep that by setting
  //    cwd=outDir and passing the tarball by basename.
  //  - GNU tar cannot read .zip at all. Windows' bundled bsdtar at
  //    %SystemRoot%\System32\tar.exe can — so on Windows hosts we invoke it
  //    explicitly rather than trusting PATH ordering.
  const tarBin =
    process.platform === "win32"
      ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
      : "tar";
  if (platform === "win32") {
    // The Windows tarball layout is node-v<version>-win-<arch>/node.exe
    // (one level deep, no bin/), so strip 1 component.
    execFileSync(
      tarBin,
      ["-xf", filename, "--strip-components=1", `node-${version}-win-${arch}/node.exe`],
      { stdio: "inherit", cwd: outDir },
    );
  } else {
    execFileSync(
      tarBin,
      ["-xzf", filename, "--strip-components=2", `node-${version}-${platform}-${arch}/bin/node`],
      { stdio: "inherit", cwd: outDir },
    );
  }
  fs.unlinkSync(path.join(outDir, filename));
  fs.writeFileSync(versionFile, version);
  console.log(`  OK: ${platform}-${arch}`);
}

async function main() {
  if (!process.env.FETCH_BUNDLED_NODE_FORCE && process.env.CI) {
    console.log(
      "fetch-bundled-node: skipped in CI (set FETCH_BUNDLED_NODE_FORCE=1 to override; pipeline fetches via dedicated step)",
    );
    return;
  }
  const version = BUNDLED_NODE_VERSION.startsWith("v")
    ? BUNDLED_NODE_VERSION
    : `v${BUNDLED_NODE_VERSION}`;
  console.log(`fetch-bundled-node: Node ${version}`);
  for (const t of TARGETS) {
    await fetchOne(version, t.platform, t.arch);
  }
}

module.exports = { buildDownloadUrl, buildShasumUrl, verifyShaSumLine };

if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
