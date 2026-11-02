import type { UiHostInteractionEvent } from "@marshal/runtime/ui";

/** Provider-neutral WebRTC transport. Credentials and provider protocols stay in extensions. */
export class MediaInteraction {
  private connection?: {
    id: string;
    peer: RTCPeerConnection;
    channel: RTCDataChannel;
    stream: MediaStream;
    audio: HTMLAudioElement;
    banner: HTMLDivElement;
    timer: ReturnType<typeof setTimeout>;
  };
  private pending?: { banner: HTMLDivElement; reject: (reason: Error) => void };
  private generation = 0;
  private opening = false;
  private disposed = false;

  constructor(
    private readonly title: string,
    private readonly emit: (event: UiHostInteractionEvent) => void,
    private readonly container: () => HTMLElement = () => document.body,
  ) {}

  private banner(label: string, action: string, onClick: () => void) {
    const banner = document.createElement("div");
    banner.setAttribute("role", "status");
    Object.assign(banner.style, {
      position: "fixed",
      top: "auto",
      left: "auto",
      margin: "0",
      bottom: "18px",
      right: "18px",
      zIndex: "99999",
      padding: "12px 16px",
      borderRadius: "12px",
      background: "#18212f",
      color: "#fff",
      boxShadow: "0 3px 20px #0005",
      font: "13px system-ui",
      display: "flex",
      gap: "12px",
      alignItems: "center",
    });
    const text = document.createElement("span");
    text.textContent = label;
    const button = document.createElement("button");
    button.textContent = action;
    button.type = "button";
    Object.assign(button.style, {
      padding: "6px 12px",
      borderRadius: "6px",
      background: "#fff",
      color: "#18212f",
      cursor: "pointer",
    });
    button.onclick = onClick;
    banner.append(text, button);
    // Keep native controls inside the application's modal ancestry, and above
    // its frame when fullscreen promotes that ancestry into the top layer.
    banner.setAttribute("popover", "manual");
    this.container().append(banner);
    banner.showPopover?.();
    return banner;
  }

  async offer() {
    if (this.disposed) throw new Error("Application closed.");
    if (this.connection || this.opening)
      throw new Error("This application already has a media connection.");
    const generation = ++this.generation;
    this.opening = true;
    try {
      return await this.open(generation);
    } finally {
      if (generation === this.generation) this.opening = false;
    }
  }

  private async open(generation: number) {
    // The untrusted frame can request this control, but only a click in native
    // chrome authorizes microphone capture. Never infer consent from a tool call.
    await new Promise<void>((resolve, reject) => {
      const banner = this.banner(
        `${this.title} wants to start a voice conversation`,
        "Start microphone",
        () => {
          banner.remove();
          this.pending = undefined;
          resolve();
        },
      );
      const cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      cancel.onclick = () => {
        banner.remove();
        this.pending = undefined;
        reject(new Error("Microphone request cancelled."));
      };
      banner.append(cancel);
      this.pending = { banner, reject };
    });
    if (this.disposed || generation !== this.generation) throw new Error("Media request expired.");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    if (this.disposed || generation !== this.generation) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error("Media request expired.");
    }
    const id = crypto.randomUUID();
    const peer = new RTCPeerConnection();
    const audio = document.createElement("audio");
    audio.autoplay = true;
    const channel = peer.createDataChannel("events");
    const banner = this.banner(`Microphone on · ${this.title}`, "Stop voice", () => this.close());
    const timer = setTimeout(() => this.close(), 30_000);
    this.connection = { id, peer, channel, stream, audio, banner, timer };
    const state = (value: string) =>
      this.emit({ type: "media-state", connectionId: id, state: value });
    stream.getTracks().forEach((track) => {
      peer.addTrack(track, stream);
      track.onended = () => this.close();
    });
    peer.ontrack = (event) => {
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void audio.play().catch(() => state("playback-blocked"));
    };
    peer.onconnectionstatechange = () => {
      state(peer.connectionState);
      if (peer.connectionState === "connected") clearTimeout(timer);
      if (["failed", "closed", "disconnected"].includes(peer.connectionState)) this.close();
    };
    channel.onopen = () => state("ready");
    channel.onmessage = (event) => {
      if (typeof event.data !== "string" || event.data.length > 512_000) return;
      try {
        this.emit({ type: "media", connectionId: id, event: JSON.parse(event.data) });
      } catch {
        /* Malformed peer data is not forwarded. */
      }
    };
    try {
      await peer.setLocalDescription(await peer.createOffer());
      if (this.connection?.id !== id) throw new Error("Media connection closed.");
      return { connectionId: id, sdp: peer.localDescription!.sdp };
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private require(id: unknown) {
    if (!this.connection || this.connection.id !== id)
      throw new Error("Media connection is no longer active.");
    return this.connection;
  }
  async answer(id: unknown, sdp: unknown) {
    const connection = this.require(id);
    if (typeof sdp !== "string" || sdp.length > 128_000 || !sdp.startsWith("v=0"))
      throw new Error("Invalid media answer.");
    await connection.peer.setRemoteDescription({ type: "answer", sdp });
    return { applied: true };
  }
  send(id: unknown, event: unknown) {
    const connection = this.require(id);
    if (!event || typeof event !== "object" || Array.isArray(event))
      throw new Error("Media event must be an object.");
    const value = JSON.stringify(event);
    if (value.length > 64_000 || connection.channel.bufferedAmount > 256_000)
      throw new Error("Media event exceeds transport limits.");
    if (connection.channel.readyState !== "open") throw new Error("Media channel is not ready.");
    connection.channel.send(value);
    return { sent: true };
  }
  close(id?: unknown) {
    if (id !== undefined) this.require(id);
    this.generation++;
    this.opening = false;
    this.pending?.banner.remove();
    this.pending?.reject(new Error("Media request closed."));
    this.pending = undefined;
    const connection = this.connection;
    this.connection = undefined;
    if (connection) {
      clearTimeout(connection.timer);
      connection.peer.onconnectionstatechange = null;
      connection.stream.getTracks().forEach((track) => {
        track.onended = null;
        track.stop();
      });
      connection.channel.close();
      connection.peer.close();
      connection.audio.pause();
      connection.audio.srcObject = null;
      connection.banner.remove();
      this.emit({ type: "media-state", connectionId: connection.id, state: "closed" });
    }
    return { closed: true };
  }
  dispose() {
    this.disposed = true;
    this.close();
  }
}
