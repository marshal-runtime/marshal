import type {
  RuntimeExtensionProjectedStatusItem,
  RuntimeExtensionProjectedStatus,
  RuntimeExtensionStatusDiagnostic,
  RuntimeExtensionsStatusSnapshot,
} from "@common/marshal-ipc-contract";
import type {
  RuntimeExtensionCatalogEntry,
  RuntimeExtensionContractConflict,
} from "@marshal/runtime/extensions";
import { useState } from "react";

import { Plug } from "@/components/icons";
import { Badge } from "@/components/marshal-ui/badge";
import { Button } from "@/components/marshal-ui/marshal-button";
import { SectionHeader } from "@/components/marshal-ui/section-header";
import { Textarea } from "@/components/marshal-ui/textarea";
import { Card } from "@/components/ui/card";

import { uniqueRuntimeEntries, uniqueDetectedItems } from "./plugin-deduplication";
import { appServicesSnippet, getRuntimeExtensionDetails } from "./runtime-extension-details";

type StatusPresentation = {
  label: string;
  variant: "outline" | "secondary" | "destructive";
};

function projectedStatusPresentation(status: RuntimeExtensionProjectedStatus): StatusPresentation {
  switch (status) {
    case "detected":
      return { label: "Detected", variant: "outline" };
    case "installing":
      return { label: "Installing / building", variant: "secondary" };
    case "installed-enabled":
      return { label: "Installed and enabled", variant: "secondary" };
    case "installed-disabled":
      return { label: "Installed and disabled", variant: "outline" };
    case "invalid":
      return { label: "Invalid", variant: "destructive" };
    case "unbuilt":
      return { label: "Build required", variant: "destructive" };
    case "unreadable":
      return { label: "Failed", variant: "destructive" };
    default:
      throw new Error(`Unsupported Runtime extension status: ${String(status)}`);
  }
}

function catalogStatusPresentation({
  status,
  health,
  blocked,
}: {
  status: RuntimeExtensionProjectedStatus;
  health?: string;
  blocked: boolean;
}): StatusPresentation {
  if (status === "installing") return projectedStatusPresentation(status);
  if (blocked || health === "blocked") return { label: "Blocked", variant: "destructive" };
  return projectedStatusPresentation(status);
}

function packageRootFromEntry(entry: RuntimeExtensionCatalogEntry): string | undefined {
  const request: unknown = entry.request;
  if (request === null || typeof request !== "object" || !("packageRoot" in request)) {
    return undefined;
  }
  return typeof request.packageRoot === "string" ? request.packageRoot : undefined;
}

