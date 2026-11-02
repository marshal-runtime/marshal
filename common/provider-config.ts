export const LOCAL_MEMORY_PROVIDER_ID = "local";
export const BRAIN_MEMORY_PROVIDER_ID = "@marshal/brain";
export const DEFAULT_MEMORY_PROVIDER_ID = BRAIN_MEMORY_PROVIDER_ID;

export const LOCAL_SESSION_STORAGE_PROVIDER_ID = "local";
export const DEFAULT_SESSION_STORAGE_PROVIDER_ID = LOCAL_SESSION_STORAGE_PROVIDER_ID;

export const OPENAI_TRANSCRIPTION_PROVIDER_ID = "openai";
export const DEFAULT_TRANSCRIPTION_PROVIDER_ID = OPENAI_TRANSCRIPTION_PROVIDER_ID;

export const APP_BUNDLED_SKILL_PROVIDER_ID = "app-bundled";
export const USER_GLOBAL_SKILL_PROVIDER_ID = "user-global";
export const WORKSPACE_LOCAL_SKILL_PROVIDER_ID = "workspace-local";
export const RUNTIME_ADAPTER_SKILL_PROVIDER_ID = "runtime-adapter";
export const DEFAULT_SKILL_PROVIDER_IDS = [
  RUNTIME_ADAPTER_SKILL_PROVIDER_ID,
  WORKSPACE_LOCAL_SKILL_PROVIDER_ID,
  USER_GLOBAL_SKILL_PROVIDER_ID,
  APP_BUNDLED_SKILL_PROVIDER_ID,
] as const;

export const NO_WORK_SERVICE_PROVIDER_ID = "none";

export const MARSHAL_RELAY_WORK_SERVICE_PROVIDER_ID = "marshal-relay";
/** Persisted value written before the notification work service became relay-neutral. */
const LEGACY_TEAMS_RELAY_WORK_SERVICE_PROVIDER_ID = "microsoft-teams-relay";

export const WHATSAPP_RELAY_PROVIDER_ID = "whatsapp";
export const DEFAULT_RELAY_PROGRESS_INTERVAL_MINUTES = 15;
export const MIN_RELAY_PROGRESS_INTERVAL_MINUTES = 1;
export const MAX_RELAY_PROGRESS_INTERVAL_MINUTES = 24 * 60;

export type RelayConnectionIntent = "connect" | "disconnect";

export interface RelayProviderConfig {
  enabled: boolean;
  /** App-owned account key, never a provider address, conversation ID, or credential. */
  accountId?: string;
  connectionIntent: RelayConnectionIntent;
}

export interface RelaySettings {
  providers: Record<string, RelayProviderConfig>;
  /** Provider IDs that receive proactive/default notifications. */
  defaultNotificationDestinations: string[];
  /** Provider IDs that receive periodic progress updates. */
  progressDestinations: string[];
  /** Cadence for asking active session owners to consider a deliberate relay update. */
  progressIntervalMinutes: number;
}

export interface RelaySettingsCarrier {
  relay?: RelaySettings;
}

export interface LegacyRelayMigrationInput {
  whatsappEnabled?: unknown;
  whatsappDefaultNotificationsEnabled?: unknown;
  whatsappProgressNotificationsEnabled?: unknown;
}

const RELAY_PROVIDER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/;
const RELAY_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;

export function createDefaultRelaySettings(): RelaySettings {
  return {
    providers: {
      [WHATSAPP_RELAY_PROVIDER_ID]: {
        enabled: true,
        connectionIntent: "disconnect",
      },
    },
    defaultNotificationDestinations: [],
    progressDestinations: [WHATSAPP_RELAY_PROVIDER_ID],
    progressIntervalMinutes: DEFAULT_RELAY_PROGRESS_INTERVAL_MINUTES,
  };
}

export function isRelayProviderId(value: unknown): value is string {
  return typeof value === "string" && RELAY_PROVIDER_ID_PATTERN.test(value);
}

