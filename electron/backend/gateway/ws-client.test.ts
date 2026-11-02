/**
 * Unit tests for GatewayWsClient.
 *
 * Mocks the `ws` module with a controllable EventEmitter-based stub so tests
 * can drive the handshake, inject server messages, and verify behaviour without
 * opening a real network connection.
 */

import type { EventEmitter } from "events";

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ── Shared mutable state (hoisted so the vi.mock factory can reference it) ────
//
// vi.hoisted() runs before any imports and before vi.mock() factories. The
// returned object is the single shared reference that both the factory and the
// test code use to hand off the latest MockWebSocket instance.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- EventEmitter's own overload signature
type RemoveAllListenersFn = (event?: string | symbol) => any;

type MockWsLike = EventEmitter & {
  readyState: number;
  send: ReturnType<typeof vi.fn<(data: string) => void>>;
  close: ReturnType<typeof vi.fn<() => void>>;
  ping: ReturnType<typeof vi.fn<() => void>>;
  terminate: ReturnType<typeof vi.fn<() => void>>;
  removeAllListeners: ReturnType<typeof vi.fn<RemoveAllListenersFn>>;
};

const mockWsRef = vi.hoisted<{ instance: MockWsLike | null }>(() => ({ instance: null }));

// ── Mock: ws ──────────────────────────────────────────────────────────────────

vi.mock("ws", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-type-assertion -- CJS require in mock factory; runtime always returns EventEmitter
  const EE = (require("events") as { EventEmitter: new () => EventEmitter }).EventEmitter;

  function makeMockWs(): MockWsLike {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- widening EventEmitter to MockWsLike to attach typed vi.fn properties below
    const ws = new EE() as MockWsLike;
    ws.readyState = 1; // WebSocket.OPEN
    ws.send = vi.fn<(data: string) => void>();
    ws.close = vi.fn<() => void>();
    ws.ping = vi.fn<() => void>();
    ws.terminate = vi.fn<() => void>();
    // Delegate to real EventEmitter so listener bookkeeping still works.
    ws.removeAllListeners = vi.fn<RemoveAllListenersFn>().mockImplementation(function (
      event?: string | symbol,
    ) {
      EE.prototype.removeAllListeners.call(ws, event);
      return ws;
    });
    mockWsRef.instance = ws;
    return ws;
  }

  const WS = vi.fn<(url: string, opts: unknown) => MockWsLike>().mockImplementation(makeMockWs);
  // Expose the static OPEN constant read by GatewayWsClient via WebSocket.OPEN.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- attaching static property to the mock constructor function
  (WS as unknown as { OPEN: number }).OPEN = 1;

  return {
    default: WS,
    WebSocket: { OPEN: 1 },
  };
});

// ── Mock: gateway-device-identity ────────────────────────────────────────────

vi.mock("./device-identity", () => ({
  signChallenge: vi
    .fn<
      () => {
        deviceId: string;
        publicKeyBase64url: string;
        signatureBase64url: string;
        signedAt: number;
      }
    >()
    .mockReturnValue({
      deviceId: "test-device-id",
      publicKeyBase64url: "test-public-key",
      signatureBase64url: "test-signature",
      signedAt: 1234567890,
    }),
  // ws-client.ts now imports the role constants from device-identity. The
  // mock has to surface them too — the values themselves don't matter for
  // these tests since the connect-handshake mock observes the wire payload
  // built from `roleConfig`, not the signed challenge contents.
  OPERATOR_ROLE: "operator",
  OPERATOR_SCOPES: ["operator.read", "operator.write", "operator.admin", "operator.approvals"],
  NODE_ROLE: "node",
  NODE_SCOPES: [],
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  GatewayWsClient,
  GatewayPairingRequiredError,
  GatewayProtocolError,
  GatewayRpcError,
} from "./ws-client";
import type { GatewayWsClientConfig } from "./ws-client";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Stub KeyObject — signChallenge is fully mocked so privateKey is never used. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- empty stub; module-level mock ensures it's never passed to real crypto
const STUB_PRIVATE_KEY = {} as import("crypto").KeyObject;

function makeConfig(overrides: Partial<GatewayWsClientConfig> = {}): GatewayWsClientConfig {
  return {
    url: "wss://gateway.example.com",
    gatewayToken: "tok_test",
    deviceIdentity: {
      deviceId: "test-device-id",
      publicKeyBase64url: "test-public-key",
      privateKey: STUB_PRIVATE_KEY,
    },
    rpcTimeoutMs: 100, // very short so timeout tests don't block
    challengeTimeoutMs: 100, // ditto for the dedicated handshake timeout
    ...overrides,
  };
}

/** Encode a value as a UTF-8 JSON Buffer — matches what a real ws server sends. */
function toMsg(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj));
}

/** Get the current mock WebSocket instance (created when connect() calls new WebSocket(…)). */
function getWs(): MockWsLike {
  if (!mockWsRef.instance) {
    throw new Error("MockWebSocket not yet created — was connect() called?");
  }
  return mockWsRef.instance;
}

/** Simulate server sending a connect.challenge event. */
function sendChallenge(ws: MockWsLike, nonce = "test-nonce", ts = 1234567890): void {
  ws.emit("message", toMsg({ type: "event", event: "connect.challenge", payload: { nonce, ts } }));
}

/** Simulate server sending a connect response for the given request ID. */
function sendConnectResponse(
  ws: MockWsLike,
  connectId: string,
  ok = true,
  error?: { message: string; code: string; details?: Record<string, unknown> },
  payload?: Record<string, unknown>,
): void {
  const resp: Record<string, unknown> = { type: "res", id: connectId, ok };
  if (error) resp["error"] = error;
  if (payload) resp["payload"] = payload;
  ws.emit("message", toMsg(resp));
}

interface WireReq {
  id: string;
  type: string;
  method: string;
  params: Record<string, unknown>;
}

/** Extract the id field from the last JSON string sent via ws.send. */
function lastSentId(ws: MockWsLike): string {
  const raw: string = ws.send.mock.calls.at(-1)?.[0] ?? "{}";
  const parsed: unknown = JSON.parse(raw);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON-parsed test wire message with known shape
  return (parsed as WireReq).id;
}

