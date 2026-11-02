// Marshal ownership: relocated module identity.
import fs from "node:fs";
import https from "node:https";
import path from "node:path";

/** Fetch an image from a URL as a data URL, following redirects. */
export function fetchImageAsDataUrl(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const request = (reqUrl: string, redirects = 0) => {
      if (redirects > 5) {
        resolve(null);
        return;
      }
      https
        .get(reqUrl, (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            // Consume the redirect response to free the underlying socket
            res.resume();
            request(res.headers.location, redirects + 1);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            resolve(null);
            return;
          }
          const contentType = res.headers["content-type"] || "image/png";
          if (!contentType.startsWith("image/")) {
            res.resume();
            resolve(null);
            return;
          }
          const MAX_DOWNLOAD_SIZE = 1024 * 1024; // 1 MB
          const chunks: Buffer[] = [];
          let totalSize = 0;
          res.on("data", (chunk: Buffer) => {
            totalSize += chunk.length;
            if (totalSize > MAX_DOWNLOAD_SIZE) {
              res.destroy();
              resolve(null);
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            const base64 = Buffer.concat(chunks).toString("base64");
            resolve(`data:${contentType};base64,${base64}`);
          });
          res.on("error", () => resolve(null));
        })
        .on("error", () => resolve(null));
    };
    request(url);
  });
}

interface ExtractedImage {
  id: string;
  filePath: string;
  /** Original path as it appeared in markdown (before path.sep normalization). */
  rawPath: string;
  mimeType: string;
  altText: string;
}

/**
 * Extract local image file references from response text.
 * Matches markdown images with file:// URLs or absolute paths.
 */
export function extractImagePaths(text: string): ExtractedImage[] {
  const images: ExtractedImage[] = [];
  const seen = new Set<string>();
  const imgRegex = /!\[([^\]]*)\]\((?:file:\/\/\/?)?((?:[A-Za-z]:[\\/]|\/)[^)]+)\)/g;
  let match;
  let idx = 0;
  while ((match = imgRegex.exec(text)) !== null) {
    // Strip leading slash before Windows drive letter (e.g. /C:/... → C:/...)
    const rawPath = match[2].replace(/^\/([A-Za-z]:)/, "$1");
    const filePath = rawPath.replace(/\//g, path.sep);
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mimeType = ext === "jpg" ? "image/jpeg" : `image/${ext || "png"}`;
    images.push({ id: `img${idx++}`, filePath, rawPath, mimeType, altText: match[1] || "image" });
  }
  return images;
}

// ---------------------------------------------------------------------------
// local-file: protocol validation helpers
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);

/**
 * Magic byte signatures for binary image formats.
 * Each entry: [header bytes, optional extra check offset+bytes].
 */
const IMAGE_SIGNATURES: Array<{
  header: Buffer;
  extra?: { offset: number; bytes: Buffer };
}> = [
  { header: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }, // PNG: \x89PNG
  { header: Buffer.from([0xff, 0xd8, 0xff]) }, // JPEG: \xFF\xD8\xFF
  { header: Buffer.from("GIF8") }, // GIF: GIF87a or GIF89a
  { header: Buffer.from("RIFF"), extra: { offset: 8, bytes: Buffer.from("WEBP") } }, // WebP: RIFF....WEBP
];

/** Check whether a file extension is in the image allowlist. */
export function isImageExtension(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Check whether a resolved file path is inside the workspace directory.
 * Case-insensitive on Windows (file paths are case-insensitive there).
 */
export function isInsideWorkspace(filePath: string, workspaceDir: string): boolean {
  const resolved = path.resolve(filePath);
  const prefix = path.resolve(workspaceDir) + path.sep;
  if (process.platform === "win32") {
    return resolved.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return resolved.startsWith(prefix);
}

export function isInsideDirectory(filePath: string, parentDir: string): boolean {
  return isInsideWorkspace(filePath, parentDir);
}

/**
 * Read the first bytes of a file and verify it matches a known image format.
 * Returns false for files that don't exist or can't be read.
 */
export async function hasImageMagicBytes(filePath: string): Promise<boolean> {
  try {
    const fd = await fs.promises.open(filePath, "r");
    try {
      const buf = Buffer.alloc(12);
      await fd.read(buf, 0, 12, 0);
      return IMAGE_SIGNATURES.some(({ header, extra }) => {
        if (!buf.subarray(0, header.length).equals(header)) return false;
        if (
          extra &&
          !buf.subarray(extra.offset, extra.offset + extra.bytes.length).equals(extra.bytes)
        )
          return false;
        return true;
      });
    } finally {
      await fd.close();
    }
  } catch {
    return false;
  }
}

/**
 * Wrap a Response with the canonical security/CORS header set for local image
 * protocol handlers (local-file: and local-preview:).
 *
 * Headers set:
 * - Access-Control-Allow-Origin: *  — lets renderer fetch() read the response
 * - Cross-Origin-Resource-Policy: cross-origin — required if COEP is ever enabled
 * - Referrer-Policy: no-referrer — don't leak origin on sub-requests
 * - X-Content-Type-Options: nosniff — prevent MIME-type sniffing
 */
export function addImageProtocolHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
