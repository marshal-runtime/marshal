import { describe, it, expect } from "vitest";

import {
  type GatewaySyncState,
  makeSnapshotEvent,
  makeUpsertEvent,
  makeDeleteEvent,
} from "./session-sync";

function freshState(): GatewaySyncState {
  return {
    sessionKeys: new Map(),
    localIdBySessionKey: new Map(),
    backendIds: new Map(),
  };
}

describe("gateway-session-sync module functions", () => {
  it("makeSnapshotEvent produces index-snapshot from a list response and seeds state", () => {
    const state = freshState();
    const raw = {
      sessions: [
        { sessionId: "cloud-1", key: "agent:main:k1", label: "Chat 1", updatedAt: 1000 },
        { sessionId: "cloud-2", key: "agent:main:k2", label: "Chat 2", updatedAt: 2000 },
      ],
    };
    const evt = makeSnapshotEvent(raw, state);
    expect(evt?.type).toBe("index-snapshot");
    if (evt?.type !== "index-snapshot") throw new Error("wrong type");
    // backendId is the stable cloud sessionId (not the sessionKey routing token).
    expect(
      evt.sessions.map((s) => s.backendId).sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(["cloud-1", "cloud-2"]);
    expect(state.sessionKeys.get("cloud-1")).toBe("agent:main:k1");
    expect(state.localIdBySessionKey.get("agent:main:k1")).toBe("cloud-1");
    expect(state.backendIds.get("cloud-1")).toBe("cloud-1");
  });

  it("makeSnapshotEvent skips rows missing key or sessionId", () => {
    const state = freshState();
    const evt = makeSnapshotEvent(
      { sessions: [{ sessionId: "cloud-1" }, { key: "agent:main:k2" }] },
      state,
    );
    expect(evt?.type).toBe("index-snapshot");
    if (evt?.type !== "index-snapshot") throw new Error("wrong type");
    expect(evt.sessions).toHaveLength(0);
  });

  it("makeUpsertEvent emits session-upsert with backendId set to the cloud sessionId", () => {
    const state = freshState();
    const rawEvt = {
      reason: "create",
      sessionKey: "agent:main:k1",
      session: { sessionId: "cloud-1", key: "agent:main:k1", label: "New" },
    };
    const evt = makeUpsertEvent(rawEvt, state);
    expect(evt?.type).toBe("session-upsert");
    if (evt?.type !== "session-upsert") throw new Error("wrong type");
    expect(evt.session.backendId).toBe("cloud-1");
    expect(state.sessionKeys.get("cloud-1")).toBe("agent:main:k1");
    expect(state.localIdBySessionKey.get("agent:main:k1")).toBe("cloud-1");
  });

  it("makeUpsertEvent returns null when session payload is missing or malformed", () => {
    const state = freshState();
    expect(makeUpsertEvent({ reason: "create", sessionKey: "k1" }, state)).toBeNull();
    expect(makeUpsertEvent({ reason: "create", sessionKey: "k1", session: {} }, state)).toBeNull();
  });

  it("makeDeleteEvent resolves backendId from the session payload when present", () => {
    const state = freshState();
    state.sessionKeys.set("cloud-1", "agent:main:k1");
    state.localIdBySessionKey.set("agent:main:k1", "cloud-1");
    state.backendIds.set("cloud-1", "cloud-1");
    const evt = makeDeleteEvent(
      { reason: "delete", sessionKey: "agent:main:k1", session: { sessionId: "cloud-1" } },
      state,
    );
    expect(evt?.type).toBe("session-delete");
    if (evt?.type !== "session-delete") throw new Error();
    expect(evt.backendId).toBe("cloud-1");
    expect(state.sessionKeys.has("cloud-1")).toBe(false);
    expect(state.localIdBySessionKey.has("agent:main:k1")).toBe(false);
    expect(state.backendIds.has("cloud-1")).toBe(false);
  });

  it("makeDeleteEvent falls back to sessionKey reverse lookup when session payload omitted", () => {
    const state = freshState();
    state.sessionKeys.set("cloud-1", "agent:main:k1");
    state.localIdBySessionKey.set("agent:main:k1", "cloud-1");
    state.backendIds.set("cloud-1", "cloud-1");
    const evt = makeDeleteEvent({ reason: "delete", sessionKey: "agent:main:k1" }, state);
    expect(evt?.type).toBe("session-delete");
    if (evt?.type !== "session-delete") throw new Error();
    expect(evt.backendId).toBe("cloud-1");
  });

  it("makeDeleteEvent returns null when sessionKey is unknown and payload omits sessionId", () => {
    const state = freshState();
    const evt = makeDeleteEvent({ reason: "delete", sessionKey: "unknown" }, state);
    expect(evt).toBeNull();
  });
});

describe("session-sync — watcher session filtering", () => {
  it("filters cron-parent sessions like agent:foo:cron:cron-watcher-1", () => {
    const state = freshState();
    const event = makeSnapshotEvent(
      {
        sessions: [
          { key: "agent:foo:cron:cron-watcher-1", sessionId: "id-1", backendId: "id-1" },
          { key: "agent:foo:user-chat-1", sessionId: "id-2", backendId: "id-2" },
        ],
      },
      state,
    );
    expect(event?.type).toBe("index-snapshot");
    if (event?.type !== "index-snapshot") return;
    const ids = event.sessions.map((s) => s.backendId);
    expect(ids).toContain("id-2");
    expect(ids).not.toContain("id-1");
  });

  it("filters ephemeral cron-run sessions (belt-and-braces; marshal also filters them server-side)", () => {
    const state = freshState();
    const event = makeSnapshotEvent(
      {
        sessions: [
          {
            key: "agent:foo:cron:cron-watcher-1:run:abc",
            sessionId: "id-3",
            backendId: "id-3",
          },
        ],
      },
      state,
    );
    expect(event?.type).toBe("index-snapshot");
    if (event?.type !== "index-snapshot") return;
    expect(event.sessions.length).toBe(0);
  });

  it("filters heartbeat and dashboard sessions (existing behavior — regression)", () => {
    const state = freshState();
    const event = makeSnapshotEvent(
      {
        sessions: [
          { key: "agent:foo:base:heartbeat", sessionId: "id-4", backendId: "id-4" },
          { key: "agent:foo:dashboard:abc", sessionId: "id-5", backendId: "id-5" },
        ],
      },
      state,
    );
    expect(event?.type).toBe("index-snapshot");
    if (event?.type !== "index-snapshot") return;
    expect(event.sessions.length).toBe(0);
  });

  it("does not filter regular agent chat sessions (regression)", () => {
    const state = freshState();
    const event = makeSnapshotEvent(
      {
        sessions: [{ key: "agent:foo:user-chat-1", sessionId: "id-6", backendId: "id-6" }],
      },
      state,
    );
    expect(event?.type).toBe("index-snapshot");
    if (event?.type !== "index-snapshot") return;
    expect(event.sessions.length).toBe(1);
    expect(event.sessions[0].backendId).toBe("id-6");
  });
});
