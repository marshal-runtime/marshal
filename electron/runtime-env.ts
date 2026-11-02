const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function getDevServerUrl(
  isPackaged: boolean,
  rawUrl: string | undefined,
): string | undefined {
  if (isPackaged || !rawUrl) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("VITE_DEV_SERVER_URL must be a valid URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("VITE_DEV_SERVER_URL must use http:// or https://.");
  }

  if (!LOCALHOST_HOSTNAMES.has(parsed.hostname)) {
    throw new Error("VITE_DEV_SERVER_URL must point to localhost in development.");
  }

  return parsed.href.replace(/\/$/, "");
}

export function isDevServerNavigation(
  devServerUrl: string | undefined,
  targetUrl: string,
): boolean {
  if (!devServerUrl) return false;

  try {
    return new URL(targetUrl).origin === new URL(devServerUrl).origin;
  } catch {
    return false;
  }
}
