import type { PermissionsConfig, PermissionsEnvelope } from "../../../../common/marshal-ipc-contract";
import { createLogger } from "../../../../common/marshal-logger";
import { MARSHAL_LOCAL_TOOL_KEYS } from "../../../permission-patterns";
import type { IPermissionsBackend, PermissionsOperationResult } from "../../types";
import type { RpcClient } from "../automation/backend";
import { GATEWAY_PERMISSIONS_CONTROLLABLE } from "./controllable";
import {
  extractPermissionsFromConfig,
  mapPermissionsToMarshalPatch,
  wrapPermissionsPatchAtConfigPath,
} from "./permissions-map";

const log = createLogger("GatewayPermissionsBackend");

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

export class GatewayPermissionsBackend implements IPermissionsBackend {
  private client: RpcClient | null = null;

  attachClient(client: RpcClient): void {
    this.client = client;
  }

  detachClient(): void {
    this.client = null;
  }

  private requireClient(): RpcClient {
    if (!this.client) throw new Error("GatewayPermissionsBackend: no client attached");
    return this.client;
  }

  async getPermissions(): Promise<PermissionsEnvelope> {
    const client = this.requireClient();
    const resp = await client.request("config.get", {});
    const {
      permissions,
      baseHash,
      hasUnrepresentablePatterns,
      migratedToolPolicy,
      migrationChanged,
    } = extractPermissionsFromConfig(resp);
    if (migrationChanged) {
      try {
        await client.request("config.patch", {
          baseHash,
          raw: JSON.stringify(wrapPermissionsPatchAtConfigPath(migratedToolPolicy)),
        });
      } catch (error) {
        log.warn("Failed to persist migrated gateway tool permissions:", error);
      }
    }
    return {
      supported: true,
      permissions,
      controllable: GATEWAY_PERMISSIONS_CONTROLLABLE,
      ...(hasUnrepresentablePatterns ? { hasUnrepresentablePatterns: true } : {}),
    };
  }

  async updatePermissions(patch: Partial<PermissionsConfig>): Promise<PermissionsOperationResult> {
    try {
      const client = this.requireClient();
      const baseResp = await client.request("config.get", {});
      const { permissions: current, baseHash, rawAllow } = extractPermissionsFromConfig(baseResp);

      // Reconstruct the marshal subtree shape from `current`'s round-tripped
      // m form. Thread `rawAllow` back through so the merge helper preserves
      // marshal's strict-mode `allow[]` field on round-trip — defense-in-depth
      // even though the UI blocks writes when `hasUnrepresentablePatterns` is true.
      const marshalPatch = mapPermissionsToMarshalPatch(patch, {
        tools: {
          ...(rawAllow !== undefined ? { allow: rawAllow } : {}),
          alsoAllow: Object.entries(current.tools)
            .filter(([k, v]) => v && !MARSHAL_LOCAL_TOOL_KEYS.has(k))
            .map(([k]) => k),
          deny: Object.entries(current.tools)
            .filter(([k, v]) => !v && !MARSHAL_LOCAL_TOOL_KEYS.has(k))
            .map(([k]) => k),
        },
        exec: {},
      });

      const { rejectedShellPatterns } = marshalPatch;

      if (!marshalPatch.tools) {
        log.info("updatePermissions: empty patch, skipping config.patch");
        return rejectedShellPatterns ? { ok: true, rejectedShellPatterns } : { ok: true };
      }

      // marshal's `config.patch` schema: `raw` is a JSON5 string of a
      // merge-patch object, NOT a nested patch object. `baseHash` provides
      // optional CAS — if the hash has changed marshal throws CONFIG_HASH_MISMATCH.
      try {
        await client.request("config.patch", {
          baseHash,
          raw: JSON.stringify(wrapPermissionsPatchAtConfigPath(marshalPatch.tools)),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = isRecord(err) && typeof err.code === "string" ? err.code : null;
        if (code === "CONFIG_HASH_MISMATCH" || message.toLowerCase().includes("hash")) {
          try {
            const latest = await this.getPermissions();
            return { ok: false, reason: "cas-conflict", latest };
          } catch {
            return {
              ok: false,
              reason: "validation-error",
              message: "Settings changed externally; could not re-fetch latest state.",
            };
          }
        }
        return {
          ok: false,
          reason: "validation-error",
          message,
        };
      }

      return rejectedShellPatterns ? { ok: true, rejectedShellPatterns } : { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // marshal can shut down the WS without responding to config.patch when
      // a field requires a restart (lobster#617). Surface as a clearer
      // user-facing message so the toast doesn't read "Connection closed
      // (code=1000)". The reconnect loop handles the rejoin; a refetch after
      // reconnect will reflect the actual landed state.
      if (
        message.includes("Connection closed") ||
        message.includes("Not connected") ||
        message.includes("handshake timed out")
      ) {
        return {
          ok: false,
          reason: "validation-error",
          message:
            "marshal is restarting to apply this change. Reload in a moment to see the result. (lobster#617)",
        };
      }
      return {
        ok: false,
        reason: "validation-error",
        message,
      };
    }
  }
}
