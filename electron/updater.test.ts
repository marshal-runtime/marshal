import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock os.platform() so we can control IS_MAC / IS_WINDOWS at import time.
// tmpdir() is also wrapped so validateUpdatePath tests can swap in a
// deterministic directory string. The default delegates to the real tmpdir.
const mockPlatform = vi.fn<() => string>(() => "darwin");
const mockTmpdir = vi.fn<() => string>();
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  mockTmpdir.mockImplementation(() => actual.tmpdir());
  return { ...actual, platform: mockPlatform, tmpdir: mockTmpdir };
});

// Mock child_process.execFileSync for signature verification tests
const mockExecFileSync = vi.fn<(...args: unknown[]) => string>();
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, execFileSync: (...args: unknown[]) => mockExecFileSync(...args) };
});

// spawnUpdateProgress is mocked file-wide because verifyAndLaunch unit tests
// shouldn't actually spawn anything. No other tests in this file exercise
// update-progress code paths, so the global mock is a no-op for them.
const mockSpawnUpdateProgress = vi.fn<(...args: unknown[]) => Promise<boolean>>();
vi.mock("./update-progress", () => ({
  spawnUpdateProgress: (...args: unknown[]) => mockSpawnUpdateProgress(...args),
}));

// Spy on telemetry so the SIGNATURE_VERIFY_FAILED / INSTALL_FAILED tests at the bottom of this
// file can assert the typed code without booting the renderer's window-bound emit pipe. The real
// `sendErrorTelemetry` is inert in tests (no window registered), so this mock changes no behavior
// for the other suites; it just gives the install-path tests something to call .mock.calls on.
const mockSendErrorTelemetry = vi.fn<(error: { code: number }, cause?: unknown) => void>();
vi.mock("./telemetry-errors", () => ({
  sendErrorTelemetry: mockSendErrorTelemetry,
  markTelemetry: vi.fn<(value: unknown) => void>(),
}));

describe("isNewer", () => {
  // isNewer has no platform dependency — safe to import once
  let isNewer: typeof import("./updater").isNewer;
  beforeEach(async () => {
    const mod = await import("./updater");
    isNewer = mod.isNewer;
  });

  it("returns true for patch bump", () => {
    expect(isNewer("0.8.28", "0.8.27")).toBe(true);
  });

  it("returns true for minor bump", () => {
    expect(isNewer("0.9.0", "0.8.27")).toBe(true);
  });

  it("returns true for major bump", () => {
    expect(isNewer("1.0.0", "0.8.27")).toBe(true);
  });

  it("returns false for same version", () => {
    expect(isNewer("0.8.27", "0.8.27")).toBe(false);
  });

  it("returns false for older patch", () => {
    expect(isNewer("0.8.26", "0.8.27")).toBe(false);
  });

  it("returns false for older minor", () => {
    expect(isNewer("0.8.27", "0.9.0")).toBe(false);
  });
});

describe("getAssetName", () => {
  it("returns DMG name on darwin", async () => {
    mockPlatform.mockReturnValue("darwin");
    vi.resetModules();
    const { getAssetName } = await import("./updater");
    expect(getAssetName("1.2.3", "arm64")).toBe("Marshal-Mac-1.2.3-arm64-Installer.dmg");
    expect(getAssetName("1.2.3", "x64")).toBe("Marshal-Mac-1.2.3-x64-Installer.dmg");
  });

  it("returns arch-qualified Setup exe name for win32 x64", async () => {
    mockPlatform.mockReturnValue("win32");
    vi.resetModules();
    const { getAssetName } = await import("./updater");
    expect(getAssetName("1.2.3", "x64")).toBe("Marshal-Windows-1.2.3-x64-Setup.exe");
  });

  it("returns arch-qualified Setup exe name for win32 arm64", async () => {
    mockPlatform.mockReturnValue("win32");
    vi.resetModules();
    const { getAssetName } = await import("./updater");
    expect(getAssetName("1.2.3", "arm64")).toBe("Marshal-Windows-1.2.3-arm64-Setup.exe");
  });
});

