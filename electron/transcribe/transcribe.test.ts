import { describe, expect, it, vi } from "vitest";

import type { TranscriptionProvider } from "./contracts";
import { transcribeAudio } from "./transcribe";

const OPENAI = "openai";

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, detail: string): Response {
  return new Response(detail, { status });
}

const SAMPLE = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

/** Extract the FormData body from a recorded fetch call (fails the test if absent). */
function formBody(init: RequestInit | undefined): FormData {
  const body = init?.body;
  if (!(body instanceof FormData)) {
    throw new Error("expected a FormData request body");
  }
  return body;
}

describe("transcribeAudio", () => {
  it("posts multipart audio with a bearer token and returns combined text", async () => {
    const acquireToken = vi.fn<() => Promise<string>>(async () => "fake-token");
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse({ text: "Hello world." }));

    const text = await transcribeAudio(SAMPLE, {
      providerId: OPENAI,
      acquireToken,
      fetchImpl,
    });

    expect(text).toBe("Hello world.");
    expect(acquireToken).toHaveBeenCalledOnce();
    const init = fetchImpl.mock.calls[0][1];
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer fake-token" });
    const body = formBody(init);
    expect(body.get("file")).toBeInstanceOf(Blob);
    expect(body.get("language")).toBe("en");
  });

  it("collapses whitespace in the transcript", async () => {
    const text = await transcribeAudio(SAMPLE, {
      providerId: OPENAI,
      acquireToken: async () => "t",
      fetchImpl: async () => okResponse({ text: "  Part one.\n  Part two. " }),
    });
    expect(text).toBe("Part one. Part two.");
  });

  it("honors a custom locale", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse({ text: "Bonjour." }));
    await transcribeAudio(SAMPLE, {
      providerId: OPENAI,
      acquireToken: async () => "t",
      fetchImpl,
      locales: ["fr-FR"],
    });
    const body = formBody(fetchImpl.mock.calls[0][1]);
    expect(body.get("language")).toBe("fr");
  });

  it("returns empty string when there are no phrases (silence)", async () => {
    const text = await transcribeAudio(SAMPLE, {
      providerId: OPENAI,
      acquireToken: async () => "t",
      fetchImpl: async () => okResponse({ text: "" }),
    });
    expect(text).toBe("");
  });

  it("throws on a non-OK HTTP response", async () => {
    await expect(
      transcribeAudio(SAMPLE, {
        providerId: OPENAI,
        acquireToken: async () => "t",
        fetchImpl: async () => errorResponse(401, "Unauthorized"),
      }),
    ).rejects.toThrow(/HTTP 401/);
  });

  it("rejects empty audio without acquiring a token", async () => {
    const acquireToken = vi.fn<() => Promise<string>>(async () => "t");
    await expect(
      transcribeAudio(new Uint8Array(0), { acquireToken, fetchImpl: async () => okResponse({}) }),
    ).rejects.toThrow(/No audio/);
    expect(acquireToken).not.toHaveBeenCalled();
  });

  it("rejects audio larger than the size cap", async () => {
    const tooBig = new Uint8Array(26 * 1024 * 1024);
    await expect(
      transcribeAudio(tooBig, {
        acquireToken: async () => "t",
        fetchImpl: async () => okResponse({}),
      }),
    ).rejects.toThrow(/too large/);
  });

  it("uses an injected provider without exposing transport or credentials in the request", async () => {
    const provider: TranscriptionProvider = {
      id: "test",
      transcribe: vi.fn<TranscriptionProvider["transcribe"]>(async (request) => {
        expect(request).toEqual({
          audio: SAMPLE,
          mimeType: "audio/ogg",
          locales: ["de-DE"],
        });
        return "Hallo.";
      }),
    };

    await expect(
      transcribeAudio(SAMPLE, {
        provider,
        mimeType: "audio/ogg",
        locales: ["de-DE"],
      }),
    ).resolves.toBe("Hallo.");
  });

  it("preserves provider errors", async () => {
    const providerError = new Error("provider unavailable");
    const provider: TranscriptionProvider = {
      id: "test",
      transcribe: async () => {
        throw providerError;
      },
    };

    await expect(transcribeAudio(SAMPLE, { provider })).rejects.toBe(providerError);
  });

  it("forwards cancellation to the provider", async () => {
    const controller = new AbortController();
    const provider: TranscriptionProvider = {
      id: "test",
      transcribe: (request) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(request.signal?.reason), {
            once: true,
          });
        }),
    };
    const cancelled = new DOMException("cancelled", "AbortError");

    const pending = transcribeAudio(SAMPLE, { provider, signal: controller.signal });
    controller.abort(cancelled);

    await expect(pending).rejects.toBe(cancelled);
  });
});
