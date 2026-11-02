import {
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityDescriptor,
  type CapabilityProvider,
  type InvocationContext,
} from "@marshal/runtime";

import type { RuntimeApplicationJobs } from "./application-jobs";
import type { SelectedSessionOwner } from "./selected-session-delivery";

const PREFIX = "marshal.application.job.";
const id = { type: "string", minLength: 1, maxLength: 256 } as const;
const statusSchema = {
  type: "object",
  additionalProperties: false,
  required: ["jobKey", "state"],
  properties: {
    jobKey: id,
    jobId: id,
    automationId: id,
    targetSessionId: id,
    state: { enum: ["armed", "disarmed", "suspended-restart", "suspended-changed"] },
  },
} as const;
const descriptors: readonly CapabilityDescriptor[] = [
  descriptor(
    "arm",
    "Arm an application job from an authenticated native application UI",
    ["jobKey", "automationId", "grantId", "capabilities"],
    {
      jobKey: id,
      automationId: id,
      grantId: id,
      capabilities: { type: "array", minItems: 1, maxItems: 8, items: id },
    },
  ),
  descriptor("status", "Read application job arm or restart suspension status", ["jobKey"], {
    jobKey: id,
  }),
  descriptor("disarm", "Disarm an application job and cancel its pending deliveries", ["jobKey"], {
    jobKey: id,
  }),
  descriptor(
    "invoke",
    "Invoke an armed job only from its actual native automation step; supply exactly one of jobKey or jobId",
    ["capability"],
    { jobId: id, jobKey: id, capability: id, input: {} },
  ),
];

export function createApplicationJobProvider(
  jobs: RuntimeApplicationJobs,
  /** Must resolve a live native UI invocation, rejecting background application tokens. */
  resolveUiOwner: (context: InvocationContext) => SelectedSessionOwner,
  resolveBackgroundInvocationId?: (context: InvocationContext) => string | undefined,
): CapabilityProvider {
  return {
    id: "marshal.application-jobs",
    version: "1.0.0",
    list: () => descriptors,
    get: (name) => descriptors.find((entry) => entry.name === name),
    async invoke(name, input, context) {
      if (name === `${PREFIX}invoke`)
        return { output: { result: await jobs.invoke(input, context) } };
      const invocationId = resolveBackgroundInvocationId?.(context);
      if (invocationId) {
        if (name === `${PREFIX}status` || name === `${PREFIX}disarm`)
          return {
            output: await jobs.control(
              invocationId,
              name === `${PREFIX}status` ? "status" : "disarm",
              input,
            ),
          };
        throw Object.assign(new Error("Background jobs cannot arm another job."), {
          code: "permission_denied",
        });
      }
      const owner = resolveUiOwner(context);
      if (name === `${PREFIX}arm`) return { output: await jobs.arm(owner, input) };
      if (name === `${PREFIX}status`) return { output: await jobs.status(owner, input) };
      if (name === `${PREFIX}disarm`) return { output: await jobs.disarm(owner, input) };
      throw Object.assign(new Error("Application job capability not found."), {
        code: "not_found",
      });
    },
  };
}
function descriptor(
  operation: string,
  description: string,
  required: readonly string[],
  properties: Record<string, unknown>,
): CapabilityDescriptor {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: `${PREFIX}${operation}`,
    version: "1.0.0",
    description,
    inputSchema: { type: "object", additionalProperties: false, required, properties },
    outputSchema:
      operation === "invoke"
        ? {
            type: "object",
            additionalProperties: false,
            required: ["result"],
            properties: { result: {} },
          }
        : statusSchema,
    // The dispatcher is deliberately reachable through the normal session broker.
    // Native active-step attestation, not a declared permission or caller metadata, authorizes it.
    permissions:
      operation === "invoke"
        ? []
        : [{ permission: `${PREFIX}${operation}`, risk: operation === "arm" ? "high" : "low" }],
  };
}
