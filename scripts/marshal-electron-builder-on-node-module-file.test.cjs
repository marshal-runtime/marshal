const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const onNodeModuleFile = require("./marshal-electron-builder-on-node-module-file.cjs");

const typescriptLib = (...segments) =>
  path.join(path.sep, "repo", "node_modules", "typescript", "lib", ...segments);

test("force-includes the TypeScript standard library declarations", () => {
  assert.equal(onNodeModuleFile(typescriptLib("lib.d.ts")), true);
  assert.equal(onNodeModuleFile(typescriptLib("lib.es5.d.ts")), true);
  assert.equal(onNodeModuleFile(typescriptLib("lib.es2015.promise.d.ts")), true);
  assert.equal(
    onNodeModuleFile(
      path.join(
        path.sep,
        "repo",
        "node_modules",
        ".pnpm",
        "typescript@5.9.3",
        "node_modules",
        "typescript",
        "lib",
        "lib.dom.d.ts",
      ),
    ),
    true,
  );
});

test("leaves every other file to electron-builder's default rules", () => {
  assert.equal(onNodeModuleFile(typescriptLib("typescript.d.ts")), false);
  assert.equal(onNodeModuleFile(typescriptLib("typescript.js")), false);
  assert.equal(
    onNodeModuleFile(path.join(path.sep, "repo", "node_modules", "zod", "lib", "lib.d.ts")),
    false,
  );
});
