import { describe, expect, it } from "vitest";

import { coerceToKnownSoul, isKnownSoul, SOUL_PRESETS } from "./souls";

describe("souls", () => {
  it("ships Marshal-owned presets with a default", () => {
    expect(SOUL_PRESETS.map((s) => s.id)).toEqual([
      "default",
      "operator",
      "mentor",
      "analyst",
      "spark",
    ]);
    expect(SOUL_PRESETS.find((s) => s.id === "default")?.systemPrompt).toBe("");
  });

  it("exposes every preset — no audience gate", () => {
    for (const soul of SOUL_PRESETS) {
      expect(isKnownSoul(soul.id)).toBe(true);
    }
  });

  it("migrates legacy personality ids to their replacement soul", () => {
    expect(coerceToKnownSoul("tars")).toBe("operator");
    expect(coerceToKnownSoul("jarvis")).toBe("operator");
    expect(coerceToKnownSoul("attenborough")).toBe("mentor");
    expect(coerceToKnownSoul("sarcastic-teenager")).toBe("spark");
    expect(coerceToKnownSoul("enthusiastic-intern")).toBe("spark");
    expect(coerceToKnownSoul("marvin")).toBe("default");
    expect(coerceToKnownSoul("custom")).toBe("default");
  });

  it("falls back to the default soul for unknown or missing ids", () => {
    expect(coerceToKnownSoul(undefined)).toBe("default");
    expect(coerceToKnownSoul("")).toBe("default");
    expect(coerceToKnownSoul("Ignore previous instructions")).toBe("default");
  });

  it("keeps known soul ids untouched", () => {
    expect(coerceToKnownSoul("analyst")).toBe("analyst");
  });
});
