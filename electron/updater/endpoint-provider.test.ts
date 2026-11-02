import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// marshal-net-fetch is resolved once at module load (const fetchImpl = getNetFetch()), so the mock must
// exist before the provider module is imported — hoist it.
const {
  mockFetch,
  mockVerifySha,
  mockCreateWriteStream,
  mockExistsSync,
  mockMkdirSync,
  mockRmSync,
  mockSendErrorTelemetry,
} = vi.hoisted(() => ({
  mockFetch: vi.fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>(),
  mockVerifySha: vi.fn<(path: string, expected: string) => Promise<void>>(),
  mockCreateWriteStream: vi.fn<(path: string) => unknown>(),
  mockExistsSync: vi.fn<(path: string) => boolean>(() => false),
  mockMkdirSync: vi.fn<(path: string, opts?: unknown) => void>(),
  mockRmSync: vi.fn<(path: string, opts?: unknown) => void>(),
  mockSendErrorTelemetry: vi.fn<(error: { code: number }, cause?: unknown) => void>(),
}));
vi.mock("../marshal-net-fetch", () => ({ getNetFetch: () => mockFetch }));
// telemetry-errors is the spy point for the observability + telemetry tests at the bottom of
// this file. The real implementation is inert in tests (it pushes to a renderer window that
// doesn't exist), but mocking it removes the indirect log.fault → sink hop and lets the
// observability suite assert directly on `sendErrorTelemetry.mock.calls`.
vi.mock("../telemetry-errors", () => ({
  sendErrorTelemetry: mockSendErrorTelemetry,
  markTelemetry: vi.fn<(value: unknown) => void>(),
}));
// The end-to-end sha256-verification tests (bottom of file) mock fs writes + the verifier so the
// download path completes deterministically without disk I/O. Mocks live at module scope so they
// are hoisted before provider imports — the other test suites in this file don't exercise writes,
// so the fs no-ops are inert there.
vi.mock("fs", () => ({
  createWriteStream: mockCreateWriteStream,
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  rmSync: mockRmSync,
  readFileSync: vi.fn<(path: string) => string>(),
}));
vi.mock("./update-check-schema", async () => {
  const actual: typeof import("./update-check-schema") =
    await vi.importActual("./update-check-schema");
  const hosts = ["downloads.example.test"];
  return {
    ...actual,
    UPDATE_ENDPOINT_BASE_URL: "https://updates.example.test",
    isDownloadHostAllowed: (url: string, assetName?: string) =>
      actual.isDownloadHostAllowed(url, assetName, hosts),
    validateEndpointDownloadUrl: (url: string, assetName?: string) =>
      actual.validateEndpointDownloadUrl(url, assetName, hosts),
    verifyDownloadSha256: mockVerifySha,
  };
});

function mockResponse(status: number, body: unknown): Response {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as Response;
}

/**
 * Build an asset name that matches whatever `process.platform`/`process.arch` is in effect when
 * this is called — so the default fixture passes `validateAssetForCurrentPlatform` on any host
 * runner AND inside any `withPlatformArch` swap. Mirrors `getAssetName` in `../updater`.
 */
function defaultAssetName(version: string): string {
  if (process.platform === "darwin") {
    return `Marshal-Mac-${version}-${process.arch}-Installer.dmg`;
  }
  if (process.platform === "win32") {
    return `Marshal-Windows-${version}-${process.arch}-Setup.exe`;
  }
  return `Marshal-Linux-${version}.AppImage`;
}

/** A schema-valid check response; override fields per case. */
function respBody(over: Record<string, unknown> = {}) {
  const latestVersion = typeof over.latestVersion === "string" ? over.latestVersion : "1.0.0";
  const asset = defaultAssetName(latestVersion);
  return {
    upToDate: false,
    latestVersion,
    minimumVersion: "0.0.0",
    blocked: false,
    channel: "stable",
    downloadUrl: `https://downloads.example.test/download/abc/${asset}`,
    assetName: asset,
    sha256: "a".repeat(64),
    ...over,
  };
}

/** Temporarily swap process.platform + process.arch for one test. Both are read-only by default
 *  but `configurable: true` makes them swappable; restore-in-finally is mandatory. */
async function withPlatformArch(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  fn: () => Promise<void>,
): Promise<void> {
  const origPlatform = process.platform;
  const origArch = process.arch;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
  try {
    await fn();
  } finally {
    Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    Object.defineProperty(process, "arch", { value: origArch, configurable: true });
  }
}

describe("EndpointUpdateProvider.checkForUpdate — only offers strictly newer versions", () => {
  let EndpointUpdateProvider: typeof import("./endpoint-provider").EndpointUpdateProvider;

  beforeEach(async () => {
    mockFetch.mockReset();
    // Per-(version,channel) endpointCache is module-scoped — resetModules() guarantees a fresh
    // cache for every test so cells in describe-level matrices don't alias on the same key.
    vi.resetModules();
    ({ EndpointUpdateProvider } = await import("./endpoint-provider"));
  });

  it("offers an update when the server reports one and latestVersion is newer", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, respBody({ upToDate: false, latestVersion: "2.0.0" })),
    );
    const r = await new EndpointUpdateProvider().checkForUpdate({
      currentVersion: "1.0.0",
      channel: "stable",
    });
    const expectedAsset = defaultAssetName("2.0.0");
    expect(r.upToDate).toBe(false);
    expect(r.downloadUrl).toBe(`https://downloads.example.test/download/abc/${expectedAsset}`);
    expect(r.sha256).toBe("a".repeat(64));
  });

  it("does NOT offer when latestVersion equals current, even if the server says upToDate:false", async () => {
    // The bug this guards: a stale/misconfigured manifest must not prompt a re-install of the same build.
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, respBody({ upToDate: false, latestVersion: "3.0.0" })),
    );
    const r = await new EndpointUpdateProvider().checkForUpdate({
      currentVersion: "3.0.0",
      channel: "stable",
    });
    expect(r.upToDate).toBe(true);
    expect(r.downloadUrl).toBeUndefined();
    expect(r.sha256).toBeUndefined();
  });

  it("does NOT offer a downgrade when latestVersion is older than current (no rollback)", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, respBody({ upToDate: false, latestVersion: "4.0.0" })),
    );
    const r = await new EndpointUpdateProvider().checkForUpdate({
      currentVersion: "5.0.0",
      channel: "stable",
    });
    expect(r.upToDate).toBe(true);
    expect(r.downloadUrl).toBeUndefined();
  });

  it("respects the server withholding an update (upToDate:true) even when a newer version exists", async () => {
    // Staged rollout: server can decline to offer a newer build; we honor that.
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, respBody({ upToDate: true, latestVersion: "7.0.0" })),
    );
    const r = await new EndpointUpdateProvider().checkForUpdate({
      currentVersion: "6.0.0",
      channel: "stable",
    });
    expect(r.upToDate).toBe(true);
    expect(r.downloadUrl).toBeUndefined();
  });
});

describe("EndpointUpdateProvider.fetchResponse — cross-platform wire protocol", () => {
  let EndpointUpdateProvider: typeof import("./endpoint-provider").EndpointUpdateProvider;

  beforeEach(async () => {
    mockFetch.mockReset();
    vi.resetModules();
    ({ EndpointUpdateProvider } = await import("./endpoint-provider"));
  });

  // The request is what binds the client to the service. Every shipped (platform, arch) cell MUST
  // hit the same query-string shape, or the server's platform/arch routing breaks silently (e.g.
  // mac users get .exe asset names — see the 2026-05-30 curl-matrix darwin-arm64 mismatch).
  // Asserts the wire contract per cell.
  it.each([
    ["win32", "x64"],
    ["win32", "arm64"],
    ["darwin", "x64"],
    ["darwin", "arm64"],
    ["linux", "x64"],
    ["linux", "arm64"],
  ] as const)(
    "includes platform=%s and arch=%s in the URL query string",
    async (platform, arch) => {
      await withPlatformArch(platform, arch, async () => {
        mockFetch.mockResolvedValueOnce(mockResponse(200, respBody()));
        await new EndpointUpdateProvider().checkForUpdate({
          currentVersion: "1.2.3",
          channel: "stable",
        });
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining(
            `/v1/marshal/updates/check?platform=${platform}&arch=${arch}&version=1.2.3&channel=stable`,
          ),
          expect.anything(),
        );
      });
    },
  );

  it("sends only the numeric prefix when currentVersion carries a prerelease suffix", async () => {
    // Internal dev builds carry suffixes like "0.0.1-dev.1"; the service comparator handles plain
    // semver only. updater.ts:numericVersion() strips the suffix.
    mockFetch.mockResolvedValueOnce(mockResponse(200, respBody()));
    await new EndpointUpdateProvider().checkForUpdate({
      currentVersion: "0.22.305-dev.1+local",
      channel: "stable",
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("version=0.22.305"),
      expect.anything(),
    );
    // First positional arg to fetch is always a URL string in our code path; the test pins
    // exactly that shape and asserts on it directly.
    const firstArg = mockFetch.mock.calls[0]?.[0];
    if (typeof firstArg !== "string") throw new Error("expected URL string");
    expect(firstArg).not.toContain("dev.1");
    expect(firstArg).not.toContain("%2B");
  });
});