export function isRelayAccountId(value: unknown): value is string {
  return typeof value === "string" && RELAY_ACCOUNT_ID_PATTERN.test(value);
}

export function isRelayConnectionIntent(value: unknown): value is RelayConnectionIntent {
  return value === "connect" || value === "disconnect";
}

export function normalizeRelayProgressIntervalMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_RELAY_PROGRESS_INTERVAL_MINUTES;
  }
  return Math.min(
    MAX_RELAY_PROGRESS_INTERVAL_MINUTES,
    Math.max(MIN_RELAY_PROGRESS_INTERVAL_MINUTES, Math.floor(value)),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function normalizeRelayProviderConfig(value: unknown): RelayProviderConfig | undefined {
  if (!isRecord(value)) return undefined;

  const accountId = isRelayAccountId(value.accountId) ? value.accountId : undefined;
  const hasEnabled = typeof value.enabled === "boolean";
  const connectionIntent = isRelayConnectionIntent(value.connectionIntent)
    ? value.connectionIntent
    : undefined;
  if (!hasEnabled && connectionIntent === undefined && accountId === undefined) return undefined;

  return {
    enabled: hasEnabled ? value.enabled === true : false,
    ...(accountId ? { accountId } : {}),
    connectionIntent: connectionIntent ?? "disconnect",
  };
}

function normalizeRelayDestinations(
  value: unknown,
  providers: Readonly<Record<string, RelayProviderConfig>>,
  fallback: readonly string[],
): string[] {
  const candidates = Array.isArray(value) ? value : fallback;
  return [
    ...new Set(
      candidates.filter(
        (providerId): providerId is string =>
          isRelayProviderId(providerId) && (providers[providerId]?.enabled ?? false),
      ),
    ),
  ];
}

function setDestination(
  destinations: readonly string[],
  providerId: string,
  enabled: boolean,
): string[] {
  if (enabled) {
    return destinations.includes(providerId) ? [...destinations] : [...destinations, providerId];
  }
  return destinations.filter((candidate) => candidate !== providerId);
}

export function normalizeRelaySettings(
  value: unknown,
  legacy: LegacyRelayMigrationInput = {},
): RelaySettings {
  const defaults = createDefaultRelaySettings();
  const source = isRecord(value) ? value : undefined;
  const hasCanonicalDefaultDestinations =
    source !== undefined && hasOwn(source, "defaultNotificationDestinations");
  const hasCanonicalProgressDestinations =
    source !== undefined && hasOwn(source, "progressDestinations");
  const providers: Record<string, RelayProviderConfig> = {};

  if (source && isRecord(source.providers)) {
    for (const [providerId, providerValue] of Object.entries(source.providers)) {
      if (!isRelayProviderId(providerId)) continue;
      const provider = normalizeRelayProviderConfig(providerValue);
      if (provider) providers[providerId] = provider;
    }
  }

  if (Object.keys(providers).length === 0) {
    Object.assign(providers, defaults.providers);
  }

  const legacyWhatsAppEnabled =
    typeof legacy.whatsappEnabled === "boolean" ? legacy.whatsappEnabled : undefined;
  if (legacyWhatsAppEnabled !== undefined) {
    providers[WHATSAPP_RELAY_PROVIDER_ID] = {
      ...providers[WHATSAPP_RELAY_PROVIDER_ID],
      enabled: true,
      accountId: providers[WHATSAPP_RELAY_PROVIDER_ID]?.accountId ?? "primary",
      connectionIntent: legacyWhatsAppEnabled ? "connect" : "disconnect",
    };
  }

  let defaultNotificationDestinations = normalizeRelayDestinations(
    hasCanonicalDefaultDestinations ? source.defaultNotificationDestinations : undefined,
    providers,
    defaults.defaultNotificationDestinations,
  );
  let progressDestinations = normalizeRelayDestinations(
    hasCanonicalProgressDestinations ? source.progressDestinations : undefined,
    providers,
    defaults.progressDestinations,
  );

  const whatsappProviderEnabled = providers[WHATSAPP_RELAY_PROVIDER_ID]?.enabled ?? false;
  if (
    !hasCanonicalDefaultDestinations &&
    typeof legacy.whatsappDefaultNotificationsEnabled === "boolean"
  ) {
    defaultNotificationDestinations = setDestination(
      defaultNotificationDestinations,
      WHATSAPP_RELAY_PROVIDER_ID,
      legacy.whatsappDefaultNotificationsEnabled && whatsappProviderEnabled,
    );
  }
  if (
    !hasCanonicalProgressDestinations &&
    typeof legacy.whatsappProgressNotificationsEnabled === "boolean"
  ) {
    progressDestinations = setDestination(
      progressDestinations,
      WHATSAPP_RELAY_PROVIDER_ID,
      legacy.whatsappProgressNotificationsEnabled && whatsappProviderEnabled,
    );
  }

  return {
    providers,
    defaultNotificationDestinations,
    progressDestinations,
    progressIntervalMinutes: normalizeRelayProgressIntervalMinutes(source?.progressIntervalMinutes),
  };
}

export interface WorkServiceProviderIds {
  notificationProviderId?: string;
}

export interface WorkServiceProviderSettings extends WorkServiceProviderIds, RelaySettingsCarrier {}

export const DEFAULT_WORK_SERVICE_PROVIDER_IDS = {
  notificationProviderId: MARSHAL_RELAY_WORK_SERVICE_PROVIDER_ID,
} as const satisfies Required<WorkServiceProviderIds>;

export interface ProviderSelectionSettings extends WorkServiceProviderSettings {
  memoryProviderId?: string;
  sessionStorageProviderId?: string;
  skillProviderIds?: string[];
}

export function normalizeProviderId(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

export function normalizeSkillProviderIds(value: readonly string[] | undefined): string[] {
  const normalized = [...new Set(value?.map((id) => id.trim()).filter(Boolean) ?? [])];
  return normalized.length > 0 ? normalized : [...DEFAULT_SKILL_PROVIDER_IDS];
}

function normalizeNotificationProviderId(value: string | undefined): string {
  const normalized = normalizeProviderId(
    value,
    DEFAULT_WORK_SERVICE_PROVIDER_IDS.notificationProviderId,
  );
  return normalized === LEGACY_TEAMS_RELAY_WORK_SERVICE_PROVIDER_ID
    ? MARSHAL_RELAY_WORK_SERVICE_PROVIDER_ID
    : normalized;
}

export function normalizeWorkServiceProviderSettings<T extends WorkServiceProviderSettings>(
  settings: T,
): T & Required<WorkServiceProviderIds> {
  return {
    ...settings,
    notificationProviderId: normalizeNotificationProviderId(settings.notificationProviderId),
  };
}

export function normalizeProviderSelectionSettings<T extends ProviderSelectionSettings>(
  settings: T,
): T &
  Required<WorkServiceProviderIds> & {
    memoryProviderId: string;
    sessionStorageProviderId: string;
    skillProviderIds: string[];
    relay?: RelaySettings;
  } {
  const normalized = normalizeWorkServiceProviderSettings(settings);
  const relay = settings.relay !== undefined ? normalizeRelaySettings(settings.relay) : undefined;
  return {
    ...normalized,
    memoryProviderId: normalizeProviderId(settings.memoryProviderId, DEFAULT_MEMORY_PROVIDER_ID),
    sessionStorageProviderId: normalizeProviderId(
      settings.sessionStorageProviderId,
      DEFAULT_SESSION_STORAGE_PROVIDER_ID,
    ),
    skillProviderIds: normalizeSkillProviderIds(settings.skillProviderIds),
    ...(relay ? { relay } : {}),
  };
}

export function isWorkServiceProviderDisabled(providerId: string): boolean {
  return providerId === NO_WORK_SERVICE_PROVIDER_ID;
}
