import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { serializeLogArg } from "./arg-serializer";

describe("serializeLogArg", () => {
  it("returns strings unchanged", () => {
    expect(serializeLogArg("trackTokenUsage (dev)")).toBe("trackTokenUsage (dev)");
  });

  it("returns an empty string for nullish direct args", () => {
    expect(serializeLogArg(null)).toBe("");
    expect(serializeLogArg(undefined)).toBe("");
  });

  it("stringifies direct numbers and booleans", () => {
    expect(serializeLogArg(42)).toBe("42");
    expect(serializeLogArg(false)).toBe("false");
  });

  it("stringifies direct non-finite numbers", () => {
    expect(serializeLogArg(NaN)).toBe("NaN");
    expect(serializeLogArg(Infinity)).toBe("Infinity");
  });

  it("serializes plain objects as JSON", () => {
    expect(serializeLogArg({ model: "gpt-4o", inputTokens: 1200 })).toBe(
      '{"model":"gpt-4o","inputTokens":1200}',
    );
  });

  it("serializes nested arrays and objects as JSON", () => {
    expect(serializeLogArg({ usage: [{ type: "input", tokens: 1200 }] })).toBe(
      '{"usage":[{"type":"input","tokens":1200}]}',
    );
  });

  it("falls back to inspect for arrays with custom own properties", () => {
    const value = [1, 2, 3] as Array<number> & {
      metadata?: { query: string; time: number };
    };
    value.metadata = { query: "SELECT *", time: 42 };

    const serialized = serializeLogArg(value);

    expect(serialized).toContain("metadata");
    expect(serialized).toContain("query: 'SELECT *'");
    expect(serialized).toContain("time: 42");
    expect(serialized).not.toBe("[1,2,3]");
  });

  it("falls back to inspect for arrays with enumerable symbol properties", () => {
    const meta = Symbol("meta");
    const value = [1, 2, 3] as Array<number> & { [meta]?: string };
    value[meta] = "critical-data";

    const serialized = serializeLogArg(value);

    expect(serialized).toContain("Symbol(meta)");
    expect(serialized).toContain("critical-data");
    expect(serialized).not.toBe("[1,2,3]");
  });

  it("preserves useful Error details", () => {
    const error = new Error("token usage failed");

    const serialized = serializeLogArg(error);

    expect(serialized).toContain("Error: token usage failed");
  });

  it("falls back to inspect when nested errors would lose detail", () => {
    const serialized = serializeLogArg({ error: new Error("fail"), count: 5 });

    expect(serialized).toContain("error: Error: fail");
    expect(serialized).toContain("count: 5");
    expect(serialized).not.toBe('{"error":{},"count":5}');
  });

  it("falls back to inspect when object properties are not JSON-safe", () => {
    const diagnosticSymbol = Symbol("diagnostic");
    const callback = function callback() {
      return "unused";
    };

    const serialized = serializeLogArg({
      callback,
      undef: undefined,
      marker: diagnosticSymbol,
      value: 42,
    });

    expect(serialized).toContain("callback: [Function: callback]");
    expect(serialized).toContain("undef: undefined");
    expect(serialized).toContain("marker: Symbol(diagnostic)");
    expect(serialized).toContain("value: 42");
  });

  it("falls back to inspect when an object contains undefined properties", () => {
    const serialized = serializeLogArg({ undef: undefined, value: 42 });

    expect(serialized).toContain("undef: undefined");
    expect(serialized).toContain("value: 42");
    expect(serialized).not.toBe('{"value":42}');
  });

  it("falls back to inspect when an enumerable getter throws", () => {
    const value = {};
    Object.defineProperty(value, "status", {
      get() {
        throw new Error("connection refused");
      },
      enumerable: true,
    });

    const serialized = serializeLogArg(value);

    expect(typeof serialized).toBe("string");
    expect(serialized).toContain("status");
    expect(serialized).not.toBe("[object Object]");
  });

  it("falls back to inspect for nested NaN values", () => {
    const serialized = serializeLogArg({ value: NaN });

    expect(serialized).toContain("value: NaN");
    expect(serialized).not.toBe('{"value":null}');
  });

  it("falls back to inspect for nested Infinity values", () => {
    const serialized = serializeLogArg({ value: Infinity });

    expect(serialized).toContain("value: Infinity");
    expect(serialized).not.toBe('{"value":null}');
  });

  it("falls back to util.inspect for circular objects", () => {
    const value: { name: string; self?: unknown } = { name: "loop" };
    value.self = value;

    const serialized = serializeLogArg(value);

    expect(serialized).toContain("name: 'loop'");
    expect(serialized).toContain("Circular");
    expect(serialized).not.toBe("[object Object]");
  });

  it("returns a literal placeholder when inspect cannot serialize a value", () => {
    const value = {
      [inspect.custom]() {
        throw new Error("inspect failed");
      },
      toString() {
        return "fallback value";
      },
    };

    expect(serializeLogArg(value)).toBe("[unserializable]");
  });

  it("serializes BigInt values without throwing", () => {
    expect(serializeLogArg(1200n)).toBe("1200");
  });

  it("serializes Symbols using String coercion", () => {
    expect(serializeLogArg(Symbol("diagnostic"))).toBe("Symbol(diagnostic)");
  });

  it("names functions without dumping source", () => {
    function namedDiagnosticHelper() {
      return "unused";
    }

    expect(serializeLogArg(namedDiagnosticHelper)).toBe("[Function: namedDiagnosticHelper]");
  });
});
