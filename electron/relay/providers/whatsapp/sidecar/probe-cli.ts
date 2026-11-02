import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as qrcode from "qrcode-terminal";

import { openEncryptedWhatsAppAuthStore } from "../auth-store";
import { WhatsAppConnectionController } from "../connection-controller";
import type { WhatsAppSidecarLaunchOptions } from "./client";
import { WHATSAPP_SIDECAR_BUNDLE_NAME, type WhatsAppConnectionEvent } from "./protocol";

function parseArguments(args: string[]): WhatsAppSidecarLaunchOptions {
  if (args.length === 0) {
    return {
      mode: "development",
      sidecarPath: path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        WHATSAPP_SIDECAR_BUNDLE_NAME,
      ),
    };
  }
  if (args.length !== 4 || args[0] !== "--packaged-resources" || args[2] !== "--platform") {
    throw new Error(
      "Usage: whatsapp-sidecar-probe [--packaged-resources <absolute-path> --platform <win32|darwin|linux>]",
    );
  }
  if (args[3] !== "win32" && args[3] !== "darwin" && args[3] !== "linux") {
    throw new Error(`Unsupported packaged platform: ${args[3]}`);
  }
  return {
    mode: "packaged",
    resourcesPath: path.resolve(args[1]),
    platform: args[3],
  };
}

function reportEvent(event: WhatsAppConnectionEvent): void {
  if (event.type === "setup" && event.phase === "qr") {
    process.stdout.write(
      "\nOpen WhatsApp > Linked devices > Link a device, then scan this one-time QR:\n\n",
    );
    qrcode.generate(event.qr, { small: true }, (rendered) => {
      process.stdout.write(`${rendered}\n`);
    });
    return;
  }
  if (event.type === "setup" && event.phase === "complete") {
    process.stdout.write("Pairing completed.\n");
    return;
  }
  if (event.type === "connected") {
    process.stdout.write("WhatsApp connected. Press Ctrl+C to shut down the probe cleanly.\n");
    return;
  }
  if (event.type === "disconnected") {
    process.stdout.write(`WhatsApp disconnected (${event.classification}, ${event.reason}).\n`);
    return;
  }
  if (event.type === "error") {
    process.stdout.write(`WhatsApp sidecar error: ${event.code}.\n`);
  }
}

async function waitForTermination(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-whatsapp-probe-"));
const keyMaterial = randomBytes(32);
const authStore = openEncryptedWhatsAppAuthStore({
  databasePath: path.join(tempDirectory, "auth.db"),
  keyMaterial,
});
const controller = new WhatsAppConnectionController({
  launch: parseArguments(process.argv.slice(2)),
  authStore,
});
controller.subscribe(reportEvent);

try {
  process.stdout.write(
    "Starting an ephemeral user-present WhatsApp pairing probe. No account is paired until you scan the QR.\n",
  );
  await controller.startPairing();
  await waitForTermination();
} catch {
  process.stderr.write("WhatsApp sidecar probe failed without logging credential material.\n");
  process.exitCode = 1;
} finally {
  await controller.shutdown().catch(() => undefined);
  authStore.close();
  keyMaterial.fill(0);
  fs.rmSync(tempDirectory, { recursive: true, force: true });
}