/** Parse the last JSON string sent via ws.send as a WireReq. */
function lastSentReq(ws: MockWsLike): WireReq {
  const raw: string = ws.send.mock.calls.at(-1)?.[0] ?? "{}";
  const parsed: unknown = JSON.parse(raw);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON-parsed test wire message with known shape
  return parsed as WireReq;
}

/**
 * Drive the full connect handshake and return the connect() promise.
 *
 * Sequence:
 *  1. Start client.connect() — synchronously creates the WebSocket.
 *  2. Emit "open" — triggers waitForChallenge().
 *  3. Emit the challenge message — triggers signChallenge() + sendConnectRequest().
 *  4. Emit the connect response — resolves waitForConnectResponse().
 */
async function performHandshake(
  client: GatewayWsClient,
  opts: {
    ok?: boolean;
    error?: { message: string; code: string; details?: Record<string, unknown> };
    payload?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const connectPromise = client.connect();
  await Promise.resolve();

  const ws = getWs();
  ws.emit("open");
  await Promise.resolve();

  sendChallenge(ws);
  await Promise.resolve();

  const connectId = lastSentId(ws);
  sendConnectResponse(ws, connectId, opts.ok ?? true, opts.error, opts.payload);

  return connectPromise;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GatewayWsClient", () => {
  let client: GatewayWsClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWsRef.instance = null;
    client = new GatewayWsClient(makeConfig());
  });

  afterEach(() => {
    vi.useRealTimers();
    try {
      client.close();
    } catch {
      // ignore — may already be closed or never connected
    }
  });

  // ── Handshake ─────────────────────────────────────────────────────────────

  describe("connect()", () => {
    it("completes successfully with a valid challenge-response sequence", async () => {
      await expect(performHandshake(client)).resolves.toBeUndefined();
      expect(client.isConnected()).toBe(true);
      expect(client.getExecutionCapabilities()).toMatchObject({
        version: 0,
        maxConcurrentRuns: 1,
      });
    });

    it("accepts explicit execution-v1 guarantees from the connect response", async () => {
      await performHandshake(client, {
        payload: {
          capabilities: {
            execution: {
              version: 1,
              maxConcurrentRuns: 100,
              runCorrelation: "runId",
              cancellation: "runId",
              idempotency: "idempotencyKey",
              eventSequence: "seq",
              startAck: "before-events",
            },
          },
        },
      });

      expect(client.getExecutionCapabilities()).toEqual({
        version: 1,
        maxConcurrentRuns: 100,
        runCorrelation: "runId",
        cancellation: "runId",
        idempotency: "idempotencyKey",
        eventSequence: "seq",
        startAck: "before-events",
      });
    });

    it("falls back to one run when an execution capability claim is incomplete", async () => {
      await performHandshake(client, {
        payload: {
          capabilities: {
            execution: {
              version: 1,
              maxConcurrentRuns: 100,
              runCorrelation: "runId",
              cancellation: "session",
              idempotency: "idempotencyKey",
              eventSequence: "seq",
              startAck: "before-events",
            },
          },
        },
      });

      expect(client.getExecutionCapabilities()).toMatchObject({
        version: 0,
        maxConcurrentRuns: 1,
      });
    });

    it("sends a connect request containing the nonce from the challenge", async () => {
      const connectPromise = client.connect();
      await Promise.resolve();

      const ws = getWs();
      ws.emit("open");
      await Promise.resolve();

      sendChallenge(ws, "nonce-abc", 9999);
      await Promise.resolve();

      const req = lastSentReq(ws);
      expect(req.type).toBe("req");
      expect(req.method).toBe("connect");
      const device = req.params["device"];
      const nonce =
        typeof device === "object" && device !== null
          ? (device as Record<string, unknown>)["nonce"] // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrowed: typeof+null check above
          : undefined;
      expect(nonce).toBe("nonce-abc");

      sendConnectResponse(ws, req.id, true);
      await connectPromise;
    });

    it("defaults to role:operator + operator scopes when no roleConfig is supplied (back-compat)", async () => {
      const connectPromise = client.connect();
      await Promise.resolve();
      const ws = getWs();
      ws.emit("open");
      await Promise.resolve();
      sendChallenge(ws);
      await Promise.resolve();

      const req = lastSentReq(ws);
      expect(req.params["role"]).toBe("operator");
      expect(req.params["scopes"]).toEqual([
        "operator.read",
        "operator.write",
        "operator.admin",
        "operator.approvals",
      ]);
      // operator connection MUST NOT carry a `commands` field — the gateway
      // schema rejects unknown keys for the operator role on some versions.
      expect("commands" in req.params).toBe(false);
      const client0 = req.params["client"];
      const mode =
        typeof client0 === "object" && client0 !== null
          ? (client0 as Record<string, unknown>)["mode"] // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrowed via typeof+null
          : undefined;
      expect(mode).toBe("backend");

      sendConnectResponse(ws, req.id, true);
      await connectPromise;
    });

    it("declares the tool-events capability in the connect payload so the gateway forwards tool stream events", async () => {
      const connectPromise = client.connect();
      await Promise.resolve();
      const ws = getWs();
      ws.emit("open");
      await Promise.resolve();
      sendChallenge(ws);
      await Promise.resolve();

      const req = lastSentReq(ws);
      expect(req.params["caps"]).toEqual(["tool-events"]);

      sendConnectResponse(ws, req.id, true);
      await connectPromise;
    });

    it("uses role:node with empty scopes, client.mode='node', and the supplied commands when constructed with a node roleConfig", async () => {
      const nodeClient = new GatewayWsClient(
        makeConfig({
          roleConfig: {
            role: "node",
            scopes: [],
            clientMode: "node",
            commands: ["mcp.fs.read_file", "mcp.fs.list_directory"],
          },
        }),
      );
      const connectPromise = nodeClient.connect();
      await Promise.resolve();
      const ws = getWs();
      ws.emit("open");
      await Promise.resolve();
      sendChallenge(ws);
      await Promise.resolve();

      const req = lastSentReq(ws);
      expect(req.params["role"]).toBe("node");
      expect(req.params["scopes"]).toEqual([]);
      expect(req.params["commands"]).toEqual(["mcp.fs.read_file", "mcp.fs.list_directory"]);
      // Node-role connects don't process `agent` stream events, so they must
      // NOT declare tool-events — the gateway rejects unknown caps on some
      // versions, and there's no consumer for the events anyway.
      expect("caps" in req.params).toBe(false);
      const client0 = req.params["client"];
      const mode =
        typeof client0 === "object" && client0 !== null
          ? (client0 as Record<string, unknown>)["mode"] // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrowed via typeof+null
          : undefined;
      expect(mode).toBe("node");

      sendConnectResponse(ws, req.id, true);
      await connectPromise;
      nodeClient.close();
    });

    it("includes client.displayName in the connect payload when nodeRoleConfig is given a displayName", async () => {
      const { nodeRoleConfig } = await import("./ws-client");
      const nodeClient = new GatewayWsClient(
        makeConfig({ roleConfig: nodeRoleConfig(["mcp.help"], "My Node") }),
      );
      const connectPromise = nodeClient.connect();
      await Promise.resolve();
      const ws = getWs();
      ws.emit("open");
      await Promise.resolve();
      sendChallenge(ws);
      await Promise.resolve();

      const req = lastSentReq(ws);
      const client0 = req.params["client"];
      const displayName =
        typeof client0 === "object" && client0 !== null
          ? (client0 as Record<string, unknown>)["displayName"] // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrowed via typeof+null
          : undefined;
      expect(displayName).toBe("My Node");

      sendConnectResponse(ws, req.id, true);
      await connectPromise;
      nodeClient.close();
    });

    it("rejects on timeout when the challenge never arrives", async () => {
      vi.useFakeTimers();

      const connectPromise = client.connect();
      await Promise.resolve();

      const ws = getWs();
      ws.emit("open");
      await Promise.resolve();

      vi.advanceTimersByTime(200);

      await expect(connectPromise).rejects.toThrow(/timed out waiting for challenge/);
      expect(ws.terminate).toHaveBeenCalled();
    });

    it("rejects when server returns ok: false on the connect response", async () => {
      await expect(
        performHandshake(client, {
          ok: false,
          error: { message: "invalid credentials", code: "auth_error" },
        }),
      ).rejects.toThrow(/invalid credentials/);
    });

    it("throws GatewayPairingRequiredError when server responds NOT_PAIRED + PAIRING_REQUIRED with a requestId", async () => {
      const error = await performHandshake(client, {
        ok: false,
        error: {
          message: "pairing required",
          code: "NOT_PAIRED",
          details: {
            code: "PAIRING_REQUIRED",
            requestId: "7a141b3b-78b1-4966-b5dc-e1c98d9cd53d",
            reason: "not-paired",
          },
        },
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(GatewayPairingRequiredError);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- asserted instanceof above
      expect((error as GatewayPairingRequiredError).requestId).toBe(
        "7a141b3b-78b1-4966-b5dc-e1c98d9cd53d",
      );
    });

    it("falls back to a generic Error when NOT_PAIRED is returned without a details.requestId", async () => {
      // Defensive: a malformed runtime response shouldn't be silently treated
      // as pairing-required without a handle to wait on.
      await expect(
        performHandshake(client, {
          ok: false,
          error: { message: "pairing required", code: "NOT_PAIRED" },
        }),
      ).rejects.toThrow(/Connect failed.*pairing required/);
    });

    it("fires connecting → connected state changes during a successful handshake", async () => {
      const states: string[] = [];
      client.onStateChange((s) => states.push(s));

      await performHandshake(client);

      expect(states).toEqual(["connecting", "connected"]);
    });

    it("ignores non-challenge messages during challenge wait and eventually times out", async () => {
      vi.useFakeTimers();

      const connectPromise = client.connect();
      await Promise.resolve();

      const ws = getWs();
      ws.emit("open");
      await Promise.resolve();

      ws.emit("message", toMsg({ type: "event", event: "some.other.event", payload: {} }));

      vi.advanceTimersByTime(200);

      await expect(connectPromise).rejects.toThrow(/timed out waiting for challenge/);
    });

    it("includes the last unexpected handshake message in the timeout error", async () => {
      // Without this, debugging a wedged proxy means turning on debug logging
      // and re-running. The most common cause is the runtime sending events
      // we don't expect, and we already see them — surfacing the most recent
      // one in the rejection turns one debug session into one log line.
      vi.useFakeTimers();
      const connectPromise = client.connect();
      await Promise.resolve();
      const ws = getWs();
      ws.emit("open");
      await Promise.resolve();
      ws.emit("message", toMsg({ type: "event", event: "ready", payload: {} }));
      vi.advanceTimersByTime(200);
      await expect(connectPromise).rejects.toThrow(/last unexpected message:.*event=ready/);
    });

    it("notes 'no messages received' when the timeout fires before any message arrives", async () => {
      vi.useFakeTimers();
      const connectPromise = client.connect();
      await Promise.resolve();
      const ws = getWs();
      ws.emit("open");
      await Promise.resolve();
      vi.advanceTimersByTime(200);
      await expect(connectPromise).rejects.toThrow(/no messages received before deadline/);
    });

    it("enriches a 403 from a localhost URL with the MARSHAL_GATEWAY_URL override hint", async () => {
      // The 0.21.x default of `ws://localhost:18789` was changed to
      // `ws://localhost:8001/v1/marshal-gateway` in this branch. Anyone
      // running the bare gateway on 18789 silently breaks; we surface the
      // override env var explicitly rather than letting them dig through
      // the diff.
      const localClient = new GatewayWsClient(
        makeConfig({ url: "ws://localhost:8001/v1/marshal-gateway" }),
      );
      const connectPromise = localClient.connect();
      await Promise.resolve();
      const ws = getWs();
      ws.emit("error", new Error("Unexpected server response: 403"));
      await expect(connectPromise).rejects.toThrow(/MARSHAL_GATEWAY_URL=ws:\/\/localhost:18789/);
    });

    it("does not enrich a 403 from a non-localhost URL", async () => {
      // Only the local-default change risks this miscofiguration; a 403
      // from the hosted runtime means something else and shouldn't be
      // misattributed to the MARSHAL_GATEWAY_URL hint.
      const remoteClient = new GatewayWsClient(
        makeConfig({ url: "wss://mcsaetherruntime.example.com/v1/marshal-gateway" }),
      );
      const connectPromise = remoteClient.connect();
      await Promise.resolve();
      const ws = getWs();
      ws.emit("error", new Error("Unexpected server response: 403"));
      await expect(connectPromise).rejects.toThrow(/Unexpected server response: 403/);
      await expect(connectPromise).rejects.not.toThrow(/MARSHAL_GATEWAY_URL/);
    });
  });

  // ── RPC ───────────────────────────────────────────────────────────────────

  describe("request()", () => {
    beforeEach(async () => {
      await performHandshake(client);
    });

    it("resolves with the response payload when server responds ok: true", async () => {
      const ws = getWs();
      const reqPromise = client.request("session.list", {});

      await Promise.resolve();

      const req = lastSentReq(ws);
      expect(req.type).toBe("req");
      expect(req.method).toBe("session.list");

      ws.emit(
        "message",
        toMsg({ type: "res", id: req.id, ok: true, payload: { sessions: ["s1", "s2"] } }),
      );

      await expect(reqPromise).resolves.toEqual({ sessions: ["s1", "s2"] });
    });

    it("rejects when server responds ok: false", async () => {
      const ws = getWs();
      const reqPromise = client.request("session.delete", { id: "s1" });

      await Promise.resolve();

      const reqId = lastSentId(ws);

      ws.emit(
        "message",
        toMsg({
          type: "res",
          id: reqId,
          ok: false,
          error: { message: "not found", code: "not_found" },
        }),
      );

      await expect(reqPromise).rejects.toThrow(/not found/);
    });

    it("rejects ok:false with a GatewayRpcError that preserves code, message, and details", async () => {
      const ws = getWs();
      const reqPromise = client.request("session.delete", { id: "s1" });

      await Promise.resolve();

      const reqId = lastSentId(ws);
      const details = { reason: "missing-row" };
      ws.emit(
        "message",
        toMsg({
          type: "res",
          id: reqId,
          ok: false,
          error: { message: "not found", code: "not_found", details },
        }),
      );

      const err = await reqPromise.then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(err).toBeInstanceOf(GatewayRpcError);
      if (!(err instanceof GatewayRpcError)) throw new Error("expected GatewayRpcError");
      expect(err.code).toBe("not_found");
      expect(err.details).toEqual(details);
      expect(err.message).toContain("not found");
    });

    it("delays and retries rate-limited responses using retryAfterMs metadata", async () => {
      vi.useFakeTimers();
      const ws = getWs();
      const reqPromise = client.request("node.invoke.result", { id: "inv-1" });

      await Promise.resolve();

      const firstReq = lastSentReq(ws);
      ws.emit(
        "message",
        toMsg({
          type: "res",
          id: firstReq.id,
          ok: false,
          error: {
            message: "Too many requests",
            code: "rate_limited",
            details: { retryAfterMs: 750 },
          },
        }),
      );
      await Promise.resolve();

      const sendsAfterThrottle = ws.send.mock.calls.length;
      vi.advanceTimersByTime(749);
      await Promise.resolve();
      expect(ws.send.mock.calls).toHaveLength(sendsAfterThrottle);

      vi.advanceTimersByTime(1);
      await Promise.resolve();

      expect(ws.send.mock.calls.length).toBeGreaterThan(sendsAfterThrottle);
      const retryReq = lastSentReq(ws);
      expect(retryReq.id).not.toBe(firstReq.id);
      ws.emit(
        "message",
        toMsg({ type: "res", id: retryReq.id, ok: true, payload: { accepted: true } }),
      );

      await expect(reqPromise).resolves.toEqual({ accepted: true });
    });

    it("uses capped exponential backoff and surfaces a terminal error after rate-limit retry exhaustion", async () => {
      vi.useFakeTimers();
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      const ws = getWs();
      const reqPromise = client.request("node.invoke.result", { id: "inv-1" });

      await Promise.resolve();

      const expectedDelays = [500, 1000, 2000];
      for (const delay of expectedDelays) {
        const req = lastSentReq(ws);
        ws.emit(
          "message",
          toMsg({
            type: "res",
            id: req.id,
            ok: false,
            error: { message: "throttled", code: "throttled" },
          }),
        );
        await Promise.resolve(); // oxlint-disable-line no-await-in-loop -- each retry is scheduled by the previous response
        const sendsAfterThrottle = ws.send.mock.calls.length;
        vi.advanceTimersByTime(delay - 1);
        await Promise.resolve(); // oxlint-disable-line no-await-in-loop -- flush the current backoff boundary before asserting
        expect(ws.send.mock.calls).toHaveLength(sendsAfterThrottle);
        vi.advanceTimersByTime(1);
        await Promise.resolve(); // oxlint-disable-line no-await-in-loop -- flush the newly scheduled retry before the next response
        expect(ws.send.mock.calls.length).toBeGreaterThan(sendsAfterThrottle);
      }

      const finalReq = lastSentReq(ws);
      ws.emit(
        "message",
        toMsg({
          type: "res",
          id: finalReq.id,
          ok: false,
          error: { message: "throttled", code: "throttled" },
        }),
      );

      await expect(reqPromise).rejects.toThrow(/rate limit retry budget exhausted/i);
      randomSpy.mockRestore();
    });

    it("rejects on timeout", async () => {
      vi.useFakeTimers();

      const reqPromise = client.request("slow.method", {});

      vi.advanceTimersByTime(200);

      await expect(reqPromise).rejects.toThrow(/timed out.*slow\.method/);
    });

    it("rejects immediately when not connected", async () => {
      const disconnectedClient = new GatewayWsClient(makeConfig());
      await expect(disconnectedClient.request("any.method", {})).rejects.toThrow(/Not connected/);
    });

    it("resolves with empty object when server sends ok: true without a payload", async () => {
      const ws = getWs();
      const reqPromise = client.request("ping", {});

      await Promise.resolve();

      const reqId = lastSentId(ws);
      ws.emit("message", toMsg({ type: "res", id: reqId, ok: true }));

      await expect(reqPromise).resolves.toEqual({});
    });
  });

  // ── Events ────────────────────────────────────────────────────────────────

  describe("onEvent()", () => {
    beforeEach(async () => {
      await performHandshake(client);
    });

    it("listener receives server-push events", () => {
      const received: Array<[string, Record<string, unknown>]> = [];
      client.onEvent((name, payload) => received.push([name, payload]));

      getWs().emit(
        "message",
        toMsg({ type: "event", event: "session.created", payload: { id: "s1" } }),
      );

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(["session.created", { id: "s1" }]);
    });

    it("unsubscribe stops event delivery", () => {
      const received: string[] = [];
      const unsub = client.onEvent((name) => received.push(name));

      getWs().emit("message", toMsg({ type: "event", event: "first.event", payload: {} }));

      unsub();

      getWs().emit("message", toMsg({ type: "event", event: "second.event", payload: {} }));

      expect(received).toEqual(["first.event"]);
    });

    it("multiple listeners all receive the same event", () => {
      const calls: string[] = [];
      client.onEvent((name) => calls.push(`A:${name}`));
      client.onEvent((name) => calls.push(`B:${name}`));

      getWs().emit("message", toMsg({ type: "event", event: "broadcast", payload: {} }));

      expect(calls).toContain("A:broadcast");
      expect(calls).toContain("B:broadcast");
    });

    it("malformed JSON on the wire doesn't crash or deliver an event", () => {
      const received: string[] = [];
      client.onEvent((name) => received.push(name));

      // Fire a bogus, non-JSON message. Must not throw and must not call the listener.
      expect(() => {
        getWs().emit("message", Buffer.from("{not valid json"));
      }).not.toThrow();
      expect(received).toHaveLength(0);

      // Client is still alive: a well-formed message after the bad one still works.
      getWs().emit("message", toMsg({ type: "event", event: "after.bad", payload: { ok: true } }));
      expect(received).toEqual(["after.bad"]);
    });
  });

  // ── Connection state ──────────────────────────────────────────────────────

  describe("onStateChange()", () => {
    it("fires disconnected when the socket closes after a successful connect", async () => {
      const states: string[] = [];
      client.onStateChange((s) => states.push(s));

      await performHandshake(client);

      getWs().emit("close", 1000, Buffer.from("normal"));

      expect(states).toContain("disconnected");
    });

    it("unsubscribe stops new state notifications after some have already fired", async () => {
      const states: string[] = [];
      const unsub = client.onStateChange((s) => states.push(s));

      // First emit a state change WITH the subscription active.
      await performHandshake(client);
      const countAfterHandshake = states.length;
      expect(countAfterHandshake).toBeGreaterThan(0);

      // Unsubscribe, then force more state changes. None should reach us.
      unsub();
      getWs().emit("close", 1000, Buffer.from(""));
      expect(states).toHaveLength(countAfterHandshake);
    });

    it("handles ws 'error' events post-handshake without crashing", async () => {
      await performHandshake(client);

      // In Node, an 'error' event on an EventEmitter with no listener crashes
      // the process. The `ws` library fires 'error' before 'close' on
      // abnormal disconnects (ECONNRESET, TLS failures) — this test verifies
      // our post-handshake error listener is attached.
      expect(() => {
        getWs().emit("error", new Error("ECONNRESET"));
      }).not.toThrow();
    });
  });

  describe("isConnected()", () => {
    it("returns true after a successful handshake", async () => {
      await performHandshake(client);
      expect(client.isConnected()).toBe(true);
    });

    it("returns false before connect() is called", () => {
      expect(client.isConnected()).toBe(false);
    });

    it("returns false after the socket closes", async () => {
      await performHandshake(client);
      getWs().emit("close", 1000, Buffer.from(""));
      expect(client.isConnected()).toBe(false);
    });

    it("returns false after close() is called", async () => {
      await performHandshake(client);
      client.close();
      expect(client.isConnected()).toBe(false);
    });
  });

  // ── Keepalive ─────────────────────────────────────────────────────────────

  describe("ping interval", () => {
    it("sends a ping every 30 seconds after connect", async () => {
      vi.useFakeTimers();

      const connectPromise = client.connect();
      await Promise.resolve();

      const ws = getWs();
      ws.emit("open");
      await Promise.resolve();

      sendChallenge(ws);
      await Promise.resolve();

      const connectId = lastSentId(ws);
      sendConnectResponse(ws, connectId, true);
      await connectPromise;

      expect(ws.ping).not.toHaveBeenCalled();

      vi.advanceTimersByTime(30_000);
      expect(ws.ping).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(30_000);
      expect(ws.ping).toHaveBeenCalledTimes(2);
    });

    it("stops pinging after close()", async () => {
      vi.useFakeTimers();

      const connectPromise = client.connect();
      await Promise.resolve();

      const ws = getWs();
      ws.emit("open");
      await Promise.resolve();

      sendChallenge(ws);
      await Promise.resolve();

      const connectId = lastSentId(ws);
      sendConnectResponse(ws, connectId, true);
      await connectPromise;

      client.close();

      vi.advanceTimersByTime(60_000);
      expect(ws.ping).not.toHaveBeenCalled();
    });
  });

  // ── Close ─────────────────────────────────────────────────────────────────

  describe("close()", () => {
    it("rejects all pending requests with a descriptive error", async () => {
      await performHandshake(client);

      const req1 = client.request("method.one", {});
      const req2 = client.request("method.two", {});
      await Promise.resolve();

      client.close();

      await expect(req1).rejects.toThrow(/Client closed/);
      await expect(req2).rejects.toThrow(/Client closed/);
    });

    it("emits disconnected state when close() is called", async () => {
      await performHandshake(client);

      const states: string[] = [];
      client.onStateChange((s) => states.push(s));

      client.close();

      expect(states).toContain("disconnected");
    });

    it("calls ws.close() on the underlying socket", async () => {
      await performHandshake(client);
      const ws = getWs();

      client.close();

      expect(ws.close).toHaveBeenCalled();
    });

    it("rejects pending requests when the server closes the connection", async () => {
      await performHandshake(client);

      const reqPromise = client.request("some.method", {});
      await Promise.resolve();

      getWs().emit("close", 1001, Buffer.from("going away"));

      await expect(reqPromise).rejects.toThrow(/Connection closed/);
    });
  });

  // ── Auth header ───────────────────────────────────────────────────────────

  describe("authToken config", () => {
    it("passes Authorization header when authToken is provided", async () => {
      vi.clearAllMocks();
      mockWsRef.instance = null;

      const wsModule = await import("ws");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- accessing vi.fn mock internals; WS is the mock constructor registered above
      const WS = wsModule.default as unknown as ReturnType<
        typeof vi.fn<(url: string, opts: unknown) => MockWsLike>
      >;

      const authedClient = new GatewayWsClient(makeConfig({ authToken: "bearer-token-xyz" }));
      const connectPromise = authedClient.connect();
      await Promise.resolve();

      const [, rawOpts] = WS.mock.calls[0] ?? [];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- known shape: createWebSocket() passes { headers } as the second arg
      const options = rawOpts as { headers?: Record<string, string> };
      expect(options?.headers?.["Authorization"]).toBe("Bearer bearer-token-xyz");

      getWs().emit("error", new Error("test cleanup"));
      await expect(connectPromise).rejects.toThrow("test cleanup");
      try {
        authedClient.close();
      } catch {
        // ignore
      }
    });

    it("sends no Authorization header when authToken is omitted", async () => {
      vi.clearAllMocks();
      mockWsRef.instance = null;

      const wsModule = await import("ws");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- accessing vi.fn mock internals; WS is the mock constructor registered above
      const WS = wsModule.default as unknown as ReturnType<
        typeof vi.fn<(url: string, opts: unknown) => MockWsLike>
      >;

      const noAuthClient = new GatewayWsClient(makeConfig());
      const connectPromise = noAuthClient.connect();
      await Promise.resolve();

      const [, rawOpts] = WS.mock.calls[0] ?? [];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- known shape: createWebSocket() passes { headers } as the second arg
      const options = rawOpts as { headers?: Record<string, string> };
      expect(options?.headers?.["Authorization"]).toBeUndefined();

      getWs().emit("error", new Error("test cleanup"));
      await expect(connectPromise).rejects.toThrow("test cleanup");
      try {
        noAuthClient.close();
      } catch {
        // ignore
      }
    });
  });

  describe("error types", () => {
    it("GatewayProtocolError carries the method and raw payload", () => {
      const err = new GatewayProtocolError("sessions.list", { unexpected: true });
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("GatewayProtocolError");
      expect(err.method).toBe("sessions.list");
      expect(err.rawPayload).toEqual({ unexpected: true });
      expect(err.message).toMatch(/sessions\.list/);
    });

    it("GatewayRpcError carries code + message", () => {
      const err = new GatewayRpcError("sessions.delete", "locked", "session is locked");
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("GatewayRpcError");
      expect(err.method).toBe("sessions.delete");
      expect(err.code).toBe("locked");
      expect(err.message).toMatch(/session is locked/);
    });
  });
});

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- empty stub; module-level mock ensures it's never passed to real crypto
const STUB_PRIVATE_KEY_2 = {} as import("crypto").KeyObject;

