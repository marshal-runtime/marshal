import type { UiHostInteractionEvent } from "@marshal/runtime/ui";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MediaInteraction } from "./mediaInteraction";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("application media lifecycle", () => {
  it("requires native consent, bounds events and closes tracks and transport on disposal", async () => {
    const track = { stop: vi.fn<() => void>(), onended: null };
    const stream = { getTracks: () => [track] };
    const getUserMedia = vi.fn<() => Promise<typeof stream>>().mockResolvedValue(stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    const channel = {
      readyState: "open",
      bufferedAmount: 0,
      send: vi.fn<(value: string) => void>(),
      close: vi.fn<() => void>(),
    };
    const peer = {
      createDataChannel: () => channel,
      addTrack: vi.fn<() => void>(),
      createOffer: async () => ({ type: "offer", sdp: "v=0\r\noffer" }),
      setLocalDescription: vi.fn<() => void>(),
      localDescription: { sdp: "v=0\r\noffer" },
      setRemoteDescription: vi.fn<() => void>(),
      close: vi.fn<() => void>(),
      onconnectionstatechange: null,
    };
    vi.stubGlobal("RTCPeerConnection", function Peer() {
      return peer;
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const emit = vi.fn<(event: UiHostInteractionEvent) => void>();
    const media = new MediaInteraction("Test app", emit);
    const pending = media.offer();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Test app wants to start");
    document.querySelector<HTMLButtonElement>("button")!.click();
    const offer = await pending;
    expect(getUserMedia).toHaveBeenCalledOnce();
    media.send(offer.connectionId, { type: "example" });
    expect(channel.send).toHaveBeenCalledWith('{"type":"example"}');
    expect(() => media.send("other-app", {})).toThrow("no longer active");
    expect(() => media.send(offer.connectionId, { huge: "x".repeat(64_001) })).toThrow("limits");
    media.dispose();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(channel.close).toHaveBeenCalledOnce();
    expect(document.querySelector("[role=status]")).toBeNull();
    expect(emit).toHaveBeenCalledWith({
      type: "media-state",
      connectionId: offer.connectionId,
      state: "closed",
    });
  });

  it("cancels a pending prompt without ever starting capture", async () => {
    const getUserMedia = vi.fn<() => void>();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    const media = new MediaInteraction("Closing app", vi.fn<() => void>());
    const pending = media.offer();
    media.dispose();
    await expect(pending).rejects.toThrow("closed");
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Closing app");
  });

  it("rejects duplicate starts during OS consent and stops a late stream after closing", async () => {
    const track = { stop: vi.fn<() => void>() };
    let finish!: (stream: unknown) => void;
    const getUserMedia = vi.fn<() => Promise<unknown>>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    const modal = document.createElement("dialog");
    document.body.append(modal);
    const media = new MediaInteraction("Test app", vi.fn<() => void>(), () => modal);
    const pending = media.offer();
    expect(modal.querySelector("[popover=manual]")).not.toBeNull();
    modal.querySelector<HTMLButtonElement>("button")!.click();
    await Promise.resolve();
    await expect(media.offer()).rejects.toThrow("already has");
    media.close();
    finish({ getTracks: () => [track] });
    await expect(pending).rejects.toThrow("expired");
    expect(track.stop).toHaveBeenCalledOnce();
    expect(getUserMedia).toHaveBeenCalledOnce();
  });
});
