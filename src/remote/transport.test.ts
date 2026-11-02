import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RemoteTransport } from "./transport";

interface Frame {
  id: string;
  method: string;
  args: unknown[];
}

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  sent: Frame[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    const { id, method, args }: Frame = JSON.parse(data);
    this.sent.push({ id, method, args });
  }
  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  reply(frame: Frame, payload: unknown) {
    this.onmessage?.({ data: JSON.stringify({ type: "res", id: frame.id, ok: true, payload }) });
  }
  last(method: string) {
    return this.sent.findLast((frame) => frame.method === method);
  }
}

const latest = () => FakeSocket.instances.at(-1)!;
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("RemoteTransport", () => {
  let transport: RemoteTransport;
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    transport = new RemoteTransport();
  });
  afterEach(() => {
    transport.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("holds requests made while connecting and sends them once the socket opens", async () => {
    transport.connect();
    const result = transport.invoke("sessions:list");
    await flush();
    expect(latest().sent).toHaveLength(0);
    latest().open();
    await flush();
    latest().reply(latest().last("sessions:list")!, { success: true });
    await expect(result).resolves.toEqual({ success: true });
  });

  it("confirms an interrupted send against the conversation instead of failing it", async () => {
    transport.connect();
    latest().open();
    const send = transport.invoke("copilot:send", "hello", "s1", undefined, "client-1");
    await flush();
    const first = latest();
    expect(first.last("copilot:send")).toBeDefined();

    first.close();
    await vi.advanceTimersByTimeAsync(300);
    const second = latest();
    expect(second).not.toBe(first);
    second.open();
    await flush();
    const lookup = second.last("sessions:get")!;
    expect(lookup.args).toEqual(["s1", { messageLimit: 40 }]);
    second.reply(lookup, {
      success: true,
      session: { messages: [{ id: "client-1", role: "user" }] },
    });
    await expect(send).resolves.toEqual({ success: true });
  });

  it("reports an interrupted send as not received when the Mac never got it", async () => {
    transport.connect();
    latest().open();
    const send = transport.invoke("copilot:send", "hello", "s1", undefined, "client-2");
    const outcome = send.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await flush();
    transport.refresh();
    latest().open();
    await flush();
    latest().reply(latest().last("sessions:get")!, { success: true, session: { messages: [] } });
    await vi.advanceTimersByTimeAsync(1_600);
    latest().reply(latest().last("sessions:get")!, { success: true, session: { messages: [] } });
    await expect(outcome).resolves.toMatch(/didn't receive this message/);
  });

  it("probes a quiet socket before sending so a dead one is replaced first", async () => {
    transport.connect();
    latest().open();
    await vi.advanceTimersByTimeAsync(4_500);
    const send = transport.invoke("copilot:send", "hi", "s1", undefined, "client-3");
    await flush();
    const stale = latest();
    expect(stale.last("remote:ping")).toBeDefined();
    expect(stale.last("copilot:send")).toBeUndefined();

    await vi.advanceTimersByTimeAsync(5_100);
    const fresh = latest();
    expect(fresh).not.toBe(stale);
    fresh.open();
    await flush();
    const frame = fresh.last("copilot:send")!;
    fresh.reply(frame, { success: true });
    await expect(send).resolves.toEqual({ success: true });
  });

  it("rejects ordinary requests that were interrupted", async () => {
    transport.connect();
    latest().open();
    const request = transport.invoke("sessions:list");
    const outcome = request.catch((error: Error) => error.message);
    await flush();
    latest().close();
    await expect(outcome).resolves.toMatch(/Connection interrupted/);
  });
});