describe("typed RPC helpers", () => {
  function makeFakeClient(responseFromRequest: Record<string, unknown> | Error) {
    // Access the private `request()` via a subclass shim so the tests don't
    // need a real WebSocket. The public API still exercises the validation logic.
    class StubbedClient extends GatewayWsClient {
      override request = vi
        .fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>()
        .mockImplementation(() => {
          if (responseFromRequest instanceof Error) return Promise.reject(responseFromRequest);
          return Promise.resolve(responseFromRequest);
        });
    }
    return new StubbedClient({
      url: "ws://unused",
      gatewayToken: "t",
      deviceIdentity: { deviceId: "d", publicKeyBase64url: "p", privateKey: STUB_PRIVATE_KEY_2 },
    });
  }

  it("sessionsCreate returns the key on valid response", async () => {
    const client = makeFakeClient({ ok: true, key: "agent:main:abc", sessionId: "s1" });
    const res = await client.sessionsCreate({ label: "hello", model: "gpt-5" });
    expect(res.key).toBe("agent:main:abc");
    expect(res.sessionId).toBe("s1");
  });

  it("sessionsCreate throws GatewayProtocolError on missing key", async () => {
    const client = makeFakeClient({ ok: true, sessionId: "s1" }); // no key
    await expect(client.sessionsCreate({ label: "x" })).rejects.toBeInstanceOf(
      GatewayProtocolError,
    );
  });

  it("sessionsList returns sessions array on valid response", async () => {
    const client = makeFakeClient({
      sessions: [{ key: "k1", sessionId: "s1", updatedAt: 1000 }],
    });
    const res = await client.sessionsList({ limit: 500 });
    expect(res.sessions).toHaveLength(1);
    expect(res.sessions[0].key).toBe("k1");
  });

  it("sessionsList throws GatewayProtocolError on missing sessions array", async () => {
    const client = makeFakeClient({ totalCount: 0 });
    await expect(client.sessionsList({})).rejects.toBeInstanceOf(GatewayProtocolError);
  });

  it("sessionsDelete resolves on ok", async () => {
    const client = makeFakeClient({ ok: true, key: "k1", deleted: true });
    const res = await client.sessionsDelete({ key: "k1", deleteTranscript: true });
    expect(res.deleted).toBe(true);
  });

  it("sessionsPatch resolves on ok", async () => {
    const client = makeFakeClient({ ok: true, key: "k1", entry: { key: "k1", label: "new" } });
    const res = await client.sessionsPatch({ key: "k1", label: "new" });
    expect(res.ok).toBe(true);
  });

  it("chatHistory returns messages array", async () => {
    const client = makeFakeClient({
      sessionKey: "k1",
      sessionId: "s1",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
    });
    const res = await client.chatHistory({ sessionKey: "k1", limit: 200 });
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].role).toBe("user");
  });

  it("chatAbort always includes the exact runId", async () => {
    const client = makeFakeClient({ ok: true, aborted: true, runIds: [] });
    await client.chatAbort({ sessionKey: "k1", runId: "r99" });
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test shim to access mock call history
    const shim = client as unknown as {
      request: { mock: { calls: Array<[string, Record<string, unknown>]> } };
    };
    expect(shim.request.mock.calls[0][1]).toEqual({ sessionKey: "k1", runId: "r99" });
  });

  it("modelsList returns models array", async () => {
    const client = makeFakeClient({
      models: [{ id: "gpt-5", name: "GPT-5" }],
    });
    const res = await client.modelsList();
    expect(res.models).toHaveLength(1);
    expect(res.models[0].id).toBe("gpt-5");
  });
});