describe("EndpointUpdateProvider.fetchResponse — non-200 status branches", () => {
  // checkForUpdate and checkMinimumVersion share fetchResponse, so a status-branch regression
  // in one is felt by both. 404 → "notfound" sentinel; 400 → typed UpdaterError (caller treats
  // as fatal request-shape bug); any other non-ok → generic UpdaterError. Pin all three so the
  // contract can't drift.
  let EndpointUpdateProvider: typeof import("./endpoint-provider").EndpointUpdateProvider;
  beforeEach(async () => {
    mockFetch.mockReset();
    vi.resetModules();
    ({ EndpointUpdateProvider } = await import("./endpoint-provider"));
  });

  it("treats a 404 as 'up to date' (notfound sentinel propagates to checkForUpdate.upToDate=true)", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(404, {}));
    const r = await new EndpointUpdateProvider().checkForUpdate({
      currentVersion: "1.0.0",
      channel: "stable",
    });
    expect(r.upToDate).toBe(true);
    expect(r.downloadUrl).toBeUndefined();
  });

  it("rejects a 400 with a typed UpdaterError mentioning the request parameters", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(400, {}));
    await expect(
      new EndpointUpdateProvider().checkForUpdate({ currentVersion: "1.0.0", channel: "stable" }),
    ).rejects.toThrow(/request parameters/i);
  });

  it("rejects a 503 with a generic UpdaterError carrying the status code", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(503, {}));
    await expect(
      new EndpointUpdateProvider().checkForUpdate({ currentVersion: "1.0.0", channel: "stable" }),
    ).rejects.toThrow(/503/);
  });
});

describe("EndpointUpdateProvider.checkMinimumVersion", () => {
  // checkMinimumVersion routes through the same fetchResponse cache as checkForUpdate. These
  // tests pin the additional fail-open guarantees: a 404, an unreachable endpoint, or a
  // schema-invalid response must NEVER hard-block the app (`blocked: false`).
  let EndpointUpdateProvider: typeof import("./endpoint-provider").EndpointUpdateProvider;
  beforeEach(async () => {
    mockFetch.mockReset();
    vi.resetModules();
    ({ EndpointUpdateProvider } = await import("./endpoint-provider"));
  });

  it("checkMinimumVersion: passes through the server's blocked + minimumVersion on a 200 success", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, respBody({ blocked: true, minimumVersion: "2.0.0" })),
    );
    const r = await new EndpointUpdateProvider().checkMinimumVersion("1.0.0");
    expect(r).toEqual({ blocked: true, minimumVersion: "2.0.0", currentVersion: "1.0.0" });
  });

  // The next two tests isolate the "Big Red Button" semantic: the manifest's `blocked` field is
  // server-authoritative. Unlike the GitHub provider (updater.ts:633), which derives blocked from
  // `isNewer(minimumVersion, currentVersion)`, the endpoint provider MUST trust the server's
  // `blocked` value verbatim — otherwise SRE can't kill-switch a build without bumping the
  // minimumVersion floor, and can't lift a block without rolling minimumVersion back. Future
  // contributors who "harden" this by re-deriving blocked from a version compare will break the
  // contract; these tests fail loudly if that happens.
  it("checkMinimumVersion: Big Red Button — respects server-forced blocked=true even when minimumVersion <= currentVersion", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, respBody({ blocked: true, minimumVersion: "0.0.0" })),
    );
    const r = await new EndpointUpdateProvider().checkMinimumVersion("1.0.0");
    expect(r).toEqual({ blocked: true, minimumVersion: "0.0.0", currentVersion: "1.0.0" });
  });

  it("checkMinimumVersion: server-authoritative — respects blocked=false even when minimumVersion > currentVersion", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, respBody({ blocked: false, minimumVersion: "999.0.0" })),
    );
    const r = await new EndpointUpdateProvider().checkMinimumVersion("1.0.0");
    expect(r).toEqual({ blocked: false, minimumVersion: "999.0.0", currentVersion: "1.0.0" });
  });

  it("checkMinimumVersion: fails open (blocked=false, minimumVersion='0.0.0') on a 404", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(404, {}));
    expect(await new EndpointUpdateProvider().checkMinimumVersion("1.0.0")).toEqual({
      blocked: false,
      minimumVersion: "0.0.0",
      currentVersion: "1.0.0",
    });
  });

  it("checkMinimumVersion: fails open on a network reject (provider catches and returns safe default)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));
    expect(await new EndpointUpdateProvider().checkMinimumVersion("1.0.0")).toEqual({
      blocked: false,
      minimumVersion: "0.0.0",
      currentVersion: "1.0.0",
    });
  });

  it("checkMinimumVersion: fails open when the response fails schema validation", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, { not: "a valid response" }));
    expect(await new EndpointUpdateProvider().checkMinimumVersion("1.0.0")).toEqual({
      blocked: false,
      minimumVersion: "0.0.0",
      currentVersion: "1.0.0",
    });
  });

  it("checkMinimumVersion always pins the channel to 'stable' (no Beta channel in the endpoint experience)", async () => {
    // The endpoint experience doesn't expose the Beta channel; checkMinimumVersion must not forward
    // the user's updateChannelBeta preference (which would otherwise poll a non-existent channel
    // and miss the manifest).
    mockFetch.mockResolvedValueOnce(mockResponse(200, respBody()));
    await new EndpointUpdateProvider().checkMinimumVersion("1.0.0");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("channel=stable"),
      expect.anything(),
    );
  });

  it("checkForUpdate always pins the channel to 'stable' (no Beta channel in the endpoint experience)", async () => {
    // §14 v42 (re-review at 615525c2): if updateChannelBeta=true is still cached from a
    // build that offered Beta, the IPC layer forwards "beta" here. Pin to "stable" on the wire so the comment in
    // update-ipc.ts:42 ("EndpointUpdateProvider forces 'stable' internally") matches behavior
    // and there's no risk of a stale preference leaking to the Lobster endpoint.
    mockFetch.mockResolvedValueOnce(mockResponse(200, respBody()));
    await new EndpointUpdateProvider().checkForUpdate({
      currentVersion: "1.0.0",
      channel: "beta",
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("channel=stable"),
      expect.anything(),
    );
  });
});

describe("EndpointUpdateProvider — download host allowlist (post-prune)", () => {
  it("isDownloadHostAllowed accepts downloads.example.test (any path)", async () => {
    const { isDownloadHostAllowed } = await import("./update-check-schema");
    expect(
      isDownloadHostAllowed(
        "https://downloads.example.test/download/5afdb888-4c32-47e5-86c0-72adab3f5152/MarshalDev-Windows-9.9.9-x64-Setup.exe",
      ),
    ).toBe(true);
  });

  // The 2026-05-30 curl matrix found 7/8 cells still returned github.com URLs that 302 to the
  // private-repo SSO HTML; pruning the allowlist downgrades those from "passes host check, fails
  // signature verify" to "fails host check up front". This test pins that contract so a future
  // re-add of github.com requires an explicit, reviewed change.
  it.each([
    "https://github.com/OmerMachluf/marshal/releases/download/v1.0.0/x.exe",
    "https://objects.githubusercontent.com/OmerMachluf-marshal/x.exe",
    "https://release.marshal.dev/x.exe",
    "https://x.azureedge.net/x.exe",
    "https://x.azurefd.net/x.exe",
    "https://x.blob.core.windows.net/x.exe",
    "http://localhost:8799/x.exe",
    "http://127.0.0.1:8799/x.exe",
  ])("isDownloadHostAllowed rejects %s (no longer on allowlist)", async (url) => {
    const { isDownloadHostAllowed } = await import("./update-check-schema");
    expect(isDownloadHostAllowed(url)).toBe(false);
  });

  it("validateEndpointDownloadUrl throws UpdaterError for off-allowlist hosts", async () => {
    const { validateEndpointDownloadUrl } = await import("./update-check-schema");
    expect(() =>
      validateEndpointDownloadUrl(
        "https://github.com/OmerMachluf/marshal/releases/download/v1.0.0/Setup.exe",
      ),
    ).toThrow(/host/i);
  });

  it("accepts a darwin .dmg downloadUrl + assetName end-to-end through checkForUpdate", async () => {
    // Closes the per-platform asset-name handoff gap: schema parse must accept .dmg, the URL must
    // pass the allowlist, and the response must propagate to the caller verbatim so downloadUpdate
    // gets the correct filename for validateAssetName. Wrapped in withPlatformArch because the new
    // validateAssetForCurrentPlatform check would reject a .dmg on a non-darwin host runner.
    await withPlatformArch("darwin", "arm64", async () => {
      mockFetch.mockReset();
      vi.resetModules();
      const { EndpointUpdateProvider } = await import("./endpoint-provider");
      mockFetch.mockResolvedValueOnce(
        mockResponse(
          200,
          respBody({
            upToDate: false,
            latestVersion: "1.2.3",
            assetName: "Marshal-Mac-1.2.3-arm64-Installer.dmg",
            downloadUrl:
              "https://downloads.example.test/download/abc-def/Marshal-Mac-1.2.3-arm64-Installer.dmg",
            sha256: "b".repeat(64),
          }),
        ),
      );
      const r = await new EndpointUpdateProvider().checkForUpdate({
        currentVersion: "1.2.2",
        channel: "stable",
      });
      expect(r.upToDate).toBe(false);
      expect(r.assetName).toBe("Marshal-Mac-1.2.3-arm64-Installer.dmg");
      expect(r.downloadUrl).toBe(
        "https://downloads.example.test/download/abc-def/Marshal-Mac-1.2.3-arm64-Installer.dmg",
      );
      expect(r.sha256).toBe("b".repeat(64));
      const { isDownloadHostAllowed } = await import("./update-check-schema");
      expect(isDownloadHostAllowed(r.downloadUrl!)).toBe(true);
    });
  });
});

