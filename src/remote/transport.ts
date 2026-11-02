import { TRANSPORT_RECONNECTED_EVENT } from "../shared/hooks/useTransportReconnects";

export type RemoteConnectionState = "connecting" | "connected" | "disconnected";

// iOS keeps reporting a socket as OPEN after the Mac dropped it (phone asleep, app
// suspended, Tailscale re-keyed), so no close event ever arrives and the open chat
// silently stops updating. Probe the socket whenever it has been quiet this long.
const IDLE_PROBE_MS = 15_000;
const PROBE_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 10_000;
// Requests made during a reconnect wait for the socket instead of failing at once.
const CONNECTION_WAIT_MS = 15_000;
// A send into a socket iOS silently killed would sit unanswered; probe first.
const SEND_PROBE_AFTER_QUIET_MS = 4_000;
// How long a send interrupted by a reconnect may wait to be confirmed.
const UNCONFIRMED_SEND_WAIT_MS = 90_000;
const DELIVERY_RECHECK_MS = 1_500;
const RETRY_DELAYS_MS = [250, 1_000, 2_000, 4_000];
const PING_METHOD = "remote:ping";
// These resolve only when the agent's turn ends, so a reconnect during a long turn
// must not report a message the Mac already accepted as unsent.
const TURN_METHODS = new Set(["copilot:send", "copilot:steer"]);

