import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Returns the protocol.handle callback for the `marshal://` scheme.
 *
 * Serves the packaged renderer bundle from `rendererDist` via
 * `net.fetch`, which is asar-aware in the main process. This avoids the
 * dependency on `grantFileProtocolExtraPrivileges` that broke the
 * asar-backed `file://` load on Windows (Electron 41).
 */
export function makeMarshalHandler(rendererDist: string): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const url = new URL(request.url);
    if (url.hostname !== "app") {
      return new Response("Not Found", { status: 404 });
    }
    const relPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.join(rendererDist, relPath);
    if (!filePath.startsWith(rendererDist + path.sep)) {
      return new Response("Forbidden", { status: 403 });
    }
    try {
      // Read directly from the confined path. Electron's net.fetch(file://…)
      // can recurse or stall while the custom scheme is initializing.
      const body = await readFile(filePath);
      return new Response(request.method === "HEAD" ? null : body, {
        status: 200,
        headers: { "content-type": contentType(filePath) },
      });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  };
}

function contentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return extension === ".html"
    ? "text/html; charset=utf-8"
    : extension === ".js"
      ? "text/javascript; charset=utf-8"
      : extension === ".css"
        ? "text/css; charset=utf-8"
        : extension === ".json"
          ? "application/json; charset=utf-8"
          : "application/octet-stream";
}
