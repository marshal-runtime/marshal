import type { RuntimeInteractiveAuthMethod } from "./runtime-auth";

export const MARSHAL_CLOUD_RUNTIME_ID = "marshal-cloud";
export const COPILOT_RUNTIME_ID = "copilot";
export const GATEWAY_RUNTIME_ID = "gateway";
export const CLAUDE_RUNTIME_ID = "claude";
export const CODEX_RUNTIME_ID = "codex";
export const CURSOR_RUNTIME_ID = "cursor";
export const DEFAULT_RUNTIME_ID = CLAUDE_RUNTIME_ID;
export const CLAUDE_AUTH_SETUP_INSTRUCTIONS =
  "Sign in with your Claude subscription in the browser, use an Anthropic API key (ANTHROPIC_API_KEY), or configure supported cloud-provider credentials.";
export const CLAUDE_BROWSER_SIGN_IN_LABEL = "Sign in with Claude";
export const COPILOT_GITHUB_SIGN_IN_LABEL = "Sign in to GitHub";
export const CODEX_BROWSER_SIGN_IN_LABEL = "Sign in with ChatGPT";
export const CURSOR_BROWSER_SIGN_IN_LABEL = "Sign in with Cursor";
export const CURSOR_API_KEY_SIGN_IN_LABEL = "Use existing API key";
export const USE_ANOTHER_RUNTIME_LABEL = "Use another runtime";
export const FIRST_RUN_BROWSER_RUNTIME_CHOICES = [
  { runtimeId: CODEX_RUNTIME_ID, label: CODEX_BROWSER_SIGN_IN_LABEL },
  { runtimeId: CURSOR_RUNTIME_ID, label: CURSOR_BROWSER_SIGN_IN_LABEL },
] as const;
export const CURSOR_API_KEYS_URL = "https://cursor.com/dashboard/api";
export const CURSOR_AUTH_SETUP_INSTRUCTIONS =
  "Sign in with Cursor in the browser, or paste an existing user API key from " +
  `${CURSOR_API_KEYS_URL}. Team Admin keys are not supported.`;

export const BUILTIN_RUNTIME_IDS = [
  COPILOT_RUNTIME_ID,
  GATEWAY_RUNTIME_ID,
  CLAUDE_RUNTIME_ID,
  CODEX_RUNTIME_ID,
  CURSOR_RUNTIME_ID,
  MARSHAL_CLOUD_RUNTIME_ID,
] as const;
export type BuiltinRuntimeId = (typeof BUILTIN_RUNTIME_IDS)[number];

const LIVE_SWITCHABLE_RUNTIME_IDS = new Set<string>([
  COPILOT_RUNTIME_ID,
  CLAUDE_RUNTIME_ID,
  CODEX_RUNTIME_ID,
  CURSOR_RUNTIME_ID,
]);

export type RuntimeCompatibilityOrigin = "copilot" | "gateway";
export type RuntimeRendererRoot = "copilot" | "gateway" | "local";
export type RuntimeAuthSurface = "copilot" | "gateway" | "runtime";

export interface RuntimeAuthMethodMetadata {
  type: RuntimeInteractiveAuthMethod;
  label: string;
}

export interface RuntimeMetadata {
  id: string;
  displayName: string;
  compatibilityOrigin: RuntimeCompatibilityOrigin;
  rendererRoot: RuntimeRendererRoot;
  selectable: boolean;
  /**
   * The adapter can make Marshal's assembled prompt the model's whole system
   * prompt (`systemMessage.mode: "replace"`), so the staged prompt-replacement
   * experiment applies to it. Adapters that cannot (Copilot, Gateway, Cursor)
   * keep their legacy or append-only delivery.
   */
  supportsNativePromptReplacement?: boolean;
  auth: {
    surface: RuntimeAuthSurface;
    methods: readonly RuntimeAuthMethodMetadata[];
    setupInstructions?: string;
    verificationFailureInstructions?: string;
    signOut?: {
      title: string;
      description: string;
      confirmLabel: string;
    };
  };
}