// Unit tests for the validator in isolation — the end-to-end tests below exercise the gate from
// inside checkForUpdate, but a direct test gives sharper failure attribution when the regex /
// boundary logic is ever revisited.
describe("validateAssetForCurrentPlatform — server-asset-name guard", () => {
  it("accepts a darwin-arm64 asset matching the requested version", async () => {
    await withPlatformArch("darwin", "arm64", async () => {
      const { validateAssetForCurrentPlatform } = await import("./update-check-schema");
      expect(() =>
        validateAssetForCurrentPlatform("Marshal-Mac-9.9.9-arm64-Installer.dmg", "9.9.9"),
      ).not.toThrow();
    });
  });

  it("accepts a darwin-arm64 asset with a MarshalDev-* (dev) prefix", async () => {
    // Product-name prefix is intentionally NOT pinned — the dev pipeline ships MarshalDev-*.
    await withPlatformArch("darwin", "arm64", async () => {
      const { validateAssetForCurrentPlatform } = await import("./update-check-schema");
      expect(() =>
        validateAssetForCurrentPlatform("MarshalDev-Mac-9.9.9-arm64-Installer.dmg", "9.9.9"),
      ).not.toThrow();
    });
  });

  it("rejects darwin-arm64 receiving an x64 .dmg (manifest typo)", async () => {
    await withPlatformArch("darwin", "arm64", async () => {
      const { validateAssetForCurrentPlatform } = await import("./update-check-schema");
      expect(() =>
        validateAssetForCurrentPlatform("Marshal-Mac-9.9.9-x64-Installer.dmg", "9.9.9"),
      ).toThrow(/darwin-arm64/);
    });
  });

  it("rejects darwin-arm64 receiving a Windows .exe (wrong installer type)", async () => {
    await withPlatformArch("darwin", "arm64", async () => {
      const { validateAssetForCurrentPlatform } = await import("./update-check-schema");
      expect(() =>
        validateAssetForCurrentPlatform("Marshal-Windows-9.9.9-arm64-Setup.exe", "9.9.9"),
      ).toThrow(/darwin-arm64/);
    });
  });

  it("rejects win32-x64 when assetName version disagrees with latestVersion", async () => {
    await withPlatformArch("win32", "x64", async () => {
      const { validateAssetForCurrentPlatform } = await import("./update-check-schema");
      expect(() =>
        validateAssetForCurrentPlatform("Marshal-Windows-9.9.8-x64-Setup.exe", "9.9.9"),
      ).toThrow(/v9\.9\.9/);
    });
  });

  it("token-bounded version: 1.0.0 does not satisfy a request for 1.0.0.1", async () => {
    await withPlatformArch("win32", "x64", async () => {
      const { validateAssetForCurrentPlatform } = await import("./update-check-schema");
      expect(() =>
        validateAssetForCurrentPlatform("Marshal-Windows-1.0.0-x64-Setup.exe", "1.0.0.1"),
      ).toThrow(/v1\.0\.0\.1/);
    });
  });

  it("token-bounded arch: x64 substring does not satisfy an arm64 request", async () => {
    await withPlatformArch("darwin", "arm64", async () => {
      const { validateAssetForCurrentPlatform } = await import("./update-check-schema");
      // The naive substring "arm64" would falsely match part of an "x64" name only via
      // careless contains; this case proves the hyphen boundary rejects the wrong-arch asset.
      expect(() =>
        validateAssetForCurrentPlatform("Marshal-Mac-9.9.9-x64-Installer.dmg", "9.9.9"),
      ).toThrow(/arm64/);
    });
  });

  it("accepts linux assets with no arch segment (single AppImage covers all archs)", async () => {
    await withPlatformArch("linux", "x64", async () => {
      const { validateAssetForCurrentPlatform } = await import("./update-check-schema");
      expect(() =>
        validateAssetForCurrentPlatform("Marshal-Linux-9.9.9.AppImage", "9.9.9"),
      ).not.toThrow();
    });
  });

  it("rejects linux when the .AppImage version disagrees with latestVersion", async () => {
    await withPlatformArch("linux", "arm64", async () => {
      const { validateAssetForCurrentPlatform } = await import("./update-check-schema");
      expect(() =>
        validateAssetForCurrentPlatform("Marshal-Linux-9.9.8.AppImage", "9.9.9"),
      ).toThrow(/linux/);
    });
  });
});

describe("EndpointUpdateProvider — assetName cross-check (mismatched manifests fail loudly)", () => {
  let EndpointUpdateProvider: typeof import("./endpoint-provider").EndpointUpdateProvider;

  beforeEach(async () => {
    mockFetch.mockReset();
    vi.resetModules();
    ({ EndpointUpdateProvider } = await import("./endpoint-provider"));
  });

  it("throws UpdaterError when the server returns the wrong-arch DMG (the original bug shape)", async () => {
    // Manifest mishap: a darwin-arm64 request receives the x64 .dmg. codesign would pass (same
    // Team ID), then the app would crash at launch with "Bad CPU type in executable". Catching it
    // here turns a far-downstream relaunch failure into a clean banner-level error.
    await withPlatformArch("darwin", "arm64", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(
          200,
          respBody({
            latestVersion: "2.0.0",
            assetName: "Marshal-Mac-2.0.0-x64-Installer.dmg",
            downloadUrl:
              "https://downloads.example.test/download/abc/Marshal-Mac-2.0.0-x64-Installer.dmg",
          }),
        ),
      );
      await expect(
        new EndpointUpdateProvider().checkForUpdate({
          currentVersion: "1.0.0",
          channel: "stable",
        }),
      ).rejects.toThrow(/darwin-arm64/);
    });
  });

  it("throws UpdaterError when the assetName extension does not match the platform", async () => {
    await withPlatformArch("darwin", "arm64", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(
          200,
          respBody({
            latestVersion: "2.0.0",
            assetName: "Marshal-Windows-2.0.0-arm64-Setup.exe",
            downloadUrl:
              "https://downloads.example.test/download/abc/Marshal-Windows-2.0.0-arm64-Setup.exe",
          }),
        ),
      );
      await expect(
        new EndpointUpdateProvider().checkForUpdate({
          currentVersion: "1.0.0",
          channel: "stable",
        }),
      ).rejects.toThrow(/Asset name mismatch/);
    });
  });

  it("throws UpdaterError when assetName version drifts from manifest latestVersion", async () => {
    // Server says "latest is 2.0.0" but the linked installer is named 2.0.1 — refuse rather than
    // download something whose claimed and actual versions disagree.
    await withPlatformArch("win32", "x64", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(
          200,
          respBody({
            latestVersion: "2.0.0",
            assetName: "Marshal-Windows-2.0.1-x64-Setup.exe",
            downloadUrl:
              "https://downloads.example.test/download/abc/Marshal-Windows-2.0.1-x64-Setup.exe",
          }),
        ),
      );
      await expect(
        new EndpointUpdateProvider().checkForUpdate({
          currentVersion: "1.0.0",
          channel: "stable",
        }),
      ).rejects.toThrow(/v2\.0\.0/);
    });
  });

  it("does NOT throw when the server omits assetName entirely", async () => {
    // No assetName ⇒ the IPC layer surfaces "No matching asset for this platform" downstream
    // (update-ipc.ts:62). The cross-check only fires when an asset IS named; missing-name is a
    // separate failure mode with its own handling path.
    await withPlatformArch("darwin", "arm64", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(
          200,
          respBody({
            latestVersion: "2.0.0",
            assetName: undefined,
            downloadUrl: "https://downloads.example.test/download/abc/whatever.dmg",
          }),
        ),
      );
      const r = await new EndpointUpdateProvider().checkForUpdate({
        currentVersion: "1.0.0",
        channel: "stable",
      });
      expect(r.upToDate).toBe(false);
      expect(r.assetName).toBeUndefined();
    });
  });

  it("does NOT enforce the cross-check when the server says we're upToDate", async () => {
    // No update is being offered — assetName won't be exposed to the renderer (it's zeroed by the
    // upToDate path). Skip validation rather than reject a stale assetName that's never used.
    await withPlatformArch("darwin", "arm64", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(
          200,
          respBody({
            upToDate: true,
            latestVersion: "1.0.0",
            assetName: "totally-bogus-name-that-would-otherwise-fail",
          }),
        ),
      );
      const r = await new EndpointUpdateProvider().checkForUpdate({
        currentVersion: "1.0.0",
        channel: "stable",
      });
      expect(r.upToDate).toBe(true);
      expect(r.assetName).toBeUndefined();
    });
  });

  it("does NOT enforce the cross-check when latestVersion is not strictly newer (no-rollback)", async () => {
    // Mirrors the upToDate case: we never offer the asset, so the cross-check is irrelevant.
    await withPlatformArch("darwin", "arm64", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse(
          200,
          respBody({
            upToDate: false,
            latestVersion: "1.0.0",
            assetName: "totally-bogus-name-that-would-otherwise-fail",
          }),
        ),
      );
      const r = await new EndpointUpdateProvider().checkForUpdate({
        currentVersion: "2.0.0",
        channel: "stable",
      });
      expect(r.upToDate).toBe(true);
      expect(r.assetName).toBeUndefined();
    });
  });
});

