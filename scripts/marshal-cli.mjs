#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  addRuntimeExtension,
  createRuntimeExtensionStub,
  defaultCliShimPath,
  defaultUserExtensionLibraryRoot,
  installMarshalCliShim,
  parseExtensionIdentity,
} from "./lib/user-extension-library.mjs";

const USAGE = `Usage:
  marshal add <git-url|folder>
  marshal add --create @scope/name
  marshal library
  marshal install-cli
`;

export function parseMarshalCliArgs(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { command: "help" };
  }
  const [command, ...rest] = argv;
  if (command === "library") return { command: "library" };
  if (command === "install-cli") return { command: "install-cli" };
  if (command === "add") {
    if (rest[0] === "--create") {
      if (!rest[1] || rest[1].startsWith("-")) {
        throw new Error("marshal add --create requires an identity like @acme/hello.");
      }
      return { command: "create", identity: rest[1] };
    }
    if (!rest[0] || rest[0].startsWith("-")) {
      throw new Error("marshal add requires a git URL or a local folder.");
    }
    return { command: "add", source: rest[0] };
  }
  throw new Error(`Unknown command: ${command}`);
}

export async function runMarshalCli(
  argv,
  {
    stdout = process.stdout,
    env = process.env,
    homedir,
    documentsDir,
    platform = process.platform,
    cliPath = fileURLToPath(import.meta.url),
    add = addRuntimeExtension,
    create = createRuntimeExtensionStub,
    installCli = installMarshalCliShim,
  } = {},
) {
  const parsed = parseMarshalCliArgs(argv);
  if (parsed.command === "help") {
    stdout.write(USAGE);
    return { command: "help" };
  }
  if (parsed.command === "install-cli") {
    const shimPath = defaultCliShimPath({
      platform,
      ...(homedir === undefined ? {} : { homedir }),
    });
    const installed = await installCli({ cliPath, shimPath, platform });
    stdout.write(`Installed ${installed}\n`);
    return { command: "install-cli", shimPath: installed };
  }
  const libraryRoot = defaultUserExtensionLibraryRoot({
    env,
    ...(homedir === undefined ? {} : { homedir }),
    documentsDir,
    platform,
  });
  if (!libraryRoot) {
    throw new Error("The Marshal Runtime extension library path is unavailable.");
  }
  if (parsed.command === "library") {
    stdout.write(`${libraryRoot}\n`);
    return { command: "library", libraryRoot };
  }
  if (parsed.command === "create") {
    const created = await create({
      identity: parseExtensionIdentity(parsed.identity),
      libraryRoot,
    });
    stdout.write(`Created ${created.identity} at ${created.packageRoot}\n`);
    return { command: "create", ...created, libraryRoot };
  }
  const added = await add({ source: parsed.source, libraryRoot });
  stdout.write(`Added ${added.identity} at ${added.packageRoot}\n`);
  return { command: "add", ...added, libraryRoot };
}

const isDirectEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectEntrypoint) {
  runMarshalCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
