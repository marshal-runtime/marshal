import {
  assertLaunchAttachments,
  assertLaunchSystemPrompt,
  MAX_LAUNCH_ATTACHMENT_PATH_CHARS,
  MAX_LAUNCH_ATTACHMENTS,
  MAX_LAUNCH_SYSTEM_PROMPT_CHARS,
} from "../session-launch-override";
import type { MarshalRuntimeAgentLaunchRequest } from "./agent-orchestration";
import { invalidRuntimeRequest } from "./runtime-provider-error";

type LaunchOverride = Pick<MarshalRuntimeAgentLaunchRequest, "systemPrompt" | "attachments">;

/** Launch input schema properties that replace the child's prompt and seed its first message. */
export const LAUNCH_OVERRIDE_INPUT_PROPERTIES = {
  systemPrompt: { type: "string", minLength: 1, maxLength: MAX_LAUNCH_SYSTEM_PROMPT_CHARS },
  attachments: {
    type: "array",
    maxItems: MAX_LAUNCH_ATTACHMENTS,
    items: { type: "string", minLength: 1, maxLength: MAX_LAUNCH_ATTACHMENT_PATH_CHARS },
  },
} as const;

/** Maps the session-shaping fields of a delegation launch request to an agent launch. */
export function delegationLaunchOverride(request: {
  readonly systemPrompt?: string;
  readonly tools?: readonly string[];
  readonly attachments?: readonly string[];
}): LaunchOverride & Pick<MarshalRuntimeAgentLaunchRequest, "allowedTools"> {
  return {
    ...(request.tools === undefined ? {} : { allowedTools: [...request.tools] }),
    ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
    ...(request.attachments === undefined ? {} : { attachments: [...request.attachments] }),
  };
}

/** Reads the optional systemPrompt and attachments fields of a launch input. */
export function launchOverrideInput(value: Record<string, unknown>): LaunchOverride {
  const { systemPrompt, attachments } = value;
  if (systemPrompt !== undefined && typeof systemPrompt !== "string") {
    throw invalidRuntimeRequest(new TypeError("systemPrompt must be a string."));
  }
  if (
    attachments !== undefined &&
    (!Array.isArray(attachments) || !attachments.every((entry) => typeof entry === "string"))
  ) {
    throw invalidRuntimeRequest(new TypeError("attachments must be an array of file paths."));
  }
  return {
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(attachments !== undefined ? { attachments: [...attachments] } : {}),
  };
}

/** Rejects a systemPrompt or attachments that the requested launch cannot honor. */
export async function assertLaunchOverride(
  request: MarshalRuntimeAgentLaunchRequest,
): Promise<void> {
  if (request.systemPrompt === undefined && request.attachments === undefined) return;
  if (request.sessionId !== undefined) {
    throw invalidRuntimeRequest(
      new TypeError("systemPrompt and attachments cannot change an already running session."),
    );
  }
  if (request.systemPrompt !== undefined && request.agentName !== undefined) {
    throw invalidRuntimeRequest(
      new TypeError("systemPrompt replaces the repository agent prompt; omit agentName."),
    );
  }
  try {
    if (request.systemPrompt !== undefined) assertLaunchSystemPrompt(request.systemPrompt);
    if (request.attachments !== undefined) await assertLaunchAttachments(request.attachments);
  } catch (error) {
    throw error instanceof TypeError || error instanceof RangeError
      ? invalidRuntimeRequest(error)
      : error;
  }
}
