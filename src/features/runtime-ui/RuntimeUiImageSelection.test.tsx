import type { RuntimeUiAPI } from "@common/marshal-ipc-contract";
import type { RuntimeUiImageHandle, RuntimeUiInstance } from "@common/runtime-ui";
import { use } from "react";
import { expect, it, vi } from "vitest";

import { installMockAPIs, render, screen, userEvent, waitFor } from "@/test-utils";

import { testDouble } from "../../../electron/testing/harness";
import { createRuntimeUiApplicationHost } from "./RuntimeUiApplicationHost";
import {
  RuntimeUiImageSelection,
  RuntimeUiRefreshImagesContext,
  RuntimeUiSelectedImagesContext,
} from "./RuntimeUiImageSelection";

function SelectedImages() {
  const images = use(RuntimeUiSelectedImagesContext);
  return (
    <output data-testid="image-handles">{images.map((image) => image.handle).join(",")}</output>
  );
}

it("refreshes nested imports into native chrome before an immediate owned resource read", async () => {
  installMockAPIs();
  const image: RuntimeUiImageHandle = {
    handle: "imported-image",
    mimeType: "image/png",
    displayName: "Imported.png",
    byteLength: 18,
    expiresAt: "2026-09-09T14:00:00.000Z",
  };
  let images: RuntimeUiImageHandle[] = [];
  const readImage = vi.fn<NonNullable<RuntimeUiAPI["readImage"]>>(async () => ({
    success: true,
    value: { mimeType: "image/png", data: "imported-base64" },
  }));
  window.runtimeUiAPI = testDouble<RuntimeUiAPI>({
    listImages: vi.fn<NonNullable<RuntimeUiAPI["listImages"]>>(async () => ({
      success: true,
      value: images,
    })),
    selectImages: vi.fn<NonNullable<RuntimeUiAPI["selectImages"]>>(),
    releaseImage: vi.fn<NonNullable<RuntimeUiAPI["releaseImage"]>>(),
    readResource: vi.fn<NonNullable<RuntimeUiAPI["readResource"]>>(),
    readImage,
    invokeCapability: vi.fn<NonNullable<RuntimeUiAPI["invokeCapability"]>>(async () => {
      images = [image];
      return { success: true, value: { output: { downloaded: image.handle } } };
    }),
  });
  const instance = testDouble<RuntimeUiInstance>({
    instanceId: "app",
    owner: {
      applicationScope: "user",
      workspaceName: "marshal",
      extensionId: "fixture",
      applicationId: "review",
    },
    content: {
      kind: "application",
      renderId: "fixture-render",
      resource: { uri: "ui://fixture/review", mimeType: "text/html" },
      descriptor: {
        version: "1.0.0",
        presentationModes: ["inline"],
        actions: [],
        tools: [],
        wantsImages: true,
      },
    },
  });
  let completed = false;
  function ImportControl() {
    const selectedImages = use(RuntimeUiSelectedImagesContext);
    const refreshImages = use(RuntimeUiRefreshImagesContext);
    const host = createRuntimeUiApplicationHost(
      instance,
      { id: "test", SourceEditor: () => null },
      undefined,
      selectedImages,
      refreshImages,
    );
    return (
      <button
        type="button"
        onClick={async () => {
          await host.invokeCapability({
            capability: "example.download",
            input: {},
            idempotencyKey: "download-one",
          });
          expect(host.selectedImages).toEqual([image]);
          expect(await host.readImage?.(image.handle)).toEqual({
            mimeType: "image/png",
            data: "imported-base64",
          });
          completed = true;
        }}
      >
        Download image
      </button>
    );
  }
  render(
    <RuntimeUiImageSelection instance={instance}>
      <ImportControl />
    </RuntimeUiImageSelection>,
  );
  await userEvent.setup().click(screen.getByRole("button", { name: "Download image" }));
  await waitFor(() => expect(completed).toBe(true));
  expect(screen.getByText("Imported.png")).toBeVisible();
  expect(readImage).toHaveBeenCalledWith({
    ...instance.owner,
    instanceId: instance.instanceId,
    handle: image.handle,
  });
});

it("opens the native image picker, exposes owned handles and removes attachments", async () => {
  installMockAPIs();
  const image: RuntimeUiImageHandle = {
    handle: "owned-image",
    mimeType: "image/png",
    displayName: "Screenshot.png",
    byteLength: 18,
    expiresAt: "2026-09-09T14:00:00.000Z",
  };
  let images: RuntimeUiImageHandle[] = [];
  const selectImages = vi.fn<NonNullable<RuntimeUiAPI["selectImages"]>>(async () => {
    images = [image];
    return { success: true, value: images };
  });
  const releaseImage = vi.fn<NonNullable<RuntimeUiAPI["releaseImage"]>>(async () => {
    images = [];
    return { success: true, value: null };
  });
  window.runtimeUiAPI = testDouble<RuntimeUiAPI>({
    listImages: vi.fn<NonNullable<RuntimeUiAPI["listImages"]>>(async () => ({
      success: true,
      value: images,
    })),
    selectImages,
    releaseImage,
  });
  const instance = testDouble<RuntimeUiInstance>({
    instanceId: "app",
    owner: {
      applicationScope: "user",
      workspaceName: "marshal",
      extensionId: "fixture",
      applicationId: "review",
    },
    content: {
      kind: "application",
      renderId: "fixture-render",
      resource: { uri: "ui://fixture/review", mimeType: "text/html" },
      descriptor: {
        version: "1.0.0",
        presentationModes: ["inline"],
        actions: [],
        tools: [],
        wantsImages: true,
      },
    },
  });
  render(
    <RuntimeUiImageSelection instance={instance}>
      <SelectedImages />
    </RuntimeUiImageSelection>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Attach images" }));
  await waitFor(() => expect(screen.getByTestId("image-handles")).toHaveTextContent("owned-image"));
  expect(selectImages).toHaveBeenCalledWith({ ...instance.owner, instanceId: instance.instanceId });
  expect(screen.getByText("Screenshot.png")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Remove Screenshot.png" }));
  await waitFor(() => expect(screen.getByTestId("image-handles")).toBeEmptyDOMElement());
  expect(releaseImage).toHaveBeenCalledWith({
    ...instance.owner,
    instanceId: instance.instanceId,
    handle: image.handle,
  });
});

it("renders no attachment chrome for applications that do not declare wantsImages", async () => {
  window.runtimeUiAPI = testDouble<RuntimeUiAPI>({
    listImages: vi.fn<NonNullable<RuntimeUiAPI["listImages"]>>(async () => ({
      success: true,
      value: [],
    })),
    selectImages: vi.fn<NonNullable<RuntimeUiAPI["selectImages"]>>(),
    releaseImage: vi.fn<NonNullable<RuntimeUiAPI["releaseImage"]>>(),
  });
  const instance = testDouble<RuntimeUiInstance>({
    instanceId: "app",
    owner: {
      applicationScope: "user",
      workspaceName: "marshal",
      extensionId: "fixture",
      applicationId: "review",
    },
    content: {
      kind: "application",
      renderId: "fixture-render",
      resource: { uri: "ui://fixture/review", mimeType: "text/html" },
      descriptor: { version: "1.0.0", presentationModes: ["inline"], actions: [], tools: [] },
    },
  });
  render(
    <RuntimeUiImageSelection instance={instance}>
      <SelectedImages />
    </RuntimeUiImageSelection>,
  );
  await waitFor(() => expect(screen.queryByRole("button", { name: "Attach images" })).toBeNull());
});
