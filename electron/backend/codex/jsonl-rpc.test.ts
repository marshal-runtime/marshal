import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { CodexJsonlRpcConnection, type CodexNotification } from "./jsonl-rpc";
import { CodexProtocolError } from "./protocol";

class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  exitCode: number | null = null;
  killed = false;
  readonly kill = vi.fn<(signal?: NodeJS.Signals | number) => boolean>(() => {
    this.killed = true;
    return true;
  });

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.emit("exit", code, signal);
  }

  asChild(): ChildProcessWithoutNullStreams {
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture implements the streams/events used by the transport
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

class BlockingFakeChildProcess extends EventEmitter {
  readonly stdin = new (class extends Writable {
    readonly chunks: string[] = [];

    override _write(
      chunk: Buffer,
      _encoding: BufferEncoding,
      _callback: (error?: Error | null) => void,
    ): void {
      this.chunks.push(chunk.toString("utf8"));
      // Intentionally never completes: simulates a child that stopped reading stdin.
    }
  })();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 5252;
  exitCode: number | null = null;
  killed = false;
  readonly kill = vi.fn<(signal?: NodeJS.Signals | number) => boolean>(() => {
    this.killed = true;
    return true;
  });

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.emit("exit", code, signal);
  }

  asChild(): ChildProcessWithoutNullStreams {
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture implements the streams/events used by the transport
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

function collectLines(stream: PassThrough): {
  lines: string[];
  waitForCount(count: number): Promise<void>;
} {
  const lines: string[] = [];
  let buffer = "";
  const waiters: Array<() => void> = [];
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      lines.push(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
    while (waiters.length > 0) waiters.shift()?.();
  });
  return {
    lines,
    async waitForCount(count) {
      while (lines.length < count) {
        // oxlint-disable-next-line no-await-in-loop -- each wake-up may deliver only a partial line
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
}

function parseLine(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected object");
  }
  return Object.fromEntries(Object.keys(parsed).map((key) => [key, Reflect.get(parsed, key)]));
}

describe("CodexJsonlRpcConnection", () => {
  it("correlates concurrent responses received out of order", async () => {
    const child = new FakeChildProcess();
    const writes = collectLines(child.stdin);
    const connection = new CodexJsonlRpcConnection(child.asChild());
    const first = connection.request("first", { value: 1 }, (value) => value);
    const second = connection.request("second", { value: 2 }, (value) => value);
    await writes.waitForCount(2);
    const firstWire = parseLine(writes.lines[0]);
    const secondWire = parseLine(writes.lines[1]);

    child.stdout.write(`${JSON.stringify({ id: secondWire["id"], result: { name: "second" } })}\n`);
    child.stdout.write(`${JSON.stringify({ id: firstWire["id"], result: { name: "first" } })}\n`);

    await expect(first).resolves.toEqual({ name: "first" });
    await expect(second).resolves.toEqual({ name: "second" });
  });

  it("handles server-initiated requests and writes correlated results", async () => {
    const child = new FakeChildProcess();
    const writes = collectLines(child.stdin);
    const connection = new CodexJsonlRpcConnection(child.asChild());
    connection.setServerRequestHandler(async (request) => ({
      echoedMethod: request.method,
      params: request.params,
    }));

    child.stdout.write(
      `${JSON.stringify({ id: "server-1", method: "item/tool/call", params: { x: 1 } })}\n`,
    );
    await writes.waitForCount(1);

    expect(parseLine(writes.lines[0])).toEqual({
      id: "server-1",
      result: { echoedMethod: "item/tool/call", params: { x: 1 } },
    });
  });

  it("rejects malformed subprocess messages and terminates the process", async () => {
    const child = new FakeChildProcess();
    const connection = new CodexJsonlRpcConnection(child.asChild());
    const errors: Error[] = [];
    connection.onError((error) => errors.push(error));

    child.stdout.write('{"id":1,"result":{},"error":{"code":1,"message":"both"}}\n');
    await vi.waitFor(() => expect(errors).toHaveLength(1));

    expect(errors[0]).toBeInstanceOf(CodexProtocolError);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("stops dispatching later frames from the same chunk after a fatal message", async () => {
    const child = new FakeChildProcess();
    const connection = new CodexJsonlRpcConnection(child.asChild());
    const notifications: CodexNotification[] = [];
    connection.onNotification((notification) => notifications.push(notification));

    child.stdout.write(
      [
        '{"id":1,"result":{},"error":{"code":1,"message":"both"}}',
        '{"method":"warning","params":{"message":"must not dispatch"}}',
        "",
      ].join("\n"),
    );
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGKILL"));

    expect(notifications).toEqual([]);
  });

  it("propagates request cancellation without corrupting later responses", async () => {
    const child = new FakeChildProcess();
    const writes = collectLines(child.stdin);
    const connection = new CodexJsonlRpcConnection(child.asChild());
    const controller = new AbortController();
    const cancelled = connection.request("cancelled", {}, (value) => value, {
      signal: controller.signal,
    });
    await writes.waitForCount(1);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });

    const later = connection.request("later", {}, (value) => value);
    await writes.waitForCount(2);
    const wire = parseLine(writes.lines[1]);
    child.stdout.write(`${JSON.stringify({ id: wire["id"], result: { ok: true } })}\n`);
    await expect(later).resolves.toEqual({ ok: true });
  });

  it("retries server-overload responses with a new correlation id", async () => {
    const child = new FakeChildProcess();
    const writes = collectLines(child.stdin);
    const connection = new CodexJsonlRpcConnection(child.asChild());
    const result = connection.request("model/list", {}, (value) => value);
    await writes.waitForCount(1);
    const first = parseLine(writes.lines[0]);
    child.stdout.write(
      `${JSON.stringify({
        id: first["id"],
        error: { code: -32001, message: "Server overloaded; retry later." },
      })}\n`,
    );
    await writes.waitForCount(2);
    const retry = parseLine(writes.lines[1]);
    expect(retry["id"]).not.toBe(first["id"]);
    child.stdout.write(`${JSON.stringify({ id: retry["id"], result: { ok: true } })}\n`);

    await expect(result).resolves.toEqual({ ok: true });
  });

  it("reports an unexpected clean process exit as a connection error", async () => {
    const child = new FakeChildProcess();
    const terminateProcess = vi.fn<(signal: NodeJS.Signals) => Promise<void>>(
      async () => undefined,
    );
    const connection = new CodexJsonlRpcConnection(child.asChild(), {
      terminateProcess,
    });
    const errors: Error[] = [];
    connection.onError((error) => errors.push(error));

    child.exit(0);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("exited with code 0");
    await vi.waitFor(() => expect(terminateProcess).toHaveBeenCalledWith("SIGKILL"));
  });

  it("closes stdin and completes graceful shutdown after process exit", async () => {
    const child = new FakeChildProcess();
    const connection = new CodexJsonlRpcConnection(child.asChild());
    child.stdin.on("finish", () => child.exit(0));

    await expect(connection.shutdown()).resolves.toEqual([]);
    expect(child.stdin.writableEnded).toBe(true);
  });

  it("bounds a blocked write drain and terminates the process tree", async () => {
    const child = new BlockingFakeChildProcess();
    const terminateProcess = vi.fn<(signal: NodeJS.Signals) => Promise<void>>(async (signal) => {
      child.exit(null, signal);
    });
    const connection = new CodexJsonlRpcConnection(child.asChild(), {
      terminateProcess,
    });
    const request = connection.request("blocked", {}, (value) => value).catch(() => undefined);

    await expect(connection.shutdown({ timeoutMs: 10 })).resolves.toEqual([]);
    expect(terminateProcess).toHaveBeenCalledWith("SIGKILL");
    await request;
  });

  it("does not transmit a queued request after cancellation", async () => {
    const child = new BlockingFakeChildProcess();
    const terminateProcess = vi.fn<(signal: NodeJS.Signals) => Promise<void>>(async (signal) => {
      child.exit(null, signal);
    });
    const connection = new CodexJsonlRpcConnection(child.asChild(), {
      terminateProcess,
    });
    const first = connection.request("blocked", {}, (value) => value).catch(() => undefined);
    await vi.waitFor(() => expect(child.stdin.chunks).toHaveLength(1));
    const controller = new AbortController();
    const second = connection.request("cancelled", {}, (value) => value, {
      signal: controller.signal,
    });
    controller.abort();

    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(child.stdin.chunks).toHaveLength(1);
    await connection.shutdown({ timeoutMs: 10 });
    await first;
  });

  it("routes RuntimeProcessHandle.kill through the tree terminator", async () => {
    const child = new FakeChildProcess();
    const terminateProcess = vi.fn<(signal: NodeJS.Signals) => Promise<void>>(async (signal) => {
      child.exit(null, signal);
    });
    const connection = new CodexJsonlRpcConnection(child.asChild(), {
      terminateProcess,
    });

    expect(connection.process?.kill("SIGKILL")).toBe(true);
    await vi.waitFor(() => expect(terminateProcess).toHaveBeenCalledWith("SIGKILL"));
  });

  it("reports when forced termination never produces an exit event", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChildProcess();
      const terminateProcess = vi.fn<(signal: NodeJS.Signals) => Promise<void>>(
        async () => undefined,
      );
      const connection = new CodexJsonlRpcConnection(child.asChild(), {
        terminateProcess,
      });

      const shutdown = connection.shutdown({ force: true });
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(shutdown).resolves.toEqual([
        expect.objectContaining({
          message: expect.stringContaining("did not produce an exit event"),
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
