/**
 * Certificate pinning — SPKI-based pin verification for high-value endpoints.
 *
 * Two entry points:
 * - verifyCertificateChain(): for Electron's setCertificateVerifyProc (PEM in Certificate.data)
 * - checkServerIdentityWithPins(): for ws WebSocket checkServerIdentity (DER in PeerCertificate.raw)
 *
 * Pin sets use SHA-256 hashes of the SubjectPublicKeyInfo (SPKI) DER encoding.
 * At least 2 pins per hostname (availability pair per SF-17).
 */

import { createHash, X509Certificate } from "crypto";
import { checkServerIdentity as defaultCheckServerIdentity } from "tls";
import type { DetailedPeerCertificate } from "tls";

import type { Certificate } from "electron";

import { createLogger } from "../common/marshal-logger";

const log = createLogger("CertPins");

// ---------------------------------------------------------------------------
// Pin set definitions
// ---------------------------------------------------------------------------

export interface PinSet {
  readonly hostname: string;
  readonly includeSubdomains: boolean;
  readonly pins: readonly string[]; // SHA-256 SPKI hashes (base64)
  readonly reportOnly: boolean;
}

// Pin at intermediate/root CA level — leaf certs rotate too frequently.
// Each set has ≥2 pins for availability.
// IMPORTANT: Update these when CAs rotate. App updates serve as the rotation mechanism.
const PIN_SETS: readonly PinSet[] = [
  {
    hostname: "github.com",
    includeSubdomains: true, // covers api.github.com
    reportOnly: true,
    pins: [
      "ZSagvDzjltLkewXEBuDxIzpW/dpVw1Juvvmd0hhkzdY=", // Sectigo Public Server Auth CA DV E36
      "sLVjNUaFYfW7n6EtgBeEpjOlcnBdNPMrZDRF36iwBdE=", // Sectigo Public Server Auth Root E46
    ],
  },
];

// ---------------------------------------------------------------------------
// SPKI hash computation
// ---------------------------------------------------------------------------

/** Compute SHA-256 hash of the SPKI (SubjectPublicKeyInfo) from a certificate. */
export function computeSpkiHash(certInput: Buffer | string): string {
  const x509 = new X509Certificate(certInput);
  const spkiDer = x509.publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(spkiDer).digest("base64");
}

// ---------------------------------------------------------------------------
// Pin lookup
// ---------------------------------------------------------------------------

// Test-only pin sets — never populated in production.
let _testPinSets: PinSet[] = [];

/** Register extra pin sets for testing. Call _clearTestPinSets() in afterEach. */
export function _addTestPinSet(ps: PinSet): void {
  _testPinSets.push(ps);
}

/** Remove all test pin sets. */
export function _clearTestPinSets(): void {
  _testPinSets = [];
}

export function findPinSet(hostname: string): PinSet | undefined {
  const allSets = _testPinSets.length > 0 ? [..._testPinSets, ...PIN_SETS] : PIN_SETS;
  return allSets.find((ps) => {
    if (ps.hostname === hostname) return true;
    if (ps.includeSubdomains && hostname.endsWith(`.${ps.hostname}`)) return true;
    return false;
  });
}

// ---------------------------------------------------------------------------
// Pin mismatch reporting
// ---------------------------------------------------------------------------

export interface PinMismatchReport {
  hostname: string;
  expectedPins: readonly string[];
  actualChainHashes: string[];
  reportOnly: boolean;
}

type MismatchCallback = (report: PinMismatchReport) => void;
let _onPinMismatch: MismatchCallback | null = null;

/** Set the callback for pin mismatch events (for telemetry). Replaces any previous callback. */
export function setPinMismatchCallback(cb: MismatchCallback): void {
  _onPinMismatch = cb;
}

function reportMismatch(report: PinMismatchReport): void {
  log.warn(
    `Pin mismatch for ${report.hostname} (reportOnly=${report.reportOnly}):`,
    `expected=[${report.expectedPins.join(", ")}]`,
    `actual=[${report.actualChainHashes.join(", ")}]`,
  );
  if (_onPinMismatch) {
    try {
      _onPinMismatch(report);
    } catch {
      // Telemetry errors must not crash the app
    }
  }
}