describe("validateAssetName", () => {
  // Stateless pure function.
  let validateAssetName: typeof import("./updater").validateAssetName;
  beforeEach(async () => {
    validateAssetName = (await import("./updater")).validateAssetName;
  });

  it("accepts a flat filename", () => {
    expect(() => validateAssetName("Marshal-Windows-1.2.3-x64-Setup.exe")).not.toThrow();
  });

  it("rejects forward-slash separator", () => {
    expect(() => validateAssetName("foo/bar.exe")).toThrow(/flat filename/i);
  });

  it("rejects backslash separator", () => {
    expect(() => validateAssetName("foo\\bar.exe")).toThrow(/flat filename/i);
  });

  it("rejects parent-directory traversal (Windows-style)", () => {
    expect(() =>
      validateAssetName("..\\..\\..\\Roaming\\Microsoft\\Windows\\Start Menu\\p.exe"),
    ).toThrow(/flat filename/i);
  });

  it("rejects the exact PoC payload (Startup-folder persistence)", () => {
    expect(() =>
      validateAssetName(
        "..\\..\\..\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\p.exe",
      ),
    ).toThrow(/flat filename/i);
  });

  it("rejects Windows NTFS Alternate Data Stream syntax", () => {
    // foo.exe:Zone.Identifier would let a renderer strip the mark-of-the-web.
    expect(() => validateAssetName("Setup.exe:Zone.Identifier")).toThrow(/flat filename/i);
  });

  it("rejects parent-directory traversal (POSIX-style)", () => {
    expect(() => validateAssetName("../../etc/passwd")).toThrow(/flat filename/i);
  });

  it("rejects absolute POSIX path", () => {
    expect(() => validateAssetName("/etc/passwd")).toThrow(/flat filename/i);
  });

  it("rejects literal '..'", () => {
    expect(() => validateAssetName("..")).toThrow(/flat filename/i);
  });

  it("rejects empty string", () => {
    expect(() => validateAssetName("")).toThrow(/flat filename/i);
  });

  it("rejects null byte", () => {
    expect(() => validateAssetName("foo\0.exe")).toThrow(/flat filename/i);
  });
});

describe("verifyMacSignature", () => {
  let verifyMacSignature: typeof import("./updater").verifyMacSignature;

  beforeEach(async () => {
    mockExecFileSync.mockReset();
    mockPlatform.mockReturnValue("darwin");
    vi.resetModules();
    const mod = await import("./updater");
    verifyMacSignature = mod.verifyMacSignature;
  });

  it("succeeds when codesign passes, with pinned Team ID in -R requirement", () => {
    mockExecFileSync.mockReturnValue("");
    expect(() => verifyMacSignature("/Volumes/Test/App.app")).not.toThrow();
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "codesign",
      [
        "--verify",
        "--deep",
        "--strict",
        "-R",
        // The leading "=" tells `codesign -R` that the argument is a literal
        // requirement string, not a path to a requirement file. Without it,
        // codesign tries to open(2) the requirement text as a file and aborts
        // before inspecting the signature (see real-codesign test below).
        '=anchor apple generic and (certificate leaf[subject.OU] = "UNCONFIGURED_MACOS_TEAM")',
        "/Volumes/Test/App.app",
      ],
      { stdio: "pipe" },
    );
  });

  it("throws signature UpdaterError when codesign fails", () => {
    const err = Object.assign(new Error("codesign failed"), {
      stderr: "code object is not signed at all",
    });
    mockExecFileSync.mockImplementation((...args: unknown[]) => {
      if (args[0] === "codesign") throw err;
      return "";
    });
    expect(() => verifyMacSignature("/Volumes/Test/App.app")).toThrow(
      expect.objectContaining({
        code: "signature",
        message: expect.stringContaining("code object is not signed at all"),
      }),
    );
  });

  it("throws signature UpdaterError when codesign rejects the Team ID requirement", () => {
    const err = Object.assign(new Error("codesign failed"), {
      stderr: "test-requirement: failed to satisfy designated requirement",
    });
    mockExecFileSync.mockImplementation((...args: unknown[]) => {
      if (args[0] === "codesign") throw err;
      return "";
    });
    expect(() => verifyMacSignature("/Volumes/Test/App.app")).toThrow(
      expect.objectContaining({
        code: "signature",
        message: expect.stringContaining("failed to satisfy designated requirement"),
      }),
    );
  });

  // Real-codesign regression. The unit tests above mock execFileSync, so they
  // assert the argv *shape* but never prove the argv is actually accepted by
  // the codesign binary. Hands the real argv to the real codesign and asserts
  // the failure mode is a signature/requirement mismatch — NOT codesign
  // aborting because it tried to open the requirement string as a file path.
  it.skipIf(process.platform !== "darwin")(
    "passes -R as a literal requirement, not a file path (real codesign)",
    async () => {
      const real = await vi.importActual<typeof import("child_process")>("child_process");
      mockExecFileSync.mockImplementation((...args: unknown[]) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- delegating loose mock signature to real execFileSync
        const out = real.execFileSync(...(args as Parameters<typeof real.execFileSync>));
        return typeof out === "string" ? out : out.toString();
      });

      // /usr/bin/codesign is Apple-signed and present on every macOS host,
      // but its leaf cert OU is Apple's, not the pinned team's — so the pinned
      // requirement must fail. The point of the assertion is that the
      // failure is a real cert-OU mismatch ("failed to satisfy designated
      // requirement"), not the file-path error mode.
      let message = "";
      try {
        verifyMacSignature("/usr/bin/codesign");
      } catch (e) {
        if (e instanceof Error) message = e.message;
      }
      // Positive assertion first — a future regression that makes
      // verifyMacSignature stop throwing would leave message="" and let the
      // two negative assertions below trivially pass. Apple's stderr on a
      // requirement mismatch varies by macOS version; the stable phrase is
      // "failed to satisfy" followed by "code requirement".
      expect(message).not.toBe("");
      expect(message).toMatch(/failed to satisfy.*code requirement/i);
      expect(message).not.toContain("No such file or directory");
      expect(message).not.toContain("invalid requirement specification");
    },
  );
});

