// Marshal-owned test
/* oxlint-disable typescript-eslint/no-unsafe-type-assertion, typescript-eslint/no-explicit-any -- test file: Electron Certificate/PeerCertificate mocks require type coercion */
import type { DetailedPeerCertificate } from "tls";

import { afterEach, describe, it, expect, vi } from "vitest";

import {
  computeSpkiHash,
  findPinSet,
  verifyCertificateChain,
  checkServerIdentityWithPins,
  setPinMismatchCallback,
  reportPinError,
  _addTestPinSet,
  _clearTestPinSets,
  type PinMismatchReport,
} from "./cert-pins";

afterEach(() => {
  setPinMismatchCallback(() => {});
  _clearTestPinSets();
});

// ---------------------------------------------------------------------------
// Pre-generated test certificates (no openssl dependency — works on Windows)
// Generated with: openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650
// ---------------------------------------------------------------------------

interface TestCert {
  pem: string;
  der: Buffer;
  spkiHash: string;
}

const CERT_A: TestCert = {
  pem: `-----BEGIN CERTIFICATE-----
MIIBgTCCASegAwIBAgIUKu3EwewPwjyez/8L+ZVrCG0wGzgwCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLY2VydC1hLnRlc3QwHhcNMjYwNDA4MTMwNTQ5WhcNMzYwNDA1
MTMwNTQ5WjAWMRQwEgYDVQQDDAtjZXJ0LWEudGVzdDBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABFd67Jfqw7xNyDoJUteQRFcoWfvpHtejFPFK+NAOCt1l+Jqh/z3n
y/N1M6MDZPOtpyaOM0UhrTalqD60Ir98fzijUzBRMB0GA1UdDgQWBBRQwyEgxCwt
BgbSuW+9dDE0VVjf5TAfBgNVHSMEGDAWgBRQwyEgxCwtBgbSuW+9dDE0VVjf5TAP
BgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIQDqj54Q66qS30XGiLUT
iE+kTfBeeWMKBHEeooMek+l2/AIgJ6FAuQc3aqXsZYjjQBIPWoX07XwlET/w+Tg3
GbRDTVE=
-----END CERTIFICATE-----`,
  der: Buffer.from(
    "MIIBgTCCASegAwIBAgIUKu3EwewPwjyez/8L+ZVrCG0wGzgwCgYIKoZIzj0EAwIwFjEUMBIGA1UEAwwLY2VydC1hLnRlc3QwHhcNMjYwNDA4MTMwNTQ5WhcNMzYwNDA1MTMwNTQ5WjAWMRQwEgYDVQQDDAtjZXJ0LWEudGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABFd67Jfqw7xNyDoJUteQRFcoWfvpHtejFPFK+NAOCt1l+Jqh/z3ny/N1M6MDZPOtpyaOM0UhrTalqD60Ir98fzijUzBRMB0GA1UdDgQWBBRQwyEgxCwtBgbSuW+9dDE0VVjf5TAfBgNVHSMEGDAWgBRQwyEgxCwtBgbSuW+9dDE0VVjf5TAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIQDqj54Q66qS30XGiLUTiE+kTfBeeWMKBHEeooMek+l2/AIgJ6FAuQc3aqXsZYjjQBIPWoX07XwlET/w+Tg3GbRDTVE=",
    "base64",
  ),
  spkiHash: "9MKOBEm9RSgxBUeC6F4URaxPnn44ZWBOOKLhwD4d7BU=",
};

