import type {
  RuntimeExtensionCatalogEntry,
  RuntimeExtensionContractConflict,
} from "@marshal/runtime/extensions";

export interface RuntimeExtensionDetails {
  health?: string;
  blockReason?: string;
  missingDependencies: readonly string[];
  disabledDependencies: readonly string[];
  dependencies: readonly string[];
  providedServices: readonly string[];
  requiredServices: readonly string[];
  canonicalContracts: readonly string[];
  selectedProvider?: string;
  selectedProviderServiceId?: string;
  providerSelections: readonly {
    serviceId: string;
    selectedProvider?: string;
    override?: string;
    alternatives: readonly string[];
    collision?: boolean;
  }[];
  alternativeProviders: readonly {
    providerId: string;
    serviceId: string;
    contractId: string;
  }[];
  collisions: readonly string[];
  configSchema?: unknown;
  configValues: Readonly<Record<string, unknown>>;
  docs: readonly string[];
  resources: readonly string[];
  examples: readonly string[];
  appServicesSnippet?: string;
  contractConflicts: readonly RuntimeExtensionContractConflict[];
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol") return value.description ?? "Symbol";
  if (typeof value === "function") return value.name ? `[function ${value.name}]` : "[function]";
  const serialized = JSON.stringify(value);
  return serialized ?? "undefined";
}

function displayValues(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return value === undefined ? [] : [displayValue(value)];
  return value.map(displayValue);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return isUnknownRecord(value) ? value : {};
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function getRuntimeExtensionDetails(
  entry: RuntimeExtensionCatalogEntry,
): RuntimeExtensionDetails {
  const providerSelections = entry.providerSelections ?? [];
  const alternativeProviders = providerSelections.flatMap((selection) =>
    selection.alternatives.map((providerId) => ({
      providerId,
      serviceId: selection.service,
      contractId: selection.service,
    })),
  );
  const selectedSelection = providerSelections.find(
    (selection) => selection.selected !== undefined || selection.override !== undefined,
  );
  const collisions = providerSelections
    .filter((selection) => selection.collision)
    .map((selection) => selection.service);
  const blockReason = entry.blockReasons
    ?.map((reason) => reason.message)
    .filter(Boolean)
    .join(" ");

  return {
    health: entry.health,
    blockReason: blockReason || undefined,
    missingDependencies: (entry.blockReasons ?? []).flatMap((reason) => {
      const dependency = reason.dependency ?? reason.service;
      return (reason.code === "MISSING_DEPENDENCY" ||
        reason.code === "MISSING_SERVICE_DEPENDENCY") &&
        dependency
        ? [dependency]
        : [];
    }),
    disabledDependencies: (entry.blockReasons ?? []).flatMap((reason) =>
      reason.code === "DISABLED_DEPENDENCY" && reason.dependency ? [reason.dependency] : [],
    ),
    dependencies: displayValues(entry.dependencies),
    providedServices: displayValues(entry.providedServices),
    requiredServices: displayValues(entry.requiredServices),
    canonicalContracts: displayValues(entry.contracts),
    selectedProvider: selectedSelection?.override ?? selectedSelection?.selected,
    selectedProviderServiceId: selectedSelection?.service,
    providerSelections: providerSelections.map((selection) => ({
      serviceId: selection.service,
      selectedProvider: selection.selected,
      override: selection.override,
      alternatives: selection.alternatives,
      collision: selection.collision,
    })),
    alternativeProviders,
    collisions,
    configSchema: entry.configurationSchema,
    configValues: record(entry.configurationValues),
    docs: displayValues(entry.docs),
    resources: displayValues(entry.resources),
    examples: displayValues(entry.examples),
    appServicesSnippet: entry.appServicesSnippet,
    contractConflicts: entry.contractConflicts ?? [],
  };
}

export function appServicesSnippet(details: RuntimeExtensionDetails): string | undefined {
  return details.appServicesSnippet;
}
