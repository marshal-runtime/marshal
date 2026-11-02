#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extensionDirectoryName, parseExtensionIdentity } from "./lib/user-extension-library.mjs";
import { runMarshalCli } from "./marshal-cli.mjs";

export { extensionDirectoryName, parseExtensionIdentity };

const USAGE = "Usage: pnpm create:runtime-extension @scope/name\n";

export function parseCreateRuntimeExtensionArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const unknown = argv.find((token) => token.startsWith("-"));
  if (unknown) throw new Error(`Unknown argument: ${unknown}`);
  return { help: false, identity: argv.find((token) => !token.startsWith("-")) };
}

export async function createMarshalRuntimeExtension({
  identity,
  env = process.env,
  homedir,
  documentsDir,
  platform,
}) {
  return runMarshalCli(["add", "--create", identity], {
    stdout: { write() {} },
    env,
    homedir,
    documentsDir,
    platform,
  });
}

const isDirectEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectEntrypoint) {
  const options = parseCreateRuntimeExtensionArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
  } else {
    runMarshalCli(["add", "--create", options.identity]).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
}
