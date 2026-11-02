import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// This file uses REAL fs so the happy-path tests can pin "bytes actually land on
// disk" the way `electron/updater.test.ts:543` does for the GitHub provider. The
// sibling `endpoint-provider.test.ts` mocks fs at module scope and is built around
// fake-timer + abort-controller tests for the stall/ceiling paths; mixing real fs
// into that file would risk mock leakage between suites. Splitting into a separate
// file keeps both styles cleanly isolated.

const { mockFetch, mockSendErrorTelemetry, mockVerifySha } = vi.hoisted(() => ({
  mockFetch: vi.fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>(),
  mockSendErrorTelemetry: vi.fn<(error: { code: number }, cause?: unknown) => void>(),
  mockVerifySha: vi.fn<(path: string, expected: string) => Promise<void>>(),
}));
vi.mock("../marshal-net-fetch", () => ({ getNetFetch: () => mockFetch }));
vi.mock("../telemetry-errors", () => ({
  sendErrorTelemetry: mockSendErrorTelemetry,
  markTelemetry: vi.fn<(value: unknown) => void>(),
}));
// Pass through the schema module but stub the sha verifier — the bytes-on-disk
// tests assert "the right bytes are written", not "they hash to the right value"
// (the latter is already pinned in endpoint-provider.test.ts).
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

/** Stream-bearing Response whose body emits `bytes` once and is then done. */
function mockBinaryResponse(
  status: number,
  bytes: Uint8Array,
  headers?: Record<string, string>,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Headers({ "content-length": String(bytes.byteLength), ...headers }),
    body: stream,
  } as Response;
}

/** A 3xx redirect Response (no body). */
function mockRedirectResponse(status: number, location?: string): Response {
  const headers = new Headers();
  if (location !== undefined) headers.set("Location", location);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
  return {
    ok: false,
    status,
    statusText: "Found",
    headers,
    json: () => Promise.resolve({}),
  } as Response;
}

/** ReadableStream whose 1st read returns `chunk` and 2nd read rejects with a non-AbortError. */
function streamingResponseThatMidstreamErrors(chunk: Uint8Array, midError: Error): Response {
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++;
      if (reads === 1) {
        controller.enqueue(chunk);
      } else {
        controller.error(midError);
      }
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    // content-length advertises a full file's worth so onProgress would try to fire — the test
    // only cares that the reader.read() rejection is caught and mapped to DOWNLOAD_STREAM_FAILED.
    headers: new Headers({ "content-length": String(chunk.byteLength * 4) }),
    body: stream,
  } as Response;
}

/** updaterErrors codes are append-only; the file-level enum lives in common/telemetry/errors/marshal-updater.ts. */
let updaterErrors: typeof import("../../common/telemetry/errors/marshal-index").updaterErrors;

const ASSET_NAME = "Marshal-Windows-9.9.9-x64-Setup.exe";
const START_URL = `https://downloads.example.test/download/abc/${ASSET_NAME}`;

/**
 * Build a START_URL whose pathname matches `assetName` so the
 * `validateEndpointDownloadUrl` pathname/assetName cross-check in
 * `update-check-schema.ts` accepts it. Tests that need per-test unique
 * filenames (to dodge Windows file-lock contention) use this helper to keep
 * the URL pathname and the manifest assetName in lock-step.
 */
function startUrlFor(assetName: string): string {
  return `https://downloads.example.test/download/abc/${assetName}`;
}

