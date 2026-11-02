const { existsSync, readdirSync, readFileSync, statSync } = require("node:fs");
const { createDecipheriv } = require("node:crypto");
const { homedir } = require("node:os");
const { join } = require("node:path");
const { app, safeStorage } = require("electron");
const { resolvePersistedPath } = require("./persisted-path-compat.cjs");

const mode = process.argv.includes("--mode=dev") ? "dev" : "prod";
const profileName = process.argv.includes("--profile=m-copilot")
  ? "m-copilot"
  : process.argv.includes("--profile=marshal")
    ? "Marshal"
    : process.argv.includes("--profile=marshal")
      ? "Marshal"
      : "Marshal";
const root = join(homedir(), mode === "dev" ? ".marshal-dev" : ".marshal");
const sessionsDir = resolvePersistedPath(root, "marshal-sessions", "m-sessions");
const magic = Buffer.from([0x4d, 0x53, 0x45, 0x01]);
let encryptionKey;

app.setName(profileName);
if (mode === "dev") {
  app.setPath("userData", join(root, "electron-data"));
} else {
  app.setPath("userData", join(app.getPath("appData"), profileName));
}

function decryptJson(file) {
  const encrypted = readFileSync(file);
  if (!encrypted.subarray(0, magic.length).equals(magic)) {
    return JSON.parse(encrypted.toString("utf8"));
  }
  const iv = encrypted.subarray(4, 16);
  const authTag = encrypted.subarray(16, 32);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv, { authTagLength: 16 });
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(encrypted.subarray(32)),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext);
}

function normalizedName(value) {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
}

app.whenReady().then(() => {
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("safeStorage unavailable");
    if (!existsSync(sessionsDir)) throw new Error(`Missing ${sessionsDir}`);
    const keyPath = resolvePersistedPath(
      root,
      "marshal-encryption-key.enc",
      "m-encryption-key.enc",
    );
    encryptionKey = Buffer.from(safeStorage.decryptString(readFileSync(keyPath)), "base64");
    if (encryptionKey.length !== 32) throw new Error("Invalid Marshal encryption key length");

    const indexPath = join(sessionsDir, "sessions-index.json");
    const index = decryptJson(indexPath);
    const indexedById = new Map((index.sessions ?? []).map((session) => [session.id, session]));
    const indexedByName = new Map();
    for (const session of index.sessions ?? []) {
      const key = normalizedName(session.name);
      if (!key) continue;
      const group = indexedByName.get(key) ?? [];
      group.push({
        id: session.id,
        name: session.name,
        source: session.source,
        parentSessionId: session.parentSessionId,
        backendId: session.backendId,
        backendOrigin: session.backendOrigin ?? "copilot",
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });
      indexedByName.set(key, group);
    }
    const headers = [];
    const failures = [];

    for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.json$/i.test(entry.name)) continue;
      const id = entry.name.slice(0, -5);
      const file = join(sessionsDir, entry.name);
      try {
        const header = decryptJson(file);
        const indexed = indexedById.get(id);
        headers.push({
          id,
          name: header.name ?? indexed?.name ?? "",
          source: header.source ?? indexed?.source,
          parentSessionId: header.parentSessionId ?? indexed?.parentSessionId,
          backendId: header.backendId ?? header.copilotSessionId ?? indexed?.backendId,
          backendOrigin: header.backendOrigin ?? indexed?.backendOrigin ?? "copilot",
          createdAt: header.createdAt ?? indexed?.createdAt,
          updatedAt: header.updatedAt ?? indexed?.updatedAt,
          messageCount:
            header.messageCount ?? (Array.isArray(header.messages) ? header.messages.length : 0),
          hasGoal: Boolean(header.goal),
          goalStatus: header.goal?.status ?? header.goal?.state,
          indexed: Boolean(indexed),
          fileBytes: statSync(file).size,
        });
      } catch (error) {
        failures.push({ id, error: error instanceof Error ? error.message : String(error) });
      }
    }

    const byName = new Map();
    for (const header of headers) {
      const key = normalizedName(header.name);
      if (!key) continue;
      const group = byName.get(key) ?? [];
      group.push(header);
      byName.set(key, group);
    }

    const duplicates = [...byName.values()]
      .filter((group) => group.length > 1)
      .map((group) =>
        group.sort((a, b) => Date.parse(b.updatedAt ?? 0) - Date.parse(a.updatedAt ?? 0)),
      )
      .sort(
        (a, b) =>
          Math.max(...b.map((item) => Date.parse(item.updatedAt ?? 0))) -
          Math.max(...a.map((item) => Date.parse(item.updatedAt ?? 0))),
      );
    const indexDuplicates = [...indexedByName.values()]
      .filter((group) => group.length > 1)
      .map((group) =>
        group.sort((a, b) => Date.parse(b.updatedAt ?? 0) - Date.parse(a.updatedAt ?? 0)),
      )
      .sort(
        (a, b) =>
          Math.max(...b.map((item) => Date.parse(item.updatedAt ?? 0))) -
          Math.max(...a.map((item) => Date.parse(item.updatedAt ?? 0))),
      );
    const orphaned = headers
      .filter((header) => !header.indexed)
      .sort((a, b) => Date.parse(b.updatedAt ?? 0) - Date.parse(a.updatedAt ?? 0));
    const indexedWithoutHeader = (index.sessions ?? [])
      .filter((session) => !headers.some((header) => header.id === session.id))
      .map((session) => ({
        id: session.id,
        name: session.name,
        source: session.source,
        parentSessionId: session.parentSessionId,
        backendId: session.backendId,
        backendOrigin: session.backendOrigin ?? "copilot",
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      }))
      .sort((a, b) => Date.parse(b.updatedAt ?? 0) - Date.parse(a.updatedAt ?? 0));

    console.log(
      JSON.stringify(
        {
          mode,
          profile: profileName,
          indexedCount: indexedById.size,
          headerCount: headers.length,
          decryptFailureCount: failures.length,
          duplicateGroupCount: duplicates.length,
          indexDuplicateGroupCount: indexDuplicates.length,
          orphanedCount: orphaned.length,
          indexedWithoutHeaderCount: indexedWithoutHeader.length,
          recentDuplicateGroups: duplicates.slice(0, 100),
          recentIndexDuplicateGroups: indexDuplicates.slice(0, 200),
          recentOrphaned: orphaned.slice(0, 100),
          recentIndexedWithoutHeader: indexedWithoutHeader.slice(0, 100),
          failures: failures.slice(0, 20),
        },
        null,
        2,
      ),
    );
    app.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    app.exit(1);
  }
});
