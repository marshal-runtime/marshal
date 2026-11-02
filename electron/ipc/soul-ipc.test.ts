import { beforeEach, describe, expect, it, vi } from "vitest";

import { SOUL_PRESETS } from "../souls";
import { testDouble } from "../testing/harness";
import { registerSoulHandlers } from "./soul-ipc";

type Deps = Parameters<typeof registerSoulHandlers>[0];
type Handler = (event: object, ...args: unknown[]) => Promise<unknown>;

function setup(
  opts: {
    getDefaultSoul?: () => string;
    setDefaultSoul?: (id: string) => Promise<void>;
    getSoulGreeting?: (id: string) => string | null;
    getSessionSoul?: (sid: string) => string | undefined;
  } = {},
) {
  const handlers = new Map<string, Handler>();
  const ipcHandle = (channel: string, handler: Handler) => {
    handlers.set(channel, handler);
  };

  const sessionManager = {
    getDefaultSoul: opts.getDefaultSoul ?? (() => "default"),
    setDefaultSoul: opts.setDefaultSoul ?? (async () => {}),
    getSoulGreeting: opts.getSoulGreeting ?? (() => null),
    getSessionSoul: opts.getSessionSoul ?? (() => undefined),
  };

  registerSoulHandlers({
    ipcHandle: testDouble<Deps["ipcHandle"]>(ipcHandle),
    sessionManager: testDouble<Deps["sessionManager"]>(sessionManager),
  });

  return { handlers, sessionManager };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("soul:list", () => {
  it("returns every Marshal-owned preset — there is no audience gate", async () => {
    const { handlers } = setup();
    const result = await handlers.get("soul:list")!({});
    expect(result).toMatchObject({
      success: true,
      souls: SOUL_PRESETS,
    });
  });
});

describe("soul:setDefault", () => {
  it("rejects an id that is not a known soul", async () => {
    const setDefault = vi.fn<(id: string) => Promise<void>>(async () => {});
    const { handlers } = setup({ setDefaultSoul: setDefault });
    const result = await handlers.get("soul:setDefault")!({}, "not-a-soul");
    expect(result).toEqual({ success: false, error: "Soul not available" });
    expect(setDefault).not.toHaveBeenCalled();
  });

  it("accepts a known id and persists it", async () => {
    const setDefault = vi.fn<(id: string) => Promise<void>>(async () => {});
    const { handlers } = setup({ setDefaultSoul: setDefault });
    const result = await handlers.get("soul:setDefault")!({}, "analyst");
    expect(result).toEqual({ success: true });
    expect(setDefault).toHaveBeenCalledWith("analyst");
  });
});

describe("soul:getDefault", () => {
  it("migrates a persisted legacy personality id to its replacement soul", async () => {
    const { handlers } = setup({ getDefaultSoul: () => "tars" });
    const result = await handlers.get("soul:getDefault")!({});
    expect(result).toEqual({ success: true, soul: "operator" });
  });

  it('coerces a persisted-but-unknown default to "default"', async () => {
    const { handlers } = setup({ getDefaultSoul: () => "not-a-soul" });
    const result = await handlers.get("soul:getDefault")!({});
    expect(result).toEqual({ success: true, soul: "default" });
  });

  it("passes through a known persisted default", async () => {
    const { handlers } = setup({ getDefaultSoul: () => "mentor" });
    const result = await handlers.get("soul:getDefault")!({});
    expect(result).toMatchObject({ soul: "mentor" });
  });
});

describe("soul:getGreeting", () => {
  it("reroutes an unknown id to the default greeting", async () => {
    const getSoulGreeting = vi.fn<(id: string) => string | null>(() => null);
    const { handlers } = setup({ getSoulGreeting });
    await handlers.get("soul:getGreeting")!({}, "not-a-soul");
    expect(getSoulGreeting).toHaveBeenCalledWith("default");
  });

  it("maps a legacy personality id onto its replacement soul's greeting", async () => {
    const getSoulGreeting = vi.fn<(id: string) => string | null>(() => "hi");
    const { handlers } = setup({ getSoulGreeting });
    await handlers.get("soul:getGreeting")!({}, "attenborough");
    expect(getSoulGreeting).toHaveBeenCalledWith("mentor");
  });

  it("passes through a known id to the session manager", async () => {
    const getSoulGreeting = vi.fn<(id: string) => string | null>(() => "hi");
    const { handlers } = setup({ getSoulGreeting });
    await handlers.get("soul:getGreeting")!({}, "spark");
    expect(getSoulGreeting).toHaveBeenCalledWith("spark");
  });
});

describe("soul:getSessionSoul", () => {
  it("coerces a persisted-but-unknown session soul to default", async () => {
    const { handlers } = setup({ getSessionSoul: () => "not-a-soul" });
    const result = await handlers.get("soul:getSessionSoul")!({}, "sess-1");
    expect(result).toMatchObject({ soul: "default" });
  });

  it("returns undefined when the session has no soul set", async () => {
    const { handlers } = setup({ getSessionSoul: () => undefined });
    const result = await handlers.get("soul:getSessionSoul")!({}, "sess-1");
    expect(result).toEqual({ success: true, soul: undefined });
  });
});
