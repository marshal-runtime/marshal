import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { RuntimeUiImageHandle, RuntimeUiImageMimeType } from "../../common/runtime-ui";
import {
  normalizeSelectedSessionOwner,
  type SelectedSessionDeliveryOptions,
  type SelectedSessionOwner,
  type SelectedSessionTarget,
} from "./selected-session-delivery";

export interface RuntimeUiImageImportInput {
  base64: string;
  mimeType?: RuntimeUiImageMimeType;
  displayName?: string;
}
type RasterMime = RuntimeUiImageMimeType;
interface PreparedImage {
  bytes: Buffer;
  mimeType: RasterMime;
  displayName: string;
}
interface StoredImage extends RuntimeUiImageHandle {
  owner: string;
  ownerIdentity: SelectedSessionOwner;
  path: string;
  digest: string;
  leases: number;
  revoked: boolean;
}
export interface RuntimeUiAttachmentStoreOptions {
  directory: string;
  isOwnerActive(owner: SelectedSessionOwner): boolean | Promise<boolean>;
  supportsTargetImages(target: SelectedSessionTarget): boolean | Promise<boolean>;
  now?: () => number;
}

const MAX_IMAGE_BYTES = 3_750_000;
const MAX_IMAGES = 8;
const MAX_SEND_BYTES = 12_000_000;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_STORE_IMAGES = 128;
const TTL_MS = 8 * 60 * 60 * 1000;

/** Native picker and bounded imported bytes use private files and owner-bound handles. */
export class RuntimeUiAttachmentStore {
  private readonly images = new Map<string, StoredImage>();
  private readonly now: () => number;
  private closed = false;
  private mutationTail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly directory: string,
    private readonly options: RuntimeUiAttachmentStoreOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  static async create(options: RuntimeUiAttachmentStoreOptions): Promise<RuntimeUiAttachmentStore> {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const root = await lstat(options.directory);
    if (!root.isDirectory() || root.isSymbolicLink())
      throw denied("Attachment directory must be a managed directory.");
    const directory = await mkdtemp(path.join(options.directory, "runtime-ui-images-"));
    return new RuntimeUiAttachmentStore(directory, options);
  }

  async selectImages(
    ownerValue: SelectedSessionOwner,
    nativePaths: readonly string[],
  ): Promise<RuntimeUiImageHandle[]> {
    const owner = normalizeSelectedSessionOwner(ownerValue);
    return this.exclusive(async () => {
      await this.authorize(owner);
      if (!Array.isArray(nativePaths) || nativePaths.length < 1 || nativePaths.length > MAX_IMAGES)
        throw invalid("Select from one to eight images.");
      await this.prune();
      const prepared = await Promise.all(
        nativePaths.map(async (filePath) => {
          if (typeof filePath !== "string" || !path.isAbsolute(filePath))
            throw invalid("The native picker must return absolute file paths.");
          const bytes = await readBoundedNativeFile(filePath);
          const mimeType = detectRaster(bytes);
          if (!mimeType) throw invalid("Only PNG, JPEG, GIF and WebP image bytes are accepted.");
          return { bytes, mimeType, displayName: path.basename(filePath).slice(0, 256) };
        }),
      );
      return this.persistImages(owner, prepared);
    });
  }

