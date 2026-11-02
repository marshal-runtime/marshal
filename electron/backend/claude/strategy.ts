import { CLAUDE_RUNTIME_ID, getRuntimeMetadata } from "../../../common/runtime-config";
import { getBundledMarshalPromptFiles } from "../../marshal-defaults";
import { createLocalRuntimeCapabilities } from "../local/capabilities";
import type { LocalRuntimeStrategy } from "../local/strategy";

const CLAUDE_RUNTIME = getRuntimeMetadata(CLAUDE_RUNTIME_ID);

export function createClaudeLocalRuntimeStrategy(): LocalRuntimeStrategy {
  return {
    runtimeId: CLAUDE_RUNTIME_ID,
    // Local adapters retain the legacy Copilot transport family for persisted-row compatibility;
    // runtimeId is the isolation and ownership boundary.
    origin: CLAUDE_RUNTIME.compatibilityOrigin,
    displayName: CLAUDE_RUNTIME.displayName,
    sessionConfigTraceFilename: "m-claude-session-config-trace.jsonl",
    defaultInferenceModel: "sonnet",
    preferredDefaultModelIds: ["sonnet", "opus", "haiku"],
    accountIdentityPrefix: "anthropic",
    capabilities: createLocalRuntimeCapabilities({ sessionCompaction: true }),
    loadWorkspaceFiles: getBundledMarshalPromptFiles,
  };
}
