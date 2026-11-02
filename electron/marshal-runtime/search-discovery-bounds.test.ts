import type { RuntimeSearchResponse } from "@marshal/runtime";
import { describe, expect, it } from "vitest";

import { __testing } from "./api";

const { boundSearchDiscoveries } = __testing;

type Discovery = NonNullable<RuntimeSearchResponse["discoveries"]>[number];

/** Shaped like the real spilled record from the Joke Machine session
 *  (531e4d94 tool-results: one runtime-composition catalog entry of 125,131
 *  bytes — 16,885-char degenerate description + 106,730 bytes of metadata, of
 *  which 52 declaration strings totalling 41,460 chars carry only 13 unique
 *  values of 10,365 chars combined). Synthesized with the real types — never
 *  copied from the untrusted spill file. */
function bloatedDiscovery(): Discovery {
  const declaration = "declare service Composition {".padEnd(800, " x");
  const declarations = Array.from({ length: 13 }, (_, i) => `${declaration} // v${i}`);
  const many = Array.from({ length: 26 }, (_, i) => ({ declaration: declarations[i % 13] }));
  return {
    protocolVersion: "1.0.0",
    score: 0.41,
    matchedTerms: ["review"],
    matchedFields: ["description"],
    entry: {
      id: "catalog://marshal.runtime-composition-catalog/runtime-composition",
      kind: "resource",
      title: "Runtime composition",
      description: "Runtime composition runtime-composition. ".repeat(400),
      tags: Array.from({ length: 20 }, (_, i) => `tag-${i}`),
      action: { type: "resource_read", uri: "runtime://composition/runtime-composition" },
      metadata: {
        composition: { services: many.slice(0, 13), contracts: many.slice(13) },
        publicMethodSchemas: { services: many.slice(0, 13), contracts: many.slice(13) },
        methodSchemas: { padding: "s".repeat(60_000) },
      },
    },
  };
}

function response(discoveries: readonly Discovery[]): RuntimeSearchResponse {
  return {
    protocolVersion: "1.0.0",
    query: "review overlay",
    detail: "summary",
    matches: [],
    discoveries,
  };
}

function omissionMarker(discovery: Discovery): { omitted?: boolean; fullRecord?: string } {
  const metadata = discovery.entry.metadata;
  if (!metadata) return {};
  const omitted = metadata.omitted;
  const fullRecord = metadata.fullRecord;
  return {
    ...(typeof omitted === "boolean" ? { omitted } : {}),
    ...(typeof fullRecord === "string" ? { fullRecord } : {}),
  };
}

describe("boundSearchDiscoveries (compact discovery listings)", () => {
  it("bounds a real-shaped 125KB catalog entry to discovery metadata with an expansion route", () => {
    const raw = bloatedDiscovery();
    expect(JSON.stringify(raw).length).toBeGreaterThan(50_000);

    const bounded = boundSearchDiscoveries(response([raw]));
    const discovery = bounded.discoveries?.[0];
    expect(discovery).toBeDefined();
    if (!discovery) return;
    expect(JSON.stringify(discovery).length).toBeLessThan(2_000);
    // Identity, ranking, and the action survive; the record dump does not.
    expect(discovery.entry.id).toContain("catalog://marshal.runtime-composition-catalog");
    expect(discovery.score).toBe(0.41);
    expect(discovery.entry.description.length).toBeLessThanOrEqual(280);
    expect(discovery.entry.tags?.length).toBeLessThanOrEqual(8);
    // Omission is explicit, never silent, and names the readback route — the
    // entry's OWN resource_read action uri (verified live: compositionCatalog
    // serves runtime://composition/*).
    const marker = omissionMarker(discovery);
    expect(marker.omitted).toBe(true);
    expect(marker.fullRecord).toContain("runtimeReadResource");
    expect(marker.fullRecord).toContain("runtime://composition/runtime-composition");
  });

  it("keeps a limit-15 worst-case listing far under the CLI's MCP spill cap", () => {
    const bounded = boundSearchDiscoveries(
      response(Array.from({ length: 15 }, () => bloatedDiscovery())),
    );
    // The Joke Machine session spilled at 136-190KB; the CLI cap is ~25k
    // tokens. Fifteen worst-case entries must stay an order of magnitude down.
    expect(JSON.stringify(bounded).length).toBeLessThan(30_000);
  });

  it("passes matches and response envelope through untouched", () => {
    const base = response([bloatedDiscovery()]);
    const bounded = boundSearchDiscoveries(base);
    expect(bounded.matches).toBe(base.matches);
    expect(bounded.detail).toBe("summary");
    expect(bounded.query).toBe("review overlay");
  });

  it("still bounds when called directly — full-detail passthrough lives at the api.search call site", () => {
    // api.search only routes through boundSearchDiscoveries when the REQUEST
    // did not ask for detail:"full"; the projection itself is unconditional.
    const raw = response([bloatedDiscovery()]);
    expect(JSON.stringify(boundSearchDiscoveries(raw)).length).toBeLessThan(6_000);
  });

  it("leaves responses without discoveries identical", () => {
    const bare: RuntimeSearchResponse = {
      protocolVersion: "1.0.0",
      query: "review overlay",
      detail: "summary",
      matches: [],
    };
    expect(boundSearchDiscoveries(bare)).toBe(bare);
  });

  it("keeps small clean entries intact apart from the projection shape", () => {
    const small: Discovery = {
      ...bloatedDiscovery(),
      entry: {
        id: "catalog://x/y",
        kind: "skill",
        title: "T",
        description: "short",
        action: { type: "resource_read", uri: "runtime://x/y" },
      },
    };
    const bounded = boundSearchDiscoveries(response([small]));
    const discovery = bounded.discoveries?.[0];
    expect(discovery?.entry.description).toBe("short");
    expect(discovery?.entry.metadata).toBeUndefined();
  });
});
