const SEALED_PREFIX = "marshal-secret:v1:";
const MAX_NAMESPACE_BYTES = 160;
const MAX_PLAINTEXT_BYTES = 64 * 1024;
const MAX_CIPHERTEXT_BYTES = 128 * 1024;
const MAX_ENVELOPE_BYTES = 96 * 1024;
const SECURE_LINUX_BACKENDS = new Set(["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]);

export interface RuntimeExtensionSecrets {
  isAvailable(): boolean;
  seal(request: { readonly namespace: string; readonly plaintext: string }): string;
  open(request: { readonly namespace: string; readonly sealed: string }): string;
}

export interface RuntimeExtensionSecretEncryption {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

const ERROR_MESSAGES = {
  unavailable: "OS-backed extension secret storage is unavailable.",
  invalid_request: "Invalid extension secret storage request.",
  encryption_failed: "Extension secret encryption failed.",
  invalid_sealed_value: "The extension secret could not be opened.",
} as const;

export class RuntimeExtensionSecretsError extends Error {
  constructor(readonly code: keyof typeof ERROR_MESSAGES) {
    super(ERROR_MESSAGES[code]);
    this.name = "RuntimeExtensionSecretsError";
  }
}

function exactRecord(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function validNamespace(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_NAMESPACE_BYTES &&
    /^[a-zA-Z0-9@][a-zA-Z0-9._:/@-]*$/.test(value)
  );
}

function plaintextBytes(value: unknown): Buffer | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PLAINTEXT_BYTES) {
    return null;
  }
  const bytes = Buffer.from(value, "utf8");
  return bytes.length <= MAX_PLAINTEXT_BYTES && bytes.toString("utf8") === value ? bytes : null;
}

function decodeBase64(value: unknown, maxBytes: number): Buffer | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil(maxBytes / 3) * 4 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return null;
  }
  const bytes = Buffer.from(value, "base64");
  return bytes.length > 0 && bytes.length <= maxBytes && bytes.toString("base64") === value
    ? bytes
    : null;
}

/** Trusted backend convenience; namespaces do not authenticate or isolate native extensions. */
export function createRuntimeExtensionSecrets(options: {
  readonly isReady: () => boolean;
  readonly encryption: RuntimeExtensionSecretEncryption;
  readonly platform?: NodeJS.Platform;
}): RuntimeExtensionSecrets {
  const platform = options.platform ?? process.platform;
  const isAvailable = (): boolean => {
    try {
      if (!options.isReady() || !options.encryption.isEncryptionAvailable()) return false;
      return (
        platform !== "linux" ||
        SECURE_LINUX_BACKENDS.has(options.encryption.getSelectedStorageBackend?.() ?? "")
      );
    } catch {
      return false;
    }
  };
  const requireAvailable = (): void => {
    if (!isAvailable()) throw new RuntimeExtensionSecretsError("unavailable");
  };
  return Object.freeze<RuntimeExtensionSecrets>({
    isAvailable,
    seal(request): string {
      if (!exactRecord(request, ["namespace", "plaintext"]) || !validNamespace(request.namespace)) {
        throw new RuntimeExtensionSecretsError("invalid_request");
      }
      const bytes = plaintextBytes(request.plaintext);
      if (!bytes) throw new RuntimeExtensionSecretsError("invalid_request");
      requireAvailable();
      const envelope = JSON.stringify({
        version: 1,
        namespace: request.namespace,
        encoded: bytes.toString("base64"),
      });
      let ciphertext: Buffer;
      try {
        ciphertext = options.encryption.encryptString(envelope);
      } catch {
        throw new RuntimeExtensionSecretsError("encryption_failed");
      }
      if (
        !Buffer.isBuffer(ciphertext) ||
        ciphertext.length === 0 ||
        ciphertext.length > MAX_CIPHERTEXT_BYTES
      ) {
        throw new RuntimeExtensionSecretsError("encryption_failed");
      }
      return SEALED_PREFIX + ciphertext.toString("base64");
    },
    open(request): string {
      if (
        !exactRecord(request, ["namespace", "sealed"]) ||
        !validNamespace(request.namespace) ||
        typeof request.sealed !== "string"
      ) {
        throw new RuntimeExtensionSecretsError("invalid_request");
      }
      const ciphertext = request.sealed.startsWith(SEALED_PREFIX)
        ? decodeBase64(request.sealed.slice(SEALED_PREFIX.length), MAX_CIPHERTEXT_BYTES)
        : null;
      if (!ciphertext) throw new RuntimeExtensionSecretsError("invalid_sealed_value");
      requireAvailable();
      let envelope: unknown;
      try {
        const decrypted = options.encryption.decryptString(ciphertext);
        if (
          typeof decrypted !== "string" ||
          decrypted.length > MAX_ENVELOPE_BYTES ||
          Buffer.byteLength(decrypted, "utf8") > MAX_ENVELOPE_BYTES
        ) {
          throw new Error();
        }
        envelope = JSON.parse(decrypted) as unknown;
      } catch {
        throw new RuntimeExtensionSecretsError("invalid_sealed_value");
      }
      if (
        !exactRecord(envelope, ["version", "namespace", "encoded"]) ||
        envelope.version !== 1 ||
        envelope.namespace !== request.namespace
      ) {
        throw new RuntimeExtensionSecretsError("invalid_sealed_value");
      }
      const decoded = decodeBase64(envelope.encoded, MAX_PLAINTEXT_BYTES);
      const plaintext = decoded?.toString("utf8");
      if (!decoded || !plaintext || !plaintextBytes(plaintext)?.equals(decoded)) {
        throw new RuntimeExtensionSecretsError("invalid_sealed_value");
      }
      return plaintext;
    },
  });
}
