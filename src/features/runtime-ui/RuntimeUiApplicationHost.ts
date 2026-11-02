import type {
  RuntimeUiApplicationCapabilityValue,
  RuntimeUiApplicationResourceContent,
  RuntimeUiContent,
  RuntimeUiEvent,
  RuntimeUiInstance,
  RuntimeUiJsonValue,
  RuntimeUiSelectedSession,
  RuntimeUiImageHandle,
} from "@common/runtime-ui";

import type { MarshalRuntimeEditor } from "./RuntimeEditor";
import type { RuntimeUiApplicationRenderHost } from "./RuntimeUiApplicationRegistry";

function idempotencyKey(operation: string, instanceId: string): string {
  const unique =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `renderer-${operation}-${instanceId}-${unique}`;
}

type RuntimeUiHostApi = NonNullable<Window["runtimeUiAPI"]> & {
  readonly invokeCapability: NonNullable<NonNullable<Window["runtimeUiAPI"]>["invokeCapability"]>;
  readonly readResource: NonNullable<NonNullable<Window["runtimeUiAPI"]>["readResource"]>;
};

function requireApi(): RuntimeUiHostApi {
  const api = window.runtimeUiAPI;
  if (!api || !api.invokeCapability || !api.readResource) {
    throw new Error("Runtime UI host callbacks are unavailable in this window.");
  }
  return {
    ...api,
    invokeCapability: api.invokeCapability,
    readResource: api.readResource,
  };
}

function requireSuccess<T>(result: {
  readonly success: boolean;
  readonly value?: T;
  readonly error?: { readonly code?: string; readonly message: string };
}): T {
  if (result.success && result.value !== undefined) return result.value;
  throw Object.assign(new Error(result.error?.message ?? "Runtime UI host operation failed."), {
    code: result.error?.code,
  });
}

export function createRuntimeUiApplicationHost(
  instance: RuntimeUiInstance,
  editor: MarshalRuntimeEditor,
  selectedSession?: RuntimeUiSelectedSession | null,
  selectedImages?: readonly RuntimeUiImageHandle[],
  refreshImages?: () => Promise<readonly RuntimeUiImageHandle[]>,
  onSessionOpened?: () => void,
): RuntimeUiApplicationRenderHost {
  if (instance.content.kind !== "application") {
    throw new Error("Application renderer host requires application content.");
  }
  const applicationContent = instance.content;
  const owner = instance.owner;
  const api = requireApi();
  let currentImages = selectedImages;
  return {
    instance,
    editor,
    selectedSession,
    async searchSessions(query: string, limit?: number) {
      if (!api.searchSessions) return [];
      return requireSuccess(
        await api.searchSessions({
          ...owner,
          instanceId: instance.instanceId,
          query,
          limit,
        }),
      );
    },
    async selectSession(targetSessionId?: string) {
      if (!api.selectSession) return null;
      return requireSuccess(
        await api.selectSession({
          ...owner,
          instanceId: instance.instanceId,
          targetSessionId,
        }),
      );
    },
    async getSelectedSession() {
      if (!api.getSelectedSession) return null;
      return requireSuccess(
        await api.getSelectedSession({
          ...owner,
          instanceId: instance.instanceId,
        }),
      );
    },
    get selectedImages() {
      return currentImages;
    },
    async readImage(handle) {
      if (!api.readImage || !currentImages?.some((image) => image.handle === handle))
        throw new Error("Select this image in the native application toolbar first.");
      return requireSuccess(
        await api.readImage({ ...owner, instanceId: instance.instanceId, handle }),
      );
    },
    async openSession(sessionId) {
      const result = await window.commandCenterAPI?.openSession(sessionId);
      if (!result?.success) throw new Error(result?.error ?? "Session could not be opened.");
      onSessionOpened?.();
    },
    async invokeCapability(request): Promise<RuntimeUiApplicationCapabilityValue> {
      const result = await api.invokeCapability({
        ...owner,
        instanceId: instance.instanceId,
        capability: request.capability,
        publicationRevisionId: request.publicationRevisionId,
        input: request.input,
        idempotencyKey:
          request.idempotencyKey || idempotencyKey(request.capability, instance.instanceId),
      });
      const value = requireSuccess(result);
      try {
        // Nested backend capabilities can import images too. Refresh before returning so the
        // immediately following resource read sees the new handle even before React rerenders.
        if (refreshImages) currentImages = await refreshImages();
      } catch {
        // A refresh failure cannot turn an already accepted capability result into a failed write.
      }
      return value;
    },
    async cancelCapability(requestId: string): Promise<void> {
      if (!api.cancelCapability) return;
      requireSuccess(
        await api.cancelCapability({
          ...owner,
          instanceId: instance.instanceId,
          idempotencyKey: requestId,
        }),
      );
    },
    async readResource(uri: string): Promise<RuntimeUiApplicationResourceContent> {
      return requireSuccess(
        await api.readResource({ ...owner, instanceId: instance.instanceId, uri }),
      );
    },
    subscribe(listener: (event: RuntimeUiEvent) => void): () => void {
      return api.onEvent(listener);
    },
    async focus(): Promise<void> {
      requireSuccess(
        await api.focus({
          ...owner,
          instanceId: instance.instanceId,
          idempotencyKey: idempotencyKey("focus", instance.instanceId),
        }),
      );
    },
    async close(): Promise<void> {
      requireSuccess(
        await api.close({
          ...owner,
          instanceId: instance.instanceId,
          idempotencyKey: idempotencyKey("close", instance.instanceId),
        }),
      );
    },
    async update(state: { readonly [key: string]: RuntimeUiJsonValue }): Promise<void> {
      const content: RuntimeUiContent = { ...applicationContent, state };
      requireSuccess(
        await api.update({
          ...owner,
          instanceId: instance.instanceId,
          content,
          idempotencyKey: idempotencyKey("update", instance.instanceId),
        }),
      );
    },
  };
}
