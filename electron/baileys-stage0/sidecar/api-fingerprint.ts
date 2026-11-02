import * as baileys from "baileys";
import type {
  AnyMessageContent,
  AuthenticationCreds,
  BaileysEventMap,
  GroupMetadata,
  SignalDataTypeMap,
  WAMessage,
  WASocket,
} from "baileys";

import type { BaileysStage0Capabilities } from "../protocol";

const REQUIRED_RUNTIME_EXPORTS = [
  "makeWASocket",
  "initAuthCreds",
  "makeCacheableSignalKeyStore",
  "useMultiFileAuthState",
  "downloadMediaMessage",
  "downloadContentFromMessage",
  "prepareWAMessageMedia",
  "generateWAMessage",
  "generateWAMessageContent",
  "generateWAMessageFromContent",
  "encodeBinaryNode",
  "proto",
  "WAProto",
] as const satisfies readonly (keyof typeof baileys)[];

const REQUIRED_SOCKET_METHODS = [
  "communityMetadata",
  "communityCreate",
  "communityCreateGroup",
  "communityLinkGroup",
  "communityUnlinkGroup",
  "communityFetchLinkedGroups",
  "groupMetadata",
  "groupCreate",
  "groupParticipantsUpdate",
  "sendMessage",
  "relayMessage",
  "readMessages",
  "updateMediaMessage",
] as const satisfies readonly (keyof WASocket)[];

const REQUIRED_EVENT_KEYS = [
  "connection.update",
  "creds.update",
  "messaging-history.set",
  "messages.delete",
  "messages.update",
  "messages.media-update",
  "messages.upsert",
  "messages.reaction",
  "groups.upsert",
  "groups.update",
  "group-participants.update",
  "call",
  "newsletter.reaction",
  "newsletter.view",
  "newsletter-participants.update",
  "newsletter-settings.update",
  "settings.update",
] as const satisfies readonly (keyof BaileysEventMap)[];

const REQUIRED_AUTH_CREDENTIAL_FIELDS = [
  "noiseKey",
  "signedIdentityKey",
  "signedPreKey",
  "registrationId",
  "pairingEphemeralKeyPair",
  "advSecretKey",
  "registered",
  "pairingCode",
] as const satisfies readonly (keyof AuthenticationCreds)[];

const REQUIRED_SIGNAL_DATA_TYPES = [
  "pre-key",
  "session",
  "sender-key",
  "sender-key-memory",
  "app-state-sync-key",
  "app-state-sync-version",
  "lid-mapping",
  "device-list",
  "tctoken",
  "identity-key",
] as const satisfies readonly (keyof SignalDataTypeMap)[];

const REQUIRED_GROUP_METADATA_FIELDS = [
  "id",
  "subject",
  "participants",
] as const satisfies readonly (keyof GroupMetadata)[];

const REQUIRED_MESSAGE_FIELDS = ["key"] as const satisfies readonly (keyof WAMessage)[];
const MESSAGE_CONTENT_WITNESS = { text: "stage0" } satisfies AnyMessageContent;

export function createBaileysStage0Capabilities(): BaileysStage0Capabilities {
  for (const exportName of REQUIRED_RUNTIME_EXPORTS) {
    if (!(exportName in baileys)) {
      throw new Error(`Required Baileys public export is missing: ${exportName}`);
    }
  }

  const encodedNode = baileys.encodeBinaryNode({ tag: "stage0", attrs: {} });
  if (!Buffer.isBuffer(encodedNode) || encodedNode.byteLength === 0) {
    throw new Error("Baileys public encodeBinaryNode returned an empty non-Buffer result");
  }

  return {
    api: {
      packageName: "baileys",
      packageVersion: "7.0.0-rc14",
      packageGitHead: "7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a",
      runtimeExports: [...REQUIRED_RUNTIME_EXPORTS],
      socketMethods: [...REQUIRED_SOCKET_METHODS],
      eventKeys: [...REQUIRED_EVENT_KEYS],
      authCredentialFields: [...REQUIRED_AUTH_CREDENTIAL_FIELDS],
      signalDataTypes: [...REQUIRED_SIGNAL_DATA_TYPES],
      groupMetadataFields: [...REQUIRED_GROUP_METADATA_FIELDS],
      messageFields: [...REQUIRED_MESSAGE_FIELDS],
      messageContentKinds: Object.keys(MESSAGE_CONTENT_WITNESS),
    },
    bridge: {
      packageName: "whatsapp-rust-bridge",
      packageVersion: "0.5.4",
      assetMode: "embedded-base64-wasm",
      encodedNodeByteLength: encodedNode.byteLength,
      encodedNodeHexPrefix: encodedNode.subarray(0, 12).toString("hex"),
    },
    safety: {
      socketCreated: false,
      authStateCreated: false,
      credentialsRead: false,
      qrGenerated: false,
      networkAttempted: false,
    },
  };
}