interface PendingRequest {
  method: string;
  args: unknown[];
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface UnconfirmedSend {
  sessionId: string;
  clientMessageId: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  deadline: ReturnType<typeof setTimeout>;
  checking: boolean;
}

export class RemoteTransport {
  private socket: WebSocket | undefined;
  private counter = 0;
  private pending = new Map<string, PendingRequest>();
  private unconfirmed = new Set<UnconfirmedSend>();
  private waiters = new Set<() => void>();
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  private retry: ReturnType<typeof setTimeout> | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setInterval> | undefined;
  private probing: Promise<boolean> | undefined;
  private lastReceivedAt = 0;
  private attempt = 0;
  private stopped = false;
  private everConnected = false;
  state: RemoteConnectionState = "connecting";
  onState: ((state: RemoteConnectionState) => void) | undefined;
  onReconnect: (() => void) | undefined;
  connect() {
    if (
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    )
      return;
    this.stopped = false;
    clearTimeout(this.retry);
    this.setState("connecting");
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
    );
    this.socket = ws;
    clearTimeout(this.connectTimer);
    // A connect into a tunnel that is still coming back can hang for the OS TCP timeout.
    this.connectTimer = setTimeout(() => {
      if (this.socket === ws && ws.readyState === WebSocket.CONNECTING) this.refresh();
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      if (this.socket !== ws) return;
      clearTimeout(this.connectTimer);
      this.lastReceivedAt = Date.now();
      this.attempt = 0;
      this.startIdleProbe();
      this.setState("connected");
      for (const wake of [...this.waiters]) wake();
      void this.confirmUnconfirmedSends();
      if (this.everConnected) {
        this.onReconnect?.();
        window.dispatchEvent(new CustomEvent(TRANSPORT_RECONNECTED_EVENT));
      }
      this.everConnected = true;
    };
    ws.onmessage = (event) => {
      if (this.socket !== ws) return;
      this.lastReceivedAt = Date.now();
      let msg: {
        type?: string;
        id?: string;
        ok?: boolean;
        payload?: unknown;
        error?: { message?: string };
        event?: string;
        args?: unknown[];
      };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.type === "res" && msg.id) {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.ok) pending.resolve(msg.payload);
        else pending.reject(new Error(msg.error?.message ?? "Request failed"));
      } else if (msg.type === "event" && msg.event) {
        for (const listener of this.listeners.get(msg.event) ?? [])
          listener(undefined, ...(msg.args ?? []));
      }
    };
    ws.onclose = () => {
      if (this.socket !== ws) return;
      this.socket = undefined;
      clearTimeout(this.connectTimer);
      clearInterval(this.idleTimer);
      this.setState("disconnected");
      this.abandonPending("Connection interrupted. Check the conversation before sending again.");
      if (!this.stopped) {
        const delay = RETRY_DELAYS_MS[Math.min(this.attempt, RETRY_DELAYS_MS.length - 1)] ?? 4_000;
        this.attempt++;
        this.retry = setTimeout(() => this.connect(), delay);
      }
    };
    ws.onerror = () => ws.close();
  }
  async invoke(method: string, ...args: unknown[]): Promise<unknown> {
    await this.whenConnected();
    const turn = TURN_METHODS.has(method);
    if (turn && Date.now() - this.lastReceivedAt > SEND_PROBE_AFTER_QUIET_MS) {
      if (!(await this.verify())) await this.whenConnected();
    }
    return this.request(method, args, turn ? 30 * 60_000 : 60_000);
  }
  /**
   * Confirms the socket still reaches the Mac; reconnects when it does not. Any
   * response counts, so an older Mac that rejects the ping still proves liveness.
   */
  verify(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    if (this.socket?.readyState !== WebSocket.OPEN) {
      if (this.socket?.readyState !== WebSocket.CONNECTING) this.refresh();
      return Promise.resolve(false);
    }
    this.probing ??= this.request(PING_METHOD, [], PROBE_TIMEOUT_MS)
      .then(
        () => true,
        (error: unknown) => !(error instanceof ProbeTimeout),
      )
      .then((alive) => {
        this.probing = undefined;
        if (!alive) this.refresh();
        return alive;
      });
    return this.probing;
  }
  on(event: string, listener: (...args: unknown[]) => void) {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }
  removeListener(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.get(event)?.delete(listener);
  }
  refresh() {
    clearTimeout(this.retry);
    clearTimeout(this.connectTimer);
    clearInterval(this.idleTimer);
    const ws = this.socket;
    this.socket = undefined;
    if (ws) {
      ws.close();
      this.abandonPending("Connection refreshed. Check the conversation before retrying.");
    }
    this.connect();
  }
  close() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.connectTimer);
    clearInterval(this.idleTimer);
    this.socket?.close();
  }
  private whenConnected(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.stopped) return Promise.reject(connectionUnavailable());
    if (!this.socket) this.connect();
    return new Promise((resolve, reject) => {
      const wake = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        reject(connectionUnavailable());
      }, CONNECTION_WAIT_MS);
      this.waiters.add(wake);
    });
  }
  /** Rejects in-flight requests; sends the Mac may already hold wait for confirmation. */
  private abandonPending(message: string) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      const sessionId = request.args[1];
      const clientMessageId = request.args[3];
      if (
        TURN_METHODS.has(request.method) &&
        typeof sessionId === "string" &&
        typeof clientMessageId === "string"
      ) {
        const entry: UnconfirmedSend = {
          sessionId,
          clientMessageId,
          resolve: request.resolve,
          reject: request.reject,
          checking: false,
          deadline: setTimeout(() => {
            this.unconfirmed.delete(entry);
            request.reject(new Error(message));
          }, UNCONFIRMED_SEND_WAIT_MS),
        };
        this.unconfirmed.add(entry);
      } else {
        request.reject(new Error(message));
      }
    }
    this.pending.clear();
  }
  private async confirmUnconfirmedSends() {
    await Promise.all(
      [...this.unconfirmed].map(async (entry) => {
        if (entry.checking) return;
        entry.checking = true;
        try {
          let delivered = await this.isDelivered(entry);
          if (!delivered) {
            await new Promise((resolve) => setTimeout(resolve, DELIVERY_RECHECK_MS));
            delivered = await this.isDelivered(entry);
          }
          clearTimeout(entry.deadline);
          this.unconfirmed.delete(entry);
          // The turn keeps running on the Mac; the live session view shows its progress.
          if (delivered) entry.resolve({ success: true });
          else
            entry.reject(new Error("Your Mac didn't receive this message. Tap retry to send it."));
        } catch {
          // The connection dropped again; the next reconnect checks once more.
        } finally {
          entry.checking = false;
        }
      }),
    );
  }
  private async isDelivered(entry: UnconfirmedSend): Promise<boolean> {
    const result = await this.request(
      "sessions:get",
      [entry.sessionId, { messageLimit: 40 }],
      60_000,
    );
    const field = (value: unknown, key: string): unknown =>
      typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
    if (field(result, "success") !== true) throw new Error("History unavailable");
    const messages = field(field(result, "session"), "messages");
    return (
      Array.isArray(messages) &&
      messages.some(
        (message: unknown) =>
          field(message, "role") === "user" &&
          (field(message, "id") === entry.clientMessageId ||
            field(message, "clientMessageId") === entry.clientMessageId),
      )
    );
  }
  private request(method: string, args: unknown[], timeoutMs: number): Promise<unknown> {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(connectionUnavailable());
    const id = String(++this.counter);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          method === PING_METHOD
            ? new ProbeTimeout()
            : new Error("Response not received. Check the conversation before retrying."),
        );
      }, timeoutMs);
      this.pending.set(id, { method, args, resolve, reject, timer });
      this.socket!.send(JSON.stringify({ type: "req", id, method, args }));
    });
  }
  private startIdleProbe() {
    clearInterval(this.idleTimer);
    this.idleTimer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - this.lastReceivedAt >= IDLE_PROBE_MS) void this.verify();
    }, IDLE_PROBE_MS / 3);
  }
  private setState(state: RemoteConnectionState) {
    if (this.state === state) return;
    this.state = state;
    this.onState?.(state);
    window.dispatchEvent(new CustomEvent("marshal:connection", { detail: state }));
  }
}
function connectionUnavailable() {
  return new Error("Connection unavailable. Your draft is kept on this device.");
}
class ProbeTimeout extends Error {
  constructor() {
    super("The Mac did not answer");
  }
}
export const remoteTransport = new RemoteTransport();
