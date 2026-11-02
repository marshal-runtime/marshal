// Marshal ownership: relocated module identity.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addImageProtocolHeaders,
  extractImagePaths,
  hasImageMagicBytes,
  isImageExtension,
  isInsideWorkspace,
} from "./image-utils";

// ---------------------------------------------------------------------------
// isImageExtension
// ---------------------------------------------------------------------------
describe("isImageExtension", () => {
  it.each(["png", "jpg", "jpeg", "gif", "svg", "webp"])("allows .%s", (ext) => {
    expect(isImageExtension(`/some/path/file.${ext}`)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isImageExtension("C:\\Users\\test\\PHOTO.PNG")).toBe(true);
    expect(isImageExtension("image.JPG")).toBe(true);
  });

  it.each(["txt", "json", "env", "pem", "js", "ts", "exe", "csv", "bmp", "ico"])(
    "rejects .%s",
    (ext) => {
      expect(isImageExtension(`/some/path/file.${ext}`)).toBe(false);
    },
  );

  it("rejects files without extension", () => {
    expect(isImageExtension("/etc/passwd")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isInsideWorkspace
// ---------------------------------------------------------------------------
describe("isInsideWorkspace", () => {
  const workspace = path.join(os.tmpdir(), "test-workspace");

  it("allows files inside workspace", () => {
    expect(isInsideWorkspace(path.join(workspace, "diagram.png"), workspace)).toBe(true);
  });

  it("allows files in subdirectories", () => {
    expect(isInsideWorkspace(path.join(workspace, "sub", "dir", "img.png"), workspace)).toBe(true);
  });

  it("rejects files outside workspace", () => {
    expect(isInsideWorkspace(path.join(os.tmpdir(), "other", "secret.png"), workspace)).toBe(false);
  });

  it("rejects parent directory traversal", () => {
    expect(isInsideWorkspace(path.join(workspace, "..", "secret.png"), workspace)).toBe(false);
  });

  it("rejects the workspace directory itself (not a file)", () => {
    expect(isInsideWorkspace(workspace, workspace)).toBe(false);
  });

  it("rejects prefix-matched sibling directories", () => {
    // "test-workspace-evil" starts with "test-workspace" but is a different dir
    expect(
      isInsideWorkspace(path.join(os.tmpdir(), "test-workspace-evil", "img.png"), workspace),
    ).toBe(false);
  });

  it.skipIf(process.platform !== "win32")("is case-insensitive on Windows", () => {
    const upper = workspace.toUpperCase();
    const lower = workspace.toLowerCase();
    expect(isInsideWorkspace(path.join(upper, "img.png"), workspace)).toBe(true);
    expect(isInsideWorkspace(path.join(lower, "img.png"), workspace)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasImageMagicBytes
// ---------------------------------------------------------------------------
describe("hasImageMagicBytes", () => {
  const tmpDir = path.join(os.tmpdir(), "image-utils-test-" + Date.now());

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(name: string, data: Buffer) {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, data);
    return p;
  }

  it("detects PNG", async () => {
    const p = writeFile("test.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(await hasImageMagicBytes(p)).toBe(true);
  });

  it("detects JPEG", async () => {
    const p = writeFile("test.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    expect(await hasImageMagicBytes(p)).toBe(true);
  });

  it("detects GIF", async () => {
    const p = writeFile("test.gif", Buffer.from("GIF89a"));
    expect(await hasImageMagicBytes(p)).toBe(true);
  });

  it("detects WebP (RIFF + WEBP at offset 8)", async () => {
    const p = writeFile("test.webp", Buffer.from("RIFF\x00\x00\x00\x00WEBP"));
    expect(await hasImageMagicBytes(p)).toBe(true);
  });

  it("rejects non-WebP RIFF file (e.g. WAV)", async () => {
    const p = writeFile("test.wav", Buffer.from("RIFF\x00\x00\x00\x00WAVE"));
    expect(await hasImageMagicBytes(p)).toBe(false);
  });

  it("rejects text file with .png extension", async () => {
    const p = writeFile("fake.png", Buffer.from("This is not an image"));
    expect(await hasImageMagicBytes(p)).toBe(false);
  });

  it("rejects JSON file", async () => {
    const p = writeFile("data.json", Buffer.from('{"key": "value"}'));
    expect(await hasImageMagicBytes(p)).toBe(false);
  });

  it("returns false for non-existent file", async () => {
    expect(await hasImageMagicBytes(path.join(tmpDir, "nope.png"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractImagePaths (existing function — basic coverage)
// ---------------------------------------------------------------------------
describe("extractImagePaths", () => {
  it("extracts file:// image paths from markdown", () => {
    const text = "Here is an image: ![diagram](file:///C:/Users/test/img.png)";
    const images = extractImagePaths(text);
    expect(images).toHaveLength(1);
    expect(images[0].altText).toBe("diagram");
  });

  it("extracts Windows absolute paths", () => {
    const text = "![chart](C:\\Users\\test\\chart.png)";
    const images = extractImagePaths(text);
    expect(images).toHaveLength(1);
  });

  it("deduplicates paths", () => {
    const text = "![a](file:///C:/img.png) ![b](file:///C:/img.png)";
    expect(extractImagePaths(text)).toHaveLength(1);
  });

  it("returns empty for no images", () => {
    expect(extractImagePaths("Hello world")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// addImageProtocolHeaders
// ---------------------------------------------------------------------------
describe("addImageProtocolHeaders", () => {
  it("adds all four security headers", () => {
    const original = new Response("body", {
      status: 200,
      statusText: "OK",
      headers: { "Content-Type": "image/png" },
    });
    const wrapped = addImageProtocolHeaders(original);
    expect(wrapped.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(wrapped.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
    expect(wrapped.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(wrapped.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("preserves original status and statusText", () => {
    const original = new Response("not found", { status: 404, statusText: "Not Found" });
    const wrapped = addImageProtocolHeaders(original);
    expect(wrapped.status).toBe(404);
    expect(wrapped.statusText).toBe("Not Found");
  });

  it("preserves existing headers", () => {
    const original = new Response("body", {
      headers: { "Content-Type": "image/jpeg", "X-Custom": "value" },
    });
    const wrapped = addImageProtocolHeaders(original);
    expect(wrapped.headers.get("Content-Type")).toBe("image/jpeg");
    expect(wrapped.headers.get("X-Custom")).toBe("value");
    expect(wrapped.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("returns a readable body", async () => {
    const original = new Response("image-data");
    const wrapped = addImageProtocolHeaders(original);
    expect(await wrapped.text()).toBe("image-data");
  });
});