const CERT_B: TestCert = {
  pem: `-----BEGIN CERTIFICATE-----
MIIBgDCCASegAwIBAgIUZQ9VerC30Zk5xNSRa3yadkC+tswwCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLY2VydC1iLnRlc3QwHhcNMjYwNDA4MTMwNTQ5WhcNMzYwNDA1
MTMwNTQ5WjAWMRQwEgYDVQQDDAtjZXJ0LWIudGVzdDBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABDWRDXDxjOursppCidbrb8B2IJrmAXT5zcod2ulpdWVfTAN2h4OP
KMk7B3ouPo82PXV+dsc1kHFWZ7HKjJ87QYejUzBRMB0GA1UdDgQWBBQQVvnSTWR8
QNlSG5GJsL/JQeZwTjAfBgNVHSMEGDAWgBQQVvnSTWR8QNlSG5GJsL/JQeZwTjAP
BgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCIA4tP/YIrmzWkU2pedL+
ASPq1O6jzaHEvtTFwBpBeRQZAiBLgjg1VE1xyUytaqAOt8Chw+TsodlGnjF88Or9
aM5f8w==
-----END CERTIFICATE-----`,
  der: Buffer.from(
    "MIIBgDCCASegAwIBAgIUZQ9VerC30Zk5xNSRa3yadkC+tswwCgYIKoZIzj0EAwIwFjEUMBIGA1UEAwwLY2VydC1iLnRlc3QwHhcNMjYwNDA4MTMwNTQ5WhcNMzYwNDA1MTMwNTQ5WjAWMRQwEgYDVQQDDAtjZXJ0LWIudGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABDWRDXDxjOursppCidbrb8B2IJrmAXT5zcod2ulpdWVfTAN2h4OPKMk7B3ouPo82PXV+dsc1kHFWZ7HKjJ87QYejUzBRMB0GA1UdDgQWBBQQVvnSTWR8QNlSG5GJsL/JQeZwTjAfBgNVHSMEGDAWgBQQVvnSTWR8QNlSG5GJsL/JQeZwTjAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCIA4tP/YIrmzWkU2pedL+ASPq1O6jzaHEvtTFwBpBeRQZAiBLgjg1VE1xyUytaqAOt8Chw+TsodlGnjF88Or9aM5f8w==",
    "base64",
  ),
  spkiHash: "hc/6M7bPnLasU/k9OhpIfGMwS27iKdALSoHJBt1MecY=",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeSpkiHash", () => {
  it("computes consistent hash from PEM input", () => {
    const hash = computeSpkiHash(CERT_A.pem);
    expect(hash).toBe(CERT_A.spkiHash);
    // SHA-256 base64 is 44 chars
    expect(hash).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(hash.length).toBe(44);
  });

  it("computes consistent hash from DER input", () => {
    const hash = computeSpkiHash(CERT_B.der);
    expect(hash).toBe(CERT_B.spkiHash);
  });

  it("produces same hash from PEM and DER of the same cert", () => {
    expect(computeSpkiHash(CERT_A.pem)).toBe(computeSpkiHash(CERT_A.der));
  });

  it("produces different hashes for different certs", () => {
    expect(CERT_A.spkiHash).not.toBe(CERT_B.spkiHash);
  });
});

