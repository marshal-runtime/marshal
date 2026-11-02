interface PlaywrightEgressConfig {
  allowUnrestrictedFileAccess: boolean;
  browser: {
    contextOptions: { acceptDownloads: boolean };
    initScript: string[];
    userDataDir?: string;
  };
  network?: { blockedOrigins: string[] };
}

// Lives in electron/platform so every backend can import it without depending on another backend.
export function buildPlaywrightEgressConfig(
  initScriptPath: string,
  blockedOrigins: string[],
  userDataDir?: string,
): PlaywrightEgressConfig {
  const browser = {
    contextOptions: { acceptDownloads: false },
    initScript: [initScriptPath],
    ...(userDataDir ? { userDataDir } : {}),
  };

  return {
    // Keep in sync with resources/marshal-playwright-mcp-config.json (used by non-session callsites).
    allowUnrestrictedFileAccess: false,
    browser,
    ...(blockedOrigins.length === 0 ? {} : { network: { blockedOrigins } }),
  };
}