describe("validateUpdatePath", () => {
  let validateUpdatePath: typeof import("./updater").validateUpdatePath;

  // Windows filesystem is case-insensitive but Node's startsWith is not.
  // os.tmpdir() can return paths whose casing doesn't match the staged
  // installer path's casing (8.3 short-name expansion, USERPROFILE casing).
  // Pre-existing gap, surfaced by this PR because validateUpdatePath now
  // sits in verifyAndLaunch's security hot path.
  it("accepts case-shifted tmpdir prefix on Windows", async () => {
    mockPlatform.mockReturnValue("win32");
    mockTmpdir.mockReturnValueOnce("/Canonical-Tmp");
    vi.resetModules();
    ({ validateUpdatePath } = await import("./updater"));
    // Staged installer path uses different casing — same directory on Windows.
    expect(() => validateUpdatePath("/canonical-tmp/marshal-update/installer.exe")).not.toThrow();
  });

  it("still rejects case-shifted tmpdir prefix on macOS (case-sensitive FS)", async () => {
    mockPlatform.mockReturnValue("darwin");
    mockTmpdir.mockReturnValueOnce("/Canonical-Tmp");
    vi.resetModules();
    ({ validateUpdatePath } = await import("./updater"));
    expect(() => validateUpdatePath("/canonical-tmp/marshal-update/installer.dmg")).toThrow(
      /Invalid update path/,
    );
  });

  it("rejects path outside tmpdir even with matching extension", async () => {
    mockPlatform.mockReturnValue("win32");
    mockTmpdir.mockReturnValueOnce("/Canonical-Tmp");
    vi.resetModules();
    ({ validateUpdatePath } = await import("./updater"));
    expect(() => validateUpdatePath("/elsewhere/installer.exe")).toThrow(/Invalid update path/);
  });
});

