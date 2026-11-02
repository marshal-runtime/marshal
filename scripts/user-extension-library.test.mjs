import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  addRuntimeExtension,
  createRuntimeExtensionStub,
  defaultCliShimPath,
  defaultUserExtensionLibraryRoot,
  gitCloneDirectoryName,
  isGitExtensionSource,
  maybeInstallPackagedMarshalCli,
  USER_LIBRARY_DIRNAME,
  USER_EXTENSIONS_DIRNAME,
  WINDOWS_DOCUMENTS_DIRNAME,
} from "./lib/user-extension-library.mjs";

const temps = [];

test.after(() => {
  temps.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function tempDir() {
  const root = mkdtempSync(path.join(os.tmpdir(), "marshal-user-extension-library-"));
  temps.push(root);
  return root;
}

function writeExtension(packageRoot, identity = "@acme/hello") {
  mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  mkdirSync(path.join(packageRoot, "node_modules", "noise"), { recursive: true });
  writeFileSync(path.join(packageRoot, "node_modules", "noise", "index.js"), "throw 'nope';\n");
  writeFileSync(
    path.join(packageRoot, "runtime-extension.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      identity,
      version: "0.1.0",
      entrypoint: "dist/index.cjs",
      moduleFormat: "commonjs-bundle-v1",
    })}\n`,
  );
  writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify({ name: identity })}\n`);
  writeFileSync(
    path.join(packageRoot, "dist", "index.cjs"),
    "module.exports = { activate() {} };\n",
  );
}

test("resolves a home-folder library on macOS and Linux", () => {
  const homedir = "/Users/ada";
  assert.equal(
    defaultUserExtensionLibraryRoot({ platform: "darwin", homedir, env: {} }),
    path.join(homedir, USER_LIBRARY_DIRNAME, USER_EXTENSIONS_DIRNAME),
  );
  assert.equal(
    defaultUserExtensionLibraryRoot({ platform: "linux", homedir, env: {} }),
    path.join(homedir, USER_LIBRARY_DIRNAME, USER_EXTENSIONS_DIRNAME),
  );
});

test("resolves a Documents library on Windows", () => {
  const homedir = "C:\\Users\\ada";
  const documentsDir = path.win32.join(homedir, WINDOWS_DOCUMENTS_DIRNAME);
  assert.equal(
    defaultUserExtensionLibraryRoot({
      platform: "win32",
      homedir,
      documentsDir,
      env: {},
    }),
    path.join(documentsDir, USER_LIBRARY_DIRNAME, USER_EXTENSIONS_DIRNAME),
  );
});

test("treats git URLs and .git suffixes as git sources", () => {
  assert.equal(isGitExtensionSource("https://github.com/acme/hello.git"), true);
  assert.equal(isGitExtensionSource("git@github.com:acme/hello.git"), true);
  assert.equal(isGitExtensionSource("/tmp/hello"), false);
  assert.equal(gitCloneDirectoryName("https://github.com/acme/hello.git"), "hello");
});

test("copies a local folder into the library and skips node_modules", async () => {
  const root = tempDir();
  const source = path.join(root, "hello");
  const libraryRoot = path.join(root, "library");
  writeExtension(source);

  const added = await addRuntimeExtension({ source, libraryRoot });
  assert.equal(added.identity, "@acme/hello");
  assert.equal(added.source, "folder");
  assert.equal(existsSync(path.join(added.packageRoot, "runtime-extension.json")), true);
  assert.equal(existsSync(path.join(added.packageRoot, "node_modules")), false);
});

test("clones a git source into the library", async () => {
  const root = tempDir();
  const libraryRoot = path.join(root, "library");
  const added = await addRuntimeExtension({
    source: "https://github.com/acme/hello.git",
    libraryRoot,
    clone: async (_url, destination) => {
      writeExtension(destination);
    },
  });
  assert.equal(added.identity, "@acme/hello");
  assert.equal(added.source, "git");
  assert.equal(added.packageRoot, path.join(libraryRoot, "hello"));
});

test("rejects a cloned repository that is not a Runtime extension", async () => {
  const root = tempDir();
  await assert.rejects(
    addRuntimeExtension({
      source: "https://github.com/acme/hello.git",
      libraryRoot: path.join(root, "library"),
      clone: async (_url, destination) => {
        mkdirSync(destination, { recursive: true });
      },
    }),
    /not a Marshal Runtime extension/,
  );
});

test("creates a stub extension in the library", async () => {
  const libraryRoot = path.join(tempDir(), "library");
  const created = await createRuntimeExtensionStub({ identity: "@acme/hello", libraryRoot });
  assert.equal(created.packageRoot, path.join(libraryRoot, "acme-hello"));
  assert.equal(
    JSON.parse(readFileSync(path.join(created.packageRoot, "runtime-extension.json"), "utf8"))
      .identity,
    "@acme/hello",
  );
});

test("installs a packaged CLI shim and skips unpackaged Marshal", async () => {
  const homedir = tempDir();
  const resourcesPath = path.join(tempDir(), "resources");
  mkdirSync(path.join(resourcesPath, "cli"), { recursive: true });
  writeFileSync(path.join(resourcesPath, "cli", "marshal-cli.mjs"), "export {}\n");

  assert.equal(
    await maybeInstallPackagedMarshalCli({
      isPackaged: false,
      resourcesPath,
      homedir,
    }),
    null,
  );

  const shimPath = await maybeInstallPackagedMarshalCli({
    isPackaged: true,
    resourcesPath,
    homedir,
    platform: "darwin",
    nodePath: "/usr/bin/node",
  });
  assert.equal(shimPath, defaultCliShimPath({ platform: "darwin", homedir }));
  assert.match(readFileSync(shimPath, "utf8"), /exec "\/usr\/bin\/node"/);
});