describe("EndpointUpdateProvider.downloadUpdate — redirect re-pin + sha256 cache lookup", () => {
  let EndpointUpdateProvider: typeof import("./endpoint-provider").EndpointUpdateProvider;

  beforeEach(async () => {
    mockFetch.mockReset();
    vi.resetModules();
    ({ EndpointUpdateProvider } = await import("./endpoint-provider"));
  });

  it("re-pins the host on a 302 redirect — Location to off-allowlist host throws BEFORE the follow-up fetch", async () => {
    // The download flow follows one redirect manually so it can validate the new host instead of
    // trusting whatever the CDN returns. A server that 302s an allowlisted URL out to an attacker
    // origin must be refused at the same layer that gated the initial fetch — never silently
    // followed. Asserting `fetchCount === 1` pins that the second fetch never runs.
    const assetName = "Marshal-Windows-9.9.9-x64-Setup.exe";
    const startUrl = `https://downloads.example.test/download/abc/${assetName}`;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
    const redirectResp = {
      ok: false,
      status: 302,
      statusText: "Found",
      headers: new Headers({ Location: "https://attacker.example/payload.exe" }),
      json: () => Promise.resolve({}),
    } as Response;
    mockFetch.mockResolvedValueOnce(redirectResp);

    await expect(
      new EndpointUpdateProvider().downloadUpdate({ url: startUrl, assetName }),
    ).rejects.toThrow(/host/i);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("looks up the expected sha256 from the prior checkForUpdate cache (no round-trip through renderer)", async () => {
    // checkForUpdate populates a module-level cache keyed on the requested assetName; downloadUpdate
    // recovers the sha256 from that cache so the renderer never has to carry the hash across IPC.
    // Pin the contract: cache hit ⇒ the expected sha256 makes it into the verify path.
    await withPlatformArch("win32", "x64", async () => {
      const assetName = "Marshal-Windows-9.9.9-x64-Setup.exe";
      const downloadUrl = `https://downloads.example.test/download/abc/${assetName}`;
      const sha = "c".repeat(64);
      mockFetch.mockResolvedValueOnce(
        mockResponse(
          200,
          respBody({ latestVersion: "9.9.9", assetName, downloadUrl, sha256: sha }),
        ),
      );
      const provider = new EndpointUpdateProvider();
      await provider.checkForUpdate({ currentVersion: "1.0.0", channel: "stable" });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- accessing private helper for cache pin
      const internal = provider as unknown as {
        expectedSha256For(n: string): string | undefined;
      };
      const got = internal.expectedSha256For(assetName);
      expect(got).toBe(sha);
    });
  });
});

describe("EndpointUpdateProvider.downloadUpdate — end-to-end sha256 verification", () => {
  // These tests run a full check → download cycle through real fs mocks so the assertion is
  // "the cached sha256 is actually fed to the verifier" rather than "the helper that surfaces
  // the cache can find it". The earlier private-helper test (above) keeps the cache-write
  // contract pinned; these pin the cache-read → verify wiring + the mismatch failure mode.
  // The module-scope vi.mock calls at the top of this file mock fs + verifyDownloadSha256.

  let EndpointUpdateProvider: typeof import("./endpoint-provider").EndpointUpdateProvider;

  beforeEach(async () => {
    mockFetch.mockReset();
    mockVerifySha.mockReset();
    mockVerifySha.mockResolvedValue();
    // Wire createWriteStream to a no-op writer that immediately fires "finish".
    mockCreateWriteStream.mockImplementation(() => {
      const handlers: Record<string, ((err?: Error) => void)[]> = {};
      return {
        write: vi.fn<(chunk: unknown) => boolean>(),
        on: (event: string, fn: (err?: Error) => void) => {
          (handlers[event] ??= []).push(fn);
        },
        end: () => handlers.finish?.forEach((fn) => fn()),
        destroy: vi.fn<() => void>(),
      };
    });
    vi.resetModules();
    ({ EndpointUpdateProvider } = await import("./endpoint-provider"));
  });

  /** Build a Response whose body streams `bytes` once and is then done. */
  function mockBinaryResponse(bytes: Uint8Array): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-length": String(bytes.byteLength) }),
      body: stream,
    } as Response;
  }

  it("feeds the cached sha256 from the prior check into verifyDownloadSha256", async () => {
    await withPlatformArch("win32", "x64", async () => {
      const assetName = "Marshal-Windows-9.9.9-x64-Setup.exe";
      const downloadUrl = `https://downloads.example.test/download/abc/${assetName}`;
      const expectedSha = "d".repeat(64);
      // 1) check populates the per-(version,channel) cache with the manifest's sha
      mockFetch.mockResolvedValueOnce(
        mockResponse(
          200,
          respBody({ latestVersion: "9.9.9", assetName, downloadUrl, sha256: expectedSha }),
        ),
      );
      // 2) download fetches the asset bytes (mocked to a tiny payload)
      mockFetch.mockResolvedValueOnce(mockBinaryResponse(new Uint8Array([0xff, 0x00, 0x42])));

      const provider = new EndpointUpdateProvider();
      await provider.checkForUpdate({ currentVersion: "1.0.0", channel: "stable" });
      await provider.downloadUpdate({ url: downloadUrl, assetName });

      expect(mockVerifySha).toHaveBeenCalledTimes(1);
      expect(mockVerifySha).toHaveBeenCalledWith(expect.any(String), expectedSha);
    });
  });

  it("propagates a sha256 mismatch from verifyDownloadSha256 as a rejected downloadUpdate", async () => {
    await withPlatformArch("win32", "x64", async () => {
      const assetName = "Marshal-Windows-9.9.9-x64-Setup.exe";
      const downloadUrl = `https://downloads.example.test/download/abc/${assetName}`;
      mockFetch.mockResolvedValueOnce(
        mockResponse(
          200,
          respBody({ latestVersion: "9.9.9", assetName, downloadUrl, sha256: "d".repeat(64) }),
        ),
      );
      mockFetch.mockResolvedValueOnce(mockBinaryResponse(new Uint8Array([0xff])));
      mockVerifySha.mockRejectedValue(new Error("sha256 mismatch: expected … got …"));

      const provider = new EndpointUpdateProvider();
      await provider.checkForUpdate({ currentVersion: "1.0.0", channel: "stable" });
      await expect(provider.downloadUpdate({ url: downloadUrl, assetName })).rejects.toThrow(
        /sha256 mismatch/,
      );
    });
  });

  it("attaches the download AbortSignal to the asset-download fetch (stall + ceiling timers wire through both initial fetch and redirect follow-up)", async () => {
    // Replaces an older test that asserted "no signal at all". The stall-based design
    // (2 min stall + 10 min overall) attaches a controller-backed signal to both the
    // initial fetch AND any redirect-follow-up fetch — so the timers can abort a hung
    // socket regardless of which leg is stuck. Slow-but-progressing downloads keep
    // working because the stall timer is reset on every received chunk.
    await withPlatformArch("win32", "x64", async () => {
      const assetName = "Marshal-Windows-9.9.9-x64-Setup.exe";
      const downloadUrl = `https://downloads.example.test/download/abc/${assetName}`;
      mockFetch.mockResolvedValueOnce(
        mockResponse(
          200,
          respBody({ latestVersion: "9.9.9", assetName, downloadUrl, sha256: "d".repeat(64) }),
        ),
      );
      mockFetch.mockResolvedValueOnce(mockBinaryResponse(new Uint8Array([0xff, 0x00, 0x42])));

      const provider = new EndpointUpdateProvider();
      await provider.checkForUpdate({ currentVersion: "1.0.0", channel: "stable" });
      await provider.downloadUpdate({ url: downloadUrl, assetName });

      // First call: manifest probe. Second call: asset download. The download MUST
      // carry a signal so the stall/ceiling timers can abort it; on success the signal
      // is not aborted because both timers were cleared in the finally.
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const downloadInit = mockFetch.mock.calls[1]?.[1];
      expect(downloadInit?.signal).toBeInstanceOf(AbortSignal);
      expect(downloadInit?.signal?.aborted).toBe(false);
    });
  });
});

