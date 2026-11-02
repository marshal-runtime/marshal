import { describe, it, expect } from "vitest";

import * as schema from "./update-check-schema";

const TEST_HOSTS = ["downloads.example.test"];
const isDownloadHostAllowed = (url: string, assetName?: string) =>
  schema.isDownloadHostAllowed(url, assetName, TEST_HOSTS);
const validateEndpointDownloadUrl = (url: string, assetName?: string) =>
  schema.validateEndpointDownloadUrl(url, assetName, TEST_HOSTS);

// The endpoint-provider path trusts the server-returned downloadUrl only after this
// allowlist check passes. Cross-host redirect leakage and downloadUrl injection are
// the two attack shapes here, so these tests pin the URL-parser traps that the
// `URL` API would otherwise let slip past a naive `endsWith()` host check.

describe("isDownloadHostAllowed — compiled default", () => {
  it("rejects every host while no download host is configured", () => {
    expect(schema.isDownloadHostAllowed("https://downloads.example.test/file.exe")).toBe(false);
  });
});

describe("isDownloadHostAllowed — host allowlist URL hardening", () => {
  it("accepts https://downloads.example.test with a deep path", () => {
    expect(
      isDownloadHostAllowed(
        "https://downloads.example.test/download/5afdb888-4c32-47e5-86c0-72adab3f5152/MarshalDev-Windows-9.9.9-x64-Setup.exe",
      ),
    ).toBe(true);
  });

  it("rejects http (must be https — no plaintext installer downloads)", () => {
    // downloads.example.test itself serves https, but a manifest that returned http
    // would be a downgrade-attack vector. The signature verify would still catch it,
    // but failing earlier keeps the dashboard signal clean.
    expect(isDownloadHostAllowed("http://downloads.example.test/file.exe")).toBe(false);
  });

  it("rejects subdomain trap (downloads.example.test.attacker.example)", () => {
    // Classic suffix-match bug: an attacker-controlled domain that ENDS with
    // "downloads.example.test" would slip past a naive `endsWith` host check. The
    // allowlist entry has no leading "." so it must match the full hostname exactly.
    expect(
      isDownloadHostAllowed("https://downloads.example.test.attacker.example/payload.exe"),
    ).toBe(false);
  });

  it("rejects userinfo trap (https://downloads.example.test@attacker.example/...)", () => {
    // URL credentials make the leftmost segment look like the host to a human but
    // the actual hostname is what comes after `@`. The validator rejects any URL
    // carrying username/password so a manifest can't smuggle a redirect target this way.
    expect(
      isDownloadHostAllowed("https://downloads.example.test@attacker.example/payload.exe"),
    ).toBe(false);
  });

  it("rejects URLs carrying a fragment", () => {
    // The download leg never makes sense with a fragment (`#…` is client-side only),
    // and a fragment in a manifest is a strong signal that the field was assembled
    // from user-influenced strings. Refusing the whole URL fails closed.
    expect(isDownloadHostAllowed("https://downloads.example.test/file.exe#fragment")).toBe(false);
  });
});

describe("validateEndpointDownloadUrl — wraps isDownloadHostAllowed with a throw", () => {
  it("throws on off-allowlist hosts so the caller can map to typed telemetry", () => {
    expect(() => validateEndpointDownloadUrl("https://attacker.example/payload.exe")).toThrow(
      /not an allowed https host/,
    );
  });

  it("is a no-op for a valid downloads.example.test URL", () => {
    expect(() =>
      validateEndpointDownloadUrl("https://downloads.example.test/download/abc/file.exe"),
    ).not.toThrow();
  });
});

describe("isDownloadHostAllowed — pathname/assetName cross-check (defense-in-depth)", () => {
  // Manifest-tampering escalation: even a compromised endpoint can only pair a server-supplied
  // assetName with a downloadUrl whose pathname terminates in the same filename. A pinned
  // assetName of "Marshal-Windows-9.9.9-x64-Setup.exe" can no longer be paired with
  // ".../older-1.0.0-Setup.exe" to trigger a silent version downgrade (older binary would still
  // pass signature verification since both can use the same private release identity).

  it("accepts a downloads.example.test URL whose pathname matches assetName", () => {
    const assetName = "MarshalDev-Windows-9.9.9-x64-Setup.exe";
    expect(
      isDownloadHostAllowed(
        `https://downloads.example.test/download/abc-def/${assetName}`,
        assetName,
      ),
    ).toBe(true);
  });

  it("rejects a URL whose pathname does NOT terminate in assetName (downgrade attack)", () => {
    // The downgrade scenario: server advertises a 9.9.9 assetName but serves a 1.0.0 path.
    expect(
      isDownloadHostAllowed(
        "https://downloads.example.test/download/abc-def/Marshal-Windows-1.0.0-x64-Setup.exe",
        "Marshal-Windows-9.9.9-x64-Setup.exe",
      ),
    ).toBe(false);
  });

  it("rejects a URL with an extra path segment after assetName (suffix smuggling)", () => {
    // The pathname must END with `/${assetName}`, so a manifest can't smuggle an extra segment
    // after the filename to bypass the check via prefix matching.
    expect(
      isDownloadHostAllowed(
        "https://downloads.example.test/download/abc/setup.exe/something-else",
        "setup.exe",
      ),
    ).toBe(false);
  });

  it("rejects a URL whose pathname only contains assetName as a substring (boundary check)", () => {
    // The leading "/" in `/${assetName}` forces the assetName to be a full final path segment —
    // a URL ending in `…suffix-setup.exe` cannot satisfy a request for `setup.exe`.
    expect(
      isDownloadHostAllowed(
        "https://downloads.example.test/download/abc/older-setup.exe",
        "setup.exe",
      ),
    ).toBe(false);
  });

  it("is a no-op when assetName is omitted — preserves redirect-Location callers that don't have it", () => {
    // Belt-and-braces: the assetName param is optional so the same validator can be reused for
    // redirect-Location verification (where the caller may not have the original assetName).
    expect(isDownloadHostAllowed("https://downloads.example.test/download/abc/anything.exe")).toBe(
      true,
    );
  });

  it("validateEndpointDownloadUrl propagates the pathname/assetName rejection as a throw", () => {
    expect(() =>
      validateEndpointDownloadUrl(
        "https://downloads.example.test/download/abc/older.exe",
        "newer.exe",
      ),
    ).toThrow(/not an allowed https host/);
  });
});
