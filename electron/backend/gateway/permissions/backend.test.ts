import { describe, expect, it, vi } from "vitest";

import type { RpcClient } from "../automation/backend";
import { GatewayPermissionsBackend } from "./backend";

function makeBackend(handlers: Record<string, (params: unknown) => unknown>) {
  const fakeClient: RpcClient = {
    request: vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>(
      async (method, params) => {
        if (method in handlers) return handlers[method](params);
        throw new Error(`unhandled rpc: ${method}`);
      },
    ),
  };
  const backend = new GatewayPermissionsBackend();
  backend.attachClient(fakeClient);
  return { backend, fakeClient };
}

describe("GatewayPermissionsBackend.getPermissions", () => {
  it("calls config.get and returns a populated envelope", async () => {
    const { backend } = makeBackend({
      "config.get": () => ({
        config: {
          tools: { alsoAllow: ["mcp:fs:read"], exec: { ask: "always" } },
        },
        hash: "h1",
      }),
    });

    const env = await backend.getPermissions();
    expect(env.supported).toBe(true);
    expect(env.permissions.tools).toEqual({ "mcp:fs:read": true });
    expect(env.permissions.autoApproveReadOnly).toBe(false);
    expect(env.controllable.tools.enabled).toBe(true);
    expect(env.controllable.shellDeny.enabled).toBe(false);
    expect(env.controllable.shellDeny.disabledReason).toBeTruthy();
    expect(env.controllable.shellDeny.helpUrl).toBeUndefined();
  });

  it("flags hasUnrepresentablePatterns when marshal has globs", async () => {
    const { backend } = makeBackend({
      "config.get": () => ({ config: { tools: { alsoAllow: ["mcp:fs:*"] } }, hash: "h" }),
    });
    const env = await backend.getPermissions();
    expect(env.hasUnrepresentablePatterns).toBe(true);
  });

  it("persists canonicalized legacy tool permissions on read", async () => {
    const patches: unknown[] = [];
    const { backend } = makeBackend({
      "config.get": () => ({
        config: {
          tools: {
            alsoAllow: ["tool:marshal_create_skill"],
            deny: ["tool:m_list_skills"],
          },
        },
        hash: "h",
      }),
      "config.patch": (params) => {
        patches.push(params);
        return undefined;
      },
    });

    const env = await backend.getPermissions();

    expect(env.permissions.tools).toEqual({
      "tool:createSkill": true,
      "tool:listSkills": false,
    });
    expect(patches).toEqual([
      {
        baseHash: "h",
        raw: JSON.stringify({
          tools: {
            alsoAllow: ["tool:createSkill"],
            deny: ["tool:listSkills"],
          },
        }),
      },
    ]);
  });
});

