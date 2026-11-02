import { describe, expect, it, vi } from "vitest";

import type { IpcHandler, IpcInvokeMap } from "../../common/marshal-ipc-contract";
import { RUNTIME_UI_USER_SCOPE, type RuntimeUiImageHandle } from "../../common/runtime-ui";
import type { RuntimeUiAttachmentStore } from "../marshal-runtime/runtime-ui-attachments";
import {
  MarshalRuntimeUiController,
  type RuntimeUiDeliveryPorts,
} from "../marshal-runtime/ui-controller";
import { testDouble } from "../testing/harness";
import { registerRuntimeUiImageHandlers, type RuntimeUiImagePorts } from "./runtime-ui-images";

async function harness() {
  const controller = new MarshalRuntimeUiController(
    Date.now,
    (request) => ({ allowed: true, scope: request.scope }),
    {
      notification: vi.fn<RuntimeUiDeliveryPorts["notification"]>(),
      chatMessage: vi.fn<RuntimeUiDeliveryPorts["chatMessage"]>(),
      chatCard: vi.fn<RuntimeUiDeliveryPorts["chatCard"]>(),
    },
  );
  const opened = await controller.open({
    ...RUNTIME_UI_USER_SCOPE,
    extensionId: "test",
    applicationId: "images",
    surface: "tab",
    idempotencyKey: "open",
    content: {
      kind: "application",
      renderId: "test.images",
      resource: { uri: "ui://test/images", mimeType: "text/html" },
      descriptor: { version: "1.0.0", presentationModes: ["inline"], actions: [], tools: [] },
    },
  });
  if (!opened.ok || !opened.value.instance) throw new Error("Fixture failed to open");
  const instance = opened.value.instance;
  const request = { ...instance.owner, instanceId: instance.instanceId };
  const image: RuntimeUiImageHandle = {
    handle: "opaque-handle",
    mimeType: "image/png",
    displayName: "image.png",
    byteLength: 128,
    expiresAt: new Date().toISOString(),
  };
  const store = {
    selectImages: vi.fn<RuntimeUiAttachmentStore["selectImages"]>().mockResolvedValue([image]),
    listImages: vi.fn<RuntimeUiAttachmentStore["listImages"]>().mockResolvedValue([image]),
    readImage: vi
      .fn<RuntimeUiAttachmentStore["readImage"]>()
      .mockResolvedValue({ mimeType: "image/png", data: "base64" }),
    release: vi.fn<RuntimeUiAttachmentStore["release"]>().mockResolvedValue(undefined),
  };
  const pickNativeImages = vi
    .fn<RuntimeUiImagePorts["pickNativeImages"]>()
    .mockResolvedValue(["/native/picker/image.png"]);
  const isOwnerActive = vi.fn<RuntimeUiImagePorts["isOwnerActive"]>().mockResolvedValue(true);
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerRuntimeUiImageHandlers({
    controller,
    getStore: async () => testDouble<RuntimeUiAttachmentStore>(store),
    pickNativeImages,
    isOwnerActive,
    ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => {
      handlers.set(channel, testDouble<(...args: unknown[]) => unknown>(handler));
    },
  });
  return {
    controller,
    instance,
    request,
    store,
    image,
    pickNativeImages,
    isOwnerActive,
    invoke: (channel: string, input: unknown) => handlers.get(channel)!(undefined, input),
  };
}

describe("native runtime UI image IPC", () => {
  it("uses only host picker paths and persists opaque handles for an owned application", async () => {
    const h = await harness();
    expect(await h.invoke("runtime-ui:selectImages", h.request)).toEqual({
      success: true,
      value: [h.image],
    });
    expect(h.pickNativeImages).toHaveBeenCalledWith();
    expect(h.store.selectImages).toHaveBeenCalledWith(h.instance.owner, [
      "/native/picker/image.png",
    ]);
    expect(await h.invoke("runtime-ui:listImages", h.request)).toEqual({
      success: true,
      value: [h.image],
    });
  });
  it("denies caller paths, foreign owners and inactive applications before opening a dialog", async () => {
    const h = await harness();
    expect(
      await h.invoke("runtime-ui:selectImages", { ...h.request, paths: ["/etc/passwd"] }),
    ).toMatchObject({ success: false });
    expect(
      await h.invoke("runtime-ui:selectImages", { ...h.request, extensionId: "foreign" }),
    ).toMatchObject({ success: false });
    h.isOwnerActive.mockResolvedValue(false);
    expect(await h.invoke("runtime-ui:selectImages", h.request)).toMatchObject({ success: false });
    expect(h.pickNativeImages).not.toHaveBeenCalled();
    expect(h.store.selectImages).not.toHaveBeenCalled();
  });
  it("revalidates application ownership after the user responds to the dialog", async () => {
    const h = await harness();
    h.pickNativeImages.mockImplementation(async () => {
      h.controller.invalidateOwner(h.instance.owner);
      return ["/native/image.png"];
    });
    expect(await h.invoke("runtime-ui:selectImages", h.request)).toMatchObject({ success: false });
    expect(h.store.selectImages).not.toHaveBeenCalled();
  });
  it("treats native dialog cancellation as an empty selection without creating files", async () => {
    const h = await harness();
    h.pickNativeImages.mockResolvedValue([]);
    expect(await h.invoke("runtime-ui:selectImages", h.request)).toEqual({
      success: true,
      value: [],
    });
    expect(h.store.selectImages).not.toHaveBeenCalled();
  });
  it("routes authorized reads and release through the exact instance owner and rejects unknown fields", async () => {
    const h = await harness();
    expect(
      await h.invoke("runtime-ui:readImage", { ...h.request, handle: h.image.handle }),
    ).toEqual({ success: true, value: { mimeType: "image/png", data: "base64" } });
    expect(h.store.readImage).toHaveBeenCalledWith(h.instance.owner, h.image.handle);
    expect(
      await h.invoke("runtime-ui:releaseImage", { ...h.request, handle: h.image.handle }),
    ).toEqual({ success: true, value: null });
    expect(h.store.release).toHaveBeenCalledWith(h.instance.owner, h.image.handle);
    expect(
      await h.invoke("runtime-ui:readImage", {
        ...h.request,
        handle: h.image.handle,
        path: "/not-a-handle",
      }),
    ).toMatchObject({ success: false });
  });
});
