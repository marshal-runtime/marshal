import {
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityDescriptor,
  type CapabilityProvider,
  type InvocationContext,
} from "@marshal/runtime";

import type { RuntimeApplicationAuthority } from "./application-authority";
import { invalidRuntimeRequest } from "./runtime-provider-error";
import type { RuntimeUiAttachmentStore, RuntimeUiImageImportInput } from "./runtime-ui-attachments";

export const RUNTIME_UI_IMAGE_IMPORT = "marshal.ui.image.import";
const mimeTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
const descriptor: CapabilityDescriptor = {
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  name: RUNTIME_UI_IMAGE_IMPORT,
  version: "1.0.0",
  title: "Import image bytes into an application-owned attachment handle",
  description:
    "Imports canonical base64 PNG, JPEG, GIF or WebP bytes up to 3.75 MB. The current application must declare this capability. Packaged UI requests remain limited to 1 MiB including JSON and base64 overhead.",
  tags: ["marshal", "ui", "image"],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["base64"],
    properties: {
      base64: { type: "string", minLength: 4, maxLength: 5_000_000 },
      mimeType: { enum: mimeTypes },
      displayName: { type: "string", minLength: 1, maxLength: 256 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["handle", "mimeType", "displayName", "byteLength", "expiresAt"],
    properties: {
      handle: { type: "string" },
      mimeType: { enum: mimeTypes },
      displayName: { type: "string" },
      byteLength: { type: "integer", minimum: 1, maximum: 3_750_000 },
      expiresAt: { type: "string" },
    },
  },
  permissions: [{ permission: RUNTIME_UI_IMAGE_IMPORT, risk: "low" }],
};

/** Only native invocation tokens confer import ownership; tracing metadata is never authority. */
export function createRuntimeUiImageProvider(
  getStore: () => Promise<RuntimeUiAttachmentStore>,
  authority: Pick<RuntimeApplicationAuthority, "resolve">,
): CapabilityProvider {
  return {
    id: "marshal.runtime-ui-image",
    version: "1.0.0",
    list: () => [descriptor],
    get: (name) => (name === RUNTIME_UI_IMAGE_IMPORT ? descriptor : undefined),
    async invoke(name, input, context) {
      if (name !== RUNTIME_UI_IMAGE_IMPORT)
        throw Object.assign(new Error("Runtime UI image capability not found."), {
          code: "not_found",
        });
      const invocation = authority.resolve(context);
      const assertCurrent = async () => {
        assertNotCancelled(context);
        if (
          !invocation ||
          authority.resolve(context) !== invocation ||
          !invocation.capabilities.has(RUNTIME_UI_IMAGE_IMPORT) ||
          !(await invocation.isActive()) ||
          authority.resolve(context) !== invocation
        )
          throw Object.assign(
            new Error(
              "Image import requires a current application invocation declaring this capability.",
            ),
            { code: "permission_denied" },
          );
        assertNotCancelled(context);
      };
      await assertCurrent();
      const request = parseInput(input);
      const store = await getStore();
      try {
        return { output: await store.importImage(invocation!.owner, request, assertCurrent) };
      } catch (error) {
        if (error instanceof Error && Reflect.get(error, "code") === "invalid_input")
          throw invalidRuntimeRequest(new TypeError(error.message));
        throw error;
      }
    },
  };
}

function parseInput(input: unknown): RuntimeUiImageImportInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw invalidRuntimeRequest(new TypeError("Image import input must be an object."));
  const request: Record<string, unknown> = Object.fromEntries(Object.entries(input));
  if (Object.keys(request).some((key) => !["base64", "mimeType", "displayName"].includes(key)))
    throw invalidRuntimeRequest(new TypeError("Unexpected image import input property."));
  if (typeof request.base64 !== "string")
    throw invalidRuntimeRequest(new TypeError("Image import requires base64 bytes."));
  const mimeType = mimeTypes.find((mime) => mime === request.mimeType);
  if (request.mimeType !== undefined && !mimeType)
    throw invalidRuntimeRequest(new TypeError("Unsupported image MIME type."));
  if (request.displayName !== undefined && typeof request.displayName !== "string")
    throw invalidRuntimeRequest(new TypeError("Image displayName must be a string."));
  return {
    base64: request.base64,
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(request.displayName !== undefined ? { displayName: request.displayName } : {}),
  };
}

function assertNotCancelled(context: InvocationContext): void {
  if (context.signal instanceof AbortSignal && context.signal.aborted)
    throw Object.assign(new Error("Image import was cancelled."), { code: "cancelled" });
}
