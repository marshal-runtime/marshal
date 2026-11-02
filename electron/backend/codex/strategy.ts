import { CODEX_RUNTIME_ID, getRuntimeMetadata } from "../../../common/runtime-config";
import { getBundledMarshalPromptFiles } from "../../marshal-defaults";
import { createLocalRuntimeCapabilities } from "../local/capabilities";
import type { LocalRuntimeStrategy } from "../local/strategy";

const CODEX_RUNTIME = getRuntimeMetadata(CODEX_RUNTIME_ID);

export function createCodexLocalRuntimeStrategy(): LocalRuntimeStrategy {
  return {
    runtimeId: CODEX_RUNTIME_ID,
    // Local adapters retain the legacy Copilot transport family for persisted-row compatibility;
    // runtimeId is the isolation and ownership boundary.
    origin: CODEX_RUNTIME.compatibilityOrigin,
    displayName: CODEX_RUNTIME.displayName,
    sessionConfigTraceFilename: "m-codex-session-config-trace.jsonl",
    defaultInferenceModel: "gpt-5.4",
    preferredDefaultModelIds: ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex"],
    accountIdentityPrefix: "openai",
    // busyTurnSteer: the Codex adapter delivers send-while-busy through the
    // app-server's native turn/steer, so host steer must not cancel the turn.
    // sessionCompaction: rpc.history.compact runs thread/compact/start.
    capabilities: createLocalRuntimeCapabilities({ busyTurnSteer: true, sessionCompaction: true }),
    loadWorkspaceFiles: getBundledMarshalPromptFiles,
    defaultClientLoginRequest: { type: "browser" },
  };
}