describe("EndpointUpdateProvider.downloadUpdate — redirect + bytes-on-disk (parity with electron/updater.test.ts)", () => {
  let EndpointUpdateProvider: typeof import("./endpoint-provider").EndpointUpdateProvider;
  let writtenPaths: string[];

  beforeEach(async () => {
    mockFetch.mockReset();
    mockSendErrorTelemetry.mockReset();
    mockVerifySha.mockReset();
    mockVerifySha.mockResolvedValue();
    writtenPaths = [];
    vi.resetModules();
    ({ EndpointUpdateProvider } = await import("./endpoint-provider"));
    ({ updaterErrors } = await import("../../common/telemetry/errors/marshal-index"));
  });

  afterEach(async () => {
    // Best-effort cleanup; tests also cleanup in-band but afterEach catches the
    // failure-path tests where the partial file is rm'd by the provider itself.
    const fs = await import("fs");
    for (const p of writtenPaths) {
      try {
        if (fs.existsSync(p)) fs.rmSync(p);
      } catch {
        /* best effort */
      }
    }
  });

  it("happy path: 302 → 200 with bytes streams to real file and returns filePath", async () => {
    // Mirrors `updater.test.ts:543`. Bytes-on-disk pin — both the redirect leg
    // AND the read loop AND the createWriteStream/end orchestration have to work
    // end-to-end for this to pass.
    const payload = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03]); // "MZ\x90\0\x03" — PE header tease
    const fileName = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}.exe`;
    mockFetch
      .mockResolvedValueOnce(
        mockRedirectResponse(302, "https://downloads.example.test/download/xyz/" + fileName),
      )
      .mockResolvedValueOnce(mockBinaryResponse(200, payload));

    const onProgress = vi.fn<(p: number) => void>();
    const filePath = await new EndpointUpdateProvider().downloadUpdate({
      url: startUrlFor(fileName),
      assetName: fileName,
      onProgress,
    });
    writtenPaths.push(filePath);

    const fs = await import("fs");
    expect(filePath).toContain(fileName);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath)).toEqual(Buffer.from(payload));
    expect(onProgress).toHaveBeenCalledWith(100);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockSendErrorTelemetry).not.toHaveBeenCalled();
  });

  it("direct 200 (no redirect) streams to real file successfully", async () => {
    // Mirrors `updater.test.ts:574`. The non-redirect arm of the provider has to
    // round-trip just as cleanly as the 302 path — most prod CDN responses are
    // terminal 200s, so the direct-200 branch is the steady-state path.
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const fileName = `probe-direct-${Date.now()}-${Math.random().toString(36).slice(2)}.exe`;
    mockFetch.mockResolvedValueOnce(mockBinaryResponse(200, payload));

    const filePath = await new EndpointUpdateProvider().downloadUpdate({
      url: startUrlFor(fileName),
      assetName: fileName,
    });
    writtenPaths.push(filePath);

    const fs = await import("fs");
    expect(filePath).toContain(fileName);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath)).toEqual(Buffer.from(payload));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockSendErrorTelemetry).not.toHaveBeenCalled();
  });

  it("does NOT attach an Authorization header on either fetch leg of a 302 → 200", async () => {
    // Endpoint-flow regression-defense: today nothing attaches an Authorization
    // header to the download leg (the manifest fetch is unauthenticated and the
    // download fetch is too). This test pins that invariant so a future change
    // adding auth to the manifest can't accidentally leak the credential to the
    // CDN redirect target. Mirrors `updater.test.ts:490`.
    const payload = new Uint8Array([0x01, 0x02, 0x03]);
    const fileName = `probe-noauth-${Date.now()}-${Math.random().toString(36).slice(2)}.exe`;
    mockFetch
      .mockResolvedValueOnce(
        mockRedirectResponse(302, "https://downloads.example.test/download/redirect/" + fileName),
      )
      .mockResolvedValueOnce(mockBinaryResponse(200, payload));

    const filePath = await new EndpointUpdateProvider().downloadUpdate({
      url: startUrlFor(fileName),
      assetName: fileName,
    });
    writtenPaths.push(filePath);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    for (const [, init] of mockFetch.mock.calls) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test asserts shape of mock call
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
    }
    // The first hop uses redirect: "manual" to gate the host; the follow-up uses
    // redirect: "error" so a chained redirect can't smuggle in a 3rd host. Pin
    // both — `updater.test.ts:512` does the same for the GitHub provider.
    expect(mockFetch.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
    expect(mockFetch.mock.calls[1][1]).toMatchObject({ redirect: "error" });
  });

  it("relative Location header → DOWNLOAD_RESPONSE_FAILED + telemetry, no follow-up fetch", async () => {
    // Code path: endpoint-provider.ts:388 — URL.parse(location) returns null for
    // a relative URL so the provider throws BEFORE attempting the follow-up
    // fetch. Without this guard the follow-up fetch would crash (or worse, be
    // resolved against the document base). Mirrors `updater.test.ts:529`.
    mockFetch.mockResolvedValueOnce(mockRedirectResponse(302, "/relative/path/file.exe"));

    const err = await new EndpointUpdateProvider()
      .downloadUpdate({ url: START_URL, assetName: ASSET_NAME })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test asserts shape of caught error
    expect((err as Error).message).toMatch(/absolute url/i);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockSendErrorTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ code: updaterErrors.DOWNLOAD_RESPONSE_FAILED }),
      expect.anything(),
    );
  });

  it("mid-stream reader error → DOWNLOAD_STREAM_FAILED (NOT DOWNLOAD_TIMEOUT) telemetry + partial file rm attempt", async () => {
    // Code path: endpoint-provider.ts:489-494 — the reader catch splits abort
    // (timeout) vs everything else (network drop, server reset, disk write fail)
    // so the dashboard can tell those apart. Pin the non-abort branch by
    // rejecting the stream with a non-AbortError after the first chunk.
    //
    // We don't assert on `existsSync` for the partial file here — the provider's
    // rmSync is wrapped in best-effort try/catch and on Windows the underlying
    // file descriptor may still be open at rm time. The test asserts the
    // user-observable contract (correct telemetry code + the call throws); the
    // afterEach hook handles any leftover bytes.
    const fileName = `probe-midstream-${Date.now()}-${Math.random().toString(36).slice(2)}.exe`;
    const midError = new Error("ECONNRESET: socket hung up mid-stream");
    mockFetch.mockResolvedValueOnce(
      streamingResponseThatMidstreamErrors(new Uint8Array([0xaa, 0xbb, 0xcc]), midError),
    );

    const { tmpdir } = await import("os");
    const { join } = await import("path");
    writtenPaths.push(join(tmpdir(), "marshal-update", fileName));

    const err = await new EndpointUpdateProvider()
      .downloadUpdate({ url: startUrlFor(fileName), assetName: fileName })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(mockSendErrorTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ code: updaterErrors.DOWNLOAD_STREAM_FAILED }),
      expect.anything(),
    );
    // Negative-pin: must NOT also fire DOWNLOAD_TIMEOUT — the dashboard's split
    // between stall/ceiling vs network/disk depends on this exclusivity.
    const calls = mockSendErrorTelemetry.mock.calls.map((c) => c[0].code);
    expect(calls).not.toContain(updaterErrors.DOWNLOAD_TIMEOUT);
  });
});
