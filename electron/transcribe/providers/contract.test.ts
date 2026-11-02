import { describe, expect, it, vi } from "vitest";

import type { TranscriptionProvider, TranscriptionRequest } from "../contracts";
import { createOpenAITranscriptionProvider } from "./openai";

const SAMPLE = new Uint8Array([1, 2, 3, 4]);
const REQUEST: TranscriptionRequest = {
  audio: SAMPLE,
  mimeType: "audio/wav",
  locales: ["en-US"],
};

interface ProviderContractHarness {
  name: string;
  create(fetchImpl: typeof fetch): TranscriptionProvider;
  response(text?: string): Response;
}

const harnesses: ProviderContractHarness[] = [
  {
    name: "OpenAI",
    create: (fetchImpl) =>
      createOpenAITranscriptionProvider({
        env: { MARSHAL_OPENAI_API_KEY: "openai-key" },
        fetchImpl,
      }),
    response: (text) =>
      new Response(JSON.stringify(text === undefined ? {} : { text }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  },
];

describe.each(harnesses)("$name transcription provider contract", (harness) => {
  it("returns normalized text", async () => {
    const provider = harness.create(async () => harness.response("  Hello   world. "));

    await expect(provider.transcribe(REQUEST)).resolves.toBe("Hello world.");
  });

  it("returns an empty transcript for silence", async () => {
    const provider = harness.create(async () => harness.response());

    await expect(provider.transcribe(REQUEST)).resolves.toBe("");
  });

  it("rejects failed provider responses without exposing response content", async () => {
    const provider = harness.create(
      async () =>
        new Response("Authorization: Bearer provider-secret; customer audio rejected", {
          status: 503,
        }),
    );

    await expect(provider.transcribe(REQUEST)).rejects.toThrow(
      /^Transcription failed \(HTTP 503\)$/,
    );
  });

  it("propagates request cancellation", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("provider did not forward the cancellation signal"));
            return;
          }
          signal.throwIfAborted();
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const provider = harness.create(fetchImpl);
    const controller = new AbortController();
    const cancelled = new DOMException("cancelled", "AbortError");

    const pending = provider.transcribe({ ...REQUEST, signal: controller.signal });
    controller.abort(cancelled);

    await expect(pending).rejects.toBe(cancelled);
  });
});
