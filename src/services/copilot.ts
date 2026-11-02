// Service for communicating with Copilot via Electron IPC

import { createLogger } from "@common/marshal-logger";

const log = createLogger("CopilotService");

function errorFromIpc(message: string | undefined, fallback: string): Error {
  const text = message || fallback;
  const abortPrefix = "AbortError:";
  if (text.startsWith(abortPrefix)) {
    const error = new Error(text.slice(abortPrefix.length).trim() || "The response was cancelled.");
    error.name = "AbortError";
    return error;
  }
  return new Error(text);
}

class CopilotService {
  private isInitialized = false;
  private initPromise: Promise<void> | null = null;

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._doInit().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async _doInit(): Promise<void> {
    if (!window.copilotAPI) {
      throw new Error("Copilot service only available in Electron app");
    }

    const result = await window.copilotAPI.init();
    if (!result.success) {
      throw new Error(result.error || "Failed to initialize Copilot");
    }

    this.isInitialized = true;
    log.info("Copilot service ready, session:", result.sessionId);
  }

  async send(
    prompt: string,
    sessionId?: string,
    attachments?: Array<{ type: "file" | "directory"; path: string; displayName?: string }>,
    clientMessageId?: string,
  ): Promise<void> {
    // All messages go through IPC — in E2E mock mode, MockCopilotSession.send()
    // plays scripted scenarios and invokes real permission/tool hooks.
    if (!window.copilotAPI) {
      throw new Error("Copilot service only available in Electron app");
    }

    const result = await window.copilotAPI.send(prompt, sessionId, attachments, clientMessageId);
    if (!result.success) {
      throw errorFromIpc(result.error, "Failed to send message");
    }
  }

  async steer(
    prompt: string,
    sessionId?: string,
    attachments?: Array<{ type: "file" | "directory"; path: string; displayName?: string }>,
    clientMessageId?: string,
  ): Promise<void> {
    if (!window.copilotAPI) {
      throw new Error("Copilot service only available in Electron app");
    }

    const result = await window.copilotAPI.steer(prompt, sessionId, attachments, clientMessageId);
    if (!result.success) {
      throw errorFromIpc(result.error, "Failed to steer message");
    }
  }

  async saveImage(base64Data: string, mimeType: string): Promise<string> {
    if (!window.copilotAPI) {
      throw new Error("Copilot service only available in Electron app");
    }

    const result = await window.copilotAPI.saveImage(base64Data, mimeType);
    if (!result.success || !result.path) {
      throw new Error(result.error || "Failed to save image");
    }
    return result.path;
  }

  async abort(sessionId?: string): Promise<void> {
    if (!window.copilotAPI) return;
    const result = await window.copilotAPI.abort(sessionId);
    if (!result.success) {
      throw new Error(result.error || "Failed to cancel response");
    }
  }

  async stop(): Promise<void> {
    if (window.copilotAPI) {
      await window.copilotAPI.destroy();
    }
    this.isInitialized = false;
    this.initPromise = null;
  }

  isReady(): boolean {
    return this.isInitialized;
  }
}

export const copilotService = new CopilotService();
