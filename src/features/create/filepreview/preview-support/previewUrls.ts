// Marshal-owned module.
const LOCAL_PREVIEW_SCHEME = "local-preview://preview";
const LOCAL_FILE_IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|bmp)(?:[?#].*)?$/i;
const DANGEROUS_SCHEME_RE = /^(?:javascript|vbscript):/i;
const DANGEROUS_DATA_RE = /^data:text\/html/i;
const SAFE_ABSOLUTE_URL_RE = /^(?:https?:|mailto:|tel:|blob:|#|\/\/)/i;
const WINDOWS_ABS_RE = /^[A-Za-z]:[\\/]/;

interface SplitPath {
  root: string;
  segments: string[];
}

function normalizePath(targetPath: string): string {
  return targetPath.replace(/\\/g, "/");
}

function splitPath(targetPath: string): SplitPath {
  const normalized = normalizePath(targetPath);
  if (/^[A-Za-z]:\//.test(normalized)) {
    return {
      root: normalized.slice(0, 2),
      segments: normalized.slice(3).split("/").filter(Boolean),
    };
  }
  if (normalized.startsWith("/")) {
    return {
      root: "/",
      segments: normalized.slice(1).split("/").filter(Boolean),
    };
  }
  return {
    root: "",
    segments: normalized.split("/").filter(Boolean),
  };
}

function joinPath({ root, segments }: SplitPath): string {
  if (root === "/") {
    return segments.length > 0 ? `/${segments.join("/")}` : "/";
  }
  if (root) {
    return segments.length > 0 ? `${root}/${segments.join("/")}` : `${root}/`;
  }
  return segments.join("/");
}

function isAbsoluteLocalPath(targetPath: string): boolean {
  const normalized = normalizePath(targetPath);
  return WINDOWS_ABS_RE.test(normalized) || normalized.startsWith("/");
}

function getPathDirectory(targetPath: string): string {
  const normalized = normalizePath(targetPath);
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash < 0) return "";
  if (lastSlash === 0) return "/";
  return normalized.slice(0, lastSlash);
}

function rewriteFileScheme(url: string, scheme: string): string {
  return url.replace(/^file:/i, `${scheme}:`);
}

function toFileUrl(targetPath: string): string {
  const normalized = normalizePath(targetPath);
  if (!isAbsoluteLocalPath(normalized)) return normalized;

  const url = new URL("file:///");
  url.pathname = /^[A-Za-z]:\//.test(normalized) ? `/${normalized}` : normalized;
  return url.toString();
}

function toLocalFileUrl(targetPath: string): string {
  return rewriteFileScheme(toFileUrl(targetPath), "local-file");
}

export function appendQueryParam(url: string, key: string, value: string): string {
  const hashIndex = url.indexOf("#");
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}${hash}`;
}

function resolveRelativePath(baseFilePath: string, targetPath: string): string | null {
  const { root, segments } = splitPath(getPathDirectory(baseFilePath));
  const resolved = [...segments];

  for (const part of normalizePath(targetPath).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (resolved.length === 0) return null;
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }

  return joinPath({ root, segments: resolved });
}

export function buildLocalPreviewUrl(filePath: string): string {
  const normalized = normalizePath(filePath);
  const pathInfo = splitPath(normalized);
  const fileName = pathInfo.segments[pathInfo.segments.length - 1] ?? normalized;
  const rootPath = joinPath({
    root: pathInfo.root,
    segments: pathInfo.segments.slice(0, -1),
  });
  const rootToken = encodeURIComponent(rootPath || "__relative__");
  return `${LOCAL_PREVIEW_SCHEME}/${rootToken}/${encodeURIComponent(fileName)}`;
}

export function resolvePreviewUrl(
  targetPath: string,
  baseFilePath?: string,
  options: { kind?: "link" | "embedded" } = {},
): string {
  const kind = options.kind ?? "link";
  if (!targetPath) return targetPath;

  const trimmed = targetPath.trim();
  if (DANGEROUS_SCHEME_RE.test(trimmed) || DANGEROUS_DATA_RE.test(trimmed)) {
    return "";
  }
  if (/^(?:local-file|local-preview):/i.test(trimmed)) {
    return trimmed;
  }
  if (/^data:/i.test(trimmed)) {
    return /^data:image\//i.test(trimmed) ? trimmed : "";
  }
  if (SAFE_ABSOLUTE_URL_RE.test(trimmed)) {
    return trimmed;
  }
  if (/^file:\/\//i.test(trimmed)) {
    return kind === "embedded" && LOCAL_FILE_IMAGE_EXT_RE.test(trimmed)
      ? rewriteFileScheme(trimmed, "local-file")
      : trimmed;
  }
  if (isAbsoluteLocalPath(trimmed)) {
    return kind === "embedded" && LOCAL_FILE_IMAGE_EXT_RE.test(trimmed)
      ? toLocalFileUrl(trimmed)
      : toFileUrl(trimmed);
  }
  if (!baseFilePath) return trimmed;

  const resolved = resolveRelativePath(baseFilePath, trimmed);
  if (!resolved) return "";
  return kind === "embedded" && LOCAL_FILE_IMAGE_EXT_RE.test(trimmed)
    ? toLocalFileUrl(resolved)
    : toFileUrl(resolved);
}
