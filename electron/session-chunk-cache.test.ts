import { describe, expect, it } from "vitest";

import { ParsedChunkCache } from "./session-chunk-cache";

describe("ParsedChunkCache", () => {
  it("keys entries by session, generation, and index", () => {
    const cache = new ParsedChunkCache<string>(100);
    cache.set("s1", "g1", 0, "a", 1);
    expect(cache.get("s1", "g1", 0)).toBe("a");
    expect(cache.get("s1", "g2", 0)).toBeUndefined();
    expect(cache.get("s1", "g1", 1)).toBeUndefined();
    expect(cache.get("s2", "g1", 0)).toBeUndefined();
  });

  it("evicts least recently used entries past the size budget", () => {
    const cache = new ParsedChunkCache<string>(10);
    cache.set("s", "g", 0, "a", 4);
    cache.set("s", "g", 1, "b", 4);
    cache.get("s", "g", 0);
    cache.set("s", "g", 2, "c", 4);
    expect(cache.get("s", "g", 0)).toBe("a");
    expect(cache.get("s", "g", 1)).toBeUndefined();
    expect(cache.get("s", "g", 2)).toBe("c");
    expect(cache.size).toBe(8);
  });

  it("never caches an entry larger than the budget", () => {
    const cache = new ParsedChunkCache<string>(10);
    cache.set("s", "g", 0, "a", 4);
    cache.set("s", "g", 1, "huge", 11);
    expect(cache.get("s", "g", 1)).toBeUndefined();
    expect(cache.get("s", "g", 0)).toBe("a");
  });

  it("carries a reused chunk into the new generation", () => {
    const cache = new ParsedChunkCache<string>(100);
    cache.set("s", "g1", 0, "a", 3);
    cache.carry("s", "g1", "g2", 0);
    expect(cache.get("s", "g1", 0)).toBeUndefined();
    expect(cache.get("s", "g2", 0)).toBe("a");
    expect(cache.size).toBe(3);
  });

  it("drops only older generations and whole sessions on request", () => {
    const cache = new ParsedChunkCache<string>(100);
    cache.set("s", "g1", 0, "old", 1);
    cache.set("s", "g2", 0, "keep", 1);
    cache.set("s", "g3", 0, "newer", 1);
    cache.set("other", "g1", 0, "other", 1);
    cache.dropGenerationsBefore("s", "g2");
    expect(cache.get("s", "g1", 0)).toBeUndefined();
    expect(cache.get("s", "g2", 0)).toBe("keep");
    expect(cache.get("s", "g3", 0)).toBe("newer");
    cache.dropSession("s");
    expect(cache.get("s", "g2", 0)).toBeUndefined();
    expect(cache.get("other", "g1", 0)).toBe("other");
    expect(cache.size).toBe(1);
  });
});
