import { describe, it, expect, vi, beforeEach } from "vitest";

import type { GatewayAuthIdentity, GatewayAuthState } from "../../../common/marshal-ipc-contract";
import { createGatewayAuthController } from "./auth/controller";
import { PairingCancelledError } from "./auth/pairing-cancelled-error";

interface FakeStore {
  current: Awaited<ReturnType<typeof import("../../auth/gateway-auth-store").loadGatewayAuthCred>>;
}

function makeBackend() {
  // Capture the latest pairing-status callback registered by the controller —
  // tests reach in via this ref to simulate the "gateway said NOT_PAIRED" tick
  // without having to spin up a full WS mock.
  const pairingRef: { cb: ((requestId: string) => void) | null } = { cb: null };
  return {
    login: vi.fn<(credentials: GatewayAuthIdentity) => Promise<unknown>>().mockResolvedValue({}),
    signOut: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    setPairingStatusCallback: vi.fn<(cb: ((requestId: string) => void) | null) => void>((cb) => {
      pairingRef.cb = cb;
    }),
    cancelPairing: vi.fn<() => void>(),
    isLocalGateway: vi.fn<() => boolean>(() => true),
    listPendingDevices: vi
      .fn<
        () => Promise<{
          pending: import("../../../common/marshal-ipc-contract").PendingDeviceRequest[];
          paired: import("../../../common/marshal-ipc-contract").PairedDevice[];
        }>
      >()
      .mockResolvedValue({ pending: [], paired: [] }),
    approveDevice: vi.fn<(requestId: string) => Promise<void>>().mockResolvedValue(undefined),
    _pairingRef: pairingRef,
  };
}

function makeStore(initial: FakeStore["current"] = null) {
  const ref: FakeStore = { current: initial };
  return {
    load: vi.fn<() => FakeStore["current"]>(() => ref.current),
    save: vi.fn<(c: FakeStore["current"]) => void>((c) => {
      ref.current = c;
    }),
    clear: vi.fn<() => void>(() => {
      ref.current = null;
    }),
    _ref: ref,
  };
}

