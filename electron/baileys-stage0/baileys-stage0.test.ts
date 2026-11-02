import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { buildBaileysStage0Environment, runBaileysStage0Probe } from "./client";
import { BAILEYS_STAGE0_SCHEMA_VERSION, parseBaileysStage0ParentFrame } from "./protocol";
import { createBaileysStage0Capabilities } from "./sidecar/api-fingerprint";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

interface PackageExpectation {
  name: string;
  version: string;
  license: string;
  manifestSha256: string;
  licenseSha256?: string;
}

const PACKAGE_EXPECTATIONS: PackageExpectation[] = [
  {
    name: "baileys",
    version: "7.0.0-rc14",
    license: "MIT",
    manifestSha256: "55dd58bf3944a426e2e72f397464a2ef9173f54ae7cbca4082cac743a4a5c178",
    licenseSha256: "0d814b3b15ae28401c32d3d0042c9537f1216be765850fdb36ad507a3cc90aa4",
  },
  {
    name: "libsignal",
    version: "6.0.0",
    license: "GPL-3.0",
    manifestSha256: "9407c8a9a4f54466991621250af3df24b639948218683b80293c21bfcabc7050",
    licenseSha256: "c61f12da7cdad526bdcbed47a4c0a603e60dbbfdaf8b66933cd088e9132c303f",
  },
  {
    name: "whatsapp-rust-bridge",
    version: "0.5.4",
    license: "MIT",
    manifestSha256: "dd6026167866c0c5cc6a0089e989dbfc2a3ea6e7b6fa77385010ba64eb9ffa8f",
  },
];