const BUILTIN_RUNTIME_METADATA_BY_ID = {
  [MARSHAL_CLOUD_RUNTIME_ID]: {
    id: MARSHAL_CLOUD_RUNTIME_ID, displayName: "Marshal Cloud", compatibilityOrigin: "copilot",
    rendererRoot: "local", selectable: true,
    auth: { surface: "runtime", methods: [], setupInstructions: "Configure the standalone cloud service URL and token file, then restart Marshal." },
  },
  [COPILOT_RUNTIME_ID]: {
    id: COPILOT_RUNTIME_ID,
    displayName: "Copilot",
    compatibilityOrigin: "copilot",
    rendererRoot: "copilot",
    selectable: true,
    auth: {
      surface: "copilot",
      methods: [],
      verificationFailureInstructions: "Run 'copilot login' from the terminal, then try again.",
    },
  },
  [GATEWAY_RUNTIME_ID]: {
    id: GATEWAY_RUNTIME_ID,
    displayName: "Gateway",
    compatibilityOrigin: "gateway",
    rendererRoot: "gateway",
    selectable: true,
    auth: {
      surface: "gateway",
      methods: [],
    },
  },
  [CLAUDE_RUNTIME_ID]: {
    id: CLAUDE_RUNTIME_ID,
    displayName: "Claude Agent",
    compatibilityOrigin: "copilot",
    rendererRoot: "local",
    selectable: true,
    supportsNativePromptReplacement: true,
    auth: {
      surface: "runtime",
      methods: [
        { type: "browser", label: CLAUDE_BROWSER_SIGN_IN_LABEL },
        { type: "api-key", label: "Use API key" },
      ],
      setupInstructions: CLAUDE_AUTH_SETUP_INSTRUCTIONS,
      signOut: {
        title: "Sign out of Claude Agent?",
        description:
          "Signing out removes Claude credentials stored by Marshal. Credentials from the launch environment may be applied again after you restart Marshal.",
        confirmLabel: "Sign out",
      },
    },
  },
  [CODEX_RUNTIME_ID]: {
    id: CODEX_RUNTIME_ID,
    displayName: "Codex",
    compatibilityOrigin: "copilot",
    rendererRoot: "local",
    selectable: true,
    supportsNativePromptReplacement: true,
    auth: {
      surface: "runtime",
      methods: [
        { type: "browser", label: CODEX_BROWSER_SIGN_IN_LABEL },
        { type: "device-code", label: "Use device code" },
        { type: "api-key", label: "Use API key" },
      ],
      verificationFailureInstructions: "Try another Codex sign-in method.",
      signOut: {
        title: "Sign out of Codex?",
        description: "Signing out disconnects Codex. You can sign in again with another method.",
        confirmLabel: "Sign out",
      },
    },
  },
  [CURSOR_RUNTIME_ID]: {
    id: CURSOR_RUNTIME_ID,
    displayName: "Cursor",
    compatibilityOrigin: "copilot",
    rendererRoot: "local",
    selectable: true,
    auth: {
      surface: "runtime",
      methods: [
        { type: "browser", label: CURSOR_BROWSER_SIGN_IN_LABEL },
        { type: "api-key", label: CURSOR_API_KEY_SIGN_IN_LABEL },
      ],
      setupInstructions: CURSOR_AUTH_SETUP_INSTRUCTIONS,
      verificationFailureInstructions:
        "Sign in with Cursor or paste a user API key, then try again.",
      signOut: {
        title: "Sign out of Cursor?",
        description:
          "Signing out removes the Cursor API key stored by Marshal. You can sign in or paste a key again.",
        confirmLabel: "Sign out",
      },
    },
  },
} as const satisfies Record<BuiltinRuntimeId, RuntimeMetadata>;

export const BUILTIN_RUNTIME_METADATA: readonly RuntimeMetadata[] = BUILTIN_RUNTIME_IDS.map(
  (id) => BUILTIN_RUNTIME_METADATA_BY_ID[id],
);

export function normalizeRuntimeId(value: string | undefined): string {
  return value?.trim() || DEFAULT_RUNTIME_ID;
}

export function isBuiltinRuntimeId(value: string): value is BuiltinRuntimeId {
  return Object.hasOwn(BUILTIN_RUNTIME_METADATA_BY_ID, value);
}

export function getRuntimeMetadata(runtimeId: string | undefined): RuntimeMetadata {
  const id = normalizeRuntimeId(runtimeId);
  if (isBuiltinRuntimeId(id)) return BUILTIN_RUNTIME_METADATA_BY_ID[id];
  return {
    id,
    displayName: id,
    compatibilityOrigin: "copilot",
    rendererRoot: "local",
    selectable: false,
    auth: {
      surface: "runtime",
      methods: [],
      setupInstructions: `Configure credentials for ${id} outside Marshal, then restart Marshal.`,
      verificationFailureInstructions: `Try signing in to ${id} again.`,
      signOut: {
        title: `Sign out of ${id}?`,
        description: `Signing out disconnects ${id}.`,
        confirmLabel: "Sign out",
      },
    },
  };
}

export function getRuntimeDisplayName(runtimeId: string | undefined): string {
  return getRuntimeMetadata(runtimeId).displayName;
}

export function canSwitchRuntimeLive(
  currentRuntimeId: string | undefined,
  targetRuntimeId: string | undefined,
): boolean {
  return (
    LIVE_SWITCHABLE_RUNTIME_IDS.has(normalizeRuntimeId(currentRuntimeId)) &&
    LIVE_SWITCHABLE_RUNTIME_IDS.has(normalizeRuntimeId(targetRuntimeId))
  );
}

export function getRuntimeSelectionMetadata(
  selectedRuntimeId: string | undefined,
): readonly RuntimeMetadata[] {
  const selected = getRuntimeMetadata(selectedRuntimeId);
  return isBuiltinRuntimeId(selected.id)
    ? BUILTIN_RUNTIME_METADATA
    : [...BUILTIN_RUNTIME_METADATA, selected];
}

export function resolveSessionRuntimeId(session: {
  runtimeId?: string;
  backendOrigin?: "copilot" | "gateway";
}): string {
  const runtimeId = session.runtimeId?.trim();
  if (runtimeId) return runtimeId;
  return session.backendOrigin ?? DEFAULT_RUNTIME_ID;
}

/** Cursor SDK has no speech-to-text API; flip this when the SDK adds transcription. */
export const CURSOR_SDK_SUPPORTS_TRANSCRIPTION = false;

/** Returns true when compose-bar voice transcription can run for this chat runtime. */
export function isVoiceTranscriptionAvailable(
  runtimeId: string | undefined,
  cursorSdkSupportsTranscription = CURSOR_SDK_SUPPORTS_TRANSCRIPTION,
): boolean {
  return runtimeId === CURSOR_RUNTIME_ID && cursorSdkSupportsTranscription;
}