describe("findPinSet", () => {
  it("finds exact hostname match", () => {
    const ps = findPinSet("github.com");
    expect(ps).toBeDefined();
    expect(ps!.hostname).toBe("github.com");
  });

  it("returns undefined for unknown hostname", () => {
    expect(findPinSet("unknown.example.com")).toBeUndefined();
  });

  it("returns undefined for partial hostname match without includeSubdomains", () => {
    _addTestPinSet({
      hostname: "exact-only.example.com",
      includeSubdomains: false,
      pins: [CERT_A.spkiHash],
      reportOnly: true,
    });

    expect(findPinSet("exact-only.example.com")).toBeDefined();
    expect(findPinSet("evil-exact-only.example.com")).toBeUndefined();
    expect(findPinSet("sub.exact-only.example.com")).toBeUndefined();
  });

  it("matches subdomains when includeSubdomains is true", () => {
    // github.com has includeSubdomains: true in production pin sets
    expect(findPinSet("api.github.com")).toBeDefined();
    expect(findPinSet("api.github.com")!.hostname).toBe("github.com");
    expect(findPinSet("deep.sub.github.com")).toBeDefined();
    expect(findPinSet("notgithub.com")).toBeUndefined();
  });

  it("matches subdomains with test pin sets", () => {
    _addTestPinSet({
      hostname: "example.com",
      includeSubdomains: true,
      pins: [CERT_A.spkiHash],
      reportOnly: true,
    });

    expect(findPinSet("sub.example.com")).toBeDefined();
    expect(findPinSet("deep.sub.example.com")).toBeDefined();
    expect(findPinSet("example.com")).toBeDefined();
    expect(findPinSet("notexample.com")).toBeUndefined();
  });

  it("finds all pinned hostnames", () => {
    expect(findPinSet("github.com")).toBeDefined();
    expect(findPinSet("api.github.com")).toBeDefined(); // via includeSubdomains
  });

  it("each pin set has at least 2 pins (availability pair)", () => {
    const hostnames = [
      "github.com",
      "api.github.com", // resolved via includeSubdomains
    ];
    for (const h of hostnames) {
      const ps = findPinSet(h);
      expect(ps!.pins.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("verifyCertificateChain", () => {
  it("passes through for unpinned hostname", () => {
    const result = verifyCertificateChain("unpinned.example.com", {
      data: CERT_A.pem,
      issuerCert: undefined,
    } as any);
    expect(result).toBe(true);
  });

  it("returns true when chain contains a matching pin (no mismatch report)", () => {
    _addTestPinSet({
      hostname: "test-pin-match.example.com",
      includeSubdomains: false,
      pins: [CERT_A.spkiHash],
      reportOnly: true,
    });

    const reports: PinMismatchReport[] = [];
    setPinMismatchCallback((r) => reports.push(r));

    const result = verifyCertificateChain("test-pin-match.example.com", {
      data: CERT_A.pem,
      issuerCert: undefined,
    } as any);
    expect(result).toBe(true);
    expect(reports).toHaveLength(0); // no mismatch — pin matched
  });

  it("reports mismatch but allows connection in report-only mode", () => {
    const reports: PinMismatchReport[] = [];
    setPinMismatchCallback((r) => reports.push(r));

    const result = verifyCertificateChain("github.com", {
      data: CERT_A.pem,
      issuerCert: undefined,
    } as any);

    // report-only: returns true (allow) but reports mismatch
    expect(result).toBe(true);
    expect(reports).toHaveLength(1);
    expect(reports[0].hostname).toBe("github.com");
    expect(reports[0].reportOnly).toBe(true);
    expect(reports[0].actualChainHashes).toContain(CERT_A.spkiHash);
  });

  it("walks the issuerCert chain to find a matching pin", () => {
    _addTestPinSet({
      hostname: "test-chain-walk.example.com",
      includeSubdomains: false,
      pins: [CERT_B.spkiHash], // only the issuer's hash — leaf won't match
      reportOnly: true,
    });

    const reports: PinMismatchReport[] = [];
    setPinMismatchCallback((r) => reports.push(r));

    const result = verifyCertificateChain("test-chain-walk.example.com", {
      data: CERT_A.pem,
      issuerCert: {
        data: CERT_B.pem,
        issuerCert: undefined,
      },
    } as any);
    expect(result).toBe(true);
    expect(reports).toHaveLength(0); // matched via issuer cert
  });

  it("handles certs with empty data gracefully", () => {
    const result = verifyCertificateChain("github.com", {
      data: "",
      issuerCert: undefined,
    } as any);
    // No chain hashes → mismatch, but report-only → true
    expect(result).toBe(true);
  });

  it("handles self-referential chains without infinite loop", () => {
    const certObj: any = { data: CERT_A.pem };
    certObj.issuerCert = certObj; // self-referential

    // Should not hang
    const result = verifyCertificateChain("github.com", certObj);
    expect(typeof result).toBe("boolean");
  });

  it("rejects connection on pin mismatch when reportOnly is false", () => {
    _addTestPinSet({
      hostname: "test-enforce.example.com",
      includeSubdomains: false,
      pins: ["bogus-pin-that-will-never-match===================="],
      reportOnly: false,
    });

    const reports: PinMismatchReport[] = [];
    setPinMismatchCallback((r) => reports.push(r));

    const result = verifyCertificateChain("test-enforce.example.com", {
      data: CERT_A.pem,
      issuerCert: undefined,
    } as any);

    expect(result).toBe(false);
    expect(reports).toHaveLength(1);
    expect(reports[0].reportOnly).toBe(false);
  });

  it("allows connection on pin match when reportOnly is false", () => {
    _addTestPinSet({
      hostname: "test-enforce-match.example.com",
      includeSubdomains: false,
      pins: [CERT_A.spkiHash],
      reportOnly: false,
    });

    const result = verifyCertificateChain("test-enforce-match.example.com", {
      data: CERT_A.pem,
      issuerCert: undefined,
    } as any);

    expect(result).toBe(true);
  });

  it("matches subdomain pins when includeSubdomains is true", () => {
    _addTestPinSet({
      hostname: "example.com",
      includeSubdomains: true,
      pins: [CERT_A.spkiHash],
      reportOnly: true,
    });

    const result = verifyCertificateChain("sub.example.com", {
      data: CERT_A.pem,
      issuerCert: undefined,
    } as any);
    expect(result).toBe(true);
  });
});

describe("checkServerIdentityWithPins", () => {
  it("passes through for unpinned hostname", () => {
    const peerCert = {
      raw: CERT_A.der,
      subject: { CN: "unpinned.example.com" },
      subjectaltname: "DNS:unpinned.example.com",
    } as unknown as DetailedPeerCertificate;

    const result = checkServerIdentityWithPins("unpinned.example.com", peerCert);
    expect(result).toBeUndefined();
  });

  it("returns error for default hostname verification failure", () => {
    const peerCert = {
      raw: CERT_A.der,
      subject: { CN: "cert-a.test" },
      subjectaltname: "DNS:cert-a.test",
    } as unknown as DetailedPeerCertificate;

    // Default check should fail because CN doesn't match hostname
    const result = checkServerIdentityWithPins("github.com", peerCert);
    expect(result).toBeInstanceOf(Error);
  });

  it("handles self-referential issuerCertificate without infinite loop", () => {
    _addTestPinSet({
      hostname: "self-ref.example.com",
      includeSubdomains: false,
      pins: [CERT_A.spkiHash],
      reportOnly: true,
    });

    const peerCert = {
      raw: CERT_A.der,
      subject: { CN: "self-ref.example.com" },
      subjectaltname: "DNS:self-ref.example.com",
    } as unknown as DetailedPeerCertificate;
    (peerCert as any).issuerCertificate = peerCert;

    // Should not hang — depth counter stops the loop
    const result = checkServerIdentityWithPins("self-ref.example.com", peerCert);
    expect(result).toBeUndefined(); // pin matches
  });

  it("returns Error on pin mismatch when reportOnly is false", () => {
    _addTestPinSet({
      hostname: "test-enforce-ws.example.com",
      includeSubdomains: false,
      pins: ["bogus-pin-that-will-never-match===================="],
      reportOnly: false,
    });

    const peerCert = {
      raw: CERT_A.der,
      subject: { CN: "test-enforce-ws.example.com" },
      subjectaltname: "DNS:test-enforce-ws.example.com",
    } as unknown as DetailedPeerCertificate;

    const result = checkServerIdentityWithPins("test-enforce-ws.example.com", peerCert);
    expect(result).toBeInstanceOf(Error);
    expect(result!.message).toContain("Certificate pinning failed");
  });

  it("returns undefined on pin match when reportOnly is false", () => {
    _addTestPinSet({
      hostname: "test-enforce-ws-match.example.com",
      includeSubdomains: false,
      pins: [CERT_A.spkiHash],
      reportOnly: false,
    });

    const peerCert = {
      raw: CERT_A.der,
      subject: { CN: "test-enforce-ws-match.example.com" },
      subjectaltname: "DNS:test-enforce-ws-match.example.com",
    } as unknown as DetailedPeerCertificate;

    const result = checkServerIdentityWithPins("test-enforce-ws-match.example.com", peerCert);
    expect(result).toBeUndefined();
  });

  it("matches subdomain pins when includeSubdomains is true", () => {
    _addTestPinSet({
      hostname: "example.com",
      includeSubdomains: true,
      pins: [CERT_A.spkiHash],
      reportOnly: true,
    });

    const peerCert = {
      raw: CERT_A.der,
      subject: { CN: "sub.example.com" },
      subjectaltname: "DNS:sub.example.com",
    } as unknown as DetailedPeerCertificate;

    const result = checkServerIdentityWithPins("sub.example.com", peerCert);
    expect(result).toBeUndefined();
  });
});

describe("reportPinError", () => {
  it("logs to console and calls mismatch callback", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reports: PinMismatchReport[] = [];
    setPinMismatchCallback((r) => reports.push(r));

    reportPinError("github.com", new Error("test error"));

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(reports).toHaveLength(1);
    expect(reports[0].hostname).toBe("github.com");
    expect(reports[0].reportOnly).toBe(true);

    consoleSpy.mockRestore();
  });

  it("does not throw if callback throws", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setPinMismatchCallback(() => {
      throw new Error("callback error");
    });

    expect(() => reportPinError("test.com", new Error("oops"))).not.toThrow();

    consoleSpy.mockRestore();
  });
});