describe("verifyWindowsSignature", () => {
  let verifyWindowsSignature: typeof import("./updater").verifyWindowsSignature;

  beforeEach(async () => {
    mockExecFileSync.mockReset();
    mockPlatform.mockReturnValue("win32");
    vi.resetModules();
    const mod = await import("./updater");
    verifyWindowsSignature = mod.verifyWindowsSignature;
  });

  it("succeeds when signature is valid AND subject matches the pinned publisher", () => {
    mockExecFileSync.mockReturnValue("");
    expect(() => verifyWindowsSignature("C:\\temp\\Setup.exe")).not.toThrow();
    expect(mockExecFileSync).toHaveBeenCalledOnce();
    const [executable, argv] = mockExecFileSync.mock.calls[0];
    expect(executable).toBe("powershell.exe");
    if (!Array.isArray(argv) || typeof argv[2] !== "string") {
      throw new Error("expected powershell.exe to be invoked with [..., '-Command', <script>]");
    }
    // Must check Status -ne Valid AND SignerCertificate.Subject.StartsWith.
    // Both are required: status-only was the bug.
    expect(argv[2]).toContain("$sig.Status -ne 'Valid'");
    expect(argv[2]).toContain(
      "$sig.SignerCertificate.Subject.StartsWith('UNCONFIGURED_WINDOWS_SIGNER', [System.StringComparison]::OrdinalIgnoreCase)",
    );
  });

  it("pins PSModulePath to the Windows PowerShell 5.1 system dirs so PS7 modules don't capture autoload", () => {
    // Regression: on dev boxes with PowerShell 7 installed, an inherited PSModulePath ordering
    // PS7's module dirs first makes powershell.exe (5.1) pick PS7's Microsoft.PowerShell.Security
    // for Get-AuthenticodeSignature, which then fails to load under PS5 and blocks every update.
    mockExecFileSync.mockReturnValue("");
    verifyWindowsSignature("C:\\temp\\Setup.exe");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "powershell.exe",
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          PSModulePath: expect.stringMatching(
            /^[^;]*\\System32\\WindowsPowerShell\\v1\.0\\Modules(?:;|$)/,
          ),
        }),
      }),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "powershell.exe",
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          PSModulePath: expect.not.stringMatching(
            /\\PowerShell\\7\\Modules|\\Program Files\\PowerShell\\Modules(?!\\)/i,
          ),
        }),
      }),
    );
  });

  it("throws signature UpdaterError when Authenticode verification fails", () => {
    const err = Object.assign(new Error("powershell failed"), {
      stderr: "Signature status: NotSigned",
    });
    mockExecFileSync.mockImplementation((...args: unknown[]) => {
      if (args[0] === "powershell.exe") throw err;
      return "";
    });
    expect(() => verifyWindowsSignature("C:\\temp\\Setup.exe")).toThrow(
      expect.objectContaining({
        code: "signature",
        message: expect.stringContaining("Signature status: NotSigned"),
      }),
    );
  });

  it("wraps publisher-mismatch stderr into signature UpdaterError", () => {
    const err = Object.assign(new Error("powershell failed"), {
      stderr: "Signature publisher mismatch: CN=Evil Corp, O=Evil Corp",
    });
    mockExecFileSync.mockImplementation((...args: unknown[]) => {
      if (args[0] === "powershell.exe") throw err;
      return "";
    });
    expect(() => verifyWindowsSignature("C:\\temp\\Setup.exe")).toThrow(
      expect.objectContaining({
        code: "signature",
        message: expect.stringContaining("Signature publisher mismatch"),
      }),
    );
  });
});

