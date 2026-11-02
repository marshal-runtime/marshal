/**
 * `runtimeShowUi {file}`: a view whose source already exists on disk, so an
 * agent need not resend thousands of lines inline. ui.compile only reads inside
 * its own root, so the entry file and everything it imports by relative path are
 * copied there into a folder named after their content, keeping their layout.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { assertRealpathAllowed, type FsAccessScope } from "../marshal-fs/path-guard";
import { expandHome } from "../marshal-fs/shared";
import { secureAtomicWriteFileSync } from "../platform-security";
import { checkSensitivePath } from "../sensitive-path-permission-guard";

const IMPORTED_DIR = [".agent", "ui", "files"] as const;
const CODE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"] as const;
const IMPORTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ...CODE_EXTENSIONS,
  ".css",
  ".json",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".woff",
  ".woff2",
]);
const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const RELATIVE_IMPORT = /\b(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"'\n]+)["']/g;

export interface ShowUiFileAccess extends FsAccessScope {
  readonly allowedSensitivePaths: string[];
}

export class ShowUiFileError extends Error {
  constructor(
    readonly code: "invalid-request" | "not-found" | "permission-denied",
    message: string,
  ) {
    super(message);
    this.name = "ShowUiFileError";
  }
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/** The candidates a bundler tries for a relative import, in its order. */
function importCandidates(importer: string, specifier: string): string[] {
  const target = path.resolve(path.dirname(importer), specifier);
  const withExtensions = (base: string) => CODE_EXTENSIONS.map((extension) => base + extension);
  return [
    target,
    ...withExtensions(target),
    // TypeScript sources import their compiled name: "./view.js" means ./view.ts(x).
    ...(/\.jsx?$/.test(target) ? withExtensions(target.replace(/\.jsx?$/, "")) : []),
    ...withExtensions(path.join(target, "index")),
  ];
}

async function resolveImport(importer: string, specifier: string): Promise<string | undefined> {
  for (const candidate of importCandidates(importer, specifier)) {
    // eslint-disable-next-line no-await-in-loop -- candidates are tried in bundler order
    if (await isFile(candidate)) return candidate;
  }
  return undefined;
}

function commonDirectory(files: readonly string[]): string {
  let common = path.dirname(files[0] ?? "");
  for (const file of files) {
    while (
      file !== common &&
      !file.startsWith(common.endsWith(path.sep) ? common : common + path.sep)
    ) {
      common = path.dirname(common);
    }
  }
  return common;
}

async function assertReadable(
  rawPath: string,
  access: ShowUiFileAccess,
  compileRoot: string,
): Promise<string> {
  let real: string;
  try {
    real = await assertRealpathAllowed(rawPath, "read", {
      ...access,
      readGrants: [...access.readGrants, compileRoot],
    });
  } catch (error) {
    throw new ShowUiFileError(
      "permission-denied",
      `${error instanceof Error ? error.message : "Access denied"}. Use a file in the session workspace or a granted folder.`,
    );
  }
  const sensitive = checkSensitivePath(
    // checkSensitivePath reads only kind + path; id/sessionId are required by
    // ApprovalRequest but unused for this synthetic check.
    { kind: "read", toolCallId: undefined, path: real, id: "", sessionId: "" },
    access.allowedSensitivePaths,
  );
  if (sensitive) {
    throw new ShowUiFileError(
      "permission-denied",
      `Access denied: ${sensitive.resolvedPath} is a sensitive path.`,
    );
  }
  return real;
}

/**
 * Copies a view's entry file and its relative imports into the compile root and
 * returns the entry's root-relative path. A relative import that resolves to
 * nothing is left for ui.compile to report, with its line and column.
 */
export async function importViewFile(
  file: string,
  access: ShowUiFileAccess,
  compileRoot: string,
): Promise<string> {
  const expanded = expandHome(file);
  const requested = path.isAbsolute(expanded) ? expanded : path.join(access.workspaceDir, expanded);
  if (!(CODE_EXTENSIONS as readonly string[]).includes(path.extname(requested).toLowerCase())) {
    throw new ShowUiFileError(
      "invalid-request",
      `runtimeShowUi file must end in ${CODE_EXTENSIONS.join(", ")}: ${file}`,
    );
  }
  if (!(await isFile(requested))) {
    throw new ShowUiFileError("not-found", `runtimeShowUi file not found: ${requested}`);
  }

  const entry = await assertReadable(requested, access, compileRoot);
  const contents = new Map<string, Buffer>();
  const pending = [entry];
  let totalBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || contents.has(current)) continue;
    if (contents.size >= MAX_FILES) {
      throw new ShowUiFileError(
        "invalid-request",
        `runtimeShowUi file imports more than ${MAX_FILES} files.`,
      );
    }
    // eslint-disable-next-line no-await-in-loop -- the walk's next files come from this read
    const data = await fs.readFile(current);
    totalBytes += data.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new ShowUiFileError(
        "invalid-request",
        `runtimeShowUi file and its imports exceed ${MAX_TOTAL_BYTES} bytes.`,
      );
    }
    contents.set(current, data);
    if (!(CODE_EXTENSIONS as readonly string[]).includes(path.extname(current).toLowerCase())) {
      continue;
    }
    for (const match of data.toString("utf8").matchAll(RELATIVE_IMPORT)) {
      // eslint-disable-next-line no-await-in-loop -- imports resolve one at a time, in source order
      const resolved = await resolveImport(current, match[1]);
      if (!resolved || !IMPORTABLE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) continue;
      // eslint-disable-next-line no-await-in-loop -- each import passes the same read gate
      pending.push(await assertReadable(resolved, access, compileRoot));
    }
  }

  const base = commonDirectory([...contents.keys()]);
  const relativeTo = (absolute: string) => path.relative(base, absolute).split(path.sep).join("/");
  const hash = createHash("sha256");
  for (const absolute of [...contents.keys()].sort()) {
    hash
      .update(relativeTo(absolute))
      .update("\0")
      .update(contents.get(absolute) ?? "")
      .update("\0");
  }
  const folder = [...IMPORTED_DIR, hash.digest("hex").slice(0, 16)];
  for (const [absolute, data] of contents) {
    secureAtomicWriteFileSync(
      path.join(compileRoot, ...folder, ...relativeTo(absolute).split("/")),
      data,
      {
        mode: 0o600,
      },
    );
  }
  return [...folder, relativeTo(entry)].join("/");
}