  async importImage(
    ownerValue: SelectedSessionOwner,
    input: RuntimeUiImageImportInput,
    assertCurrent?: () => Promise<void>,
  ): Promise<RuntimeUiImageHandle> {
    const owner = normalizeSelectedSessionOwner(ownerValue);
    return this.exclusive(async () => {
      await this.authorize(owner);
      await assertCurrent?.();
      const { base64, mimeType, displayName } = input;
      if (
        typeof base64 !== "string" ||
        !base64.length ||
        base64.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) ||
        base64.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
      )
        throw invalid("Provide canonical base64 image bytes up to 3.75 MB.");
      const bytes = Buffer.from(base64, "base64");
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== base64)
        throw invalid("Provide canonical base64 image bytes up to 3.75 MB.");
      const detected = detectRaster(bytes);
      if (!detected) throw invalid("Only PNG, JPEG, GIF and WebP image bytes are accepted.");
      if (mimeType !== undefined && mimeType !== detected)
        throw invalid("The supplied MIME type does not match the image bytes.");
      if (
        displayName !== undefined &&
        (typeof displayName !== "string" ||
          !displayName.trim() ||
          displayName.length > 256 ||
          /[\p{Cc}/\\]/u.test(displayName))
      )
        throw invalid("Image displayName must be a label of 1 to 256 characters without paths.");
      await this.prune();
      const [handle] = await this.persistImages(
        owner,
        [
          {
            bytes,
            mimeType: detected,
            displayName: displayName ?? `image${extensionFor(detected)}`,
          },
        ],
        assertCurrent,
      );
      return handle;
    });
  }

  async readImage(
    ownerValue: SelectedSessionOwner,
    handle: string,
  ): Promise<{ mimeType: RasterMime; data: string }> {
    const owner = normalizeSelectedSessionOwner(ownerValue);
    return this.exclusive(async () => {
      await this.authorize(owner);
      await this.prune();
      const image = this.requireImage(owner, handle);
      const bytes = await this.verifiedBytes(image);
      await this.authorize(owner);
      return { mimeType: image.mimeType, data: bytes.toString("base64") };
    });
  }

  async listImages(ownerValue: SelectedSessionOwner): Promise<RuntimeUiImageHandle[]> {
    const owner = normalizeSelectedSessionOwner(ownerValue);
    return this.exclusive(async () => {
      await this.authorize(owner);
      await this.prune();
      return [...this.images.values()]
        .filter(
          (image) =>
            image.owner === ownerKey(owner) &&
            !image.revoked &&
            Date.parse(image.expiresAt) > this.now(),
        )
        .map(publicHandle);
    });
  }

  async resolve(request: {
    owner: SelectedSessionOwner;
    target: SelectedSessionTarget;
    handles: readonly string[];
  }): Promise<
    Awaited<ReturnType<NonNullable<SelectedSessionDeliveryOptions["resolveAttachments"]>>>
  > {
    const owner = normalizeSelectedSessionOwner(request.owner);
    return this.exclusive(async () => {
      await this.authorize(owner);
      if (!(await this.options.supportsTargetImages(request.target)))
        throw Object.assign(
          new Error("The selected provider has no verified native image delivery support."),
          { code: "unsupported" },
        );
      if (
        !Array.isArray(request.handles) ||
        request.handles.length < 1 ||
        request.handles.length > MAX_IMAGES ||
        new Set(request.handles).size !== request.handles.length
      )
        throw invalid("Provide one to eight distinct image handles.");
      await this.prune();
      const images = request.handles.map((handle) => this.requireImage(owner, handle));
      if (images.reduce((sum, image) => sum + image.byteLength, 0) > MAX_SEND_BYTES)
        throw invalid("Attachment handles exceed the 12 MB delivery limit.");
      await Promise.all(images.map((image) => this.verifiedBytes(image)));
      await this.authorize(owner);
      for (const image of images) image.leases += 1;
      let released = false;
      return {
        attachments: images.map((image) => ({
          type: "file",
          path: image.path,
          displayName: image.displayName,
          byteLength: image.byteLength,
        })),
        dispose: () =>
          this.exclusive(async () => {
            if (released) return;
            released = true;
            for (const image of images) image.leases = Math.max(0, image.leases - 1);
            await this.prune();
            if (this.closed && this.images.size === 0)
              await rm(this.directory, { recursive: true, force: true });
          }),
      };
    });
  }

  async release(ownerValue: SelectedSessionOwner, handle: string): Promise<void> {
    const owner = normalizeSelectedSessionOwner(ownerValue);
    await this.exclusive(async () => {
      await this.authorize(owner);
      const image = this.requireImage(owner, handle);
      image.revoked = true;
      await this.prune();
    });
  }

  async revokeOwner(ownerValue: SelectedSessionOwner): Promise<void> {
    const key = ownerKey(normalizeSelectedSessionOwner(ownerValue));
    await this.exclusive(async () => {
      for (const image of this.images.values()) if (image.owner === key) image.revoked = true;
      await this.prune();
    });
  }

  async revokeApplication(identity: { extensionId: string; applicationId: string }): Promise<void> {
    await this.exclusive(async () => {
      for (const image of this.images.values()) {
        if (
          image.ownerIdentity.extensionId === identity.extensionId &&
          image.ownerIdentity.applicationId === identity.applicationId
        )
          image.revoked = true;
      }
      await this.prune();
    });
  }

  async dispose(): Promise<void> {
    await this.exclusive(async () => {
      this.closed = true;
      for (const image of this.images.values()) image.revoked = true;
      await this.prune();
      if (this.images.size === 0) await rm(this.directory, { recursive: true, force: true });
    });
  }

  private async persistImages(
    owner: SelectedSessionOwner,
    prepared: readonly PreparedImage[],
    assertCurrent?: () => Promise<void>,
  ): Promise<RuntimeUiImageHandle[]> {
    const total = prepared.reduce((sum, image) => sum + image.bytes.length, 0);
    const storedBytes = [...this.images.values()].reduce((sum, image) => sum + image.byteLength, 0);
    if (total > MAX_SEND_BYTES) throw invalid("Selected images exceed the 12 MB delivery limit.");
    if (
      this.images.size + prepared.length > MAX_STORE_IMAGES ||
      storedBytes + total > MAX_STORE_BYTES
    )
      throw invalid("The application image store is full; release unused handles first.");
    await this.authorize(owner);
    const created = prepared.map((image): StoredImage => {
      const handle = randomUUID();
      return {
        handle,
        mimeType: image.mimeType,
        displayName: image.displayName,
        byteLength: image.bytes.length,
        expiresAt: new Date(this.now() + TTL_MS).toISOString(),
        owner: ownerKey(owner),
        ownerIdentity: owner,
        path: path.join(this.directory, handle + extensionFor(image.mimeType)),
        digest: digest(image.bytes),
        leases: 0,
        revoked: false,
      };
    });
    try {
      const writes = await Promise.allSettled(
        created.map((image, index) =>
          writeFile(image.path, prepared[index].bytes, { flag: "wx", mode: 0o400 }),
        ),
      );
      const failed = writes.find((write) => write.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      await this.authorize(owner);
      await assertCurrent?.();
      for (const image of created) this.images.set(image.handle, image);
      return created.map(publicHandle);
    } catch (error) {
      await Promise.all(created.map((image) => rm(image.path, { force: true })));
      throw error;
    }
  }

  private async verifiedBytes(image: StoredImage): Promise<Buffer> {
    const bytes = await readBoundedNativeFile(image.path);
    if (bytes.length !== image.byteLength || digest(bytes) !== image.digest)
      throw denied("Stored attachment bytes changed; select the image again.");
    return bytes;
  }
  private requireImage(owner: SelectedSessionOwner, handle: string): StoredImage {
    const image = this.images.get(handle);
    if (
      !image ||
      image.owner !== ownerKey(owner) ||
      image.revoked ||
      Date.parse(image.expiresAt) <= this.now()
    )
      throw denied("The image handle is unavailable for this application; select it again.");
    return image;
  }
  private async authorize(owner: SelectedSessionOwner): Promise<void> {
    if (this.closed || !(await this.options.isOwnerActive(owner)))
      throw denied("The extension application owner is inactive.");
  }
  private async prune(): Promise<void> {
    await Promise.all(
      [...this.images.entries()]
        .filter(
          ([, image]) =>
            !image.leases && (image.revoked || Date.parse(image.expiresAt) <= this.now()),
        )
        .map(async ([handle, image]) => {
          await rm(image.path, { force: true });
          this.images.delete(handle);
        }),
    );
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}

async function readBoundedNativeFile(filePath: string): Promise<Buffer> {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_IMAGE_BYTES || stat.size < 1)
    throw invalid("Images must be regular files up to 3.75 MB.");
  const file = await open(
    filePath,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const opened = await file.stat();
    if (
      !opened.isFile() ||
      opened.size > MAX_IMAGE_BYTES ||
      opened.size < 1 ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino
    )
      throw invalid("The selected file changed while opening it.");
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      // Each read advances the offset by the bytes actually read; parallel reads would race that boundary.
      // eslint-disable-next-line no-await-in-loop
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== opened.size) throw invalid("The selected image changed while reading it.");
    return buffer.subarray(0, length);
  } finally {
    await file.close();
  }
}
function detectRaster(bytes: Buffer): RasterMime | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  return undefined;
}
function extensionFor(mime: RasterMime): string {
  return { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" }[
    mime
  ];
}
function publicHandle(image: StoredImage): RuntimeUiImageHandle {
  return {
    handle: image.handle,
    mimeType: image.mimeType,
    displayName: image.displayName,
    byteLength: image.byteLength,
    expiresAt: image.expiresAt,
  };
}
function ownerKey(owner: SelectedSessionOwner): string {
  return JSON.stringify(owner);
}
function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: "invalid_input" });
}
function denied(message: string): Error {
  return Object.assign(new Error(message), { code: "permission_denied" });
}
