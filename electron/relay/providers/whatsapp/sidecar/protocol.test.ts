import { describe, expect, it } from "vitest";

import {
  decodeWhatsAppAuthValue,
  encodeWhatsAppAuthValue,
  parseWhatsAppSidecarChildFrame,
  parseWhatsAppSidecarParentFrame,
  serializeWhatsAppSidecarFrame,
  WHATSAPP_SIDECAR_SCHEMA_VERSION,
} from "./protocol";

describe("WhatsApp sidecar protocol", () => {
  it("round-trips binary auth values without putting them in argv or environment", () => {
    const value = {
      keyPair: {
        public: new Uint8Array([1, 2, 3]),
        private: Buffer.from([4, 5, 6]),
      },
      counter: 9n,
    };
    expect(decodeWhatsAppAuthValue(encodeWhatsAppAuthValue(value))).toEqual(value);
  });

  it("accepts only exact schema-versioned command and event shapes", () => {
    expect(
      parseWhatsAppSidecarParentFrame(
        JSON.stringify({
          schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
          kind: "command",
          requestId: "command-1",
          command: "start",
        }),
      ),
    ).toEqual({
      schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
      kind: "command",
      requestId: "command-1",
      command: "start",
    });
    expect(() =>
      parseWhatsAppSidecarParentFrame(
        JSON.stringify({
          schemaVersion: 2,
          kind: "command",
          requestId: "command-1",
          command: "start",
        }),
      ),
    ).toThrow(/invalid schema version/);
    expect(() =>
      parseWhatsAppSidecarParentFrame(
        JSON.stringify({
          schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
          kind: "command",
          requestId: "command-1",
          command: "start",
          unexpected: true,
        }),
      ),
    ).toThrow(/invalid shape/);

    const event = {
      schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
      kind: "event" as const,
      event: {
        type: "disconnected" as const,
        classification: "retryable" as const,
        reason: "connection-lost" as const,
        statusCode: 408,
        retryInMs: 1000,
      },
    };
    expect(parseWhatsAppSidecarChildFrame(serializeWhatsAppSidecarFrame(event).trim())).toEqual(
      event,
    );
    expect(
      parseWhatsAppSidecarChildFrame(
        JSON.stringify({
          schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
          kind: "event",
          event: {
            type: "error",
            code: "SIDECAR_FAILED",
            message: "WhatsApp sidecar process failed.",
          },
        }),
      ),
    ).toEqual({
      schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
      kind: "event",
      event: {
        type: "error",
        code: "SIDECAR_FAILED",
        message: "WhatsApp sidecar process failed.",
      },
    });
    expect(
      parseWhatsAppSidecarChildFrame(
        JSON.stringify({
          schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
          kind: "event",
          event: {
            type: "provisioned",
            provisioning: {
              community: true,
              newChats: true,
              progress: true,
              informationControl: true,
            },
          },
        }),
      ),
    ).toMatchObject({
      kind: "event",
      event: {
        type: "provisioned",
        provisioning: {
          community: true,
          newChats: true,
          progress: true,
          informationControl: true,
        },
      },
    });
  });

  it("rejects malformed encoded auth values and oversized QR frames", () => {
    expect(() =>
      parseWhatsAppSidecarParentFrame(
        JSON.stringify({
          schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
          kind: "auth-response",
          requestId: "auth-1",
          operation: "read-credentials",
          ok: true,
          credentials: { encoding: "v8-base64", data: "not base64!" },
        }),
      ),
    ).toThrow(/invalid shape/);
    expect(() =>
      parseWhatsAppSidecarChildFrame(
        JSON.stringify({
          schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
          kind: "event",
          event: {
            type: "setup",
            phase: "qr",
            qr: "x".repeat(16 * 1024 + 1),
            sequence: 1,
          },
        }),
      ),
    ).toThrow(/invalid shape/);
  });

  it("keeps session-group retirement request and response validators aligned", () => {
    expect(
      parseWhatsAppSidecarParentFrame(
        JSON.stringify({
          schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
          kind: "request",
          requestId: "retire-1",
          request: {
            type: "retire-session-group",
            conversationId: "session@g.us",
            communityConversationId: "community@g.us",
          },
        }),
      ),
    ).toMatchObject({
      kind: "request",
      request: { type: "retire-session-group", conversationId: "session@g.us" },
    });
    expect(
      parseWhatsAppSidecarChildFrame(
        JSON.stringify({
          schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
          kind: "request-result",
          requestId: "retire-1",
          requestType: "retire-session-group",
          ok: true,
          response: {
            type: "retire-session-group",
            conversationId: "session@g.us",
            unlinked: true,
            left: true,
          },
        }),
      ),
    ).toMatchObject({
      kind: "request-result",
      requestType: "retire-session-group",
      response: { unlinked: true, left: true },
    });
  });
});