// ---------------------------------------------------------------------------
// Electron setCertificateVerifyProc entry point
// ---------------------------------------------------------------------------

/**
 * Verify a certificate chain against our pin set.
 * Used inside setCertificateVerifyProc.
 *
 * @returns true if the chain is trusted (pins match or hostname not pinned), false if pin check fails.
 */
export function verifyCertificateChain(hostname: string, certificate: Certificate): boolean {
  const pinSet = findPinSet(hostname);
  if (!pinSet) return true; // not a pinned hostname — pass through

  // Walk the chain and collect SPKI hashes
  const chainHashes: string[] = [];
  let current: Certificate | undefined = certificate;
  const seen = new Set<string>(); // prevent infinite loops on self-signed chains

  while (current?.data) {
    // Deduplicate by PEM data to avoid infinite loops at self-signed roots
    if (seen.has(current.data)) break;
    seen.add(current.data);

    try {
      chainHashes.push(computeSpkiHash(current.data));
    } catch {
      // Skip certs we can't parse
    }
    current = current.issuerCert;
  }

  // Check if ANY cert in the chain matches ANY pin
  const match = chainHashes.some((h) => pinSet.pins.includes(h));

  if (!match) {
    reportMismatch({
      hostname,
      expectedPins: pinSet.pins,
      actualChainHashes: chainHashes,
      reportOnly: pinSet.reportOnly,
    });
    return pinSet.reportOnly; // report-only mode: log but allow
  }

  return true;
}

// ---------------------------------------------------------------------------
// WebSocket checkServerIdentity entry point
// ---------------------------------------------------------------------------

/**
 * Custom checkServerIdentity for the ws WebSocket library.
 *
 * IMPORTANT: @types/ws declares this as (servername, cert: CertMeta) => boolean,
 * but at runtime Node.js TLS calls it as (hostname, cert: PeerCertificate) => Error | undefined.
 * The ws library forwards options to tls.connect() verbatim, so we follow the Node.js signature.
 */
export function checkServerIdentityWithPins(
  hostname: string,
  cert: DetailedPeerCertificate,
): Error | undefined {
  // First, run default hostname verification
  const defaultError = defaultCheckServerIdentity(hostname, cert);
  if (defaultError) return defaultError;

  const pinSet = findPinSet(hostname);
  if (!pinSet) return undefined; // not pinned — pass

  // Walk the chain and collect SPKI hashes.
  // Depth limit guards against malformed chains (self-referential or unexpectedly deep).
  const MAX_CHAIN_DEPTH = 10;
  const chainHashes: string[] = [];
  let current: DetailedPeerCertificate | undefined = cert;

  for (let depth = 0; current?.raw && depth < MAX_CHAIN_DEPTH; depth++) {
    try {
      chainHashes.push(computeSpkiHash(current.raw));
    } catch {
      // Skip certs we can't parse
    }
    current = current.issuerCertificate;
  }

  const match = chainHashes.some((h) => pinSet.pins.includes(h));

  if (!match) {
    reportMismatch({
      hostname,
      expectedPins: pinSet.pins,
      actualChainHashes: chainHashes,
      reportOnly: pinSet.reportOnly,
    });
    if (!pinSet.reportOnly) {
      return new Error(
        `Certificate pinning failed for ${hostname}: ` +
          `none of the chain SPKI hashes match the expected pins`,
      );
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Error reporting helper (for fail-open try/catch in main.ts)
// ---------------------------------------------------------------------------

export function reportPinError(hostname: string, err: unknown): void {
  log.error(`Error during pin verification for ${hostname}:`, err);
  if (_onPinMismatch) {
    try {
      _onPinMismatch({
        hostname,
        expectedPins: [],
        actualChainHashes: [],
        reportOnly: true,
      });
    } catch {
      // Telemetry errors must not crash the app
    }
  }
}
