import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseMarshalCliArgs, runMarshalCli } from "./marshal-cli.mjs";

const temps = [];

test.after(() => {
  temps.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function capture() {
  const chunks = [];
  return {
    stdout: {
      write(value) {
        chunks.push(value);
      },
    },
    output: () => chunks.join(""),
  };
}

test("parses add, create, library, and install-cli commands", () => {
  assert.deepEqual(parseMarshalCliArgs(["add", "https://github.com/acme/hello.git"]), {
    command: "add",
    source: "https://github.com/acme/hello.git",
  });
  assert.deepEqual(parseMarshalCliArgs(["add", "--create", "@acme/hello"]), {
    command: "create",
    identity: "@acme/hello",
  });
  assert.deepEqual(parseMarshalCliArgs(["library"]), { command: "library" });
  assert.deepEqual(parseMarshalCliArgs(["install-cli"]), { command: "install-cli" });
  assert.throws(() => parseMarshalCliArgs(["add"]), /git URL or a local folder/);
  assert.throws(() => parseMarshalCliArgs(["add", "--create"]), /@acme\/hello/);
});

test("prints the user-visible library path", async () => {
  const homedir = mkdtempSync(path.join(os.tmpdir(), "marshal-cli-library-"));
  temps.push(homedir);
  const io = capture();
  const result = await runMarshalCli(["library"], { stdout: io.stdout, homedir });
  assert.equal(result.libraryRoot, path.join(homedir, "Marshal Runtime", "extensions"));
  assert.equal(io.output(), `${result.libraryRoot}\n`);
});

test("creates an extension through marshal add --create", async () => {
  const homedir = mkdtempSync(path.join(os.tmpdir(), "marshal-cli-create-"));
  temps.push(homedir);
  const io = capture();
  const result = await runMarshalCli(["add", "--create", "@acme/hello"], {
    stdout: io.stdout,
    homedir,
  });
  assert.equal(result.identity, "@acme/hello");
  assert.equal(
    JSON.parse(readFileSync(path.join(result.packageRoot, "runtime-extension.json"), "utf8"))
      .identity,
    "@acme/hello",
  );
});

test("adds a git source through marshal add", async () => {
  const homedir = mkdtempSync(path.join(os.tmpdir(), "marshal-cli-add-"));
  temps.push(homedir);
  const io = capture();
  const result = await runMarshalCli(["add", "https://github.com/acme/hello.git"], {
    stdout: io.stdout,
    homedir,
    add: async ({ source, libraryRoot }) => ({
      identity: "@acme/hello",
      packageRoot: path.join(libraryRoot, "hello"),
      source,
    }),
  });
  assert.equal(result.command, "add");
  assert.match(io.output(), /Added @acme\/hello/);
});

test("installs a CLI shim through marshal install-cli", async () => {
  const homedir = mkdtempSync(path.join(os.tmpdir(), "marshal-cli-install-"));
  temps.push(homedir);
  const io = capture();
  const result = await runMarshalCli(["install-cli"], {
    stdout: io.stdout,
    homedir,
    platform: "darwin",
    installCli: async ({ shimPath }) => shimPath,
  });
  assert.equal(result.command, "install-cli");
  assert.match(io.output(), /Installed /);
});