describe("verifyMacSignature / verifyWindowsSignature — SIGNATURE_VERIFY_FAILED telemetry", () => {
  // Spec: every signature-verification failure is a security-relevant event. The verifier
  // emits its own typed telemetry (so install-path doesn't have to retro-classify a generic
  // throw), and the catch in installUpdate must filter the "signature" code OUT of
  // INSTALL_FAILED to prevent dual-emission. Pin both halves here; the dual-emission guard
  // is also pinned by "installUpdate routes Windows signature failure exactly once" below.
  let verifyMacSignature: typeof import("./updater").verifyMacSignature;
  let verifyWindowsSignature: typeof import("./updater").verifyWindowsSignature;
  let updaterErrors: typeof import("../common/telemetry/errors/marshal-index").updaterErrors;

  beforeEach(async () => {
    mockExecFileSync.mockReset();
    mockSendErrorTelemetry.mockReset();
    vi.resetModules();
    const mod = await import("./updater");
    verifyMacSignature = mod.verifyMacSignature;
    verifyWindowsSignature = mod.verifyWindowsSignature;
    ({ updaterErrors } = await import("../common/telemetry/errors/marshal-index"));
  });

  it("verifyMacSignature emits SIGNATURE_VERIFY_FAILED with the wrapped UpdaterError as the cause", () => {
    mockPlatform.mockReturnValue("darwin");
    const err = Object.assign(new Error("codesign failed"), {
      stderr: "code object is not signed at all",
    });
    mockExecFileSync.mockImplementation((...args: unknown[]) => {
      if (args[0] === "codesign") throw err;
      return "";
    });
    expect(() => verifyMacSignature("/Volumes/Test/App.app")).toThrow(
      expect.objectContaining({ code: "signature" }),
    );
    expect(mockSendErrorTelemetry).toHaveBeenCalledTimes(1);
    // The wrapped UpdaterError is passed as cause so the WeakSet dedup in
    // telemetry-errors.markTelemetry marks the same instance that escapes upward.
    expect(mockSendErrorTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ code: updaterErrors.SIGNATURE_VERIFY_FAILED }),
      expect.objectContaining({ code: "signature" }),
    );
  });

  it("verifyWindowsSignature emits SIGNATURE_VERIFY_FAILED with the wrapped UpdaterError as the cause", () => {
    mockPlatform.mockReturnValue("win32");
    const err = Object.assign(new Error("powershell failed"), {
      stderr: "Signature status: NotSigned",
    });
    mockExecFileSync.mockImplementation((...args: unknown[]) => {
      if (args[0] === "powershell.exe") throw err;
      return "";
    });
    expect(() => verifyWindowsSignature("C:\\temp\\Setup.exe")).toThrow(
      expect.objectContaining({ code: "signature" }),
    );
    expect(mockSendErrorTelemetry).toHaveBeenCalledTimes(1);
    expect(mockSendErrorTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ code: updaterErrors.SIGNATURE_VERIFY_FAILED }),
      expect.objectContaining({ code: "signature" }),
    );
  });
});

describe("installUpdate — INSTALL_FAILED telemetry + signature-dedup guard", () => {
  // Spec: installUpdate is the single point of INSTALL_FAILED emission for the install
  // attempt. The catch MUST skip emission when the cause is an UpdaterError with
  // code: "signature" — those have already been telemetered as SIGNATURE_VERIFY_FAILED
  // by the verifier, and a second INSTALL_FAILED would double-count in dashboards.
  let installUpdate: typeof import("./updater").installUpdate;
  let updaterErrors: typeof import("../common/telemetry/errors/marshal-index").updaterErrors;

  beforeEach(async () => {
    mockExecFileSync.mockReset();
    mockSendErrorTelemetry.mockReset();
    vi.resetModules();
    const mod = await import("./updater");
    installUpdate = mod.installUpdate;
    ({ updaterErrors } = await import("../common/telemetry/errors/marshal-index"));
  });

  it("installUpdate (Windows) emits INSTALL_FAILED when the installer file is missing", async () => {
    // Set the platform mock BEFORE re-importing so the fresh module evaluates
    // IS_WINDOWS=true on POSIX CI runners too (`const IS_WINDOWS = platform() === "win32"`
    // is module-load-time). path.join keeps separators host-native so validateUpdatePath's
    // tmpdir-prefix check passes and execution reaches installWindowsNSIS's
    // `if (!existsSync(exePath)) throw …` branch — the one this test exercises.
    mockPlatform.mockReturnValue("win32");
    vi.resetModules();
    ({ installUpdate } = await import("./updater"));
    const { join } = await import("path");
    const missing = join(mockTmpdir(), "marshal-update", `does-not-exist-${Date.now()}.exe`);
    await expect(installUpdate(missing)).rejects.toThrow(/Installer not found/);
    expect(mockSendErrorTelemetry).toHaveBeenCalledTimes(1);
    expect(mockSendErrorTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ code: updaterErrors.INSTALL_FAILED }),
      expect.anything(),
    );
  });

  it("installUpdate routes Windows signature failure exactly once — SIGNATURE_VERIFY_FAILED, NOT also INSTALL_FAILED", async () => {
    // Regression guard: an earlier draft emitted INSTALL_FAILED whenever the install path
    // threw at all — including when the throw was the signature verifier — which would
    // double-count signature events in the dashboard. The catch in installUpdate must
    // detect `err instanceof UpdaterError && err.code === "signature"` and skip its own
    // emission. We need a real Setup.exe-shaped file on disk so existsSync passes and
    // execution reaches verifyWindowsSignature; the verifier's mocked failure provides
    // the throw.
    mockPlatform.mockReturnValue("win32");
    const { writeFileSync, mkdirSync, rmSync } = await import("fs");
    const { join } = await import("path");
    const stageDir = join(mockTmpdir(), "marshal-update");
    mkdirSync(stageDir, { recursive: true });
    const installerPath = join(stageDir, `Setup-${Date.now()}.exe`);
    writeFileSync(installerPath, Buffer.alloc(8));
    try {
      const err = Object.assign(new Error("powershell failed"), {
        stderr: "Signature status: NotSigned",
      });
      mockExecFileSync.mockImplementation((...args: unknown[]) => {
        if (args[0] === "powershell.exe") throw err;
        return "";
      });
      await expect(installUpdate(installerPath)).rejects.toThrow(
        expect.objectContaining({ code: "signature" }),
      );
      // The verifier emits SIGNATURE_VERIFY_FAILED. installUpdate's catch must NOT add a
      // second INSTALL_FAILED for the same throw — exactly one telemetry event.
      expect(mockSendErrorTelemetry).toHaveBeenCalledTimes(1);
      expect(mockSendErrorTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({ code: updaterErrors.SIGNATURE_VERIFY_FAILED }),
        expect.anything(),
      );
    } finally {
      try {
        rmSync(installerPath, { force: true });
      } catch {
        /* best effort cleanup */
      }
    }
  });
});

