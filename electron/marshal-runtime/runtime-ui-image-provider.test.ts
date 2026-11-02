import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { InvocationContext } from "@marshal/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeApplicationAuthority } from "./application-authority";
import { RuntimeUiAttachmentStore } from "./runtime-ui-attachments";
import { createRuntimeUiImageProvider, RUNTIME_UI_IMAGE_IMPORT } from "./runtime-ui-image-provider";

const owner = {
  extensionId: "example",
  applicationId: "review",
  applicationScope: "user" as const,
  workspaceName: "marshal",
};
const base64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l4sAAAAASUVORK5CYII=";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function harness() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "marshal-image-provider-"));
  const store = await RuntimeUiAttachmentStore.create({
    directory,
    isOwnerActive: () => true,
    supportsTargetImages: () => true,
  });
  cleanups.push(async () => {
    await store.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const authority = new RuntimeApplicationAuthority();
  const getStore = vi.fn<() => Promise<RuntimeUiAttachmentStore>>().mockResolvedValue(store);
  const provider = createRuntimeUiImageProvider(getStore, authority);
  const isActive = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const capabilities = new Set([RUNTIME_UI_IMAGE_IMPORT]);
  const run = <T>(operation: (context: InvocationContext) => T | Promise<T>) =>
    authority.run({ owner, workspacePath: directory, capabilities, isActive }, async (context) =>
      operation({ principal: { id: "application", kind: "user" }, metadata: context.metadata }),
    );
  return { store, authority, getStore, provider, isActive, capabilities, run };
}

describe("authenticated runtime UI image import provider", () => {
  it("returns a direct managed handle owned by the native token despite forged tracing metadata", async () => {
    const h = await harness();
    expect(h.getStore).not.toHaveBeenCalled();
    expect(
      await h.run((context) => h.provider.get?.(RUNTIME_UI_IMAGE_IMPORT, context)),
    ).toMatchObject({
      permissions: [{ permission: RUNTIME_UI_IMAGE_IMPORT }],
    });
    const result = await h.run((context) =>
      h.provider.invoke(
        RUNTIME_UI_IMAGE_IMPORT,
        { base64 },
        {
          ...context,
          metadata: {
            ...context.metadata,
            runtimeExtensionIdentity: "foreign",
            runtimeApplicationId: "foreign",
          },
          scope: { sessionId: "synthetic" },
        },
      ),
    );
    const [image] = await h.store.listImages(owner);
    expect(result.output).toEqual(image);
    expect(image).toMatchObject({ mimeType: "image/png", displayName: "image.png" });
    await expect(
      h.store.readImage({ ...owner, extensionId: "foreign" }, image.handle),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(await h.store.listImages({ ...owner, applicationId: "foreign" })).toEqual([]);
  });

  it("rejects missing, forged, expired and undeclared authority before opening the store", async () => {
    const h = await harness();
    const forged: InvocationContext = {
      principal: { id: "agent", kind: "agent" },
      metadata: {
        marshalApplicationInvocation: "fake",
        runtimeExtensionIdentity: owner.extensionId,
        runtimeApplicationId: owner.applicationId,
        runtimeApplicationScope: "user",
        marshalWorkspaceName: "marshal",
      },
    };
    await expect(
      h.provider.invoke(RUNTIME_UI_IMAGE_IMPORT, { base64 }, forged),
    ).rejects.toMatchObject({ code: "permission_denied" });
    let saved = forged;
    await h.run(async (context) => {
      saved = context;
    });
    await expect(
      h.provider.invoke(RUNTIME_UI_IMAGE_IMPORT, { base64 }, saved),
    ).rejects.toMatchObject({ code: "permission_denied" });
    h.capabilities.clear();
    await expect(
      h.run((context) => h.provider.invoke(RUNTIME_UI_IMAGE_IMPORT, { base64 }, context)),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(h.getStore).not.toHaveBeenCalled();
  });

  it("revalidates current publication after writing and removes bytes when it becomes inactive", async () => {
    const h = await harness();
    h.isActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await expect(
      h.run((context) => h.provider.invoke(RUNTIME_UI_IMAGE_IMPORT, { base64 }, context)),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(await h.store.listImages(owner)).toEqual([]);
    expect(h.isActive).toHaveBeenCalledTimes(4);
  });

  it.each([
    null,
    [],
    {},
    { base64, owner },
    { base64, path: "/tmp/image.png" },
    { base64, mimeType: "image/svg+xml" },
    { base64, mimeType: "image/jpeg" },
    { base64: "invalid" },
    { base64, displayName: "../unsafe.png" },
  ])("rejects invalid input without path or owner forwarding %#", async (input) => {
    const h = await harness();
    await expect(
      h.run((context) => h.provider.invoke(RUNTIME_UI_IMAGE_IMPORT, input, context)),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(await h.store.listImages(owner)).toEqual([]);
  });

  it("honors cancellation and rejects unknown capabilities", async () => {
    const h = await harness();
    await expect(
      h.run((context) =>
        h.provider.invoke(
          RUNTIME_UI_IMAGE_IMPORT,
          { base64 },
          { ...context, signal: AbortSignal.abort() },
        ),
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    await expect(
      h.run((context) => h.provider.invoke("marshal.ui.image.other", { base64 }, context)),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(h.getStore).not.toHaveBeenCalled();
  });
});
