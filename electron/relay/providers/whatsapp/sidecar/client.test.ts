import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  buildWhatsAppSidecarEnvironment,
  createAuthResponse,
  WhatsAppSidecarClient,
} from "./client";
import {
  decodeWhatsAppAuthValue,
  encodeWhatsAppAuthValue,
  serializeWhatsAppSidecarFrame,
  WHATSAPP_SIDECAR_SCHEMA_VERSION,
} from "./protocol";

type MockChild = Omit<
  ChildProcessWithoutNullStreams,
  "exitCode" | "kill" | "killed" | "stderr" | "stdin" | "stdout"
> & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn<(signal?: number | NodeJS.Signals) => boolean>>;
};

describe("WhatsApp sidecar parent client", () => {
  it("passes only non-secret environment values to the sidecar", () => {
    const environment = buildWhatsAppSidecarEnvironment({
      APP_ROOT: "parent-root",
      GITHUB_TOKEN: "secret-token",
      NODE_ENV: "development",
      NODE_OPTIONS: "--inspect",
      TEMP: "C:\\whatsapp-temp",
      VITE_DEV_SERVER_URL: "http://localhost:5544",
      WHATSAPP_CREDENTIALS: "secret-creds",
      WHATSAPP_ROOT_KEY: "secret-key",
    });
    expect(environment).toEqual({
      APP_ROOT: "",
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      NO_COLOR: "1",
      TEMP: "C:\\whatsapp-temp",
      VITE_DEV_SERVER_URL: "",
      VITE_PUBLIC: "",
      WS_NO_BUFFER_UTIL: "1",
      WS_NO_UTF_8_VALIDATE: "1",
    });
    expect(JSON.stringify(environment)).not.toContain("secret");
  });

  it("serves credential and Signal-key operations through the transactional store port", async () => {
    const credentials = {
      noiseKey: { public: new Uint8Array([1]), private: new Uint8Array([2]) },
      registered: false,
    };
    const authStore = {
      readCredentials: vi.fn(() => credentials),
      readSignalKeys: vi.fn(() => ({ device: Buffer.from([3, 4]) })),
      applyTransaction: vi.fn(),
      resetAfterTerminalDisconnect: vi.fn(),
    };

    const credentialResponse = await createAuthResponse(
      {
        schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
        kind: "auth-request",
        requestId: "auth-1",
        operation: "read-credentials",
      },
      authStore,
    );
    expect(credentialResponse.operation).toBe("read-credentials");
    if (credentialResponse.operation !== "read-credentials" || !credentialResponse.ok) {
      throw new Error("Unexpected credentials response");
    }
    expect(decodeWhatsAppAuthValue(credentialResponse.credentials!)).toEqual(credentials);

    const signalResponse = await createAuthResponse(
      {
        schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
        kind: "auth-request",
        requestId: "auth-2",
        operation: "read-signal-keys",
        category: "session",
        ids: ["device"],
      },
      authStore,
    );
    expect(signalResponse.operation).toBe("read-signal-keys");
    if (signalResponse.operation !== "read-signal-keys" || !signalResponse.ok) {
      throw new Error("Unexpected Signal-key response");
    }
    expect(decodeWhatsAppAuthValue(signalResponse.values.device)).toEqual(Buffer.from([3, 4]));

    await createAuthResponse(
      {
        schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
        kind: "auth-request",
        requestId: "auth-3",
        operation: "apply-transaction",
        update: {
          credentials: encodeWhatsAppAuthValue({ registered: true }),
          signalKeys: {
            session: {
              device: encodeWhatsAppAuthValue(Buffer.from([5, 6])),
              removed: null,
            },
          },
        },
      },
      authStore,
    );
    expect(authStore.applyTransaction).toHaveBeenCalledWith({
      credentials: { registered: true },
      signalKeys: {
        session: {
          device: Buffer.from([5, 6]),
          removed: null,
        },
      },
    });

    await createAuthResponse(
      {
        schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
        kind: "auth-request",
        requestId: "auth-4",
        operation: "reset",
      },
      authStore,
    );
    expect(authStore.resetAfterTerminalDisconnect).toHaveBeenCalledOnce();
  });

  it("reports child spawn errors through readiness without an unhandled exit rejection", async () => {
    const child = createMockChild();
    queueMicrotask(() => {
      child.emit("error", new Error("spawn EACCES"));
    });

    await expect(
      WhatsAppSidecarClient.launch(
        {
          mode: "development",
          sidecarPath: fileURLToPath(import.meta.url),
          nodeExecutable: process.execPath,
          timeoutMs: 500,
        },
        createNoopAuthStore(),
        { spawnSidecar: () => child },
      ),
    ).rejects.toThrow(/failed to start/);
  });

  it("fails immediately when the child exits before shutdown acknowledgement", async () => {
    const child = createMockChild();
    child.stdin.on("data", (chunk: Buffer) => {
      if (!chunk.toString("utf8").includes('"command":"shutdown"')) return;
      child.exitCode = 1;
      child.stdout.end();
      child.emit("exit", 1, null);
    });
    const launch = WhatsAppSidecarClient.launch(
      {
        mode: "development",
        sidecarPath: fileURLToPath(import.meta.url),
        nodeExecutable: process.execPath,
        timeoutMs: 500,
      },
      createNoopAuthStore(),
      { spawnSidecar: () => child },
    );
    child.stdout.write(
      serializeWhatsAppSidecarFrame({
        schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
        kind: "ready",
        capabilities: {
          packageName: "baileys",
          packageVersion: "7.0.0-rc14",
          autoConnect: false,
          authPersistence: "parent-rpc",
        },
      }),
    );
    const client = await launch;

    await expect(client.shutdown()).rejects.toThrow(/before shutdown acknowledgement/);
  });

  it("surfaces a post-ready child failure so a controller can relaunch", async () => {
    const child = createMockChild();
    const launch = WhatsAppSidecarClient.launch(
      {
        mode: "development",
        sidecarPath: fileURLToPath(import.meta.url),
        nodeExecutable: process.execPath,
        timeoutMs: 500,
      },
      createNoopAuthStore(),
      { spawnSidecar: () => child },
    );
    child.stdout.write(
      serializeWhatsAppSidecarFrame({
        schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
        kind: "ready",
        capabilities: {
          packageName: "baileys",
          packageVersion: "7.0.0-rc14",
          autoConnect: false,
          authPersistence: "parent-rpc",
        },
      }),
    );
    const client = await launch;
    const events: unknown[] = [];
    client.subscribe((event) => events.push(event));

    child.exitCode = 1;
    child.stdout.end();
    child.emit("exit", 1, null);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(events).toEqual([
      {
        type: "error",
        code: "SIDECAR_FAILED",
        message: "WhatsApp sidecar process failed.",
      },
      { type: "status", status: "stopped", attempt: 0 },
    ]);
  });

  it("ignores bounded dependency output outside framed protocol messages", async () => {
    const child = createMockChild();
    const launch = WhatsAppSidecarClient.launch(
      {
        mode: "development",
        sidecarPath: fileURLToPath(import.meta.url),
        nodeExecutable: process.execPath,
        timeoutMs: 500,
      },
      createNoopAuthStore(),
      { spawnSidecar: () => child },
    );
    child.stdout.write('{"level":30,"schemaVersion":"dependency-log"}\n');
    child.stdout.write(
      serializeWhatsAppSidecarFrame({
        schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
        kind: "ready",
        capabilities: {
          packageName: "baileys",
          packageVersion: "7.0.0-rc14",
          autoConnect: false,
          authPersistence: "parent-rpc",
        },
      }),
    );

    await launch;
    expect(child.killed).toBe(false);
    child.exitCode = 0;
    child.stdout.end();
    child.emit("exit", 0, null);
  });

  it("handles a broken child stdin pipe without reflecting its error content", async () => {
    const child = createMockChild();
    const launch = WhatsAppSidecarClient.launch(
      {
        mode: "development",
        sidecarPath: fileURLToPath(import.meta.url),
        nodeExecutable: process.execPath,
        timeoutMs: 500,
      },
      createNoopAuthStore(),
      { spawnSidecar: () => child },
    );
    child.stdout.write(
      serializeWhatsAppSidecarFrame({
        schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
        kind: "ready",
        capabilities: {
          packageName: "baileys",
          packageVersion: "7.0.0-rc14",
          autoConnect: false,
          authPersistence: "parent-rpc",
        },
      }),
    );
    const client = await launch;
    const events: unknown[] = [];
    client.subscribe((event) => events.push(event));

    child.stdin.emit("error", new Error("EOF credential-secret"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(events).toEqual([
      {
        type: "error",
        code: "SIDECAR_FAILED",
        message: "WhatsApp sidecar process failed.",
      },
      { type: "status", status: "stopped", attempt: 0 },
    ]);
    expect(JSON.stringify(events)).not.toContain("credential-secret");
  });
});

function createMockChild(): MockChild {
  const child: MockChild = Object.assign(Object.create(EventEmitter.prototype), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    killed: false,
    kill: vi.fn<(signal?: number | NodeJS.Signals) => boolean>(),
  });
  child.kill = vi.fn<(signal?: number | NodeJS.Signals) => boolean>(() => {
    child.killed = true;
    child.exitCode = 1;
    child.stdout.end();
    child.emit("exit", 1, null);
    return true;
  });
  return child;
}

function createNoopAuthStore() {
  return {
    readCredentials: () => null,
    readSignalKeys: () => ({}),
    applyTransaction: () => undefined,
    resetAfterTerminalDisconnect: () => undefined,
  };
}