describe("EndpointUpdateProvider — observability + telemetry", () => {
  // Spec: a coworker hit a Mac update failure and the disk log had no useful evidence —
  // no log.error at the catch site, no timestamps, no bytes-received counter. These tests
  // pin the post-incident contract: every catch site logs at error level AND emits a
  // typed `updaterErrors.*` telemetry event, AND `checkMinimumVersion` (which runs every
  // 4 hours and fails open) logs but does NOT emit telemetry. The 14-code enum lives in
  // `common/telemetry/errors/marshal-updater.ts` (APPEND-ONLY — never reorder).
  let EndpointUpdateProvider: typeof import("./endpoint-provider").EndpointUpdateProvider;
  let logs: { level: string; tag: string; msg: string }[];
  let restoreLogSink: () => void;
  let updaterErrors: typeof import("../../common/telemetry/errors/marshal-index").updaterErrors;

  beforeEach(async () => {
    mockFetch.mockReset();
    mockVerifySha.mockReset();
    mockVerifySha.mockResolvedValue();
    mockSendErrorTelemetry.mockReset();
    // Inert writer for the download path — fires 'finish' immediately on end().
    mockCreateWriteStream.mockImplementation(() => {
      const handlers: Record<string, ((err?: Error) => void)[]> = {};
      return {
        write: vi.fn<(chunk: unknown) => boolean>(),
        on: (event: string, fn: (err?: Error) => void) => {
          (handlers[event] ??= []).push(fn);
        },
        end: () => handlers.finish?.forEach((fn) => fn()),
        destroy: vi.fn<() => void>(),
      };
    });
    vi.resetModules();
    ({ EndpointUpdateProvider } = await import("./endpoint-provider"));
    ({ updaterErrors } = await import("../../common/telemetry/errors/marshal-index"));

    // Capture log entries via the logger's sink API so the assertion is immune to
    // console-mock ordering.
    const { addLogSink } = await import("../../common/marshal-logger");
    logs = [];
    restoreLogSink = addLogSink((entry) => {
      logs.push({
        level: entry.level,
        tag: entry.tag,
        msg: entry.args.map(String).join(" "),
      });
    });
  });

  function updaterLogs(level?: "info" | "warn" | "error") {
    return logs.filter(
      (l) => l.tag === "UpdaterEndpoint" && (level === undefined || l.level === level),
    );
  }

  function telemetryCalls() {
    return mockSendErrorTelemetry.mock.calls.map((c) => ({ code: c[0].code, cause: c[1] }));
  }

  // The hoisted afterEach restores the sink so subsequent tests aren't polluted.
  // (vitest runs sinks for all installed listeners; an un-restored sink would
  // capture entries from other tests' modules.)
  function withCleanup<T>(fn: () => Promise<T>): Promise<T> {
    return fn().finally(() => restoreLogSink());
  }

  function respBodyFor(over: Record<string, unknown> = {}) {
    return respBody(over);
  }

  function mockBinaryResponseInner(bytes: Uint8Array): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-length": String(bytes.byteLength) }),
      body: stream,
    } as Response;
  }

  // ── Manifest fetch (every branch) ─────────────────────────────────────

  it("manifest cache hit logs at info with platform/arch/version/channel context (no telemetry)", () =>
    withCleanup(async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(200, respBodyFor()));
      const provider = new EndpointUpdateProvider();
      await provider.checkForUpdate({ currentVersion: "1.0.0", channel: "stable" });
      // Second call within the same key → cache hit.
      await provider.checkForUpdate({ currentVersion: "1.0.0", channel: "stable" });
      const cacheHits = updaterLogs("info").filter((l) => l.msg.includes("cache hit"));
      expect(cacheHits.length).toBeGreaterThanOrEqual(1);
      expect(cacheHits[0].msg).toMatch(/platform=/);
      expect(cacheHits[0].msg).toMatch(/arch=/);
      expect(cacheHits[0].msg).toMatch(/version=1\.0\.0/);
      expect(cacheHits[0].msg).toMatch(/channel=stable/);
      expect(mockSendErrorTelemetry).not.toHaveBeenCalled();
    }));

  it("manifest start log includes (op, platform, arch, version, channel) context", () =>
    withCleanup(async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(200, respBodyFor()));
      const provider = new EndpointUpdateProvider();
      await provider.checkForUpdate({ currentVersion: "1.0.0", channel: "stable" });
      const startLine = updaterLogs("info").find((l) => l.msg.includes("starting"));
      expect(startLine).toBeDefined();
      expect(startLine?.msg).toMatch(
        /\(check, platform=.+, arch=.+, version=1\.0\.0, channel=stable\)/,
      );
    }));

  it("manifest 200 logs at info with elapsed-ms format and result metadata", () =>
    withCleanup(async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(200, respBodyFor({ latestVersion: "9.9.9" })));
      const provider = new EndpointUpdateProvider();
      await provider.checkForUpdate({ currentVersion: "1.0.0", channel: "stable" });
      const successLine = updaterLogs("info").find((l) =>
        /manifest check → 200 in \d+ms/.test(l.msg),
      );
      expect(successLine).toBeDefined();
      expect(successLine?.msg).toMatch(/latestVersion=9\.9\.9/);
      expect(successLine?.msg).toMatch(/channel=stable/);
      expect(successLine?.msg).toMatch(/upToDate=false/);
      expect(successLine?.msg).toMatch(/blocked=false/);
      expect(mockSendErrorTelemetry).not.toHaveBeenCalled();
    }));

  it("manifest 404 logs at info (treating as up-to-date) and does NOT emit telemetry", () =>
    withCleanup(async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(404, {}));
      const provider = new EndpointUpdateProvider();
      await provider.checkForUpdate({ currentVersion: "1.0.0", channel: "stable" });
      const line = updaterLogs("info").find((l) => l.msg.includes("404"));
      expect(line).toBeDefined();
      expect(line?.msg).toMatch(/up-to-date/);
      expect(mockSendErrorTelemetry).not.toHaveBeenCalled();
    }));

  it("manifest 400 logs at error and emits MANIFEST_BAD_REQUEST", () =>
    withCleanup(async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(400, {}));
      const provider = new EndpointUpdateProvider();
      await expect(
        provider.checkForUpdate({ currentVersion: "1.0.0", channel: "stable" }),
      ).rejects.toThrow(/400/);
      const errLine = updaterLogs("error").find((l) => l.msg.includes("400"));
      expect(errLine).toBeDefined();
      expect(errLine?.msg).toMatch(/config bug/);
      const calls = telemetryCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].code).toBe(updaterErrors.MANIFEST_BAD_REQUEST);
      // Second arg (cause) must be present so ipc-handle's HANDLER_UNCAUGHT dedup catches it.
      expect(calls[0].cause).toBeInstanceOf(Error);
    }));

  it("manifest 503 logs at error and emits MANIFEST_SERVER_ERROR", () =>
    withCleanup(async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(503, {}));
      const provider = new EndpointUpdateProvider();
      await expect(
        provider.checkForUpdate({ currentVersion: "1.0.0", channel: "stable" }),
      ).rejects.toThrow(/503/);
      const errLine = updaterLogs("error").find((l) => l.msg.includes("503"));
      expect(errLine).toBeDefined();
      const calls = telemetryCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].code).toBe(updaterErrors.MANIFEST_SERVER_ERROR);
      expect(calls[0].cause).toBeInstanceOf(Error);
    }));

  it("manifest network reject logs at error FAILED and emits MANIFEST_NETWORK_ERROR", () =>
    withCleanup(async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const provider = new EndpointUpdateProvider();
      await expect(
        provider.checkForUpdate({ currentVersion: "1.0.0", channel: "stable" }),
      ).rejects.toThrow(/ECONNREFUSED/);
      const errLine = updaterLogs("error").find((l) => l.msg.includes("FAILED"));
      expect(errLine).toBeDefined();
      const calls = telemetryCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].code).toBe(updaterErrors.MANIFEST_NETWORK_ERROR);
    }));

  it("manifest AbortError reject logs at error TIMED OUT and emits MANIFEST_TIMEOUT", () =>
    withCleanup(async () => {
      const abortErr = new Error("The operation was aborted");
      abortErr.name = "AbortError";
      mockFetch.mockRejectedValueOnce(abortErr);
      const provider = new EndpointUpdateProvider();
      await expect(
        provider.checkForUpdate({ currentVersion: "1.0.0", channel: "stable" }),
      ).rejects.toThrow(/aborted/);
      const errLine = updaterLogs("error").find((l) => l.msg.includes("TIMED OUT"));
      expect(errLine).toBeDefined();
      const calls = telemetryCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].code).toBe(updaterErrors.MANIFEST_TIMEOUT);
    }));

  it("manifest schema-invalid logs at error and emits MANIFEST_SCHEMA_INVALID", () =>
    withCleanup(async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(200, { not: "valid" }));
      const provider = new EndpointUpdateProvider();
      await expect(
        provider.checkForUpdate({ currentVersion: "1.0.0", channel: "stable" }),
      ).rejects.toThrow(/validation/);
      const errLine = updaterLogs("error").find((l) => l.msg.includes("schema validation failed"));
      expect(errLine).toBeDefined();
      const calls = telemetryCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].code).toBe(updaterErrors.MANIFEST_SCHEMA_INVALID);
    }));

  // ── checkMinimumVersion: logs but silences telemetry (4-hour cadence, fails open) ──

  it("checkMinimumVersion 5xx still logs at error but does NOT emit telemetry", () =>
    withCleanup(async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(503, {}));
      const provider = new EndpointUpdateProvider();
      // Fails open — no rejection.
      const r = await provider.checkMinimumVersion("1.0.0");
      expect(r.blocked).toBe(false);
      // Disk evidence is preserved...
      expect(updaterLogs("error").some((l) => l.msg.includes("503"))).toBe(true);
      // ...but telemetry stays quiet so the 4-hour cadence doesn't flood the dashboard.
      expect(mockSendErrorTelemetry).not.toHaveBeenCalled();
    }));

  it("checkMinimumVersion network reject still logs but does NOT emit telemetry", () =>
    withCleanup(async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));
      const provider = new EndpointUpdateProvider();
      const r = await provider.checkMinimumVersion("1.0.0");
      expect(r.blocked).toBe(false);
      expect(updaterLogs("error").some((l) => l.msg.includes("FAILED"))).toBe(true);
      expect(mockSendErrorTelemetry).not.toHaveBeenCalled();
    }));

  it("checkMinimumVersion start log marks the op as 'minimumVersion'", () =>
    withCleanup(async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(200, respBodyFor()));
      const provider = new EndpointUpdateProvider();
      await provider.checkMinimumVersion("1.0.0");
      const start = updaterLogs("info").find((l) => l.msg.includes("starting"));
      expect(start?.msg).toMatch(/\(minimumVersion,/);
    }));

  // ── Pre-download validation ───────────────────────────────────────────

  it("emits ASSET_NAME_REJECTED when validateAssetForCurrentPlatform throws", () =>
    withCleanup(async () => {
      // Force a mismatch by handing the win32/x64 host a darwin asset name.
      await withPlatformArch("win32", "x64", async () => {
        mockFetch.mockResolvedValueOnce(
          mockResponse(
            200,
            respBodyFor({
              latestVersion: "9.9.9",
              assetName: "Marshal-Mac-9.9.9-arm64-Installer.dmg",
              downloadUrl: "https://downloads.example.test/d/Marshal-Mac-9.9.9-arm64-Installer.dmg",
            }),
          ),
        );
        const provider = new EndpointUpdateProvider();
        await expect(
          provider.checkForUpdate({ currentVersion: "1.0.0", channel: "stable" }),
        ).rejects.toBeDefined();
        const errLine = updaterLogs("error").find((l) => l.msg.includes("asset name rejected"));
        expect(errLine).toBeDefined();
        const calls = telemetryCalls();
        expect(calls).toHaveLength(1);
        expect(calls[0].code).toBe(updaterErrors.ASSET_NAME_REJECTED);
      });
    }));

  // ── Download path ─────────────────────────────────────────────────────

  it("emits DOWNLOAD_HOST_REJECTED when initial URL host is off-allowlist", () =>
    withCleanup(async () => {
      const provider = new EndpointUpdateProvider();
      await expect(
        provider.downloadUpdate({
          url: "https://attacker.example/payload.exe",
          assetName: "Marshal-Windows-9.9.9-x64-Setup.exe",
        }),
      ).rejects.toThrow(/host/i);
      const errLine = updaterLogs("error").find((l) => l.msg.includes("download host rejected"));
      expect(errLine).toBeDefined();
      const calls = telemetryCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].code).toBe(updaterErrors.DOWNLOAD_HOST_REJECTED);
    }));

  it("emits DOWNLOAD_HOST_REJECTED when a redirect Location targets an off-allowlist host", () =>
    withCleanup(async () => {
      const assetName = "Marshal-Windows-9.9.9-x64-Setup.exe";
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
      const redirectResp = {
        ok: false,
        status: 302,
        statusText: "Found",
        headers: new Headers({ Location: "https://attacker.example/payload.exe" }),
        json: () => Promise.resolve({}),
      } as Response;
      mockFetch.mockResolvedValueOnce(redirectResp);
      const provider = new EndpointUpdateProvider();
      await expect(
        provider.downloadUpdate({
          url: `https://downloads.example.test/download/abc/${assetName}`,
          assetName,
        }),
      ).rejects.toThrow(/host/i);
      const errLine = updaterLogs("error").find((l) => l.msg.includes("redirect host rejected"));
      expect(errLine).toBeDefined();
      const calls = telemetryCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].code).toBe(updaterErrors.DOWNLOAD_HOST_REJECTED);
    }));

  it("emits DOWNLOAD_RESPONSE_FAILED on a 3xx redirect with no Location header", () =>
    withCleanup(async () => {
      const assetName = "Marshal-Windows-9.9.9-x64-Setup.exe";
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
      const redirectResp = {
        ok: false,
        status: 302,
        statusText: "Found",
        headers: new Headers(),
        json: () => Promise.resolve({}),
      } as Response;
      mockFetch.mockResolvedValueOnce(redirectResp);
      const provider = new EndpointUpdateProvider();
      await expect(
        provider.downloadUpdate({
          url: `https://downloads.example.test/download/abc/${assetName}`,
          assetName,
        }),
      ).rejects.toThrow(/Location/);
      expect(updaterLogs("error").some((l) => l.msg.includes("no Location header"))).toBe(true);
      const calls = telemetryCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].code).toBe(updaterErrors.DOWNLOAD_RESPONSE_FAILED);
    }));

  it("emits DOWNLOAD_RESPONSE_FAILED on a non-2xx download response", () =>
    withCleanup(async () => {
      const assetName = "Marshal-Windows-9.9.9-x64-Setup.exe";
      mockFetch.mockResolvedValueOnce(mockResponse(503, {}));
      const provider = new EndpointUpdateProvider();
      await expect(
        provider.downloadUpdate({
          url: `https://downloads.example.test/download/abc/${assetName}`,
          assetName,
        }),
      ).rejects.toThrow(/503/);
      expect(updaterLogs("error").some((l) => l.msg.includes("download response"))).toBe(true);
      const calls = telemetryCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].code).toBe(updaterErrors.DOWNLOAD_RESPONSE_FAILED);
    }));

  it("emits DOWNLOAD_RESPONSE_FAILED when the response has no body", () =>
    withCleanup(async () => {
      const assetName = "Marshal-Windows-9.9.9-x64-Setup.exe";
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
      const noBodyResp = {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        body: null,
      } as Response;
      mockFetch.mockResolvedValueOnce(noBodyResp);
      const provider = new EndpointUpdateProvider();
      await expect(
        provider.downloadUpdate({
          url: `https://downloads.example.test/download/abc/${assetName}`,
          assetName,
        }),
      ).rejects.toThrow(/No response body/);
      const calls = telemetryCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].code).toBe(updaterErrors.DOWNLOAD_RESPONSE_FAILED);
    }));

  it("emits DOWNLOAD_SHA256_MISMATCH when verifyDownloadSha256 rejects", () =>
    withCleanup(async () => {
      await withPlatformArch("win32", "x64", async () => {
        const assetName = "Marshal-Windows-9.9.9-x64-Setup.exe";
        const downloadUrl = `https://downloads.example.test/download/abc/${assetName}`;
        mockFetch.mockResolvedValueOnce(
          mockResponse(
            200,
            respBodyFor({
              latestVersion: "9.9.9",
              assetName,
              downloadUrl,
              sha256: "d".repeat(64),
            }),
          ),
        );
        mockFetch.mockResolvedValueOnce(mockBinaryResponseInner(new Uint8Array([0xff])));
        mockVerifySha.mockRejectedValueOnce(new Error("sha256 mismatch: expected … got …"));
        const provider = new EndpointUpdateProvider();
        await provider.checkForUpdate({ currentVersion: "1.0.0", channel: "stable" });
        await expect(provider.downloadUpdate({ url: downloadUrl, assetName })).rejects.toThrow(
          /sha256 mismatch/,
        );
        expect(updaterLogs("error").some((l) => l.msg.includes("sha256 verification FAILED"))).toBe(
          true,
        );
        const calls = telemetryCalls();
        expect(calls).toHaveLength(1);
        expect(calls[0].code).toBe(updaterErrors.DOWNLOAD_SHA256_MISMATCH);
      });
    }));

  it("download success log includes MB / elapsed-ms / throughput", () =>
    withCleanup(async () => {
      await withPlatformArch("win32", "x64", async () => {
        const assetName = "Marshal-Windows-9.9.9-x64-Setup.exe";
        const downloadUrl = `https://downloads.example.test/download/abc/${assetName}`;
        mockFetch.mockResolvedValueOnce(
          mockResponse(
            200,
            respBodyFor({
              latestVersion: "9.9.9",
              assetName,
              downloadUrl,
              sha256: "d".repeat(64),
            }),
          ),
        );
        mockFetch.mockResolvedValueOnce(
          mockBinaryResponseInner(new Uint8Array([0xff, 0x00, 0x42])),
        );
        const provider = new EndpointUpdateProvider();
        await provider.checkForUpdate({ currentVersion: "1.0.0", channel: "stable" });
        await provider.downloadUpdate({ url: downloadUrl, assetName });
        const completeLine = updaterLogs("info").find((l) => l.msg.includes("download complete"));
        expect(completeLine).toBeDefined();
        expect(completeLine?.msg).toMatch(/\d+ MB in \d+ms/);
        expect(completeLine?.msg).toMatch(/MB\/s/);
        expect(mockSendErrorTelemetry).not.toHaveBeenCalled();
      });
    }));
});