describe("verifyAndLaunch", () => {
  let verifyAndLaunch: typeof import("./updater").verifyAndLaunch;

  beforeEach(async () => {
    mockExecFileSync.mockReset();
    mockSpawnUpdateProgress.mockReset();
    mockPlatform.mockReturnValue("win32");
    vi.resetModules();
    const mod = await import("./updater");
    verifyAndLaunch = mod.verifyAndLaunch;
  });

  it("validates path, verifies signature, then spawns installer in that order on the happy path", async () => {
    mockExecFileSync.mockReturnValue("");
    mockSpawnUpdateProgress.mockResolvedValue(true);

    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const installerPath = join(tmpdir(), "marshal-update", "Marshal-Setup.exe");

    await verifyAndLaunch(installerPath, "C:\\Program Files\\Marshal\\Marshal.exe");

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "powershell.exe",
      expect.any(Array),
      expect.objectContaining({ encoding: "utf-8" }),
    );
    expect(mockSpawnUpdateProgress).toHaveBeenCalledWith(
      installerPath,
      "C:\\Program Files\\Marshal\\Marshal.exe",
    );
    // Ordering: verify (execFileSync) must run before spawn.
    expect(mockExecFileSync.mock.invocationCallOrder[0]).toBeLessThan(
      mockSpawnUpdateProgress.mock.invocationCallOrder[0],
    );
  });

  it("does NOT call spawnUpdateProgress when signature verification fails", async () => {
    const err = Object.assign(new Error("powershell failed"), {
      stderr: "Signature publisher mismatch: CN=Evil Corp",
    });
    mockExecFileSync.mockImplementation((...args: unknown[]) => {
      if (args[0] === "powershell.exe") throw err;
      return "";
    });

    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const installerPath = join(tmpdir(), "marshal-update", "Marshal-Setup.exe");

    await expect(verifyAndLaunch(installerPath, "C:\\app.exe")).rejects.toThrow(
      expect.objectContaining({ code: "signature" }),
    );
    expect(mockSpawnUpdateProgress).not.toHaveBeenCalled();
  });

  it("rejects a path outside the expected staging dir before verifying or spawning", async () => {
    await expect(
      verifyAndLaunch("C:\\Users\\victim\\Desktop\\rogue.exe", "C:\\app.exe"),
    ).rejects.toThrow(/Invalid update path/);
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockSpawnUpdateProgress).not.toHaveBeenCalled();
  });

  it("throws when called on a non-Windows platform", async () => {
    mockPlatform.mockReturnValue("darwin");
    vi.resetModules();
    const mod = await import("./updater");
    const verifyAndLaunchOnMac = mod.verifyAndLaunch;

    await expect(
      verifyAndLaunchOnMac("/tmp/marshal-update/Marshal.dmg", "/Applications/Marshal.app"),
    ).rejects.toThrow(
      expect.objectContaining({
        code: "signature",
        message: expect.stringContaining("Windows-only"),
      }),
    );
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockSpawnUpdateProgress).not.toHaveBeenCalled();
  });
});
