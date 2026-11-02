/**
 * Minimal CDP (Chrome DevTools Protocol) client over WebSocket.
 *
 * Uses the Node.js 22 global WebSocket. Connects to a specific
 * page target and exposes typed send/receive helpers.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TargetInfo {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  description?: string;
  devtoolsFrontendUrl?: string;
  faviconUrl?: string;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type EventHandler = (params: Record<string, unknown>) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function targetInfo(value: unknown): TargetInfo | undefined {
  if (!isRecord(value)) return undefined;
  const { id, type, title, url } = value;
  if (
    typeof id !== "string" ||
    typeof type !== "string" ||
    typeof title !== "string" ||
    typeof url !== "string"
  ) {
    return undefined;
  }
  const optionalString = (name: string): string | undefined => {
    const field = value[name];
    return typeof field === "string" ? field : undefined;
  };
  return {
    id,
    type,
    title,
    url,
    ...(optionalString("webSocketDebuggerUrl")
      ? { webSocketDebuggerUrl: optionalString("webSocketDebuggerUrl") }
      : {}),
    ...(optionalString("description") ? { description: optionalString("description") } : {}),
    ...(optionalString("devtoolsFrontendUrl")
      ? { devtoolsFrontendUrl: optionalString("devtoolsFrontendUrl") }
      : {}),
    ...(optionalString("faviconUrl") ? { faviconUrl: optionalString("faviconUrl") } : {}),
  };
}

function cdpMessage(value: unknown): CdpMessage | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === "number" ? value.id : undefined;
  const method = typeof value.method === "string" ? value.method : undefined;
  const params = isRecord(value.params) ? value.params : undefined;
  const error = isRecord(value.error) ? value.error : undefined;
  if (id === undefined && method === undefined) return undefined;
  let parsedError: CdpMessage["error"];
  if (error) {
    const { code, message } = error;
    if (typeof code !== "number" || typeof message !== "string") return undefined;
    parsedError = { code, message };
  }
  return {
    ...(id !== undefined ? { id } : {}),
    ...(method ? { method } : {}),
    ...(params ? { params } : {}),
    ...(Object.hasOwn(value, "result") ? { result: value.result } : {}),
    ...(parsedError ? { error: parsedError } : {}),
  };
}

// ---------------------------------------------------------------------------
// Remote host configuration
// ---------------------------------------------------------------------------

let _host = "127.0.0.1";

/** Set the CDP endpoint host (for connecting to remote browsers). */
export function setCDPHost(host: string): void {
  _host = host;
}

export function getCDPHost(): string {
  return _host;
}

function cdpUrl(port: number, path: string): string {
  return `http://${_host}:${String(port)}${path}`;
}

/**
 * Rewrite WebSocket URLs returned by the browser to use the configured host.
 * Browsers always report ws://127.0.0.1:... regardless of how we connect.
 */