describe("EndpointUpdateProvider — download stall + ceiling timeouts", () => {
  // These tests pin the two-tier timeout contract introduced after the Mac coworker incident:
  //
  //   STALL   2 min of zero bytes received → controller.abort → reader.read rejects
  //   CEILING 10 min total wall-clock → controller.abort → reader.read rejects
  //
  // Slow-but-progressing downloads keep working because the stall timer is reset on
  // EVERY received chunk. Truly hung sockets and pathologically slow streams both fail
  // closed with a typed DOWNLOAD_TIMEOUT telemetry event.
  //
  // The reader mock here listens to the AbortSignal that the provider attaches to
  // fetch() and rejects the in-flight read() with an AbortError when the signal aborts
  // — that's what a real fetch body would do when the underlying request is aborted.
  //
  // Fake timers are required so vi.advanceTimersByTimeAsync can pump the 2-min stall
  // and the 10-min ceiling without actually waiting. AbortSignal.timeout in the
  // manifest probe path is also driven by setTimeout, but because the mocked fetch
  // resolves synchronously, the manifest's 15s timer never has a chance to fire.

  let EndpointUpdateProvider: typeof import("./endpoint-provider").EndpointUpdateProvider;
  let updaterErrors: typeof import("../../common/telemetry/errors/marshal-index").updaterErrors;

  beforeEach(async () => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    mockVerifySha.mockReset();
    mockVerifySha.mockResolvedValue();
    mockExistsSync.mockReturnValue(false);
    mockMkdirSync.mockReset();
    mockRmSync.mockReset();
    mockSendErrorTelemetry.mockReset();
    mockCreateWriteStream.mockImplementation(() => {
      const handlers: Record<string, ((err?: Error) => void)[]> = {};
      return {
        write: vi.fn<(chunk: unknown) => boolean>(),
        on: (event: string, fn: (err?: Error) => void) => {
          (handlers[event] ??= []).push(fn);
        },
        end: () => handlers.finish?.forEach((fn) => fn()),
        destroy: vi.fn<() => void>(),
      };
    });
    vi.resetModules();
    ({ EndpointUpdateProvider } = await import("./endpoint-provider"));
    ({ updaterErrors } = await import("../../common/telemetry/errors/marshal-index"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Build a Response whose body's `reader.read()` returns a pending promise that:
   *   - resolves with the next pushed chunk (via `pushChunk()`), OR
   *   - resolves with done=true (via `close()`), OR
   *   - rejects with an AbortError when the supplied signal aborts (mirrors what
   *     a real fetch body does when the underlying request is cancelled mid-stream).
   */
  function makeControlledResponse(signal?: AbortSignal) {
    let resolveRead: ((v: { done: boolean; value: Uint8Array | undefined }) => void) | null = null;
    let rejectRead: ((err: Error) => void) | null = null;
    const clearPending = () => {
      resolveRead = null;
      rejectRead = null;
    };
    if (signal) {
      signal.addEventListener("abort", () => {
        const r = rejectRead;
        clearPending();
        if (r) {
          // Mirror real fetch body behavior: aborted reader.read rejects with
          // an AbortError carrying the signal's reason as the message.
          const reasonMsg =
            signal.reason instanceof Error ? signal.reason.message : String(signal.reason);
          const abortErr = new Error(reasonMsg || "Aborted");
          abortErr.name = "AbortError";
          r(abortErr);
        }
      });
    }
    const reader = {
      read: () =>
        new Promise<{ done: boolean; value: Uint8Array | undefined }>((res, rej) => {
          resolveRead = res;
          rejectRead = rej;
        }),
      cancel: () => Promise.resolve(),
    };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
    const response = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-length": "10485760" }),
      body: { getReader: () => reader },
    } as unknown as Response;
    return {
      response,
      pushChunk: (b: Uint8Array) => {
        const r = resolveRead;
        clearPending();
        if (r) r({ done: false, value: b });
      },
      close: () => {
        const r = resolveRead;
        clearPending();
        if (r) r({ done: true, value: undefined });
      },
    };
  }

  /** Set up a check + download fetch pair, capturing the download's AbortSignal. */
  async function primeDownload() {
    const assetName = `Marshal-Windows-9.9.9-${process.arch}-Setup.exe`;
    const downloadUrl = `https://downloads.example.test/download/abc/${assetName}`;
    mockFetch.mockResolvedValueOnce(
      mockResponse(
        200,
        respBody({ latestVersion: "9.9.9", assetName, downloadUrl, sha256: "d".repeat(64) }),
      ),
    );
    let capturedController: ReturnType<typeof makeControlledResponse> | null = null;
    mockFetch.mockImplementationOnce(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedController = makeControlledResponse(init?.signal ?? undefined);
      return Promise.resolve(capturedController.response);
    });

    const provider = new EndpointUpdateProvider();
    await provider.checkForUpdate({ currentVersion: "1.0.0", channel: "stable" });
    return { provider, assetName, downloadUrl, getController: () => capturedController };
  }

  it("aborts with DOWNLOAD_TIMEOUT when no bytes arrive for 2 minutes (stall)", async () => {
    await withPlatformArch("win32", "x64", async () => {
      const { provider, assetName, downloadUrl } = await primeDownload();
      // Kick off the download — the reader.read promise will pend forever in the
      // mock until either we push or the stall fires.
      const downloadPromise = provider.downloadUpdate({ url: downloadUrl, assetName });
      // Pre-attach a no-op catch handler so Node's unhandled-rejection tracker
      // doesn't trip during the fake-timer advance below. We still assert on
      // downloadPromise itself further down.
      downloadPromise.catch(() => {});
      // Advance just past the 2-min stall threshold. The setTimeout fires
      // controller.abort → signal abort event → reader.read rejects with AbortError.
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 1);
      await expect(downloadPromise).rejects.toThrow(/stalled/i);
      // The catch routes AbortError to DOWNLOAD_TIMEOUT (not DOWNLOAD_STREAM_FAILED).
      expect(mockSendErrorTelemetry).toHaveBeenCalledTimes(1);
      expect(mockSendErrorTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({ code: updaterErrors.DOWNLOAD_TIMEOUT }),
        expect.anything(),
      );
    });
  });

  it("does NOT abort a slow-but-progressing download (stall timer resets on each chunk)", async () => {
    await withPlatformArch("win32", "x64", async () => {
      const { provider, assetName, downloadUrl, getController } = await primeDownload();
      const downloadPromise = provider.downloadUpdate({ url: downloadUrl, assetName });
      downloadPromise.catch(() => {});
      // Drive the loop manually: push 5 chunks at 1.5-min intervals. Each push resets
      // the stall (2 min); 1.5 min < 2 min so the stall never fires. Total wall time
      // = 5 × 1.5 = 7.5 min, well under the 10-min ceiling. The awaits inside the
      // loop are intentional: each iteration is a discrete tick (advance → push
      // → flush microtasks) that mirrors a real time-ordered stream.
      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line no-await-in-loop -- sequential ticks ARE the test
        await vi.advanceTimersByTimeAsync(90_000);
        const c = getController();
        if (!c) throw new Error("controller not captured");
        c.pushChunk(new Uint8Array([0x42]));
        // Let the loop body run (write + reset timer) before next advance.
        // eslint-disable-next-line no-await-in-loop -- sequential ticks ARE the test
        await Promise.resolve();
      }
      // Close the stream — the loop sees done=true, breaks, sha256 verify runs.
      const c = getController();
      if (!c) throw new Error("controller not captured");
      c.close();
      await expect(downloadPromise).resolves.toBeDefined();
      // Slow-but-progressing success: no timeout telemetry.
      expect(mockSendErrorTelemetry).not.toHaveBeenCalled();
    });
  });

  it("aborts with DOWNLOAD_TIMEOUT when the 10-minute overall ceiling fires (even with steady progress)", async () => {
    await withPlatformArch("win32", "x64", async () => {
      const { provider, assetName, downloadUrl, getController } = await primeDownload();
      const downloadPromise = provider.downloadUpdate({ url: downloadUrl, assetName });
      downloadPromise.catch(() => {});
      // Push a 1-byte chunk every minute for 9 minutes — stall never fires
      // (interval 1 min ≪ 2 min stall), but elapsed reaches 9 min. The awaits
      // inside the loop are intentional; same reasoning as the slow-progress test.
      for (let i = 0; i < 9; i++) {
        // eslint-disable-next-line no-await-in-loop -- sequential ticks ARE the test
        await vi.advanceTimersByTimeAsync(60_000);
        const c = getController();
        if (!c) throw new Error("controller not captured");
        c.pushChunk(new Uint8Array([0x42]));
        // eslint-disable-next-line no-await-in-loop -- sequential ticks ARE the test
        await Promise.resolve();
      }
      // Now advance another 60_001 ms → total 10 min + 1 ms → ceiling fires.
      // Stall was just reset at the 9-min mark; it would fire at 11 min, so the
      // ceiling wins the race.
      await vi.advanceTimersByTimeAsync(60_001);
      await expect(downloadPromise).rejects.toThrow(/ceiling/i);
      expect(mockSendErrorTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({ code: updaterErrors.DOWNLOAD_TIMEOUT }),
        expect.anything(),
      );
    });
  });

  it("threads the same AbortSignal through both the initial fetch and the redirect follow-up fetch", async () => {
    await withPlatformArch("win32", "x64", async () => {
      const assetName = `Marshal-Windows-9.9.9-${process.arch}-Setup.exe`;
      const downloadUrl = `https://downloads.example.test/download/abc/${assetName}`;
      const redirectUrl = `https://downloads.example.test/download/abc/follow/${assetName}`;
      mockFetch.mockResolvedValueOnce(
        mockResponse(
          200,
          respBody({ latestVersion: "9.9.9", assetName, downloadUrl, sha256: "d".repeat(64) }),
        ),
      );
      let initialSignal: AbortSignal | undefined;
      let redirectSignal: AbortSignal | undefined;
      // Initial download fetch returns a 302 → drives the redirect arm.
      mockFetch.mockImplementationOnce((_url: string | URL | Request, init?: RequestInit) => {
        initialSignal = init?.signal ?? undefined;
        return Promise.resolve(
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
          {
            ok: false,
            status: 302,
            statusText: "Found",
            headers: new Headers({ Location: redirectUrl }),
          } as unknown as Response,
        );
      });
      // Redirect follow-up fetch — capture signal, then return a body whose
      // reader immediately yields done=true so the loop exits cleanly.
      mockFetch.mockImplementationOnce((_url: string | URL | Request, init?: RequestInit) => {
        redirectSignal = init?.signal ?? undefined;
        const reader = {
          read: () => Promise.resolve({ done: true as const, value: undefined }),
          cancel: () => Promise.resolve(),
        };
        return Promise.resolve(
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
          {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: new Headers({ "content-length": "0" }),
            body: { getReader: () => reader },
          } as unknown as Response,
        );
      });

      const provider = new EndpointUpdateProvider();
      await provider.checkForUpdate({ currentVersion: "1.0.0", channel: "stable" });
      await provider.downloadUpdate({ url: downloadUrl, assetName });

      expect(initialSignal).toBeInstanceOf(AbortSignal);
      expect(redirectSignal).toBeInstanceOf(AbortSignal);
      // SAME controller drives both fetches — a stall during the redirect leg must
      // be able to abort the redirected fetch, not just the initial one.
      expect(initialSignal).toBe(redirectSignal);
      // Both signals were not aborted (download succeeded) — finally block cleared
      // both timers, so no late abort fires.
      expect(initialSignal?.aborted).toBe(false);
      expect(redirectSignal?.aborted).toBe(false);
    });
  });

  it("clears both timers in the success-path finally — no late abort fires after the download completes", async () => {
    await withPlatformArch("win32", "x64", async () => {
      const assetName = `Marshal-Windows-9.9.9-${process.arch}-Setup.exe`;
      const downloadUrl = `https://downloads.example.test/download/abc/${assetName}`;
      mockFetch.mockResolvedValueOnce(
        mockResponse(
          200,
          respBody({ latestVersion: "9.9.9", assetName, downloadUrl, sha256: "d".repeat(64) }),
        ),
      );
      // Download fetch: stream one chunk then done so we exercise resetStallTimer
      // at least once before the loop exits.
      let firstRead = true;
      let downloadSignal: AbortSignal | undefined;
      mockFetch.mockImplementationOnce((_url: string | URL | Request, init?: RequestInit) => {
        downloadSignal = init?.signal ?? undefined;
        const reader = {
          read: () => {
            if (firstRead) {
              firstRead = false;
              return Promise.resolve({ done: false as const, value: new Uint8Array([0x42]) });
            }
            return Promise.resolve({ done: true as const, value: undefined });
          },
          cancel: () => Promise.resolve(),
        };
        return Promise.resolve(
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
          {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: new Headers({ "content-length": "1" }),
            body: { getReader: () => reader },
          } as unknown as Response,
        );
      });

      const provider = new EndpointUpdateProvider();
      await provider.checkForUpdate({ currentVersion: "1.0.0", channel: "stable" });
      await provider.downloadUpdate({ url: downloadUrl, assetName });

      // Sanity: download succeeded without aborting.
      expect(downloadSignal?.aborted).toBe(false);
      mockSendErrorTelemetry.mockReset();
      // Advance well past both timeout windows. If the finally didn't clear the
      // timers, abort would fire here. Because the controller's no longer referenced
      // by any awaiting reader, the only observable signal of a late abort would be
      // telemetry — assert none emitted, AND the signal stays un-aborted.
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      expect(mockSendErrorTelemetry).not.toHaveBeenCalled();
      expect(downloadSignal?.aborted).toBe(false);
    });
  });
});

