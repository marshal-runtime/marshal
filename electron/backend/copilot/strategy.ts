import { COPILOT_RUNTIME_ID } from "../../../common/runtime-config";
import { getBundledMarshalPromptFiles } from "../../marshal-defaults";
import { createLocalRuntimeCapabilities } from "../local/capabilities";
import type { LocalRuntimeStrategy } from "../local/strategy";
import { CopilotAuthStrategy } from "./auth";

export function createCopilotLocalRuntimeStrategy(): LocalRuntimeStrategy {
  return {
    runtimeId: COPILOT_RUNTIME_ID,
    origin: "copilot",
    displayName: "Copilot",
    sessionConfigTraceFilename: "m-copilot-session-config-trace.jsonl",
    defaultInferenceModel: "gpt-5.4-mini",
    preferredDefaultModelIds: [
      "gpt-5.6-sol",
      "gpt-5.5",
      "claude-opus-4.7",
      "claude-opus-4.6",
      "claude-sonnet-4.6",
      "gpt-5.4",
    ],
    accountIdentityPrefix: "github",
    capabilities: createLocalRuntimeCapabilities({ sessionCompaction: true }),
    loadWorkspaceFiles: getBundledMarshalPromptFiles,
    auth: new CopilotAuthStrategy(),
  };
}