function rewriteTargetUrls(target: TargetInfo): TargetInfo {
  if (_host === "127.0.0.1" || _host === "localhost") return target;
  const rewrite = (url?: string): string | undefined =>
    url?.replace(/ws:\/\/(127\.0\.0\.1|localhost):/, `ws://${_host}:`);
  return {
    ...target,
    webSocketDebuggerUrl: rewrite(target.webSocketDebuggerUrl),
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers (Chrome DevTools HTTP API)
// ---------------------------------------------------------------------------

export async function listTargets(port: number): Promise<TargetInfo[]> {
  const res = await fetch(cdpUrl(port, "/json"));
  const decoded: unknown = await res.json();
  if (!Array.isArray(decoded)) throw new Error("CDP target list response is invalid.");
  const targets = decoded.map(targetInfo);
  if (targets.some((target) => target === undefined)) {
    throw new Error("CDP target list contains an invalid target.");
  }
  return targets
    .filter((target): target is TargetInfo => target !== undefined)
    .map(rewriteTargetUrls);
}

export async function getPageTargets(port: number): Promise<TargetInfo[]> {
  const targets = await listTargets(port);
  return targets.filter((t) => t.type === "page");
}

export async function createTarget(port: number, url = "about:blank"): Promise<TargetInfo> {
  const res = await fetch(cdpUrl(port, `/json/new?${encodeURIComponent(url)}`), { method: "PUT" });
  const target = targetInfo(await res.json());
  if (!target) throw new Error("CDP create-target response is invalid.");
  return rewriteTargetUrls(target);
}

export async function closeTarget(port: number, targetId: string): Promise<void> {
  await fetch(cdpUrl(port, `/json/close/${targetId}`));
}

export async function activateTarget(port: number, targetId: string): Promise<void> {
  await fetch(cdpUrl(port, `/json/activate/${targetId}`));
}

/** Check browser version — works with remote hosts. */
export async function getVersion(port: number): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(cdpUrl(port, "/json/version"));
    const decoded: unknown = await res.json();
    return isRecord(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CDP WebSocket Client
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 30_000;

export class CDPClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventHandlers = new Map<string, EventHandler[]>();
  private _connected = false;

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Connect to a page target's CDP WebSocket endpoint.
   */
  async connect(wsUrl: string, timeout = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`CDP connection timed out after ${String(timeout)}ms`));
      }, timeout);

      const ws = new WebSocket(wsUrl);

      ws.addEventListener("open", () => {
        clearTimeout(timer);
        this._connected = true;
        resolve();
      });

      ws.addEventListener("error", (event) => {
        clearTimeout(timer);
        // WebSocket ErrorEvent doesn't expose message in Node's implementation
        const message: unknown = Reflect.get(event, "message");
        reject(
          new Error(
            `CDP WebSocket error: ${typeof message === "string" ? message : "connection failed"}`,
          ),
        );
      });

      ws.addEventListener("close", () => {
        this._connected = false;
        // Reject all pending requests
        for (const [, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error("WebSocket closed"));
        }
        this.pending.clear();
      });

      ws.addEventListener("message", (event) => {
        this.handleMessage(String(event.data));
      });

      this.ws = ws;
    });
  }

  /**
   * Send a CDP command and wait for the response.
   */
  async send(
    method: string,
    params?: Record<string, unknown>,
    timeout = DEFAULT_TIMEOUT,
  ): Promise<unknown> {
    if (!this.ws || !this._connected) {
      throw new Error("Not connected to CDP");
    }

    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command "${method}" timed out after ${String(timeout)}ms`));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });

      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Register a handler for a CDP event (e.g., 'Page.loadEventFired').
   */
  on(method: string, handler: EventHandler): void {
    const handlers = this.eventHandlers.get(method) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(method, handlers);
  }

  /**
   * Wait for a specific CDP event to fire.
   */
  async waitForEvent(method: string, timeout = DEFAULT_TIMEOUT): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for event "${method}"`));
      }, timeout);

      const handler: EventHandler = (params) => {
        clearTimeout(timer);
        // Remove this one-shot handler
        const handlers = this.eventHandlers.get(method);
        if (handlers) {
          const idx = handlers.indexOf(handler);
          if (idx >= 0) handlers.splice(idx, 1);
        }
        resolve(params);
      };

      this.on(method, handler);
    });
  }

  /**
   * Close the WebSocket connection.
   */
  async close(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this._connected = false;
    }
  }

  private handleMessage(raw: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    const msg = cdpMessage(decoded);
    if (!msg) return;

    // Response to a command
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);

      if (msg.error) {
        pending.reject(
          new Error(`CDP error: ${msg.error.message} (code ${String(msg.error.code)})`),
        );
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Event
    if (msg.method) {
      const handlers = this.eventHandlers.get(msg.method);
      if (handlers) {
        for (const handler of handlers) {
          handler(msg.params ?? {});
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// High-level helper: connect to the first available page
// ---------------------------------------------------------------------------

export async function connectToActivePage(
  port: number,
  targetId?: string,
): Promise<{ client: CDPClient; target: TargetInfo }> {
  if (targetId) {
    // Resolve a specific target by exact or prefix match (searches ALL types)
    const allTargets = await listTargets(port);
    let target = allTargets.find((t) => t.id === targetId);
    if (!target) {
      const lower = targetId.toLowerCase();
      const matches = allTargets.filter((t) => t.id.toLowerCase().startsWith(lower));
      if (matches.length === 1) {
        target = matches[0];
      } else if (matches.length > 1) {
        throw new Error(
          `Ambiguous target prefix "${targetId}" matches ${String(matches.length)} targets. Use a longer prefix or the full ID.`,
        );
      }
    }
    if (!target) {
      const available = allTargets.map((t) => `  ${t.id} [${t.type}] ${t.title}`).join("\n");
      throw new Error(`Target not found: ${targetId}\n\nAvailable targets:\n${available}`);
    }
    if (!target.webSocketDebuggerUrl) {
      throw new Error(
        `Target "${target.title}" has no WebSocket URL — it may already be attached by DevTools`,
      );
    }
    const client = new CDPClient();
    await client.connect(target.webSocketDebuggerUrl);
    if (target.type === "page") {
      await client.send("Page.enable");
    }
    await client.send("Runtime.enable");
    return { client, target };
  }

  const pages = await getPageTargets(port);
  if (pages.length === 0) {
    // Create a new tab if none exists
    const newTarget = await createTarget(port);
    const client = new CDPClient();
    if (!newTarget.webSocketDebuggerUrl) {
      throw new Error("New target has no WebSocket URL");
    }
    await client.connect(newTarget.webSocketDebuggerUrl);
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    return { client, target: newTarget };
  }

  const target = pages[0];
  if (!target.webSocketDebuggerUrl) {
    throw new Error(
      `Target "${target.title}" has no WebSocket URL — it may already be attached by DevTools`,
    );
  }

  const client = new CDPClient();
  await client.connect(target.webSocketDebuggerUrl);
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  return { client, target };
}
