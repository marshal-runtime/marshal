import { describe, expect, it, vi } from "vitest";

import { createOpenAITranscriptionProvider, readOpenAITranscriptionConfig } from "./openai";

const SAMPLE = new Uint8Array([1, 2, 3, 4]);

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function formBody(init: RequestInit | undefined): FormData {
  const body = init?.body;
  if (!(body instanceof FormData)) {
    throw new Error("expected a FormData request body");
  }
  return body;
}

describe("readOpenAITranscriptionConfig", () => {
  it("defaults the base URL and model", () => {
    expect(readOpenAITranscriptionConfig({ OPENAI_API_KEY: "k" })).toEqual({
      apiKey: "k",
      baseUrl: "https://api.openai.com/v1",
      model: "whisper-1",
    });
  });

  it("prefers the namespaced key and trims trailing slashes", () => {
    expect(
      readOpenAITranscriptionConfig({
        OPENAI_API_KEY: "generic",
        MARSHAL_OPENAI_API_KEY: "scoped",
        MARSHAL_OPENAI_BASE_URL: "https://gateway.internal/v1//",
        MARSHAL_OPENAI_TRANSCRIBE_MODEL: "gpt-4o-mini-transcribe",
      }),
    ).toEqual({
      apiKey: "scoped",
      baseUrl: "https://gateway.internal/v1",
      model: "gpt-4o-mini-transcribe",
    });
  });

  it("omits the API key when none is configured", () => {
    expect(readOpenAITranscriptionConfig({}).apiKey).toBeUndefined();
  });

  it("ignores blank keys and falls back to a trimmed standard key", () => {
    expect(
      readOpenAITranscriptionConfig({
        MARSHAL_OPENAI_API_KEY: " ",
        OPENAI_API_KEY: " generic ",
      }).apiKey,
    ).toBe("generic");
    expect(
      readOpenAITranscriptionConfig({
        MARSHAL_OPENAI_API_KEY: " ",
        OPENAI_API_KEY: "\t",
      }).apiKey,
    ).toBeUndefined();
  });
});

describe("createOpenAITranscriptionProvider", () => {
  it("posts multipart audio with the configured key, model and language hint", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse({ text: "Bonjour  le monde." }));
    const provider = createOpenAITranscriptionProvider({
      env: { MARSHAL_OPENAI_API_KEY: "sk-test" },
      fetchImpl,
    });

    const text = await provider.transcribe({
      audio: SAMPLE,
      mimeType: "audio/wav",
      locales: ["fr-FR"],
    });

    expect(text).toBe("Bonjour le monde.");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer sk-test" });
    const body = formBody(init);
    expect(body.get("file")).toBeInstanceOf(Blob);
    expect(body.get("model")).toBe("whisper-1");
    expect(body.get("language")).toBe("fr");
  });

  it("targets an OpenAI-compatible base URL when configured", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse({ text: "hi" }));
    const provider = createOpenAITranscriptionProvider({
      env: {
        MARSHAL_OPENAI_API_KEY: "sk-test",
        MARSHAL_OPENAI_BASE_URL: "https://gateway.internal/v1",
      },
      fetchImpl,
    });
    await provider.transcribe({
      audio: SAMPLE,
      mimeType: "audio/wav",
      locales: ["en-US"],
    });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://gateway.internal/v1/audio/transcriptions");
  });

  it("fails with an actionable message when no key is configured", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse({ text: "" }));
    const provider = createOpenAITranscriptionProvider({ env: {}, fetchImpl });
    await expect(
      provider.transcribe({
        audio: SAMPLE,
        mimeType: "audio/wav",
        locales: ["en-US"],
      }),
    ).rejects.toThrow(/MARSHAL_OPENAI_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces non-OK responses without leaking response content", async () => {
    const provider = createOpenAITranscriptionProvider({
      env: { MARSHAL_OPENAI_API_KEY: "sk-test" },
      fetchImpl: async () => new Response("x".repeat(1000), { status: 429 }),
    });
    await expect(
      provider.transcribe({
        audio: SAMPLE,
        mimeType: "audio/wav",
        locales: ["en-US"],
      }),
    ).rejects.toThrow(/^Transcription failed \(HTTP 429\)$/);
  });

  it("returns empty string for silence", async () => {
    const provider = createOpenAITranscriptionProvider({
      env: { MARSHAL_OPENAI_API_KEY: "sk-test" },
      fetchImpl: async () => okResponse({}),
    });
    await expect(
      provider.transcribe({
        audio: SAMPLE,
        mimeType: "audio/wav",
        locales: ["en-US"],
      }),
    ).resolves.toBe("");
  });
});
