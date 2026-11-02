import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createMarshalRuntimeExtension,
  extensionDirectoryName,
  parseCreateRuntimeExtensionArgs,
  parseExtensionIdentity,
} from "./create-marshal-runtime-extension.mjs";

const temps = [];

test.after(() => {
  temps.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function libraryHome() {
  const homedir = mkdtempSync(path.join(os.tmpdir(), "marshal-extension-library-"));
  temps.push(homedir);
  mkdirSync(homedir, { recursive: true });
  return homedir;
}

test("parses a scoped extension identity and folder name", () => {
  assert.equal(parseExtensionIdentity("@acme/hello"), "@acme/hello");
  assert.equal(extensionDirectoryName("@acme/hello"), "acme-hello");
  assert.throws(() => parseExtensionIdentity("hello"), /@acme\/hello/);
  assert.deepEqual(parseCreateRuntimeExtensionArgs(["@acme/hello"]), {
    help: false,
    identity: "@acme/hello",
  });
  assert.deepEqual(parseCreateRuntimeExtensionArgs(["--help"]), { help: true });
  assert.throws(() => parseCreateRuntimeExtensionArgs(["--nope"]), /Unknown argument/);
});

test("scaffolds a discoverable Runtime extension in the user library", async () => {
  const homedir = libraryHome();
  const created = await createMarshalRuntimeExtension({
    identity: "@acme/hello",
    homedir,
  });

  assert.equal(created.packageRoot, path.join(homedir, "Marshal Runtime", "extensions", "acme-hello"));
  assert.equal(
    JSON.parse(readFileSync(path.join(created.packageRoot, "runtime-extension.json"), "utf8"))
      .identity,
    "@acme/hello",
  );
  assert.match(
    readFileSync(path.join(created.packageRoot, "dist", "index.cjs"), "utf8"),
    /activate/,
  );
});

test("refuses to overwrite an existing extension directory", async () => {
  const homedir = libraryHome();
  await createMarshalRuntimeExtension({ identity: "@acme/hello", homedir });
  await assert.rejects(
    createMarshalRuntimeExtension({ identity: "@acme/hello", homedir }),
    /already exists/,
  );
});