describe("GatewayPermissionsBackend.updatePermissions", () => {
  it("issues config.patch with the mapped subtree and base-hash CAS", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const { backend } = makeBackend({
      "config.get": () => ({ config: { tools: {} }, hash: "h1" }),
      "config.patch": (params) => {
        calls.push({ method: "config.patch", params });
        // marshal returns nothing meaningful on success — the absence of a
        // throw is the success signal.
        return undefined;
      },
    });

    const result = await backend.updatePermissions({ tools: { foo: true } });
    expect(result).toEqual({ ok: true });
    expect(calls[0].params).toMatchObject({
      baseHash: "h1",
      raw: JSON.stringify({ tools: { alsoAllow: ["foo"], deny: [] } }),
    });
  });

  it("filters Marshal-internal synthetic keys (tool:read) out of alsoAllow/deny", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const { backend } = makeBackend({
      "config.get": () => ({
        config: {
          tools: { alsoAllow: ["tool:read", "mcp:filesystem"], deny: [] },
        },
        hash: "h1",
      }),
      "config.patch": (params) => {
        calls.push({ method: "config.patch", params });
        return undefined;
      },
    });

    const result = await backend.updatePermissions({ tools: { foo: true } });
    expect(result).toEqual({ ok: true });
    const raw = JSON.stringify(calls[0].params);
    expect(raw).toContain('\\"alsoAllow\\":[\\"mcp:filesystem\\",\\"foo\\"]');
    expect(raw).not.toContain("tool:read");
  });

  it("returns cas-conflict with latest envelope on hash mismatch", async () => {
    let getCount = 0;
    const { backend } = makeBackend({
      "config.get": () => {
        getCount += 1;
        return {
          config: { tools: { alsoAllow: getCount === 1 ? [] : ["external-write"] } },
          hash: getCount === 1 ? "h1" : "h2",
        };
      },
      "config.patch": () => {
        const err = new Error("hash mismatch");
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        (err as Error & { code?: string }).code = "CONFIG_HASH_MISMATCH";
        throw err;
      },
    });

    const result = await backend.updatePermissions({ tools: { foo: true } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.reason).toBe("cas-conflict");
    if (result.reason !== "cas-conflict") throw new Error("expected cas-conflict");
    expect(result.latest.permissions.tools).toEqual({ "external-write": true });
  });

  it("returns validation-error when CAS conflict re-fetch also throws (WS detached)", async () => {
    let getCount = 0;
    const fakeClient: RpcClient = {
      request: vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>(
        async (method) => {
          if (method === "config.get") {
            getCount += 1;
            if (getCount === 1) return { config: {}, hash: "h1" };
            // Second call (re-fetch after CAS mismatch) fails
            throw new Error("[gateway-ws] Not connected");
          }
          if (method === "config.patch") {
            const err = new Error("hash mismatch");
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            (err as Error & { code?: string }).code = "CONFIG_HASH_MISMATCH";
            throw err;
          }
          throw new Error(`unhandled rpc: ${method}`);
        },
      ),
    };
    const backend = new GatewayPermissionsBackend();
    backend.attachClient(fakeClient);

    const result = await backend.updatePermissions({ tools: { foo: true } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.reason).toBe("validation-error");
    if (result.reason !== "validation-error") throw new Error("expected reason=validation-error");
    expect(result.message).toContain("could not re-fetch");
  });

  it("returns validation-error when config.get throws (e.g., disconnected client)", async () => {
    const fakeClient: RpcClient = {
      request: vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>(
        async () => {
          throw new Error("[gateway-ws] Not connected");
        },
      ),
    };
    const backend = new GatewayPermissionsBackend();
    backend.attachClient(fakeClient);

    const result = await backend.updatePermissions({ tools: { foo: true } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.reason).toBe("validation-error");
    if (result.reason !== "validation-error") throw new Error("expected reason=validation-error");
    // Connection-closed errors are rewritten to a friendlier message that
    // points at the marshal restart-during-patch issue (lobster#617).
    expect(result.message).toContain("marshal is restarting");
    expect(result.message).toContain("lobster#617");
  });

  it("returns rejectedShellPatterns when shell allow contains non-binary patterns", async () => {
    let patchedRaw: string | undefined;
    const fakeClient: RpcClient = {
      request: vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>(
        async (method, params) => {
          if (method === "config.get") return { config: {}, hash: "h1" };
          if (method === "config.patch") {
            // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only: config.patch params shape is known
            patchedRaw = (params as { raw: string }).raw;
            return undefined;
          }
          throw new Error(`unhandled rpc: ${method}`);
        },
      ),
    };
    const backend = new GatewayPermissionsBackend();
    backend.attachClient(fakeClient);

    const result = await backend.updatePermissions({ allow: ["git", "npm run build --watch"] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.rejectedShellPatterns).toEqual(["npm run build --watch"]);
    expect(patchedRaw).toContain('"safeBins":["git"]');
  });

  it("preserves tools.allow[] (strict mode) on round-trip — defense-in-depth", async () => {
    let patchedRaw: string | undefined;
    const { backend } = makeBackend({
      "config.get": () => ({
        config: { tools: { allow: ["strict-tool"], alsoAllow: [], deny: [] } },
        hash: "h",
      }),
      "config.patch": (params) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        patchedRaw = (params as { raw: string }).raw;
        return undefined;
      },
    });

    // Patch an unrelated field — the allow[] should survive
    const result = await backend.updatePermissions({ tools: { "another-tool": true } });
    expect(result.ok).toBe(true);
    // The emitted patch must still carry the original allow[] entry
    expect(patchedRaw).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const patched = JSON.parse(patchedRaw!) as { tools: { allow?: string[] } };
    expect(patched.tools.allow).toEqual(["strict-tool"]);
  });

  it("drops fields that have no marshal equivalent", async () => {
    const calls: Array<{ params: unknown }> = [];
    const { backend } = makeBackend({
      "config.get": () => ({ config: {}, hash: "h" }),
      "config.patch": (params) => {
        calls.push({ params });
        return undefined;
      },
    });

    const result = await backend.updatePermissions({ denyPatterns: ["rm -rf /"] });
    expect(result.ok).toBe(true);
    // No-op patch — nothing to send. Backend should skip the RPC entirely.
    expect(calls.length).toBe(0);
  });
});
