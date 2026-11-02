import { describe, expect, it, vi } from "vitest";

import type { ContextPersonEntity, IpcHandler } from "../../../common/marshal-ipc-contract";
import { registerContextPickerHandlers } from "./context-picker-handler-registration";
import { errorMessage, resolveEntityTypes } from "./internals";
import type { RuntimePeopleSearch } from "./search";

type Handler = IpcHandler<"contextPicker:search">;
type HandlerResult = Awaited<ReturnType<Handler>>;

function captureHandler(runtimePeopleSearch?: RuntimePeopleSearch): {
  handler: Handler;
  ipcHandle: ReturnType<typeof vi.fn>;
} {
  let handler: Handler | null = null;
  const ipcHandle = vi.fn<(channel: string, fn: unknown) => void>((channel, fn) => {
    if (channel === "contextPicker:search") {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- vi.fn signature can't carry the IPC contract's generic, so we narrow at the boundary.
      handler = fn as Handler;
    }
  });
  registerContextPickerHandlers(
    {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the test fake satisfies the structural shape required by registerContextPickerHandlers; the IpcHandle generic is too narrow for vi.fn to model.
      ipcHandle: ipcHandle as unknown as Parameters<
        typeof registerContextPickerHandlers
      >[0]["ipcHandle"],
    },
    { runtimePeopleSearch },
  );
  if (!handler) throw new Error("Handler not registered");
  return { handler, ipcHandle };
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Electron's IpcMainInvokeEvent is large and not under test; an empty object suffices because the handler ignores `event`.
const fakeEvent = {} as Parameters<Handler>[0];

async function invoke(
  handler: Handler,
  query: string,
  entityTypes?: Parameters<Handler>[2],
): Promise<HandlerResult> {
  return handler(fakeEvent, query, entityTypes);
}

const ALICE: ContextPersonEntity = {
  type: "People",
  id: "person-1",
  displayName: "Alice Example",
  email: "alice@example.com",
};

describe("registerContextPickerHandlers", () => {
  it("registers the contextPicker:search channel exactly once", () => {
    const { ipcHandle } = captureHandler();
    expect(ipcHandle).toHaveBeenCalledTimes(1);
    expect(ipcHandle).toHaveBeenCalledWith("contextPicker:search", expect.any(Function));
  });

  it("returns people from the runtime people search", async () => {
    const runtimePeopleSearch = vi.fn<RuntimePeopleSearch>().mockResolvedValue([ALICE]);
    const { handler } = captureHandler(runtimePeopleSearch);

    const result = await invoke(handler, "alice");

    expect(runtimePeopleSearch).toHaveBeenCalledWith("alice");
    expect(result).toEqual({ success: true, entities: [ALICE] });
  });

  it("skips the runtime people search when People is not requested", async () => {
    const runtimePeopleSearch = vi.fn<RuntimePeopleSearch>().mockResolvedValue([ALICE]);
    const { handler } = captureHandler(runtimePeopleSearch);

    const result = await invoke(handler, "alice", ["File"]);

    expect(runtimePeopleSearch).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, entities: [] });
  });

  it("returns an empty result when no runtime people search is available", async () => {
    const { handler } = captureHandler();

    const result = await invoke(handler, "alice");

    expect(result).toEqual({ success: true, entities: [] });
  });

  it("degrades a failing runtime people search to an empty result", async () => {
    const runtimePeopleSearch = vi
      .fn<RuntimePeopleSearch>()
      .mockRejectedValue(new Error("directory unavailable"));
    const { handler } = captureHandler(runtimePeopleSearch);

    const result = await invoke(handler, "alice");

    expect(result).toEqual({ success: true, entities: [] });
  });
});

describe("resolveEntityTypes", () => {
  it("returns the default set when no types are requested", () => {
    expect([...resolveEntityTypes(undefined)]).toEqual(["People", "File"]);
    expect([...resolveEntityTypes([])]).toEqual(["People", "File"]);
  });

  it("filters out invalid types", () => {
    expect([...resolveEntityTypes(["People", "Bogus"])]).toEqual(["People"]);
  });

  it("falls back to the default set when all requested types are invalid", () => {
    expect([...resolveEntityTypes(["Bogus"])]).toEqual(["People", "File"]);
  });
});

describe("errorMessage", () => {
  it("uses Error.message for Error instances", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("falls back to String() for non-Error values", () => {
    expect(errorMessage("string error")).toBe("string error");
    expect(errorMessage(42)).toBe("42");
  });
});
