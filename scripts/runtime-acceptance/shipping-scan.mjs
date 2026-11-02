import fs from "node:fs";
import path from "node:path";

const SCAN_CHUNK_BYTES = 1024 * 1024;

export function buildAcceptanceSignatures(repoRoot) {
  const sources = [
    path.join(repoRoot, "common", "runtime-acceptance.ts"),
    path.join(repoRoot, "electron", "runtime-acceptance-preload.cjs"),
    path.join(repoRoot, "electron", "runtime-acceptance", "main.ts"),
  ]
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => fs.readFileSync(filePath, "utf8"))
    .join("\n");
  const values = new Map();
  const add = (kind, value) => {
    if (typeof value !== "string" || value.length === 0) return;
    values.set(value, { kind, value });
  };

  add("module", "runtime-acceptance-preload.cjs");
  add("module", "runtime-acceptance/main");
  add("module", "runtime-acceptance\\main");
  add("property", "runtimeAcceptanceAPI");
  add("channel-prefix", "runtime-acceptance:");
  add("event", "acceptance.harness.created");
  add("compile-gate", "__MARSHAL_RUNTIME_ACCEPTANCE_BUILD__");

  for (const match of sources.matchAll(/"((?:runtime-acceptance):[^"]+)"/g)) {
    add("channel", match[1]);
  }
  for (const match of sources.matchAll(/\bMARSHAL_RUNTIME_ACCEPTANCE[A-Z0-9_]*\b/g)) {
    add("enable-flag", match[0]);
  }
  for (const match of sources.matchAll(/\bRuntimeAcceptance[A-Za-z0-9_]*\b/g)) {
    add("identifier", match[0]);
  }

  return [...values.values()].sort((left, right) => left.value.localeCompare(right.value));
}

export function scanShippingPaths(paths, signatures, options = {}) {
  const roots = paths.map((entry) =>
    typeof entry === "string" ? { label: entry, path: path.resolve(entry) } : entry,
  );
  const exclusions = new Set((options.excludePaths ?? []).map((entry) => path.resolve(entry)));
  const files = [];
  for (const root of roots) {
    if (!fs.existsSync(root.path)) continue;
    const stat = fs.statSync(root.path);
    if (stat.isFile()) {
      if (!exclusions.has(path.resolve(root.path)))
        files.push({ label: root.label, path: root.path });
      continue;
    }
    for (const filePath of listFiles(root.path)) {
      if (!exclusions.has(path.resolve(filePath))) {
        files.push({ label: root.label, path: filePath, root: root.path });
      }
    }
  }

  const hits = [];
  for (const file of files) {
    const matched = scanFile(file.path, signatures);
    for (const signature of matched) {
      hits.push({
        root: file.label,
        file: file.root ? normalizePath(path.relative(file.root, file.path)) : file.path,
        ...signature,
      });
    }
  }
  return {
    fileCount: files.length,
    hits,
  };
}

export function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

export function flattenAsarHeader(header) {
  const entries = [];
  const visit = (node, parentPath) => {
    if (!node || typeof node !== "object" || !node.files) return;
    for (const [name, child] of Object.entries(node.files)) {
      const entryPath = parentPath ? `${parentPath}/${name}` : name;
      if (child && typeof child === "object" && "files" in child) {
        entries.push({ path: entryPath, type: "directory", unpacked: child.unpacked === true });
        visit(child, entryPath);
      } else if (child && typeof child === "object" && "size" in child) {
        entries.push({
          path: entryPath,
          type: "file",
          size: child.size,
          unpacked: child.unpacked === true,
        });
      } else {
        entries.push({ path: entryPath, type: "link", unpacked: child?.unpacked === true });
      }
    }
  };
  visit(header, "");
  return entries;
}

function scanFile(filePath, signatures) {
  const pending = signatures.map((signature) => ({
    ...signature,
    bytes: Buffer.from(signature.value),
  }));
  if (pending.length === 0) return [];
  const maxSignatureBytes = Math.max(...pending.map((signature) => signature.bytes.length));
  const handle = fs.openSync(filePath, "r");
  const chunk = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
  let carry = Buffer.alloc(0);
  let position = 0;
  try {
    while (pending.length > 0) {
      const bytesRead = fs.readSync(handle, chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const data = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        if (data.indexOf(pending[index].bytes) >= 0) pending.splice(index, 1);
      }
      carry =
        maxSignatureBytes > 1
          ? Buffer.from(data.subarray(Math.max(0, data.length - maxSignatureBytes + 1)))
          : Buffer.alloc(0);
    }
  } finally {
    fs.closeSync(handle);
  }
  const missing = new Set(pending.map((signature) => signature.value));
  return signatures.filter((signature) => !missing.has(signature.value));
}

function normalizePath(value) {
  return value.split(path.sep).join("/");
}