export function RuntimeExtensionsSection({
  entries,
  status,
  pending,
  onInstall,
  onInstallDetected,
  onUpdate,
  onUpdateFromDirectory,
  onEnable,
  onDisable,
  onRemove,
  onConfigure,
  onChooseProvider,
  onClearProvider,
  onRepairContractConflict,
}: {
  entries: readonly RuntimeExtensionCatalogEntry[];
  status?: RuntimeExtensionsStatusSnapshot;
  pending: boolean;
  onInstall: (entry: RuntimeExtensionCatalogEntry) => void;
  onInstallDetected: (packageRoot: string) => void;
  onUpdate: (entry: RuntimeExtensionCatalogEntry) => void;
  onUpdateFromDirectory: (entry: RuntimeExtensionCatalogEntry) => void;
  onEnable: (entry: RuntimeExtensionCatalogEntry) => void;
  onDisable: (entry: RuntimeExtensionCatalogEntry) => void;
  onRemove: (entry: RuntimeExtensionCatalogEntry) => void;
  onConfigure?: (
    entry: RuntimeExtensionCatalogEntry,
    configuration: Readonly<Record<string, unknown>>,
  ) => void;
  onChooseProvider?: (
    entry: RuntimeExtensionCatalogEntry,
    providerId: string,
    serviceId: string,
  ) => void;
  onClearProvider?: (entry: RuntimeExtensionCatalogEntry, serviceId: string) => void;
  onRepairContractConflict?: (
    entry: RuntimeExtensionCatalogEntry,
    conflict: RuntimeExtensionContractConflict,
  ) => void;
}) {
  const [copiedId, setCopiedId] = useState<string>();
  const [configurationText, setConfigurationText] = useState<Record<string, string>>({});
  const [configurationError, setConfigurationError] = useState<Record<string, string>>({});

  const statusByEntryId = new Map(
    (status?.items ?? []).flatMap((item) =>
      item.catalogEntryId ? [[item.catalogEntryId, item] as const] : [],
    ),
  );
  const uniqueEntries = uniqueRuntimeEntries(entries);
  const detectedOnly = uniqueDetectedItems(status?.items ?? [], entries);

  if (entries.length === 0 && detectedOnly.length === 0) return null;
  return (
    <section className="space-y-2">
      <SectionHeader divider={false}>Runtime Extensions</SectionHeader>
      {status && status.diagnostics.length > 0 && (
        <RuntimeExtensionDiagnostics
          title="Discovery diagnostics"
          diagnostics={status.diagnostics}
        />
      )}
      <div className="grid items-start gap-4">
        {detectedOnly.length > 0 && (
          <details className="rounded-2xl border border-border/60 bg-muted/10 p-4">
            <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
              Discovered candidates ({detectedOnly.length})
            </summary>
            <div className="mt-4 grid items-start gap-4">
              {detectedOnly.map((item) => (
                <DetectedExtensionCard
                  key={item.candidateId}
                  item={item}
                  pending={pending}
                  onInstall={onInstallDetected}
                />
              ))}
            </div>
          </details>
        )}
        {uniqueEntries.map((entry) => {
          const installation = entry.installation;
          const projectedStatus = statusByEntryId.get(entry.id);
          const entryPending = pending || projectedStatus?.status === "installing";
          const details = getRuntimeExtensionDetails(entry);
          const blocked = Boolean(details.blockReason) || details.health === "blocked";
          const lifecycleStatus =
            projectedStatus?.status ??
            (installation
              ? installation.status === "enabled"
                ? "installed-enabled"
                : "installed-disabled"
              : "detected");
          const statusPresentation = catalogStatusPresentation({
            status: lifecycleStatus,
            health: details.health,
            blocked,
          });
          const configurationValues =
            Object.keys(details.configValues).length > 0
              ? details.configValues
              : (installation?.configuration ?? {});
          const configure = installation ? onConfigure : undefined;
          const showConfiguration =
            details.configSchema !== undefined ||
            Object.keys(configurationValues).length > 0 ||
            Boolean(configure);
          const snippet = appServicesSnippet(details);
          const alternativeProviders = details.alternativeProviders.map(
            (provider) => `${provider.providerId} (${provider.serviceId})`,
          );
          const metadataSections = [
            ["Provided services", details.providedServices],
            ["Required services", details.requiredServices],
            ["Canonical contracts", details.canonicalContracts],
            ["Dependencies", details.dependencies],
            ["Missing dependencies", details.missingDependencies],
            ["Disabled dependencies", details.disabledDependencies],
            ["Alternative providers", alternativeProviders],
            ["Provider collisions", details.collisions],
            ["Docs", details.docs],
            ["Resources", details.resources],
            ["Examples", details.examples],
          ] as const;
          return (
            <Card
              key={entry.id}
              className="gap-4 rounded-2xl border border-border/70 bg-card p-5 shadow-none transition-colors hover:border-border-loud/40"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-badge-bg text-brand-badge-text">
                    <Plug className="size-5" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold">{entry.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {entry.originLabel} · v{entry.version}
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap justify-end gap-1">
                  <Badge variant={statusPresentation.variant}>{statusPresentation.label}</Badge>
                  {details.health && details.health !== "blocked" && (
                    <Badge variant="secondary">{details.health}</Badge>
                  )}
                </div>
              </div>
              <p className="text-sm/relaxed text-foreground-secondary">{entry.description}</p>
              {projectedStatus && projectedStatus.diagnostics.length > 0 && (
                <RuntimeExtensionDiagnostics diagnostics={projectedStatus.diagnostics} />
              )}
              {details.blockReason ||
              details.missingDependencies.length ||
              details.disabledDependencies.length ? (
                <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive">
                  {details.blockReason && <div>{details.blockReason}</div>}
                  {details.missingDependencies.length > 0 && (
                    <div>Missing dependencies: {details.missingDependencies.join(", ")}</div>
                  )}
                  {details.disabledDependencies.length > 0 && (
                    <div>Disabled dependencies: {details.disabledDependencies.join(", ")}</div>
                  )}
                </div>
              ) : null}
              <details
                className="group rounded-xl border border-border/60 bg-muted/20 p-3"
                open={
                  blocked ||
                  details.contractConflicts.length > 0 ||
                  Boolean(configurationError[entry.id])
                }
              >
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
                  Details &amp; configuration
                </summary>
                <div className="mt-4 space-y-4">
                  <RuntimeExtensionPackageDetails
                    packageRoot={projectedStatus?.packageRoot ?? packageRootFromEntry(entry)}
                    installation={projectedStatus?.installation}
                  />
                  {metadataSections.some(([, values]) => values.length > 0) && (
                    <div className="grid gap-2 text-xs sm:grid-cols-2">
                      {metadataSections.map(([label, values]) =>
                        values.length > 0 ? (
                          <div key={label}>
                            <div className="font-medium text-foreground">{label}</div>
                            <div className="text-muted-foreground">{values.join(", ")}</div>
                          </div>
                        ) : null,
                      )}
                    </div>
                  )}
                  {details.providerSelections.length > 0 && (
                    <div className="space-y-2 text-xs">
                      <div className="font-medium">Provider selections</div>
                      {details.providerSelections.map((selection) => (
                        <div
                          key={selection.serviceId}
                          className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 p-2"
                        >
                          <span className="font-medium">{selection.serviceId}</span>
                          <span className="text-muted-foreground">
                            Selected: {selection.selectedProvider ?? "none"}
                          </span>
                          {selection.override && (
                            <span className="text-muted-foreground">
                              Preference: {selection.override}
                            </span>
                          )}
                          {selection.collision && <Badge variant="destructive">collision</Badge>}
                          {onChooseProvider &&
                            selection.alternatives.map((providerId) => (
                              <Button
                                key={`${selection.serviceId}:${providerId}`}
                                size="sm"
                                variant="outline"
                                disabled={entryPending}
                                onClick={() =>
                                  onChooseProvider(entry, providerId, selection.serviceId)
                                }
                              >
                                Choose {providerId}
                              </Button>
                            ))}
                          {onClearProvider && selection.override && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={entryPending}
                              onClick={() => onClearProvider(entry, selection.serviceId)}
                            >
                              Clear preference
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {details.contractConflicts.length > 0 && (
                    <div className="space-y-2 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-xs">
                      <div className="font-medium text-destructive">Contract conflicts</div>
                      {details.contractConflicts.map((conflict) => (
                        <div
                          key={`${entry.id}:${conflict.canonicalService}`}
                          className="space-y-1 rounded-md border border-destructive/20 bg-background/60 p-2"
                        >
                          <div className="font-medium">{conflict.canonicalService}</div>
                          <div className="text-muted-foreground">
                            Owners:{" "}
                            {conflict.owners
                              .map(
                                (owner) => `${owner.identity} (${JSON.stringify(owner.contract)})`,
                              )
                              .join(", ")}
                          </div>
                          <div className="text-muted-foreground">
                            Proposed bindings:{" "}
                            {conflict.proposedBindings
                              .map(
                                (binding) =>
                                  `${binding.providerIdentity} -> ${binding.effectiveService} (${binding.publicName})`,
                              )
                              .join(", ")}
                          </div>
                          {conflict.affectedDependents.length > 0 && (
                            <div className="text-muted-foreground">
                              Affected dependents: {conflict.affectedDependents.join(", ")}
                            </div>
                          )}
                          {onRepairContractConflict && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={entryPending}
                              onClick={() => onRepairContractConflict(entry, conflict)}
                            >
                              Repair contract conflict
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {showConfiguration && (
                    <div className="rounded-lg bg-muted/40 p-3 text-xs">
                      <div className="font-medium">Configuration</div>
                      {details.configSchema !== undefined && (
                        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-muted-foreground">
                          {JSON.stringify(details.configSchema, null, 2)}
                        </pre>
                      )}
                      {Object.keys(configurationValues).length > 0 && (
                        <div className="mt-1 text-muted-foreground">
                          Current values: {JSON.stringify(configurationValues)}
                        </div>
                      )}
                      {configure && (
                        <>
                          <Textarea
                            className="mt-2 min-h-20 font-mono text-xs"
                            aria-label={`Configuration for ${entry.title}`}
                            value={
                              configurationText[entry.id] ??
                              JSON.stringify(configurationValues, null, 2)
                            }
                            onChange={(event) => {
                              setConfigurationText((current) => ({
                                ...current,
                                [entry.id]: event.target.value,
                              }));
                              setConfigurationError((current) => {
                                const next = { ...current };
                                delete next[entry.id];
                                return next;
                              });
                            }}
                          />
                          {configurationError[entry.id] && (
                            <div className="mt-1 text-destructive">
                              {configurationError[entry.id]}
                            </div>
                          )}
                        </>
                      )}
                      {configure && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="mt-2"
                          disabled={entryPending}
                          onClick={() => {
                            try {
                              const parsed: unknown = JSON.parse(
                                configurationText[entry.id] ??
                                  JSON.stringify(configurationValues, null, 2),
                              );
                              if (
                                parsed === null ||
                                typeof parsed !== "object" ||
                                Array.isArray(parsed)
                              ) {
                                throw new Error("Configuration must be a JSON object.");
                              }
                              setConfigurationError((current) => {
                                const next = { ...current };
                                delete next[entry.id];
                                return next;
                              });
                              configure(entry, Object.fromEntries(Object.entries(parsed)));
                            } catch (error) {
                              setConfigurationError((current) => ({
                                ...current,
                                [entry.id]:
                                  error instanceof Error
                                    ? error.message
                                    : "Invalid JSON configuration.",
                              }));
                            }
                          }}
                        >
                          Configure
                        </Button>
                      )}
                    </div>
                  )}
                  {snippet && (
                    <div className="rounded-lg bg-muted/40 p-3 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">TypeScript AppServices</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            void navigator.clipboard
                              .writeText(snippet)
                              .then(() => setCopiedId(entry.id));
                          }}
                        >
                          {copiedId === entry.id ? "Copied" : "Copy"}
                        </Button>
                      </div>
                      <pre className="mt-1 overflow-auto whitespace-pre-wrap text-muted-foreground">
                        {snippet}
                      </pre>
                    </div>
                  )}
                </div>
              </details>
              <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-4">
                {!installation ? (
                  <Button
                    size="sm"
                    disabled={entryPending || blocked}
                    onClick={() => onInstall(entry)}
                  >
                    {projectedStatus?.status === "installing" ? "Installing / building" : "Install"}
                  </Button>
                ) : (
                  <>
                    {!entry.isCurrentVersion && (
                      <Button
                        size="sm"
                        disabled={entryPending || blocked}
                        onClick={() => onUpdate(entry)}
                      >
                        Update
                      </Button>
                    )}
                    {entry.origin === "native" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={entryPending || blocked}
                        onClick={() => onUpdateFromDirectory(entry)}
                      >
                        Update from directory
                      </Button>
                    )}
                    {installation.status === "enabled" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={entryPending}
                        onClick={() => onDisable(entry)}
                      >
                        Disable
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={entryPending || blocked}
                        onClick={() => onEnable(entry)}
                      >
                        Enable
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={entryPending}
                      onClick={() => onRemove(entry)}
                    >
                      Remove
                    </Button>
                  </>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

function DetectedExtensionCard({
  item,
  pending,
  onInstall,
}: {
  item: RuntimeExtensionProjectedStatusItem;
  pending: boolean;
  onInstall: (packageRoot: string) => void;
}) {
  const statusPresentation = projectedStatusPresentation(item.status);
  const installLabel =
    item.status === "unbuilt" && item.installation
      ? "Install and build"
      : item.status === "detected"
        ? "Install"
        : undefined;

  return (
    <Card className="gap-4 rounded-2xl border border-border/70 bg-card p-5 shadow-none transition-colors hover:border-border-loud/40">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">
            {item.identity ?? item.packageRoot ?? item.candidateId}
          </div>
          {item.version && <div className="text-xs text-muted-foreground">v{item.version}</div>}
        </div>
        <Badge variant={statusPresentation.variant}>{statusPresentation.label}</Badge>
      </div>
      <RuntimeExtensionPackageDetails
        packageRoot={item.packageRoot}
        installation={item.installation}
      />
      {item.diagnostics.length > 0 && (
        <RuntimeExtensionDiagnostics diagnostics={item.diagnostics} />
      )}
      {installLabel && item.packageRoot && (
        <Button
          size="sm"
          disabled={pending}
          onClick={() => {
            if (item.packageRoot) onInstall(item.packageRoot);
          }}
        >
          {installLabel}
        </Button>
      )}
    </Card>
  );
}

function RuntimeExtensionPackageDetails({
  packageRoot,
  installation,
}: {
  packageRoot?: string;
  installation?: RuntimeExtensionProjectedStatusItem["installation"];
}) {
  if (!packageRoot && !installation) return null;
  const packageManager = installation?.packageManager ?? "npm";

  return (
    <dl className="grid gap-1 text-xs text-muted-foreground">
      {packageRoot && (
        <div>
          <dt className="inline font-medium text-foreground">Package root: </dt>
          <dd className="inline break-all">{packageRoot}</dd>
        </div>
      )}
      {installation && (
        <>
          <div>
            <dt className="inline font-medium text-foreground">Package manager: </dt>
            <dd className="inline">{packageManager}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-foreground">Install command: </dt>
            <dd className="inline font-mono">
              {packageManager} run {installation.script}
            </dd>
          </div>
        </>
      )}
    </dl>
  );
}

function RuntimeExtensionDiagnostics({
  diagnostics,
  title = "Diagnostics",
}: {
  diagnostics: readonly RuntimeExtensionStatusDiagnostic[];
  title?: string;
}) {
  return (
    <div className="space-y-1 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive">
      <div className="font-medium">{title}</div>
      {diagnostics.map((diagnostic) => (
        <div key={`${diagnostic.code}:${diagnostic.path}:${diagnostic.message}`}>
          <div>{diagnostic.message}</div>
          <div className="break-all opacity-80">
            {diagnostic.code} - {diagnostic.path}
          </div>
        </div>
      ))}
    </div>
  );
}
