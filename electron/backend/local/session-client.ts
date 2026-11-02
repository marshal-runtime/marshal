import { runtimeTargetKey } from "../../../common/runtime-accounts";
import { parseRuntimeQualifiedModel } from "../../../common/runtime-qualified-model";
import { isRuntimeClientDead } from "./client-process";
import type { ILocalProviderForSession, LocalClientSubset } from "./internal";

export interface SessionClientSelection {
  client: LocalClientSubset;
  model: string | undefined;
  /** `runtimeTargetKey()` of the peer client (`cursor`, `claude@work`) when one runs the session. */
  peerRuntimeId?: string;
}

export type SessionClientSource = Pick<
  ILocalProviderForSession,
  "getClient" | "initClient" | "getRuntimeDisplayName" | "getRuntimeId" | "getPeerClients"
>;

/**
 * Picks the client that runs a session start. A `<runtime>:<model>` id selects a peer
 * runtime, and `<runtime>@<account>:<model>` selects that account's client, including an
 * extra account of the active runtime.
 */
export async function selectSessionClient(
  backend: SessionClientSource,
  model: string | undefined,
): Promise<SessionClientSelection> {
  const qualified = parseRuntimeQualifiedModel(model);
  const activeRuntimeId = backend.getRuntimeId?.();
  const targetKey = qualified ? runtimeTargetKey(qualified) : undefined;
  if (qualified && targetKey !== activeRuntimeId) {
    const peers = backend.getPeerClients?.();
    if (!peers) {
      throw new Error(
        `Model "${model}" needs the ${targetKey} runtime, which cannot run next to ${activeRuntimeId ?? "the active runtime"}.`,
      );
    }
    return {
      client: await peers.clientForModel(qualified),
      model: qualified.model,
      peerRuntimeId: targetKey,
    };
  }
  const current = backend.getClient();
  if (!current || isRuntimeClientDead(current)) {
    await backend.initClient();
  }
  const client = backend.getClient();
  if (!client) {
    throw new Error(
      `${backend.getRuntimeDisplayName?.() ?? "Local runtime"} client not initialized`,
    );
  }
  return { client, model: qualified?.model ?? model };
}

/**
 * Maps an in-place model switch onto the session's own runtime account. An in-place switch
 * cannot cross runtimes or accounts; SessionManager.switchSessionModel restarts the backend
 * on the target's client.
 */
export function modelForSessionSwitch(
  backend: SessionClientSource,
  sessionId: string,
  model: string,
): string {
  const qualified = parseRuntimeQualifiedModel(model);
  const activeRuntimeId = backend.getRuntimeId?.();
  const sessionTargetKey =
    backend.getPeerClients?.().runtimeForSession(sessionId) ?? activeRuntimeId;
  const targetKey = qualified ? runtimeTargetKey(qualified) : activeRuntimeId;
  if (targetKey !== sessionTargetKey) {
    throw new Error(
      `This session runs on the ${sessionTargetKey ?? "active"} runtime; "${model}" needs a session restart on its runtime, not an in-place switch.`,
    );
  }
  return qualified?.model ?? model;
}