function packageRoot(packageName: string): string {
  return path.join(repoRoot, "node_modules", ...packageName.split("/"));
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonRecord(filePath: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (!isJsonRecord(value)) {
    throw new Error(`Expected JSON object at ${filePath}`);
  }
  return value;
}

function listFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function typescriptFiles(directory: string): string[] {
  return listFiles(directory).filter((filePath) => filePath.endsWith(".ts"));
}

describe("Baileys Stage 0 protocol", () => {
  test("accepts only the schema-versioned parent frame shape", () => {
    expect(
      parseBaileysStage0ParentFrame(
        JSON.stringify({
          schemaVersion: BAILEYS_STAGE0_SCHEMA_VERSION,
          kind: "ping",
          requestId: "stage0-ping",
        }),
      ),
    ).toEqual({
      schemaVersion: BAILEYS_STAGE0_SCHEMA_VERSION,
      kind: "ping",
      requestId: "stage0-ping",
    });
    expect(() =>
      parseBaileysStage0ParentFrame(
        JSON.stringify({ schemaVersion: 2, kind: "ping", requestId: "stage0-ping" }),
      ),
    ).toThrow(/Unsupported Baileys Stage 0 schema version/);
    expect(() =>
      parseBaileysStage0ParentFrame(
        JSON.stringify({
          schemaVersion: BAILEYS_STAGE0_SCHEMA_VERSION,
          kind: "ping",
          requestId: "stage0-ping",
          unexpected: true,
        }),
      ),
    ).toThrow(/invalid shape/);
  });

  test("passes only non-secret environment values to the sidecar", () => {
    const environment = buildBaileysStage0Environment({
      APP_ROOT: "parent-app-root",
      GITHUB_TOKEN: "secret",
      NODE_ENV: "development",
      NODE_OPTIONS: "--inspect",
      TEMP: "C:\\stage0-temp",
      VITE_DEV_SERVER_URL: "http://localhost:5173",
      VITE_PUBLIC: "parent-public",
      WHATSAPP_TOKEN: "secret",
    });
    expect(environment).toEqual({
      APP_ROOT: "",
      NODE_ENV: "production",
      NO_COLOR: "1",
      TEMP: "C:\\stage0-temp",
      VITE_DEV_SERVER_URL: "",
      VITE_PUBLIC: "",
      WS_NO_BUFFER_UTIL: "1",
      WS_NO_UTF_8_VALIDATE: "1",
    });
  });
});

describe("Baileys Stage 0 public API fingerprint", () => {
  test("imports the public package root and exercises the embedded bridge locally", () => {
    const capabilities = createBaileysStage0Capabilities();
    expect(capabilities.api.packageVersion).toBe("7.0.0-rc14");
    expect(capabilities.api.runtimeExports).toContain("makeWASocket");
    expect(capabilities.api.socketMethods).toContain("communityCreateGroup");
    expect(capabilities.api.socketMethods).toContain("sendMessage");
    expect(capabilities.api.eventKeys).toContain("messages.upsert");
    expect(capabilities.api.eventKeys).toContain("newsletter-settings.update");
    expect(capabilities.bridge).toEqual({
      packageName: "whatsapp-rust-bridge",
      packageVersion: "0.5.4",
      assetMode: "embedded-base64-wasm",
      encodedNodeByteLength: 11,
      encodedNodeHexPrefix: "00f801fc06737461676530",
    });
    expect(capabilities.safety).toEqual({
      socketCreated: false,
      authStateCreated: false,
      credentialsRead: false,
      qrGenerated: false,
      networkAttempted: false,
    });
  });

  test("keeps Baileys imports and types inside the sidecar boundary", () => {
    const stage0Root = path.join(repoRoot, "electron", "baileys-stage0");
    const baileysImports: Array<{ file: string; specifier: string }> = [];
    for (const filePath of typescriptFiles(stage0Root)) {
      const source = readFileSync(filePath, "utf8");
      for (const match of source.matchAll(/(?:from\s+|import\s*\()\s*["']([^"']+)["']/g)) {
        const specifier = match[1];
        if (specifier === "baileys" || specifier.startsWith("baileys/")) {
          baileysImports.push({ file: path.relative(stage0Root, filePath), specifier });
        }
      }
    }
    expect(baileysImports).toEqual([
      { file: path.join("sidecar", "api-fingerprint.ts"), specifier: "baileys" },
      { file: path.join("sidecar", "api-fingerprint.ts"), specifier: "baileys" },
    ]);
    expect(baileysImports.every(({ specifier }) => specifier === "baileys")).toBe(true);

    const fingerprintSource = readFileSync(
      path.join(stage0Root, "sidecar", "api-fingerprint.ts"),
      "utf8",
    );
    expect(fingerprintSource).not.toMatch(/\bmakeWASocket\s*\(/);
    expect(fingerprintSource).not.toMatch(/\binitAuthCreds\s*\(/);
    expect(fingerprintSource).not.toMatch(/\buseMultiFileAuthState\s*\(/);
  });
});

describe("Baileys Stage 0 provenance", () => {
  test("pins package metadata, license evidence, and lock integrity", () => {
    for (const expectation of PACKAGE_EXPECTATIONS) {
      const root = packageRoot(expectation.name);
      const manifestPath = path.join(root, "package.json");
      const manifest = readJsonRecord(manifestPath);
      expect(manifest.name).toBe(expectation.name);
      expect(manifest.version).toBe(expectation.version);
      expect(manifest.license).toBe(expectation.license);
      expect(sha256(manifestPath)).toBe(expectation.manifestSha256);

      const licensePath = path.join(root, "LICENSE");
      const licensePresent = existsSync(licensePath);
      const actualLicenseEvidence = {
        present: licensePresent,
        sha256: licensePresent ? sha256(licensePath) : null,
      };
      const expectedLicenseEvidence = {
        present: expectation.licenseSha256 !== undefined,
        sha256: expectation.licenseSha256 ?? null,
      };
      expect(actualLicenseEvidence).toEqual(expectedLicenseEvidence);
    }

    expect(sha256(path.join(packageRoot("whatsapp-rust-bridge"), "dist", "index.js"))).toBe(
      "13586c5d558b7a683f1aa5678dadf8cbe664182fbc63608d294c9a5c7378e206",
    );

    const lock = readFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "utf8").replaceAll(
      "\r\n",
      "\n",
    );
    expect(lock).toContain(
      "baileys@7.0.0-rc14:\n    resolution: {integrity: sha512-pewtrljhWx5JTUBvvkXZz1fL3JPiwzjBsnhx/DWf2LWBx1cZNH7J/sF22xDehba5mySWUQU4a1Pwt7lWARUxaA==",
    );
    expect(lock).toContain(
      "libsignal@6.0.0:\n    resolution: {integrity: sha512-d/5V3YFtDljbFMufz4ncyUYGYhJl+vzAe+c2EFFBQ6bz1h8Q3IOMEGXYMzlibU60I+e8GagMMpji18iez3P1hA==",
    );
    expect(lock).toContain(
      "whatsapp-rust-bridge@0.5.4:\n    resolution: {integrity: sha512-yYO1qSs0Fe7tGtnxOFHomocUD6IZtoAgmA4oDFyGIRZ67D3QZk3w7swA6XXFXNQngiyrg2k7tul6IrM3eUFh7A==",
    );
    expect(lock).toContain("libsignal: 6.0.0");
    expect(lock).toContain("whatsapp-rust-bridge: 0.5.4");
  });

  test("proves the Rust bridge has embedded data and no external wasm asset", () => {
    const bridgeRoot = packageRoot("whatsapp-rust-bridge");
    expect(listFiles(bridgeRoot).filter((filePath) => filePath.endsWith(".wasm"))).toEqual([]);
    const bridgeSource = readFileSync(path.join(bridgeRoot, "dist", "index.js"), "utf8");
    expect(bridgeSource).toMatch(/[A-Za-z0-9+/]{4096,}={0,2}/);
  });
});

describe("Baileys Stage 0 parent-child probe", () => {
  test("performs ping, capabilities, shutdown, and clean exit", async () => {
    const sidecarPath = path.join(repoRoot, "dist-baileys-stage0", "baileys-stage0-sidecar.mjs");
    expect(existsSync(sidecarPath)).toBe(true);
    const result = await runBaileysStage0Probe({
      mode: "development",
      sidecarPath,
      timeoutMs: 15_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.transcript.map(({ frame }) => frame.kind)).toEqual([
      "ping",
      "capabilities",
      "shutdown",
      "shutdown-ack",
    ]);
  });
});
