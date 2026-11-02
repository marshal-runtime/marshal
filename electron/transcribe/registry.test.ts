import { describe, expect, it, vi } from "vitest";

import {
  TranscriptionProviderRegistry,
  audioFileName,
  type TranscriptionProvider,
} from "./contracts";
import { createBuiltinTranscriptionRegistry, resolveTranscriptionProvider } from "./registry";

function stubProvider(id: string): TranscriptionProvider {
  return { id, transcribe: async () => id };
}

describe("TranscriptionProviderRegistry", () => {
  it("registers and creates providers", () => {
    const registry = new TranscriptionProviderRegistry();
    registry.register("openai", () => stubProvider("openai"));
    expect(registry.registeredIds()).toEqual(["openai"]);
    expect(registry.create("openai").id).toBe("openai");
  });

  it("rejects duplicate registrations and unknown lookups", () => {
    const registry = new TranscriptionProviderRegistry();
    registry.register("openai", () => stubProvider("openai"));
    expect(() => registry.register("openai", () => stubProvider("openai"))).toThrow(
      /already registered/,
    );
    expect(() => registry.create("nope")).toThrow(/Registered providers: openai/);
  });
});

describe("builtin transcription registry", () => {
  it("registers the OpenAI adapter", () => {
    expect(createBuiltinTranscriptionRegistry().registeredIds()).toEqual(["openai"]);
  });

  it("defaults to OpenAI when no provider is configured", () => {
    expect(resolveTranscriptionProvider({ env: {} }).id).toBe("openai");
  });

  it.each(["MARSHAL_OPENAI_API_KEY", "OPENAI_API_KEY"] as const)(
    "defaults to OpenAI when an existing %s is available",
    (key) => {
      expect(resolveTranscriptionProvider({ env: { [key]: "configured" } }).id).toBe("openai");
    },
  );

  function twoProviderRegistry(): TranscriptionProviderRegistry {
    const registry = new TranscriptionProviderRegistry();
    registry.register("local", () => stubProvider("local"));
    registry.register("openai", () => stubProvider("openai"));
    return registry;
  }

  it("honors a configured provider ID", () => {
    expect(
      resolveTranscriptionProvider({
        registry: twoProviderRegistry(),
        env: { MARSHAL_TRANSCRIBE_PROVIDER: "local" },
      }).id,
    ).toBe("local");
  });

  it("prefers an explicit provider ID over configuration", () => {
    expect(
      resolveTranscriptionProvider({
        registry: twoProviderRegistry(),
        providerId: "local",
        env: { MARSHAL_TRANSCRIBE_PROVIDER: "openai" },
      }).id,
    ).toBe("local");
  });

  it("falls back to the default when the configured provider is unknown", () => {
    expect(
      resolveTranscriptionProvider({ env: { MARSHAL_TRANSCRIBE_PROVIDER: "removed" } }).id,
    ).toBe("openai");
  });

  it("falls back to OpenAI for an unknown provider when credentials support it", () => {
    expect(
      resolveTranscriptionProvider({
        env: {
          MARSHAL_TRANSCRIBE_PROVIDER: "removed",
          OPENAI_API_KEY: "configured",
        },
      }).id,
    ).toBe("openai");
  });
});

describe("audioFileName", () => {
  it("maps MIME types to container-appropriate names", () => {
    expect(audioFileName("audio/wav")).toBe("audio.wav");
    expect(audioFileName("audio/webm; codecs=opus")).toBe("audio.webm");
    expect(audioFileName("audio/ogg; codecs=opus")).toBe("audio.ogg");
    expect(audioFileName("audio/mpeg")).toBe("audio.mp3");
    expect(audioFileName("audio/mp4")).toBe("audio.m4a");
    expect(audioFileName("application/octet-stream")).toBe("audio.wav");
  });
});

describe("transcribeAudio dispatch", () => {
  it("routes to the selected provider", async () => {
    const { transcribeAudio } = await import("./transcribe");
    const registry = createBuiltinTranscriptionRegistry();
    expect(registry.has("openai")).toBe(true);
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ text: "  Hello   there. " }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const text = await transcribeAudio(new Uint8Array([1, 2, 3]), {
      providerId: "openai",
      acquireToken: async () => "key",
      fetchImpl,
    });
    expect(text).toBe("Hello there.");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.openai.com/v1/audio/transcriptions");
  });
});
