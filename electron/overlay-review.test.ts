import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerOverlayReviewHandlers,
  type OverlayReviewAttachment,
  type OverlayReviewController,
  type OverlayReviewDeps,
  type OverlayReviewOptions,
  type OverlayReviewPayload,
  type OverlayReviewRuntime,
} from "./overlay-review";
import { callIpc, testDouble, type TestIpcHandlers } from "./testing/harness";

const mockElectron = vi.hoisted(() => ({
  tempDir: "",
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => "C:\\mock-app",
    getPath: (name: string) => {
      if (name !== "temp") throw new Error(`Unexpected app path request: ${name}`);
      return mockElectron.tempDir;
    },
  },
}));

vi.mock("./transcribe/transcribe", () => ({
  transcribeAudio: vi.fn<() => Promise<string>>(),
}));

type Handler = (...args: unknown[]) => unknown;

function makePayload(): OverlayReviewPayload {
  return {
    target: { sessionId: "session-1", isNew: false },
    markdown:
      "# Screen review\n\n## Frame 1\n- Move the CTA above the fold.\n\n## Frame 2\n- Keep the modal centered after resize.",
  };
}

function makeAttachments(): OverlayReviewAttachment[] {
  return [
    {
      name: "review-frame-1-display-1.png",
      mimeType: "image/png",
      dataUrl: `data:image/png;base64,${Buffer.from("frame-1-clean").toString("base64")}`,
      kind: "screenshot",
    },
    {
      name: "review-frame-1-display-1-marked.png",
      mimeType: "image/png",
      dataUrl: `data:image/png;base64,${Buffer.from("frame-1-marked").toString("base64")}`,
      kind: "composite",
    },
    {
      name: "review-frame-2-display-1.png",
      mimeType: "image/png",
      dataUrl: `data:image/png;base64,${Buffer.from("frame-2-clean").toString("base64")}`,
      kind: "screenshot",
    },
    {
      name: "review-frame-2-display-1-marked.png",
      mimeType: "image/png",
      dataUrl: `data:image/png;base64,${Buffer.from("frame-2-marked").toString("base64")}`,
      kind: "composite",
    },
    {
      name: "review-frame-2-voice-note-1-pin-2.webm",
      mimeType: "audio/webm",
      dataUrl: `data:audio/webm;base64,${Buffer.from("frame-2-audio").toString("base64")}`,
      kind: "audio",
    },
  ];
}

describe("overlay review host handlers", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "marshal-overlay-review-test-"));
    mockElectron.tempDir = tempRoot;
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("persists a multi-frame attachment bundle and preserves frame-aware names in claimed events", async () => {
    const handlers: TestIpcHandlers = new Map();
    const ipcHandle = (channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    };
    const sentPending = vi.fn<(channel: string, event: { sessionId: string }) => void>();
    let submitReview: OverlayReviewOptions["hooks"]["onSubmitReview"] | undefined;
    const overlay = testDouble<OverlayReviewController>({
      enable: vi.fn<OverlayReviewController["enable"]>(),
      destroy: vi.fn<OverlayReviewController["destroy"]>(),
      show: vi.fn<OverlayReviewController["show"]>(),
    });
    const attachments = makeAttachments();
    const loadRuntime = vi
      .fn<(entry: string) => Promise<OverlayReviewRuntime>>()
      .mockResolvedValue({
        createOverlay: vi.fn<OverlayReviewRuntime["createOverlay"]>((options) => {
          submitReview = options.hooks.onSubmitReview;
          return overlay;
        }),
        reviewToAttachments: vi.fn<OverlayReviewRuntime["reviewToAttachments"]>((payload) => ({
          attachments,
          summaryMarkdown: payload.markdown,
        })),
      });

    const host = registerOverlayReviewHandlers(
      testDouble<OverlayReviewDeps>({
        ipcHandle,
        getWindow: () =>
          testDouble<BrowserWindow>({
            isDestroyed: () => false,
            webContents: testDouble<BrowserWindow["webContents"]>({ send: sentPending }),
          }),
        appVersion: "0.0.0-test",
        loadRuntime,
      }),
    );
    const packageRoot = path.join(tempRoot, "installed-overlay-review");
    const release = await host.activatePackage(packageRoot);

    await expect(
      callIpc(handlers, "overlay-review:launch", { sessionId: "session-1" }),
    ).resolves.toEqual({
      success: true,
    });
    expect(loadRuntime).toHaveBeenCalledWith(path.join(packageRoot, "dist", "main", "index.js"));
    expect(overlay.enable).toHaveBeenCalledOnce();

    if (!submitReview) throw new Error("Expected overlay submit hook to be registered.");
    await submitReview(makePayload());

    expect(sentPending).toHaveBeenCalledWith("overlay-review:pending", { sessionId: "session-1" });

    const claimed = await callIpc(handlers, "overlay-review:claim", "session-1");

    expect(claimed?.reviews).toHaveLength(1);
    const event = claimed?.reviews[0];
    expect(event?.summaryMarkdown).toContain("## Frame 1");
    expect(event?.summaryMarkdown).toContain("## Frame 2");
    expect(event?.attachments.map((attachment) => attachment.name)).toEqual([
      "review-frame-1-display-1.png",
      "review-frame-1-display-1-marked.png",
      "review-frame-2-display-1.png",
      "review-frame-2-display-1-marked.png",
      "review-frame-2-voice-note-1-pin-2.webm",
    ]);
    expect(event?.attachments.map((attachment) => attachment.kind)).toEqual([
      "screenshot",
      "composite",
      "screenshot",
      "composite",
      "audio",
    ]);

    const persisted = event?.attachments ?? [];
    await expect(readFile(persisted[0]?.path ?? "", "utf8")).resolves.toBe("frame-1-clean");
    await expect(readFile(persisted[1]?.path ?? "", "utf8")).resolves.toBe("frame-1-marked");
    await expect(readFile(persisted[2]?.path ?? "", "utf8")).resolves.toBe("frame-2-clean");
    await expect(readFile(persisted[3]?.path ?? "", "utf8")).resolves.toBe("frame-2-marked");
    await expect(readFile(persisted[4]?.path ?? "", "utf8")).resolves.toBe("frame-2-audio");
    await release();
    expect(overlay.destroy).toHaveBeenCalledOnce();
  });
});
