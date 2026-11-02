// Marshal-owned tooling test.
import { describe, expect, it } from "vitest";

import { buffersToIcns, parseIcnsEntries } from "./marshal-icns.mjs";

describe("buffersToIcns", () => {
  it("builds a valid icns container with correct magic, size, and entries", () => {
    const a = Buffer.from("first-icon-data");
    const b = Buffer.from("second-icon-data-longer");

    const icns = buffersToIcns([
      { type: "ic07", data: a },
      { type: "ic08", data: b },
    ]);

    expect(icns.toString("ascii", 0, 4)).toBe("icns");
    expect(icns.readUInt32BE(4)).toBe(icns.length);

    const { total, entries } = parseIcnsEntries(icns);
    expect(total).toBe(icns.length);
    expect(entries.map((e) => e.type)).toEqual(["ic07", "ic08"]);
    expect(entries[0].data.equals(a)).toBe(true);
    expect(entries[1].data.equals(b)).toBe(true);
  });

  it("rejects OSTypes that are not four characters", () => {
    expect(() => buffersToIcns([{ type: "ic7", data: Buffer.from("x") }])).toThrow();
  });
});