describe("inbound RPC dispatch", () => {
  let client: GatewayWsClient;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockWsRef.instance = null;
    client = new GatewayWsClient({
      url: "wss://gateway.example.com",
      gatewayToken: "tok_test",
      deviceIdentity: {
        deviceId: "test-device-id",
        publicKeyBase64url: "test-public-key",
        privateKey: STUB_PRIVATE_KEY_2,
      },
      rpcTimeoutMs: 100,
    });
    await performHandshake(client);
  });

  afterEach(() => {
    try {
      client.close();
    } catch {
      // ignore — already closed
    }
  });

  /**
   * Fire an inbound `req` and wait until the handler chain has called
   * `ws.send` with the response. Using `vi.waitFor` instead of a hardcoded
   * promise-flush count makes this robust to handlers adding more awaits
   * (e.g., when a future bridge wraps each handler in additional async work).
   */
  async function fireInboundReq(
    ws: MockWsLike,
    method: string,
    params: Record<string, unknown>,
    id = "test-req-id",
  ): Promise<void> {
    const sendCallsBefore = ws.send.mock.calls.length;
    ws.emit("message", toMsg({ type: "req", id, method, params }));
    // Unknown-method or registered-and-resolves: the handler chain calls
    // ws.send. For tests that expect no send (e.g., unregister-then-fire),
    // a short timeout falls through and the caller's findResponse() returns
    // undefined as expected.
    try {
      await vi.waitFor(() => ws.send.mock.calls.length > sendCallsBefore, {
        timeout: 100,
        interval: 1,
      });
    } catch {
      // Timed out — caller's findResponse() will return undefined.
    }
  }

  /** Find the first sent message that is a response to the given inbound id. */
  function findResponse(ws: MockWsLike, id: string): Record<string, unknown> | undefined {
    for (const call of ws.send.mock.calls) {
      const raw: string = call[0] ?? "{}";
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) continue;
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by typeof+null check above
      const obj = parsed as Record<string, unknown>;
      if (obj["type"] === "res" && obj["id"] === id) {
        return obj;
      }
    }
    return undefined;
  }

  /** Pull a typed `error` field off a response, with a single guarded cast. */
  function errorOf(res: Record<string, unknown>): Record<string, unknown> {
    const err = res["error"];
    if (typeof err !== "object" || err === null) {
      throw new Error(`expected res.error to be an object, got ${typeof err}`);
    }
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by typeof+null check above
    return err as Record<string, unknown>;
  }

  it("registered handler receives params and its result is sent back as 'res'", async () => {
    const handler = vi
      .fn<(params: Record<string, unknown>) => Promise<unknown>>()
      .mockImplementation(async (params) => ({ doubled: params["x"] }));
    client.registerInboundHandler("test.echo", handler);

    const ws = getWs();
    ws.send.mockClear();
    await fireInboundReq(ws, "test.echo", { x: 21 }, "r-1");

    expect(handler).toHaveBeenCalledWith({ x: 21 });
    const res = findResponse(ws, "r-1");
    expect(res).toBeDefined();
    expect(res!["type"]).toBe("res");
    expect(res!["ok"]).toBe(true);
    expect(res!["payload"]).toEqual({ doubled: 21 });
  });

  it("unknown method returns ok:false with code:'not-supported'", async () => {
    const ws = getWs();
    ws.send.mockClear();
    await fireInboundReq(ws, "no.such.method", {}, "r-unknown");

    const res = findResponse(ws, "r-unknown");
    expect(res).toBeDefined();
    expect(res!["ok"]).toBe(false);
    const error = errorOf(res!);
    expect(error["code"]).toBe("not-supported");
    expect(typeof error["message"]).toBe("string");
    expect(error["message"]).toMatch(/no\.such\.method/);
  });

  it("handler that throws returns ok:false with code:'internal'", async () => {
    client.registerInboundHandler("test.boom", async () => {
      throw new Error("kaboom");
    });

    const ws = getWs();
    ws.send.mockClear();
    await fireInboundReq(ws, "test.boom", {}, "r-throw");

    const res = findResponse(ws, "r-throw");
    expect(res).toBeDefined();
    expect(res!["ok"]).toBe(false);
    const error = errorOf(res!);
    expect(error["code"]).toBe("internal");
    expect(error["message"]).toBe("kaboom");
  });

  it("handler that throws a non-Error reports a generic message", async () => {
    client.registerInboundHandler("test.string-throw", async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "not an error instance";
    });

    const ws = getWs();
    ws.send.mockClear();
    await fireInboundReq(ws, "test.string-throw", {}, "r-non-error");

    const res = findResponse(ws, "r-non-error");
    expect(res).toBeDefined();
    expect(res!["ok"]).toBe(false);
    const error = errorOf(res!);
    expect(error["code"]).toBe("internal");
    expect(error["message"]).toBe("Unknown error");
  });

  it("registerInboundHandler returns an unregister function", async () => {
    const handler = vi
      .fn<(params: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValue({ ok: true });
    const unregister = client.registerInboundHandler("test.toggle", handler);
    expect(typeof unregister).toBe("function");

    unregister();

    const ws = getWs();
    ws.send.mockClear();
    await fireInboundReq(ws, "test.toggle", {}, "r-after-unreg");

    expect(handler).not.toHaveBeenCalled();
    // After unregistering, the method should report not-supported.
    const res = findResponse(ws, "r-after-unreg");
    expect(res).toBeDefined();
    expect(res!["ok"]).toBe(false);
    expect(errorOf(res!)["code"]).toBe("not-supported");
  });

  it("registerInboundHandler throws on double-registration", () => {
    client.registerInboundHandler("test.dup", async () => undefined);
    expect(() => client.registerInboundHandler("test.dup", async () => undefined)).toThrow(
      /already registered/,
    );
  });

  it("handler that throws an Error with a string `code` propagates that code to the wire", async () => {
    // DesktopCapabilityErrorThrow.code (e.g., "policy-deny", "user-deny",
    // "auth-failed") must reach the wire envelope so the cloud can branch on
    // category. The inbound dispatcher reads .code off the thrown Error.
    class StructuredErr extends Error {
      readonly code: string;
      constructor(code: string, message: string) {
        super(message);
        this.code = code;
      }
    }
    client.registerInboundHandler("test.structured", async () => {
      throw new StructuredErr("policy-deny", "blocked");
    });

    const ws = getWs();
    ws.send.mockClear();
    await fireInboundReq(ws, "test.structured", {}, "r-structured");

    const res = findResponse(ws, "r-structured");
    expect(res).toBeDefined();
    expect(res!["ok"]).toBe(false);
    const error = errorOf(res!);
    expect(error["code"]).toBe("policy-deny");
    expect(error["message"]).toBe("blocked");
  });

  it("handler that throws an Error with a non-string `code` falls back to 'internal'", async () => {
    // Defensive: only string codes are honored. A boolean / number / object
    // `code` shouldn't smuggle past the type guard.
    client.registerInboundHandler("test.bad-code", async () => {
      const err = new Error("oops");
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- exercising the guard against non-string codes; assigning a number to `.code` to ensure it falls back to "internal"
      (err as Error & { code?: unknown }).code = 42;
      throw err;
    });

    const ws = getWs();
    ws.send.mockClear();
    await fireInboundReq(ws, "test.bad-code", {}, "r-bad-code");

    const res = findResponse(ws, "r-bad-code");
    expect(res).toBeDefined();
    expect(errorOf(res!)["code"]).toBe("internal");
  });

  it("rejects new inbound requests once MAX_INBOUND_PENDING is in flight", async () => {
    // Defense-in-depth cap (see ws-client.ts MAX_INBOUND_PENDING). Cloud is
    // expected to bound this server-side too; this test pins the desktop
    // belt-and-suspenders.
    const MAX = 32;
    const released: Array<() => void> = [];
    client.registerInboundHandler("test.block", () => {
      return new Promise<unknown>((resolve) => {
        released.push(() => resolve(undefined));
      });
    });

    const ws = getWs();
    ws.send.mockClear();

    // Saturate the cap (don't await — these handlers are blocked).
    for (let i = 0; i < MAX; i++) {
      ws.emit("message", toMsg({ type: "req", id: `pending-${i}`, method: "test.block" }));
    }
    // Yield so handleInboundRequest's microtask increments inboundPending.
    await Promise.resolve();
    await Promise.resolve();

    // The (MAX+1)th must be refused with `not-supported` before its handler
    // is even invoked.
    await fireInboundReq(ws, "test.block", {}, "over-cap");
    const res = findResponse(ws, "over-cap");
    expect(res).toBeDefined();
    expect(res!["ok"]).toBe(false);
    expect(errorOf(res!)["code"]).toBe("not-supported");
    expect(errorOf(res!)["message"]).toMatch(/Too many concurrent/);

    // Release the held handlers so afterEach can close cleanly.
    for (const r of released) r();
  });
});

