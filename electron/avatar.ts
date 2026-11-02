import fs from "node:fs";
import path from "node:path";

import { createLogger } from "../common/marshal-logger";
import { getAppDataDir } from "./app-paths";
import { fetchImageAsDataUrl } from "./platform/image-utils";

const log = createLogger("Avatar");

// GitHub avatar caching
function avatarCachePath() {
  return path.join(getAppDataDir(), "marshal-avatar-cache.json");
}
let cachedAvatarDataUrl: string | null = null;
let cachedAvatarLogin: string | null = null;

/** Load a previously cached avatar from disk. */
function loadCachedAvatar(login: string): string | null {
  try {
    const raw = fs.readFileSync(avatarCachePath(), "utf-8");
    const cache: { login?: string; dataUrl?: string } = JSON.parse(raw); // SF-4: trusted — app-written local cache, accesses only .login and .dataUrl strings
    if (cache.login === login && cache.dataUrl) {
      return cache.dataUrl;
    }
  } catch {
    /* no cache or invalid */
  }
  return null;
}

/** Save avatar to disk cache. */
function saveCachedAvatar(login: string, dataUrl: string): void {
  try {
    fs.writeFileSync(avatarCachePath(), JSON.stringify({ login, dataUrl }), "utf-8");
  } catch {
    /* best effort */
  }
}

/** Clear in-memory and disk avatar caches (e.g. on sign-out). */
export function clearAvatarCache(): void {
  cachedAvatarDataUrl = null;
  cachedAvatarLogin = null;
  try {
    if (fs.existsSync(avatarCachePath())) fs.unlinkSync(avatarCachePath());
  } catch {
    /* best effort */
  }
}

export async function fetchGitHubAvatar(login: string): Promise<string | null> {
  // In-memory cache
  if (cachedAvatarLogin === login && cachedAvatarDataUrl) {
    return cachedAvatarDataUrl;
  }

  // Disk cache
  const diskCached = loadCachedAvatar(login);
  if (diskCached) {
    cachedAvatarDataUrl = diskCached;
    cachedAvatarLogin = login;
    return diskCached;
  }

  // Fetch from GitHub's avatar CDN (no auth needed, no SSO)
  try {
    const avatarUrl = `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=72`;
    const dataUrl = await fetchImageAsDataUrl(avatarUrl);
    if (dataUrl) {
      cachedAvatarDataUrl = dataUrl;
      cachedAvatarLogin = login;
      saveCachedAvatar(login, dataUrl);
    }
    return dataUrl;
  } catch (err) {
    log.error("Failed to fetch avatar:", err);
    return null;
  }
}
