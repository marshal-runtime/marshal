const { createCipheriv, createDecipheriv, randomBytes } = require("node:crypto");
const { copyFileSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const { app, safeStorage } = require("electron");

const root = join(homedir(), ".marshal-dev");
const sessionsDir = join(root, "marshal-sessions");
const sessionId = "d5ef75da-a4f9-4433-b289-d5af0134db6a";
const backendId = "agent-45bd0eac-77a3-47fd-a402-3db7ec96678a";
const magic = Buffer.from([0x4d, 0x53, 0x45, 0x01]);

app.setName("Marshal");
app.setPath("userData", join(root, "electron-data"));

function decryptJson(file, key) {
  const encrypted = readFileSync(file);
  const iv = encrypted.subarray(4, 16);
  const authTag = encrypted.subarray(16, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  decipher.setAuthTag(authTag);
  return JSON.parse(
    Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]).toString("utf8"),
  );
}

function encryptJson(file, value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const plaintext = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const output = Buffer.concat([magic, iv, cipher.getAuthTag(), encrypted]);
  const temporary = `${file}.restore-tmp`;
  writeFileSync(temporary, output, { mode: 0o600 });
  renameSync(temporary, file);
}

app.whenReady().then(() => {
  try {
    const key = Buffer.from(
      safeStorage.decryptString(readFileSync(join(root, "marshal-encryption-key.enc"))),
      "base64",
    );
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const sessionPath = join(sessionsDir, `${sessionId}.json`);
    const indexPath = join(sessionsDir, "sessions-index.json");
    const session = decryptJson(sessionPath, key);
    const index = decryptJson(indexPath, key);
    const row = index.sessions.find((candidate) => candidate.id === sessionId);
    if (!row) throw new Error(`Session ${sessionId} is missing from the index`);

    copyFileSync(sessionPath, `${sessionPath}.before-backend-restore-${timestamp}`);
    copyFileSync(indexPath, `${indexPath}.before-backend-restore-${timestamp}`);
    const previousSessionBackendId = session.backendId;
    const previousIndexBackendId = row.backendId;
    session.backendId = backendId;
    row.backendId = backendId;
    encryptJson(sessionPath, session, key);
    encryptJson(indexPath, index, key);
    console.log(
      JSON.stringify({
        sessionId,
        previousSessionBackendId,
        previousIndexBackendId,
        backendId,
      }),
    );
    app.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    app.exit(1);
  }
});