describe("sessions.subscribe", () => {
  it("calls sessions.subscribe RPC then invokes the callback on sessions.changed events", async () => {
    class StubbedClient extends GatewayWsClient {
      override request = vi
        .fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>()
        .mockResolvedValue({ ok: true });
      // Capture event listeners and their unsubscribe functions so the test can fire events and unsub.
      private captured: Array<{
        listener: (eventName: string, payload: Record<string, unknown>) => void;
        unsub: () => void;
      }> = [];
      override onEvent = vi
        .fn<
          (listener: (eventName: string, payload: Record<string, unknown>) => void) => () => void
        >()
        .mockImplementation((listener: (e: string, p: Record<string, unknown>) => void) => {
          const unsub = (): void => {
            this.captured = this.captured.filter((item) => item.listener !== listener);
          };
          this.captured.push({ listener, unsub });
          return unsub;
        });
      fire(eventName: string, payload: Record<string, unknown>): void {
        for (const { listener } of this.captured) {
          listener(eventName, payload);
        }
      }
    }
    const client = new StubbedClient({
      url: "ws://u",
      gatewayToken: "t",
      deviceIdentity: { deviceId: "d", publicKeyBase64url: "p", privateKey: STUB_PRIVATE_KEY_2 },
    });
    const received: Array<{ reason: string; sessionKey: string }> = [];
    const unsub = await client.sessionsSubscribe((evt) => {
      received.push({ reason: evt.reason, sessionKey: evt.sessionKey });
    });
    expect(client.request).toHaveBeenCalledWith("sessions.subscribe", {});

    // Unrelated events do not fire the callback.
    client.fire("agent", { stream: "assistant" });
    // sessions.changed does.
    client.fire("sessions.changed", {
      reason: "create",
      sessionKey: "k1",
      session: { key: "k1", sessionId: "s1", updatedAt: 1000 },
    });
    expect(received).toEqual([{ reason: "create", sessionKey: "k1" }]);

    // unsub() tears down the event listener (observed via fire after unsub being a no-op).
    unsub();
    client.fire("sessions.changed", {
      reason: "delete",
      sessionKey: "k1",
    });
    expect(received).toHaveLength(1);
  });
});
