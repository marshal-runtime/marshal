import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Pack-time coupling for the hardcoded FIRST_PARTY_EXTENSION_CATALOG pins.
 *
 * The catalog in electron/marshal-runtime/first-party-extension-catalog.ts is
 * release data maintained by hand, while archives are produced by repack runs.
 * Startup verifies the installed copy against the catalog, so a stale pin
 * fails closed only at install/startup. These helpers verify each catalog pin
 * against the actual archive bytes the host package.json installs from, so a
 * repack that forgets to refresh the catalog fails pack verification instead.
 */

const ARCHIVE_SPECIFIER_PREFIX = "file:.marshal-runtime-packs/archives/";

export function parseFirstPartyExtensionCatalogPins(catalogSource) {
  const domainMatch = catalogSource.match(/const INTEGRITY_DOMAIN = "([^"]+)";/);
  if (!domainMatch) {
    throw new Error("First-party extension catalog source has no INTEGRITY_DOMAIN constant.");
  }
  const arrayMatch = catalogSource.match(
    /FIRST_PARTY_EXTENSION_CATALOG[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\);/,
  );
  if (!arrayMatch) {
    throw new Error("First-party extension catalog source has no catalog array literal.");
  }
  const entryPattern =
    /^Object\.freeze\(\{\s*identity:\s*"([^"]+)",\s*version:\s*"([^"]+)",\s*packageName:\s*"([^"]+)",[\s\S]*integrity:\s*Object\.freeze\(\{\s*algorithm:\s*"sha256" as const,\s*domain:\s*INTEGRITY_DOMAIN,\s*value:\s*"([0-9a-f]{64})",\s*\}\),\s*\}\)$/;
  const pins = [];
  for (const element of splitTopLevelArrayElements(arrayMatch[1])) {
    const entry = element.match(entryPattern);
    if (!entry) {
      throw new Error(
        "First-party extension catalog contains an element that does not parse as a pinned " +
          `entry; refusing to ignore catalog contents: ${element.slice(0, 120)}`,
      );
    }
    const [, identity, version, packageName, integrityValue] = entry;
    pins.push({ identity, version, packageName, domain: domainMatch[1], integrityValue });
  }
  if (pins.length === 0) {
    throw new Error("First-party extension catalog declares no pinned entries.");
  }
  if (new Set(pins.map((pin) => pin.identity)).size !== pins.length) {
    throw new Error("First-party extension catalog declares duplicate identities.");
  }
  return pins;
}

/**
 * Splits the catalog array literal into top-level elements so every
 * non-whitespace element must parse as a pinned entry — an element the entry
 * pattern cannot read fails verification instead of being silently skipped.
 */
function splitTopLevelArrayElements(arraySource) {
  const elements = [];
  let depth = 0;
  let start = 0;
  let quote = null;
  for (let index = 0; index < arraySource.length; index++) {
    const character = arraySource[index];
    if (quote) {
      if (character === "\\") index++;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === "/" && arraySource[index + 1] === "/") {
      while (index < arraySource.length && arraySource[index] !== "\n") index++;
    } else if (character === "/" && arraySource[index + 1] === "*") {
      index += 2;
      while (
        index < arraySource.length &&
        !(arraySource[index] === "*" && arraySource[index + 1] === "/")
      ) {
        index++;
      }
      index++;
    } else if (character === "(" || character === "[" || character === "{") {
      depth++;
    } else if (character === ")" || character === "]" || character === "}") {
      depth--;
    } else if (character === "," && depth === 0) {
      elements.push(arraySource.slice(start, index));
      start = index + 1;
    }
  }
  if (quote || depth !== 0) {
    throw new Error("First-party extension catalog array literal is unbalanced.");
  }
  elements.push(arraySource.slice(start));
  return elements.map((element) => element.trim()).filter((element) => element.length > 0);
}

export async function verifyFirstPartyExtensionCatalogPins({
  catalogSource,
  hostDependencies,
  repositoryRoot,
  computeIntegrity,
}) {
  const pins = parseFirstPartyExtensionCatalogPins(catalogSource);
  for (const pin of pins) {
    const specifier = hostDependencies?.[pin.packageName];
    if (typeof specifier !== "string" || !specifier.startsWith(ARCHIVE_SPECIFIER_PREFIX)) {
      throw new Error(
        `First-party extension ${pin.identity} is not pinned to a runtime pack archive ` +
          "in the host package.json dependencies.",
      );
    }
    const archivePath = path.join(repositoryRoot, specifier.slice("file:".length));
    const extractRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "marshal-catalog-pin-"));
    try {
      execFileSync("tar", ["-xf", archivePath, "-C", extractRoot]);
      const packageRoot = path.join(extractRoot, "package");
      const packageManifest = JSON.parse(
        await fsp.readFile(path.join(packageRoot, "package.json"), "utf8"),
      );
      if (packageManifest.name !== pin.packageName || packageManifest.version !== pin.version) {
        throw new Error(
          `First-party extension catalog entry ${pin.identity}@${pin.version} does not match ` +
            `the archive package ${packageManifest.name}@${packageManifest.version} ` +
            `(${path.basename(archivePath)}).`,
        );
      }
      const actual = computeIntegrity(packageRoot);
      if (actual.domain !== pin.domain || actual.value !== pin.integrityValue) {
        throw new Error(
          `FIRST_PARTY_EXTENSION_CATALOG pin for ${pin.identity} does not match the archive ` +
            `bytes of ${path.basename(archivePath)} (pinned ${pin.integrityValue}, ` +
            `actual ${actual.value}); update ` +
            "electron/marshal-runtime/first-party-extension-catalog.ts for the repacked archive.",
        );
      }
    } finally {
      await fsp.rm(extractRoot, { recursive: true, force: true });
    }
  }
  return pins.length;
}
