import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeUiAttachmentStore } from "./runtime-ui-attachments";
import type { SelectedSessionOwner, SelectedSessionTarget } from "./selected-session-delivery";

const owner: SelectedSessionOwner = {
  extensionId: "example.reviews",
  applicationId: "review",
  applicationScope: "user",
  workspaceName: "marshal",
};
const target: SelectedSessionTarget = {
  sessionId: "selected-session",
  workspaceName: "Engineering",
  runtimeId: "test",
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l4sAAAAASUVORK5CYII=",
  "base64",
);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
async function harness() {
  const root = await mkdtemp(path.join(os.tmpdir(), "marshal-ui-image-test-"));
  const isOwnerActive = vi.fn<() => boolean>(() => true);
  const supportsTargetImages = vi.fn<() => boolean>(() => true);
  let now = Date.now();
  const store = await RuntimeUiAttachmentStore.create({
    directory: path.join(root, "managed"),
    isOwnerActive,
    supportsTargetImages,
    now: () => now,
  });
  cleanups.push(async () => {
    await store.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const original = path.join(root, "screenshot.png");
  await writeFile(original, png);
  return {
    store,
    original,
    root,
    isOwnerActive,
    supportsTargetImages,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("native runtime UI image handles", () => {
  it("imports sniffed bytes into the same owner-bound expiring leased store", async () => {
    const h = await harness();
    const handle = await h.store.importImage(owner, {
      base64: png.toString("base64"),
      mimeType: "image/png",
      displayName: "download.png",
    });
    expect(handle).toMatchObject({
      mimeType: "image/png",
      displayName: "download.png",
      byteLength: png.length,
    });
    expect(handle).not.toHaveProperty("path");
    expect(await h.store.readImage(owner, handle.handle)).toEqual({
      mimeType: "image/png",
      data: png.toString("base64"),
    });
    await expect(
      h.store.readImage({ ...owner, applicationId: "other" }, handle.handle),
    ).rejects.toMatchObject({ code: "permission_denied" });
    const lease = await h.store.resolve({ owner, target, handles: [handle.handle] });
    h.advance(8 * 60 * 60 * 1000);
    expect(await h.store.listImages(owner)).toEqual([]);
    expect(await readFile(lease.attachments[0].path)).toEqual(png);
    await lease.dispose?.();
    await expect(stat(lease.attachments[0].path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { base64: "" },
    { base64: "%%%=" },
    { base64: "Zh==" },
    { base64: `data:image/png;base64,${png.toString("base64")}` },
    { base64: `${png.toString("base64")}\n` },
    { base64: Buffer.from("<svg />").toString("base64") },
    { base64: png.toString("base64"), mimeType: "image/jpeg" as const },
    { base64: png.toString("base64"), displayName: "../image.png" },
    { base64: png.toString("base64"), displayName: "bad\u0000.png" },
    { base64: Buffer.alloc(3_750_001).toString("base64") },
  ])("rejects malformed, spoofed or oversized image import %#", async (input) => {
    const h = await harness();
    await expect(h.store.importImage(owner, input)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(await h.store.listImages(owner)).toEqual([]);
  });

  it("cleans imported bytes when invocation authority expires before commit", async () => {
    const h = await harness();
    const guard = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        Object.assign(new Error("Expired token"), { code: "permission_denied" }),
      );
    await expect(
      h.store.importImage(owner, { base64: png.toString("base64") }, guard),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(guard).toHaveBeenCalledTimes(2);
    expect(await h.store.listImages(owner)).toEqual([]);
    const [managed] = await readdir(path.join(h.root, "managed"));
    expect(await readdir(path.join(h.root, "managed", managed))).toEqual([]);
  });

  it("shares the aggregate count limit with picker images and frees released handles", async () => {
    const h = await harness();
    const imports = await Promise.all(
      Array.from({ length: 128 }, () =>
        h.store.importImage(owner, { base64: png.toString("base64") }),
      ),
    );
    await expect(h.store.selectImages(owner, [h.original])).rejects.toMatchObject({
      code: "invalid_input",
    });
    await h.store.release(owner, imports[0].handle);
    expect(await h.store.selectImages(owner, [h.original])).toHaveLength(1);
  });

  it("enforces the aggregate byte limit across imports and reclaims expired handles", async () => {
    const h = await harness();
    const bytes = Buffer.alloc(3_750_000);
    png.copy(bytes);
    const base64 = bytes.toString("base64");
    await Promise.all(Array.from({ length: 17 }, () => h.store.importImage(owner, { base64 })));
    await expect(h.store.importImage(owner, { base64 })).rejects.toMatchObject({
      code: "invalid_input",
    });
    h.advance(8 * 60 * 60 * 1000);
    expect(await h.store.importImage(owner, { base64 })).toMatchObject({
      byteLength: bytes.length,
    });
    expect(await h.store.listImages(owner)).toHaveLength(1);
  });

  it("copies native selected raster bytes and exposes only opaque owner-bound handles", async () => {
    const h = await harness();
    const [handle] = await h.store.selectImages(owner, [h.original]);
    expect(handle).toMatchObject({
      mimeType: "image/png",
      displayName: "screenshot.png",
      byteLength: png.length,
    });
    expect(handle).not.toHaveProperty("path");
    await writeFile(h.original, "original file changed");
    expect(await h.store.readImage(owner, handle.handle)).toEqual({
      mimeType: "image/png",
      data: png.toString("base64"),
    });
    await expect(
      h.store.readImage({ ...owner, applicationId: "other" }, handle.handle),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(h.store.readImage(owner, h.original)).rejects.toMatchObject({
      code: "permission_denied",
    });
  });

  it("holds the copied file through delivery and releases it exactly once after revocation", async () => {
    const h = await harness();
    const [handle] = await h.store.selectImages(owner, [h.original]);
    const lease = await h.store.resolve({ owner, target, handles: [handle.handle] });
    const localPath = lease.attachments[0].path;
    expect(localPath).not.toBe(h.original);
    expect(await readFile(localPath)).toEqual(png);
    await h.store.revokeOwner(owner);
    await expect(h.store.readImage(owner, handle.handle)).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect((await stat(localPath)).size).toBe(png.length);
    await lease.dispose?.();
    await lease.dispose?.();
    await expect(stat(localPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("checks target image support and denies expired, disabled, duplicate, or foreign handles", async () => {
    const h = await harness();
    const [handle] = await h.store.selectImages(owner, [h.original]);
    h.supportsTargetImages.mockReturnValue(false);
    await expect(
      h.store.resolve({ owner, target, handles: [handle.handle] }),
    ).rejects.toMatchObject({ code: "unsupported" });
    h.supportsTargetImages.mockReturnValue(true);
    await expect(
      h.store.resolve({ owner, target, handles: [handle.handle, handle.handle] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      h.store.resolve({
        owner: { ...owner, extensionId: "other" },
        target,
        handles: [handle.handle],
      }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    h.isOwnerActive.mockReturnValue(false);
    await expect(h.store.readImage(owner, handle.handle)).rejects.toMatchObject({
      code: "permission_denied",
    });
    h.isOwnerActive.mockReturnValue(true);
    h.advance(8 * 60 * 60 * 1000);
    await expect(
      h.store.resolve({ owner, target, handles: [handle.handle] }),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("rejects non-raster data, symlinks, oversized files and arbitrary directories", async () => {
    const h = await harness();
    const disguised = path.join(h.root, "disguised.png");
    await writeFile(disguised, '<svg onload="alert(1)"></svg>');
    await expect(h.store.selectImages(owner, [disguised])).rejects.toMatchObject({
      code: "invalid_input",
    });
    const link = path.join(h.root, "link.png");
    await symlink(h.original, link);
    await expect(h.store.selectImages(owner, [link])).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(h.store.selectImages(owner, [h.root])).rejects.toMatchObject({
      code: "invalid_input",
    });
    const oversized = path.join(h.root, "oversized.png");
    await writeFile(oversized, Buffer.alloc(3_750_001));
    await expect(h.store.selectImages(owner, [oversized])).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      h.store.selectImages(
        owner,
        Array.from({ length: 9 }, () => h.original),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("detects changes to managed attachment bytes before exposing them", async () => {
    const h = await harness();
    const [handle] = await h.store.selectImages(owner, [h.original]);
    const lease = await h.store.resolve({ owner, target, handles: [handle.handle] });
    await chmod(lease.attachments[0].path, 0o600);
    await writeFile(lease.attachments[0].path, Buffer.from(png).fill(1, png.length - 3));
    await expect(h.store.readImage(owner, handle.handle)).rejects.toMatchObject({
      code: "permission_denied",
    });
    await lease.dispose?.();
  });

  it("fails closed after store disposal while preserving in-flight attachment leases", async () => {
    const h = await harness();
    const [handle] = await h.store.selectImages(owner, [h.original]);
    const lease = await h.store.resolve({ owner, target, handles: [handle.handle] });
    await h.store.dispose();
    await expect(h.store.selectImages(owner, [h.original])).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(await readFile(lease.attachments[0].path)).toEqual(png);
    await lease.dispose?.();
    await expect(stat(lease.attachments[0].path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("revokes handles after publication removal even when there is no open view", async () => {
    const h = await harness();
    const [handle] = await h.store.selectImages(owner, [h.original]);
    const sibling = { ...owner, applicationId: "another-app" };
    const [other] = await h.store.selectImages(sibling, [h.original]);
    await h.store.revokeApplication({
      extensionId: owner.extensionId,
      applicationId: owner.applicationId,
    });
    expect(await h.store.listImages(owner)).toEqual([]);
    await expect(h.store.readImage(owner, handle.handle)).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(await h.store.listImages(sibling)).toEqual([other]);
  });
});