describe("gateway auth-controller", () => {
  let backend: ReturnType<typeof makeBackend>;
  let store: ReturnType<typeof makeStore>;
  let broadcaster: ReturnType<typeof vi.fn<(state: GatewayAuthState) => void>>;

  beforeEach(() => {
    backend = makeBackend();
    store = makeStore();
    broadcaster = vi.fn<(state: GatewayAuthState) => void>();
  });

  it("getState returns picking when no saved cred", () => {
    const c = createGatewayAuthController({ backend, store, broadcaster });
    expect(c.getState()).toEqual({ status: "picking" });
  });

  it("signIn with aad persists the cred, fires onSignedIn(cred), and transitions picking → connecting → signed-in", async () => {
    const onSignedIn = vi.fn<(id: GatewayAuthIdentity) => void>();
    const c = createGatewayAuthController({ backend, store, broadcaster, onSignedIn });
    const cred: GatewayAuthIdentity = { mode: "hosted", roleMode: "operator-and-node" };
    const result = await c.signIn(cred);
    expect(result.success).toBe(true);
    expect(backend.login).toHaveBeenCalledWith(cred);
    expect(store.save).toHaveBeenCalledWith(cred);
    expect(onSignedIn).toHaveBeenCalledWith(cred);
    expect(c.getState().status).toBe("signed-in");
    const states = broadcaster.mock.calls.map((args) => (args[0] as { status: string }).status);
    expect(states).toEqual(["connecting", "signed-in"]);
  });

  it("tryAutoSignIn with a saved aad cred transitions connecting → signed-in and broadcasts both", async () => {
    store._ref.current = { mode: "hosted", roleMode: "operator-and-node" };
    const c = createGatewayAuthController({ backend, store, broadcaster });
    await c.tryAutoSignIn();
    expect(backend.login).toHaveBeenCalledWith({ mode: "hosted", roleMode: "operator-and-node" });
    expect(c.getState().status).toBe("signed-in");
    const states = broadcaster.mock.calls.map((args) => (args[0] as { status: string }).status);
    expect(states).toEqual(["connecting", "signed-in"]);
  });

  it("signIn does NOT persist the cred when the backend fails", async () => {
    // Persist-after-connect: a bad cred must not be saved — otherwise
    // tryAutoSignIn would loop forever on every launch with no way for the
    // user to clear it short of wiping the file.
    backend.login.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const c = createGatewayAuthController({ backend, store, broadcaster });
    const cred: GatewayAuthIdentity = { mode: "no-auth" };
    const result = await c.signIn(cred);
    expect(result.success).toBe(false);
    expect(store.save).not.toHaveBeenCalled();
    expect(c.getState().status).toBe("error");
    expect(c.getState().error).toMatch(/ECONNREFUSED/);
  });

  it("signOut clears cred, calls backend.signOut, returns to picking", async () => {
    store._ref.current = { mode: "no-auth" };
    const c = createGatewayAuthController({ backend, store, broadcaster });
    await c.signOut();
    expect(store.clear).toHaveBeenCalled();
    expect(backend.signOut).toHaveBeenCalled();
    expect(c.getState().status).toBe("picking");
  });

  it("signOut still transitions to picking when backend.signOut throws", async () => {
    backend.signOut.mockRejectedValueOnce(new Error("WS close failed"));
    store._ref.current = { mode: "no-auth" };
    const c = createGatewayAuthController({ backend, store, broadcaster });
    const result = await c.signOut();
    // User is logged out from their perspective: in-memory state AND disk are aligned.
    expect(c.getState().status).toBe("picking");
    expect(store.clear).toHaveBeenCalled();
    // Caller still sees the error surface so UI can log / toast if it wants.
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/WS close failed/);
  });

  it("tryAutoSignIn is a no-op when no cred is saved", async () => {
    const c = createGatewayAuthController({ backend, store, broadcaster });
    await c.tryAutoSignIn();
    expect(backend.login).not.toHaveBeenCalled();
    expect(c.getState().status).toBe("picking");
    expect(broadcaster).not.toHaveBeenCalled();
  });

  it("tryAutoSignIn sets error state on backend failure and retains saved cred", async () => {
    backend.login.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    store._ref.current = { mode: "no-auth" };
    const c = createGatewayAuthController({ backend, store, broadcaster });
    await c.tryAutoSignIn();
    expect(c.getState().status).toBe("error");
    expect(c.getState().error).toMatch(/ECONNREFUSED/);
    expect(store.clear).not.toHaveBeenCalled();
    // Both transitions (connecting + error) must reach the renderer.
    const states = broadcaster.mock.calls.map((args) => (args[0] as { status: string }).status);
    expect(states).toEqual(["connecting", "error"]);
  });

  it("tryAutoSignIn drops back to picking (no error banner) when the launch-time pairing wait is cancelled", async () => {
    // Mirrors signIn(): a Cancel during the launch-time pairing dialog is a
    // user action, not a failure. Without the PairingCancelledError guard the
    // user is stranded on an error banner with a "Try again" button.
    backend.login.mockRejectedValueOnce(new PairingCancelledError());
    store._ref.current = { mode: "hosted" };
    const c = createGatewayAuthController({ backend, store, broadcaster });
    await c.tryAutoSignIn();
    expect(c.getState().status).toBe("picking");
    expect(broadcaster).toHaveBeenCalledWith(expect.objectContaining({ status: "picking" }));
    // Saved cred MUST stay on disk — a Cancel doesn't sign the user out.
    expect(store.clear).not.toHaveBeenCalled();
  });

  it("registers a pairing-status callback at construction so the backend can push pairing transitions", () => {
    createGatewayAuthController({ backend, store, broadcaster });
    expect(backend.setPairingStatusCallback).toHaveBeenCalledTimes(1);
    expect(typeof backend._pairingRef.cb).toBe("function");
  });

  it("backend invoking the pairing callback broadcasts status:'pairing' with the requestId and pending identity", async () => {
    // Stretch the login call across the test so the controller sees the
    // pairing push while signIn is still awaiting backend.login.
    let resolveLogin!: () => void;
    backend.login.mockImplementationOnce(
      () => new Promise<unknown>((resolve) => (resolveLogin = () => resolve({}))),
    );
    const c = createGatewayAuthController({ backend, store, broadcaster });
    const cred: GatewayAuthIdentity = { mode: "hosted" };
    const signInPromise = c.signIn(cred);
    await Promise.resolve();
    backend._pairingRef.cb?.("req-pair-123");
    expect(c.getState()).toEqual({
      status: "pairing",
      identity: cred,
      pairingRequestId: "req-pair-123",
    });
    // Belt-and-braces: state was also actually broadcast — a regression where
    // setState updated the in-memory copy but bypassed the broadcaster would
    // leave the renderer stuck on "connecting" forever.
    expect(broadcaster).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pairing",
        identity: cred,
        pairingRequestId: "req-pair-123",
      }),
    );
    resolveLogin();
    await signInPromise;
    expect(c.getState().status).toBe("signed-in");
  });

  it("cancelPairing forwards to backend.cancelPairing and signIn surfaces the cancellation back to picking", async () => {
    // PairingCancelledError is the typed signal — the controller routes on
    // instanceof rather than matching err.message, so a wording change in
    // the backend can't silently demote this to the error-alert path.
    backend.login.mockRejectedValueOnce(new PairingCancelledError());
    const c = createGatewayAuthController({ backend, store, broadcaster });
    const result = await c.signIn({ mode: "hosted" });
    // No error alert should be shown — cancellation is a user action, not a failure.
    expect(c.getState().status).toBe("picking");
    // Broadcaster assertion (not just getState) — a regression where setState
    // updates the in-memory state but bypasses broadcast would leave the
    // renderer stuck on "connecting" forever while getState() returns "picking".
    expect(broadcaster).toHaveBeenCalledWith(expect.objectContaining({ status: "picking" }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Pairing cancelled/);
    expect(store.save).not.toHaveBeenCalled();
  });

  it("a generic Error with the same wording does NOT route to picking — only the typed PairingCancelledError signals user-cancel", async () => {
    backend.login.mockRejectedValueOnce(new Error("Pairing cancelled"));
    const c = createGatewayAuthController({ backend, store, broadcaster });
    const result = await c.signIn({ mode: "hosted" });
    expect(c.getState().status).toBe("error");
    expect(result.success).toBe(false);
  });

  it("cancelPairing on the controller calls backend.cancelPairing", async () => {
    const c = createGatewayAuthController({ backend, store, broadcaster });
    const result = await c.cancelPairing();
    expect(result.success).toBe(true);
    expect(backend.cancelPairing).toHaveBeenCalledTimes(1);
  });

  it("signOut fires the onSignOut hook AFTER backend.signOut so SessionManager can drop stale handles", async () => {
    const callOrder: string[] = [];
    backend.signOut.mockImplementationOnce(async () => {
      callOrder.push("backend.signOut");
    });
    const onSignOut = vi.fn<() => void>(() => {
      callOrder.push("onSignOut");
    });
    const c = createGatewayAuthController({ backend, store, broadcaster, onSignOut });
    await c.signOut();
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["backend.signOut", "onSignOut"]);
  });

  it("signOut still fires the onSignOut hook when backend.signOut throws — local state must be cleared regardless", async () => {
    backend.signOut.mockRejectedValueOnce(new Error("WS close failed"));
    const onSignOut = vi.fn<() => void>();
    const c = createGatewayAuthController({ backend, store, broadcaster, onSignOut });
    const result = await c.signOut();
    expect(result.success).toBe(false);
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("a throwing onSignedIn hook does NOT flip the successful sign-in into an error state", async () => {
    const onSignedIn = vi.fn<(identity: GatewayAuthIdentity) => void>(() => {
      throw new Error("node start failed");
    });
    const c = createGatewayAuthController({ backend, store, broadcaster, onSignedIn });
    const result = await c.signIn({ mode: "no-auth" });
    expect(result.success).toBe(true);
    expect(c.getState().status).toBe("signed-in");
  });

  describe("setReconnecting", () => {
    it("is a no-op when status is not 'signed-in' (does not emit state)", async () => {
      const c = createGatewayAuthController({ backend, store, broadcaster });
      // status is 'picking' — setReconnecting should do nothing
      c.setReconnecting(true);
      expect(broadcaster).not.toHaveBeenCalled();
      expect(c.getState().status).toBe("picking");
    });

    it("debounces identical values — calling setReconnecting(true) twice only broadcasts once", async () => {
      const c = createGatewayAuthController({ backend, store, broadcaster });
      const cred: GatewayAuthIdentity = { mode: "no-auth" };
      await c.signIn(cred);
      const callsBefore = broadcaster.mock.calls.length;
      c.setReconnecting(true);
      c.setReconnecting(true); // second call — same value, should be a no-op
      expect(broadcaster.mock.calls.length).toBe(callsBefore + 1);
    });
  });

  describe("local device-approval surface", () => {
    it("listPendingDevices passes through to the backend when local", async () => {
      backend.listPendingDevices.mockResolvedValueOnce({
        pending: [{ requestId: "req-1", deviceId: "dev-a", ts: 1 }],
        paired: [{ deviceId: "dev-a", approvedAtMs: 2 }],
      });
      const c = createGatewayAuthController({ backend, store, broadcaster });
      const result = await c.listPendingDevices();
      expect(result.success).toBe(true);
      expect(result.pending).toHaveLength(1);
      expect(result.pending?.[0]?.requestId).toBe("req-1");
      expect(result.paired).toHaveLength(1);
    });

    it("listPendingDevices rejects with not-supported-non-local when gateway is non-local", async () => {
      // The renderer's hook keys "no panel" off this exact code; a wording
      // change here would silently leak the panel into hosted deployments.
      backend.isLocalGateway.mockReturnValueOnce(false);
      const c = createGatewayAuthController({ backend, store, broadcaster });
      const result = await c.listPendingDevices();
      expect(result.success).toBe(false);
      expect(result.error).toBe("not-supported-non-local");
      expect(backend.listPendingDevices).not.toHaveBeenCalled();
    });

    it("listPendingDevices surfaces RPC failures as success:false with the error message", async () => {
      backend.listPendingDevices.mockRejectedValueOnce(new Error("WS closed"));
      const c = createGatewayAuthController({ backend, store, broadcaster });
      const result = await c.listPendingDevices();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/WS closed/);
    });

    it("approveDevice passes the requestId through to the backend when local", async () => {
      const c = createGatewayAuthController({ backend, store, broadcaster });
      const result = await c.approveDevice("req-42");
      expect(result.success).toBe(true);
      expect(backend.approveDevice).toHaveBeenCalledWith("req-42");
    });

    it("approveDevice rejects with not-supported-non-local when gateway is non-local", async () => {
      backend.isLocalGateway.mockReturnValueOnce(false);
      const c = createGatewayAuthController({ backend, store, broadcaster });
      const result = await c.approveDevice("req-42");
      expect(result.success).toBe(false);
      expect(result.error).toBe("not-supported-non-local");
      expect(backend.approveDevice).not.toHaveBeenCalled();
    });

    it("approveDevice surfaces RPC failures as success:false with the error message", async () => {
      backend.approveDevice.mockRejectedValueOnce(new Error("unknown requestId"));
      const c = createGatewayAuthController({ backend, store, broadcaster });
      const result = await c.approveDevice("req-stale");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/unknown requestId/);
    });

    it.each([
      ["undefined", undefined],
      ["number", 123],
      ["empty string", ""],
      ["whitespace-only", "  "],
    ] as const)(
      "approveDevice rejects %s requestId with invalid-requestId before calling the RPC",
      async (_label, value) => {
        const c = createGatewayAuthController({ backend, store, broadcaster });
        const result = await c.approveDevice(value);
        expect(result).toEqual({ success: false, error: "invalid requestId" });
        expect(backend.approveDevice).not.toHaveBeenCalled();
      },
    );
  });
});
