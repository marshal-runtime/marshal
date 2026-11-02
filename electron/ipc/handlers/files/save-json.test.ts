import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ dialog: { showSaveDialog: vi.fn<() => void>() } }));
vi.mock("node:fs/promises", () => ({ default: { writeFile: vi.fn<() => void>() } }));

import fs from "node:fs/promises";

import { dialog } from "electron";

import { testDouble } from "../../../testing/harness";
import { registerSaveJsonHandler } from "./save-json";

type RegisteredHandler = (...args: unknown[]) => unknown;

function setup(win: object | null = {}) {
  const handlers = new Map<string, RegisteredHandler>();
  const ipcHandle = vi.fn<(channel: string, handler: RegisteredHandler) => void>(
    (channel, handler) => handlers.set(channel, handler),
  );
  const getWindow = vi.fn<() => object | null>().mockReturnValue(win);
  registerSaveJsonHandler(
    testDouble<Parameters<typeof registerSaveJsonHandler>[0]>({ ipcHandle, getWindow }),
  );
  return { handlers };
}

beforeEach(() => vi.clearAllMocks());

describe("file:saveJson handler", () => {
  it("uses the parent window overload and basename-only default path", async () => {
    const mockWin = { id: 1 };
    const { handlers } = setup(mockWin);
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: true, filePath: "" });
    await handlers.get("file:saveJson")!({}, '{"foo":"bar"}', path.join("x", "export.json"));
    expect(dialog.showSaveDialog).toHaveBeenCalledWith(mockWin, {
      defaultPath: "export.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
  });

  it("writes UTF-8 content and returns cancellation without writing", async () => {
    const { handlers } = setup(null);
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({
      canceled: false,
      filePath: path.join(os.tmpdir(), "export.json"),
    });
    expect(await handlers.get("file:saveJson")!({}, '{"foo":"bar"}', "export.json")).toEqual({
      success: true,
    });
    expect(fs.writeFile).toHaveBeenCalledWith(
      path.join(os.tmpdir(), "export.json"),
      '{"foo":"bar"}',
      "utf-8",
    );
  });

  it("returns cancellation without writing when the dialog is canceled", async () => {
    const { handlers } = setup();
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: true, filePath: "" });
    await expect(
      handlers.get("file:saveJson")!({}, '{"foo":"bar"}', "export.json"),
    ).resolves.toEqual({ success: true, canceled: true });
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it("returns a write error", async () => {
    const { handlers } = setup();
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({
      canceled: false,
      filePath: path.join(os.tmpdir(), "export.json"),
    });
    vi.mocked(fs.writeFile).mockRejectedValue(new Error("disk full"));
    await expect(
      handlers.get("file:saveJson")!({}, '{"foo":"bar"}', "export.json"),
    ).resolves.toEqual({ success: false, error: "Error: disk full" });
  });

  it("rejects content exceeding the size limit before opening the dialog", async () => {
    const { handlers } = setup();
    const oversized = "x".repeat(6 * 1024 * 1024);
    await expect(
      handlers.get("file:saveJson")!({}, oversized, "export.json"),
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining("limit") });
    expect(dialog.showSaveDialog).not.toHaveBeenCalled();
  });
});
