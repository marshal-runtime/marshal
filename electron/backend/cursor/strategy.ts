import { CURSOR_RUNTIME_ID, getRuntimeMetadata } from "../../../common/runtime-config";
import { getBundledMarshalPromptFiles } from "../../marshal-defaults";
import { createLocalRuntimeCapabilities } from "../local/capabilities";
import type { LocalRuntimeStrategy } from "../local/strategy";
import {
  CURSOR_ACCOUNT_IDENTITY_PREFIX,
  CURSOR_DEFAULT_MODEL_ID,
  CURSOR_PREFERRED_MODEL_IDS,
  CURSOR_SESSION_CONFIG_TRACE_FILENAME,
} from "./constants";

const CURSOR_RUNTIME = getRuntimeMetadata(CURSOR_RUNTIME_ID);

export function createCursorLocalRuntimeStrategy(): LocalRuntimeStrategy {
  return {
    runtimeId: CURSOR_RUNTIME_ID,
    // Local adapters retain the legacy Copilot transport family for persisted-row compatibility;
    // runtimeId is the isolation and ownership boundary.
    origin: CURSOR_RUNTIME.compatibilityOrigin,
    displayName: CURSOR_RUNTIME.displayName,
    sessionConfigTraceFilename: CURSOR_SESSION_CONFIG_TRACE_FILENAME,
    defaultInferenceModel: CURSOR_DEFAULT_MODEL_ID,
    preferredDefaultModelIds: CURSOR_PREFERRED_MODEL_IDS,
    accountIdentityPrefix: CURSOR_ACCOUNT_IDENTITY_PREFIX,
    capabilities: createLocalRuntimeCapabilities({ sessionCompaction: true, busyTurnSteer: true }),
    loadWorkspaceFiles: getBundledMarshalPromptFiles,
    defaultClientLoginRequest: { type: "browser" },
  };
}
