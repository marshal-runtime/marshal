import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import type {
  RelayAttachmentMetadata,
  RelayAttachmentIngestionRequest,
  RelayIngestedAttachment,
  RelayVoiceTranscript,
  RelayVoiceTranscriptionRequest,
} from "../../common/relay-experience-contract";
import { secureMkdir, secureWriteFile } from "../platform-security";
import { transcribeAudio } from "../transcribe/transcribe";

const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const TRANSCRIPTION_TIMEOUT_MS = 120_000;
const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const AUDIO_MIME_TYPES = new Set([
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
]);

export interface RelayHostMediaAdapter {
  ingest(request: RelayAttachmentIngestionRequest): Promise<RelayIngestedAttachment>;
  restore(attachment: RelayStoredAttachment): Promise<RelayIngestedAttachment>;
  transcribe(request: RelayVoiceTranscriptionRequest): Promise<RelayVoiceTranscript>;
  release(attachment: RelayIngestedAttachment): Promise<void>;
}

export interface RelayStoredAttachment {
  readonly metadata: RelayAttachmentMetadata;
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly ingestedAt: string;
}

export interface RelayHostMediaAdapterOptions {
  readonly rootDir: string;
  readonly transcribe?: typeof transcribeAudio;
}

export function createDefaultRelayHostMediaAdapter(
  options: RelayHostMediaAdapterOptions,
): RelayHostMediaAdapter {
  const rootDir = path.resolve(options.rootDir);
  const transcribe = options.transcribe ?? transcribeAudio;
  const ingestions = new Map<string, Promise<RelayIngestedAttachment>>();

  return {
    ingest: (request) => {
      const pending = ingestions.get(request.idempotencyKey);
      if (pending) return pending;
      const operation = ingestAttachment(rootDir, request);
      ingestions.set(request.idempotencyKey, operation);
      const cleanup = () => {
        if (ingestions.get(request.idempotencyKey) === operation) {
          ingestions.delete(request.idempotencyKey);
        }
      };
      void operation.then(cleanup, cleanup);
      return operation;
    },
    restore: async (attachment) => restoreAttachment(rootDir, attachment),
    transcribe: async (request) => transcribeAttachment(request, transcribe),
    release: async (attachment) => {
      const directory = path.dirname(path.resolve(attachment.localPath));
      if (!isWithin(directory, rootDir)) {
        throw new Error("Relay attachment cleanup path escapes the media root");
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function ingestAttachment(
  rootDir: string,
  request: RelayAttachmentIngestionRequest,
): Promise<RelayIngestedAttachment> {
  if (request.source.kind !== "local-file" || !path.isAbsolute(request.source.path)) {
    throw new Error("Relay attachment source must be an absolute local file");
  }
  const mimeType = normalizeMimeType(request.attachment.mimeType);
  const maxBytes = maxBytesFor(request.attachment.kind, mimeType);
  const sourceStat = await stat(request.source.path);
  if (!sourceStat.isFile() || sourceStat.size === 0 || sourceStat.size > maxBytes) {
    throw new Error("Relay attachment source has an invalid size");
  }
  if (
    request.attachment.sizeBytes !== undefined &&
    request.attachment.sizeBytes !== sourceStat.size
  ) {
    throw new Error("Relay attachment size does not match its descriptor");
  }

  const bytes = await readFile(request.source.path);
  if (bytes.byteLength !== sourceStat.size || bytes.byteLength > maxBytes) {
    bytes.fill(0);
    throw new Error("Relay attachment source changed during ingestion");
  }
  const directoryId = createHash("sha256").update(request.idempotencyKey).digest("hex");
  const fileName = safeFileName(request.attachment.fileName, request.attachment.kind);
  const storageFileName = storedFileName(fileName);
  const storageKey = `${directoryId}/${storageFileName}`;
  const directory = path.join(rootDir, directoryId);
  const localPath = path.join(directory, storageFileName);
  let createdFile = false;
  try {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (request.attachment.sha256 && request.attachment.sha256 !== sha256) {
      throw new Error("Relay attachment digest does not match its descriptor");
    }
    await secureMkdir(directory, 0o700);
    try {
      await secureWriteFile(localPath, bytes, { flag: "wx", mode: 0o600 });
      createdFile = true;
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
      return await restoreAttachment(rootDir, {
        metadata: {
          ...request.attachment,
          mimeType,
          sizeBytes: bytes.byteLength,
          sha256,
        },
        storageKey,
        sizeBytes: bytes.byteLength,
        sha256,
        ingestedAt: new Date().toISOString(),
      });
    }
    return {
      metadata: {
        ...request.attachment,
        mimeType,
        sizeBytes: bytes.byteLength,
        sha256,
      },
      localPath,
      storageKey,
      sizeBytes: bytes.byteLength,
      sha256,
      ingestedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (createdFile) await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    bytes.fill(0);
  }
}

async function restoreAttachment(
  rootDir: string,
  attachment: RelayStoredAttachment,
): Promise<RelayIngestedAttachment> {
  const match = /^([a-f0-9]{64})\/([^/\\]{1,120})$/.exec(attachment.storageKey);
  if (!match) throw new Error("Relay attachment storage key is invalid");
  const localPath = path.join(rootDir, match[1], match[2]);
  if (!isWithin(localPath, rootDir)) {
    throw new Error("Relay attachment storage key escapes the media root");
  }
  const sourceStat = await stat(localPath);
  if (!sourceStat.isFile() || sourceStat.size !== attachment.sizeBytes) {
    throw new Error("Stored relay attachment has an invalid size");
  }
  const bytes = await readFile(localPath);
  try {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== attachment.sha256) {
      throw new Error("Stored relay attachment digest does not match");
    }
    return {
      metadata: attachment.metadata,
      localPath,
      storageKey: attachment.storageKey,
      sizeBytes: sourceStat.size,
      sha256,
      ingestedAt: attachment.ingestedAt,
    };
  } finally {
    bytes.fill(0);
  }
}

async function transcribeAttachment(
  request: RelayVoiceTranscriptionRequest,
  transcribe: typeof transcribeAudio,
): Promise<RelayVoiceTranscript> {
  if (request.attachment.metadata.kind !== "audio") {
    throw new Error("Relay voice transcription requires an audio attachment");
  }
  const bytes = await readFile(request.attachment.localPath);
  try {
    const transcriptionAbort = new AbortController();
    const text = await withTimeout(
      transcribe(new Uint8Array(bytes), {
        mimeType: request.attachment.metadata.mimeType,
        ...(request.languageHint ? { locales: [request.languageHint] } : {}),
        signal: transcriptionAbort.signal,
      }),
      TRANSCRIPTION_TIMEOUT_MS,
      "Relay voice transcription",
      () => transcriptionAbort.abort(),
    );
    return {
      address: request.attachment.metadata.address,
      providerMessageId: request.attachment.metadata.providerMessageId,
      attachmentId: request.attachment.metadata.attachmentId,
      text,
      ...(request.languageHint ? { language: request.languageHint } : {}),
      ...(request.attachment.metadata.voice?.durationMs === undefined
        ? {}
        : { durationMs: request.attachment.metadata.voice.durationMs }),
      transcribedAt: new Date().toISOString(),
    };
  } finally {
    bytes.fill(0);
  }
}

function maxBytesFor(kind: string, mimeType: string): number {
  if (kind === "image" && IMAGE_MIME_TYPES.has(mimeType)) return MAX_IMAGE_BYTES;
  if (kind === "audio" && AUDIO_MIME_TYPES.has(mimeType)) return MAX_AUDIO_BYTES;
  throw new Error("Relay attachment MIME type is unsupported");
}

function normalizeMimeType(value: string): string {
  return (value.split(";")[0] ?? "").trim().toLowerCase();
}

function safeFileName(value: string | undefined, kind: string): string {
  const fallback = kind === "image" ? "image" : "voice";
  const base = stripControlCharacters(
    path.basename(value?.trim() || fallback).replace(/[<>:"/\\|?*]/g, "_"),
  );
  const normalized = base === "." || base === ".." ? fallback : base;
  return (normalized || fallback).slice(0, 120);
}

function stripControlCharacters(value: string): string {
  let sanitized = "";
  for (const character of value) {
    sanitized += character.charCodeAt(0) < 0x20 ? "_" : character;
  }
  return sanitized;
}

function storedFileName(displayName: string): string {
  const extension = path.extname(displayName).toLowerCase();
  return /^[.][a-z0-9]{1,10}$/.test(extension) ? `payload${extension}` : "payload";
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    Reflect.get(error, "code") === code
  );
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`${label} timed out`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
