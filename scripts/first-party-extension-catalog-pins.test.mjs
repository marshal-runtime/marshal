import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseFirstPartyExtensionCatalogPins,
  verifyFirstPartyExtensionCatalogPins,
} from "./first-party-extension-catalog-pins.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { computeRuntimeExtensionIntegrity } = await import(
  path.join(repositoryRoot, "node_modules", "@marshal", "runtime", "dist", "extensions.js")
);

const FIXTURE_PACKAGE = "@marshal/fixture-extension";
const FIXTURE_ARCHIVE = "marshal-fixture-extension-1.0.0-test.tgz";

function catalogSourceFor(integrityValue) {
  return `const INTEGRITY_DOMAIN = "marshal-runtime-extension-package-v1";

export const FIRST_PARTY_EXTENSION_CATALOG: readonly FirstPartyExtensionCatalogManifestEntry[] =
  Object.freeze([
    Object.freeze({
      identity: "${FIXTURE_PACKAGE}",
      version: "1.0.0",
      packageName: "${FIXTURE_PACKAGE}",
      bundledLocation: Object.freeze(["@marshal", "fixture-extension"]),
      integrity: Object.freeze({
        algorithm: "sha256" as const,
        domain: INTEGRITY_DOMAIN,
        value: "${integrityValue}",
      }),
    }),
  ]);
`;
}

async function fixtureRepository(t, { entrypointSource = "module.exports = {};\n" } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "marshal-catalog-fixture-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "stage", "package");
  await fsp.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await fsp.writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: FIXTURE_PACKAGE, version: "1.0.0", main: "dist/runtime.cjs" })}\n`,
  );
  await fsp.writeFile(path.join(packageRoot, "dist", "runtime.cjs"), entrypointSource);
  const archivesRoot = path.join(root, ".marshal-runtime-packs", "archives");
  await fsp.mkdir(archivesRoot, { recursive: true });
  execFileSync("tar", [
    "-czf",
    path.join(archivesRoot, FIXTURE_ARCHIVE),
    "-C",
    path.join(root, "stage"),
    "package",
  ]);
  return {
    repositoryRoot: root,
    integrity: computeRuntimeExtensionIntegrity(packageRoot),
    hostDependencies: {
      [FIXTURE_PACKAGE]: `file:.marshal-runtime-packs/archives/${FIXTURE_ARCHIVE}`,
    },
  };
}

test("catalog pins matching the archive bytes verify", async (t) => {
  const fixture = await fixtureRepository(t);
  const verified = await verifyFirstPartyExtensionCatalogPins({
    catalogSource: catalogSourceFor(fixture.integrity.value),
    hostDependencies: fixture.hostDependencies,
    repositoryRoot: fixture.repositoryRoot,
    computeIntegrity: computeRuntimeExtensionIntegrity,
  });
  assert.equal(verified, 1);
});

test("a stale catalog pin fails verification before launch", async (t) => {
  const fixture = await fixtureRepository(t);
  const stalePin = fixture.integrity.value.replace(/^./, (first) => (first === "0" ? "1" : "0"));
  await assert.rejects(
    verifyFirstPartyExtensionCatalogPins({
      catalogSource: catalogSourceFor(stalePin),
      hostDependencies: fixture.hostDependencies,
      repositoryRoot: fixture.repositoryRoot,
      computeIntegrity: computeRuntimeExtensionIntegrity,
    }),
    /FIRST_PARTY_EXTENSION_CATALOG pin for @marshal\/fixture-extension does not match/,
  );
});

test("repacked archive content with an unchanged catalog pin fails verification", async (t) => {
  const fixture = await fixtureRepository(t);
  const repacked = await fixtureRepository(t, {
    entrypointSource: "module.exports = { repacked: true };\n",
  });
  assert.notEqual(repacked.integrity.value, fixture.integrity.value);
  await assert.rejects(
    verifyFirstPartyExtensionCatalogPins({
      catalogSource: catalogSourceFor(fixture.integrity.value),
      hostDependencies: repacked.hostDependencies,
      repositoryRoot: repacked.repositoryRoot,
      computeIntegrity: computeRuntimeExtensionIntegrity,
    }),
    /does not match the archive bytes/,
  );
});

test("a catalog package missing from the host dependencies fails verification", async (t) => {
  const fixture = await fixtureRepository(t);
  await assert.rejects(
    verifyFirstPartyExtensionCatalogPins({
      catalogSource: catalogSourceFor(fixture.integrity.value),
      hostDependencies: {},
      repositoryRoot: fixture.repositoryRoot,
      computeIntegrity: computeRuntimeExtensionIntegrity,
    }),
    /not pinned to a runtime pack archive/,
  );
});

test("catalog entries that stop matching the expected shape fail parsing", () => {
  assert.throws(
    () => parseFirstPartyExtensionCatalogPins(catalogSourceFor("not-a-digest")),
    /does not parse as a pinned entry/,
  );
  assert.throws(
    () => parseFirstPartyExtensionCatalogPins("export const FIRST_PARTY_EXTENSION_CATALOG = 1;"),
    /no INTEGRITY_DOMAIN constant/,
  );
});

test("a catalog element without an identity fails parsing instead of being ignored", () => {
  const source = catalogSourceFor("a".repeat(64)).replace(
    "  ]);",
    "    Object.freeze({ bogus: true }),\n  ]);",
  );
  assert.throws(
    () => parseFirstPartyExtensionCatalogPins(source),
    /does not parse as a pinned entry[\s\S]*bogus/,
  );
});

test("unsupported catalog element expressions fail parsing instead of being ignored", () => {
  for (const element of ["...EXTRA_ENTRIES", "extraEntry", 'buildEntry("@marshal/swarm")']) {
    const source = catalogSourceFor("a".repeat(64)).replace("  ]);", `    ${element},\n  ]);`);
    assert.throws(
      () => parseFirstPartyExtensionCatalogPins(source),
      /does not parse as a pinned entry/,
      element,
    );
  }
});

test("the committed catalog pins match the committed archive bytes", async () => {
  const [catalogSource, hostManifest] = await Promise.all([
    fsp.readFile(
      path.join(repositoryRoot, "electron", "marshal-runtime", "first-party-extension-catalog.ts"),
      "utf8",
    ),
    fsp.readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  ]);
  const verified = await verifyFirstPartyExtensionCatalogPins({
    catalogSource,
    hostDependencies: JSON.parse(hostManifest).dependencies,
    repositoryRoot,
    computeIntegrity: computeRuntimeExtensionIntegrity,
  });
  assert.equal(verified, 5);
});
