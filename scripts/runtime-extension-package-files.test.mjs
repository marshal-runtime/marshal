import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectRuntimeExtensionPackageFiles } from "./runtime-extension-package-files.mjs";

test("runtime extension verification excludes package-manager dependency trees", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "marshal-extension-files-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  await fsp.mkdir(path.join(root, "dist"), { recursive: true });
  await fsp.mkdir(path.join(root, "node_modules", "dependency"), { recursive: true });
  await fsp.mkdir(path.join(root, "dist", "node_modules", "nested-dependency"), {
    recursive: true,
  });
  await Promise.all([
    fsp.writeFile(path.join(root, "package.json"), "{}"),
    fsp.writeFile(path.join(root, "dist", "index.js"), "export {};"),
    fsp.writeFile(path.join(root, "node_modules", "dependency", "index.js"), "ignored"),
    fsp.writeFile(
      path.join(root, "dist", "node_modules", "nested-dependency", "index.js"),
      "ignored",
    ),
  ]);

  const files = await collectRuntimeExtensionPackageFiles(root);
  assert.deepEqual(
    files.map((file) => path.relative(root, file).replaceAll(path.sep, "/")),
    ["dist/index.js", "package.json"],
  );
});
