import {
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityProvider,
  type InvocationContext,
} from "@marshal/runtime";
import { z } from "zod";

import type { SelectedSessionOwner } from "./selected-session-delivery";
const input = z.object({ sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/) }).strict();
export function createCloudSessionProvider(
  resolveUiOwner: (context: InvocationContext) => SelectedSessionOwner,
  open: (id: string) => Promise<string>,
): CapabilityProvider {
  const descriptor = {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: "marshal.cloud.session.open",
    version: "1.0.0",
    title: "Open a cloud task in Marshal chat",
    description:
      "Attach an authenticated standalone cloud task to the regular desktop chat without launching another worker.",
    tags: ["cloud", "session"],
    inputSchema: z.toJSONSchema(input),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId"],
      properties: { sessionId: { type: "string" } },
    },
    permissions: [{ permission: "marshal.cloud.session.open", risk: "medium" as const }],
  };
  return {
    id: "marshal.cloud-session-host",
    version: "1.0.0",
    list: () => [descriptor],
    get: (name) => (name === descriptor.name ? descriptor : undefined),
    invoke: async (name, value, context) => {
      const owner = resolveUiOwner(context);
      if (owner.extensionId !== "@marshal/cloud-workers" || name !== descriptor.name)
        throw new Error("A live Cloud Workers application is required");
      return { output: { sessionId: await open(input.parse(value).sessionId) } };
    },
  };
}