describe("EndpointUpdateProvider.authenticate — no-op parity with the IUpdateProvider contract", () => {
  let EndpointUpdateProvider: typeof import("./endpoint-provider").EndpointUpdateProvider;

  beforeEach(async () => {
    mockFetch.mockReset();
    vi.resetModules();
    ({ EndpointUpdateProvider } = await import("./endpoint-provider"));
  });

  it("returns { ok: true } immediately — endpoint flow has no device-code step", async () => {
    // Parity with `github-provider.test.ts`'s authenticate happy-path: every
    // IUpdateProvider must accept authenticate() without throwing. The endpoint
    // provider is unauthenticated by design (1P-runtime URL gated by host
    // network), so it satisfies the contract by returning ok=true without doing
    // anything. Pin that so a future implementation can't quietly add latency
    // or side effects against the IUpdateProvider contract in `ports.ts`.
    const result = await new EndpointUpdateProvider().authenticate({});
    expect(result).toEqual({ ok: true });
  });

  it("never invokes the onDeviceCode callback — endpoint has no device-code flow", async () => {
    // The github-provider authenticate path can fall back to a device-code
    // flow that fires `onDeviceCode(userCode, verificationUri)`. The endpoint
    // provider has no such fallback. Pin that the callback stays silent so a
    // future refactor that unifies authenticate() across providers can't quietly
    // start firing it on the endpoint path and surface a device-code UI for a
    // flow that doesn't use device codes.
    const onDeviceCode = vi.fn<(info: { userCode: string; verificationUri: string }) => void>();
    const result = await new EndpointUpdateProvider().authenticate({ onDeviceCode });
    expect(result).toEqual({ ok: true });
    expect(onDeviceCode).not.toHaveBeenCalled();
  });
});

