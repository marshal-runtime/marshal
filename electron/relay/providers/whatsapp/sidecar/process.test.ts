import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { runWhatsAppSidecarProcess } from "./process";
import {
  parseWhatsAppSidecarChildFrame,
  serializeWhatsAppSidecarFrame,
  WHATSAPP_SIDECAR_SCHEMA_VERSION,
  type WhatsAppSidecarChildFrame,
} from "./protocol";

describe("WhatsApp sidecar process", () => {
  it("announces readiness without creating a socket until requested", async () => {
    const input = new PassThrough();
    const frames: WhatsAppSidecarChildFrame[] = [];
    const createSocket = vi.fn(async () => ({
      close: vi.fn(async () => undefined),
    }));
    const run = runWhatsAppSidecarProcess({
      input,
      writeFrame: (frame) => frames.push(frame),
      createSocket,
    });

    expect(frames).toEqual([
      {
        schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
        kind: "ready",
        capabilities: {
          packageName: "baileys",
          packageVersion: "7.0.0-rc14",
          autoConnect: false,
          authPersistence: "parent-rpc",
        },
      },
    ]);
    expect(createSocket).not.toHaveBeenCalled();

    input.write(
      serializeWhatsAppSidecarFrame({
        schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
        kind: "command",
        requestId: "command-shutdown",
        command: "shutdown",
      }),
    );
    await run;
    expect(createSocket).not.toHaveBeenCalled();
    expect(frames.at(-1)).toEqual({
      schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
      kind: "command-result",
      requestId: "command-shutdown",
      command: "shutdown",
      ok: true,
    });
  });

  it("rejects invalid protocol frames without reflecting secret content", async () => {
    const input = new PassThrough();
    const frames: WhatsAppSidecarChildFrame[] = [];
    const run = runWhatsAppSidecarProcess({
      input,
      writeFrame: (frame) => frames.push(frame),
      createSocket: vi.fn(),
    });
    input.end(
      JSON.stringify({
        schemaVersion: 999,
        kind: "command",
        requestId: "secret-access-token",
        command: "start",
        credentials: "credential-secret",
      }) + "\n",
    );

    await expect(run).rejects.toThrow(/protocol validation failed/);
    const fatal = frames.at(-1);
    expect(fatal?.kind).toBe("fatal");
    expect(JSON.stringify(fatal)).not.toContain("secret");
    expect(JSON.stringify(fatal)).not.toContain("credential");
    expect(() => parseWhatsAppSidecarChildFrame(JSON.stringify(fatal))).not.toThrow();
  });

  it("rejects pending auth RPC when the parent closes stdin unexpectedly", async () => {
    const input = new PassThrough();
    const frames: WhatsAppSidecarChildFrame[] = [];
    const run = runWhatsAppSidecarProcess({
      input,
      writeFrame: (frame) => {
        frames.push(frame);
        if (frame.kind === "auth-request") input.end();
      },
      createSocket: async (authStore) => {
        await authStore.readCredentials();
        return { close: vi.fn<() => Promise<void>>(async () => undefined) };
      },
    });

    input.write(
      serializeWhatsAppSidecarFrame({
        schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
        kind: "command",
        requestId: "command-start",
        command: "start",
      }),
    );

    await expect(run).rejects.toThrow(/closed stdin before shutdown/);
    expect(frames.some((frame) => frame.kind === "auth-request")).toBe(true);
  });

  it("rejects a mismatched auth response without deadlocking startup", async () => {
    const input = new PassThrough();
    const frames: WhatsAppSidecarChildFrame[] = [];
    const run = runWhatsAppSidecarProcess({
      input,
      writeFrame: (frame) => {
        frames.push(frame);
        if (frame.kind !== "auth-request") return;
        input.write(
          serializeWhatsAppSidecarFrame({
            schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
            kind: "auth-response",
            requestId: frame.requestId,
            operation: "reset",
            ok: true,
          }),
        );
      },
      createSocket: async (authStore) => {
        await authStore.readCredentials();
        return { close: vi.fn<() => Promise<void>>(async () => undefined) };
      },
    });

    input.write(
      serializeWhatsAppSidecarFrame({
        schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
        kind: "command",
        requestId: "command-start",
        command: "start",
      }),
    );

    await expect(run).rejects.toThrow(/Unexpected WhatsApp auth-store RPC response/);
    expect(frames.at(-1)).toEqual({
      schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
      kind: "fatal",
      code: "PROTOCOL_ERROR",
      message: "WhatsApp sidecar received an invalid protocol frame.",
    });
  });
});