describe("EndpointUpdateProvider.downloadUpdate — pre-fetch input validation rejects before any side effect", () => {
  let EndpointUpdateProvider: typeof import("./endpoint-provider").EndpointUpdateProvider;

  beforeEach(async () => {
    mockFetch.mockReset();
    mockMkdirSync.mockReset();
    vi.resetModules();
    ({ EndpointUpdateProvider } = await import("./endpoint-provider"));
  });

  it("rejects a path-traversal assetName before fetch — no fetch, no mkdir, no partial state", async () => {
    // The download path runs `validateAssetName` BEFORE the first fetch and
    // BEFORE mkdirSync touches the tmpdir. Pin the rejection so a future change
    // that re-orders the guards (e.g. moves the mkdir before validation as an
    // optimization) can't introduce a path-traversal hole. Parallel to GitHub
    // provider's input-validation block in `updater.test.ts`.
    const downloadUrl = "https://downloads.example.test/download/abc/legit.exe";
    const traversalAssetName = "../../etc/passwd";

    await expect(
      new EndpointUpdateProvider().downloadUpdate({
        url: downloadUrl,
        assetName: traversalAssetName,
      }),
    ).rejects.toThrow(/flat filename/i);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  it("rejects the Startup-folder PoC assetName (NTFS Alternate Data Stream colon) before fetch", async () => {
    // A security report documented a Windows-specific ADS injection where a `:` in
    // the asset filename would, post-write, expose an alternate data stream on
    // NTFS. validateAssetName treats `:` as one of the rejected characters.
    // Pin it specifically — the PoC is the regression we most need to never
    // re-introduce on the endpoint path.
    const downloadUrl = "https://downloads.example.test/download/abc/legit.exe";
    const adsAssetName = "installer.exe:hidden-ads";

    await expect(
      new EndpointUpdateProvider().downloadUpdate({
        url: downloadUrl,
        assetName: adsAssetName,
      }),
    ).rejects.toThrow(/flat filename/i);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });
});
