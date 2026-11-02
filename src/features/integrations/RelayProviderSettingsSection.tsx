import type { MSettings } from "@common/marshal-ipc-contract";
import {
  isRelayAccountId,
  MAX_RELAY_PROGRESS_INTERVAL_MINUTES,
  MIN_RELAY_PROGRESS_INTERVAL_MINUTES,
} from "@common/provider-config";
import type {
  RelayProviderKey,
  RelayProviderRuntimeSnapshot,
  RelayProviderSetupEvent,
} from "@common/relay-provider-settings";
import { useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useEffect, useState, type ReactNode } from "react";

import {
  CircleCheck,
  CircleX,
  KeyRound,
  Link2Off,
  MonitorX,
  PlugZap,
  RotateCcw,
} from "@/components/icons";
import { Badge } from "@/components/marshal-ui/badge";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Input } from "@/components/marshal-ui/input";
import { Switch } from "@/components/marshal-ui/marshal-switch";
import {
  InteractiveElementMonitor_Connect,
  InteractiveElementMonitor_Disconnect,
} from "@/services/telemetry/schema";

import { findRelayProviderSetupEvent } from "./relayProviderQueryKeys";
import {
  getRelayProviderConfig,
  getRelayProgressIntervalMinutes,
  setRelayProviderAccountId,
  setRelayProviderDestination,
  setRelayProviderEnabled,
  setRelayProgressIntervalMinutes,
} from "./relayProviderSettingsModel";
import { useRelayProviderSettings } from "./useRelayProviderSettings";

export type BotStatus =
  | "disabled"
  | "unavailable"
  | "disconnected"
  | "connecting"
  | "reconnecting"
  | "disconnecting"
  | "connected"
  | "error"
  | "displaced";

interface RelayProviderSettingsSectionProps {
  settings: MSettings;
  persist: (settings: MSettings) => void;
  onStatusChange?: (status: BotStatus) => void;
  onOpenSettings?: () => void;
}

interface ProviderDefinition {
  providerKey: RelayProviderKey;
  name: string;
  description: string;
}

const PROVIDERS: readonly ProviderDefinition[] = [
  {
    providerKey: "whatsapp",
    name: "WhatsApp",
    description: "Pair a dedicated WhatsApp account through the Baileys relay provider.",
  },
];

const CAPABILITY_DEFINITIONS = [
  { key: "inbound", label: "Inbound messages" },
  { key: "quotedReplies", label: "Quoted replies" },
  { key: "attachments", label: "Attachments" },
  { key: "voice", label: "Voice" },
  { key: "managedGroups", label: "Managed groups" },
  { key: "communities", label: "Communities" },
  { key: "renameConversation", label: "Rename conversations" },
  { key: "retireConversation", label: "Retire conversations" },
  { key: "remotePermissionApproval", label: "Remote approvals" },
] as const;

export function RelayProviderSettingsSection({
  settings,
  persist,
  onStatusChange,
  onOpenSettings,
}: RelayProviderSettingsSectionProps) {
  const relayProviders = useRelayProviderSettings();
  const progressIntervalMinutes = getRelayProgressIntervalMinutes(settings);

  const providersByKey = new Map(
    relayProviders.providers.map((provider) => [provider.providerKey, provider]),
  );

  const primaryStatus = getProviderStatus(
    settings,
    PROVIDERS[0].providerKey,
    providersByKey.get(PROVIDERS[0].providerKey),
  );

  useEffect(() => {
    onStatusChange?.(primaryStatus);
  }, [onStatusChange, primaryStatus]);

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="font-content text-xl/tight font-semibold text-foreground">
          Messaging providers
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Providers can run concurrently. Account IDs are Marshal-owned labels, not phone numbers,
          user IDs, or conversation IDs.
        </p>
      </div>

      <label className="max-w-xs space-y-1.5 text-sm text-foreground">
        <span className="font-medium">Relay progress interval (minutes)</span>
        <Input
          key={progressIntervalMinutes}
          aria-label="Relay progress interval"
          type="number"
          min={MIN_RELAY_PROGRESS_INTERVAL_MINUTES}
          max={MAX_RELAY_PROGRESS_INTERVAL_MINUTES}
          defaultValue={progressIntervalMinutes}
          onBlur={(event) => {
            persist(setRelayProgressIntervalMinutes(settings, Number(event.currentTarget.value)));
          }}
        />
        <span className="block text-xs text-muted-foreground">
          When a connected session or its subagents are still working, Marshal asks the owning agent
          to consider a useful update at this cadence.
        </span>
      </label>

      <div className="grid gap-4">
        {PROVIDERS.map((definition) => {
          const runtime = providersByKey.get(definition.providerKey);
          const providerStatus = getProviderStatus(settings, definition.providerKey, runtime);
          const providerActive = isActiveProviderStatus(providerStatus);
          const configuredAccountId = getRelayProviderConfig(
            settings,
            definition.providerKey,
          ).accountId;
          const setup = findRelayProviderSetupEvent(
            relayProviders.setupEvents,
            definition.providerKey,
            providerActive ? runtime?.accountId : configuredAccountId,
          );
          const actionError =
            relayProviders.pendingAction?.request.providerKey === definition.providerKey ||
            !relayProviders.pendingAction
              ? relayProviders.actionError?.message
              : undefined;
          return (
            <RelayProviderCard
              key={`${definition.providerKey}:${configuredAccountId ?? ""}`}
              definition={definition}
              settings={settings}
              persist={persist}
              runtime={runtime}
              setup={setup}
              status={providerStatus}
              actionAvailable={runtime?.available === true || providerActive}
              actionError={actionError}
              actionPending={
                relayProviders.pendingAction?.request.providerKey === definition.providerKey
              }
              onConnect={(accountId) =>
                void relayProviders.runAction("connect", definition.providerKey, accountId)
              }
              onDisconnect={(accountId) =>
                void relayProviders.runAction("disconnect", definition.providerKey, accountId)
              }
              onDisable={(accountId) => {
                void relayProviders.runAction("disconnect", definition.providerKey, accountId).then(
                  () => persist(setRelayProviderEnabled(settings, definition.providerKey, false)),
                  () => undefined,
                );
              }}
              onReset={(accountId) =>
                void relayProviders.runAction("reset", definition.providerKey, accountId)
              }
              onRelink={(accountId) =>
                void relayProviders.runAction("relink", definition.providerKey, accountId)
              }
              onProvision={(accountId) =>
                void relayProviders.runAction("provision", definition.providerKey, accountId)
              }
              onOpenSettings={onOpenSettings}
            />
          );
        })}
      </div>
    </section>
  );
}

interface RelayProviderCardProps {
  definition: ProviderDefinition;
  settings: MSettings;
  persist: (settings: MSettings) => void;
  runtime?: RelayProviderRuntimeSnapshot;
  setup?: RelayProviderSetupEvent;
  status: BotStatus;
  actionAvailable: boolean;
  actionError?: string;
  actionPending?: boolean;
  onConnect: (accountId?: string) => void;
  onDisconnect: (accountId?: string) => void;
  onDisable: (accountId?: string) => void;
  onReset: (accountId?: string) => void;
  onRelink: (accountId?: string) => void;
  onProvision: (accountId?: string) => void;
  onOpenSettings?: () => void;
}

function RelayProviderCard({
  definition,
  settings,
  persist,
  runtime,
  setup,
  status,
  actionAvailable,
  actionError,
  actionPending,
  onConnect,
  onDisconnect,
  onDisable,
  onReset,
  onRelink,
  onProvision,
  onOpenSettings,
}: RelayProviderCardProps) {
  const [accountError, setAccountError] = useState<string | null>(null);
  const config = getRelayProviderConfig(settings, definition.providerKey);
  const [accountDraft, setAccountDraft] = useState(config.accountId ?? "");
  const relay = settings.relay;
  const defaultNotifications =
    relay?.defaultNotificationDestinations.includes(definition.providerKey) ?? false;
  const progressNotifications =
    relay?.progressDestinations.includes(definition.providerKey) ?? false;
  const statusContent = getStatusContent(definition.providerKey, status);
  const enabledCapabilities = runtime
    ? CAPABILITY_DEFINITIONS.filter(({ key }) => runtime.capabilities[key])
    : [];
  const disconnectVisible = ["connected", "connecting", "reconnecting", "disconnecting"].includes(
    status,
  );
  const canUseRuntime =
    (config.enabled || disconnectVisible) && actionAvailable && accountError === null;
  const connectionTransitioning = ["connecting", "reconnecting", "disconnecting"].includes(status);
  const disconnecting = status === "disconnecting";
  const configuredAccountId = accountDraft.trim() || undefined;
  const actionAccountId = runtime?.accountId ?? configuredAccountId;
  const connectLabel = status === "displaced" ? "Reconnect" : `Connect ${definition.name}`;

  return (
    <div
      className="rounded-[10px] border border-border bg-background p-5"
      data-testid={`relay-provider-${definition.providerKey}`}
    >
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 shrink-0 ${getStatusColor(status)}`}>{getStatusIcon(status)}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">{definition.name}</h3>
            <Badge variant="outline">{statusContent.label}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{statusContent.detail}</p>
          <p className="mt-1 text-xs text-muted-foreground">{definition.description}</p>
        </div>
        <Switch
          aria-label={`${definition.name} enabled`}
          checked={config.enabled || disconnectVisible}
          disabled={
            actionPending || connectionTransitioning || (disconnectVisible && !canUseRuntime)
          }
          onCheckedChange={(enabled) => {
            if (!enabled && disconnectVisible && canUseRuntime) {
              onDisable(actionAccountId);
              return;
            }
            persist(setRelayProviderEnabled(settings, definition.providerKey, enabled));
          }}
        />
      </div>

      <div className="mt-4 grid gap-4 border-t border-border pt-4 md:grid-cols-2">
        <label className="space-y-1.5 text-sm text-foreground">
          <span className="font-medium">Account ID</span>
          <Input
            aria-label={`${definition.name} account ID`}
            value={
              disconnectVisible
                ? (runtime?.accountId ?? accountDraft)
                : accountDraft || runtime?.accountId || ""
            }
            placeholder="default"
            disabled={disconnectVisible || actionPending}
            onChange={(event) => {
              const accountId = event.currentTarget.value;
              setAccountDraft(accountId);
              setAccountError(
                accountId.trim() && !isRelayAccountId(accountId.trim())
                  ? "Use letters, numbers, dots, underscores, or hyphens for this app-owned ID."
                  : null,
              );
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            onBlur={(event) => {
              const accountId = event.currentTarget.value.trim();
              if (accountId && !isRelayAccountId(accountId)) {
                setAccountError(
                  "Use letters, numbers, dots, underscores, or hyphens for this app-owned ID.",
                );
                return;
              }
              setAccountError(null);
              persist(
                setRelayProviderAccountId(settings, definition.providerKey, accountId || undefined),
              );
            }}
          />
          <span className="block text-xs text-muted-foreground">
            Account ID changes take effect after restart. Until then, actions use the currently
            loaded account.
          </span>
          {accountError && <span className="text-xs text-destructive">{accountError}</span>}
        </label>

        <div className="space-y-3">
          <ProviderToggle
            label="Default notifications"
            description="Receive proactive and attention notifications."
            checked={defaultNotifications}
            disabled={!config.enabled}
            onCheckedChange={(selected) =>
              persist(
                setRelayProviderDestination(
                  settings,
                  definition.providerKey,
                  "defaultNotificationDestinations",
                  selected,
                ),
              )
            }
          />
          <ProviderToggle
            label="Progress updates"
            description="Receive periodic progress notifications."
            checked={progressNotifications}
            disabled={!config.enabled}
            onCheckedChange={(selected) =>
              persist(
                setRelayProviderDestination(
                  settings,
                  definition.providerKey,
                  "progressDestinations",
                  selected,
                ),
              )
            }
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {disconnectVisible ? (
          <InteractiveElementMonitor_Disconnect callback={() => onDisconnect(actionAccountId)}>
            {(callback) => (
              <Button
                variant="outline"
                size="sm"
                onClick={callback}
                disabled={!canUseRuntime || actionPending || disconnecting}
              >
                Disconnect {definition.name}
              </Button>
            )}
          </InteractiveElementMonitor_Disconnect>
        ) : (
          <InteractiveElementMonitor_Connect callback={() => onConnect(actionAccountId)}>
            {(callback) => (
              <Button
                size="sm"
                onClick={callback}
                disabled={!canUseRuntime || actionPending || status === "connecting"}
              >
                {connectLabel}
              </Button>
            )}
          </InteractiveElementMonitor_Connect>
        )}
        {definition.providerKey === "whatsapp" ? (
          <>
            {status === "connecting" && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onReset(actionAccountId)}
                disabled={runtime?.available !== true || actionPending}
              >
                Cancel pairing
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onRelink(actionAccountId)}
              disabled={runtime?.available !== true || actionPending || connectionTransitioning}
            >
              <RotateCcw size={14} />
              Reset &amp; Relink
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onReset(actionAccountId)}
            disabled={runtime?.available !== true || actionPending || connectionTransitioning}
          >
            <RotateCcw size={14} />
            Reset
          </Button>
        )}
        {definition.providerKey === "whatsapp" && status === "connected" && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onProvision(actionAccountId)}
            disabled={!canUseRuntime || actionPending || connectionTransitioning}
          >
            Retry provisioning
          </Button>
        )}
        {runtime?.available === false && (
          <span className="text-xs text-muted-foreground">Runtime integration pending</span>
        )}
      </div>

      {status === "connected" && onOpenSettings && (
        <p className="mt-3 text-xs/snug text-muted-foreground">
          Sleep prevention settings are in{" "}
          <Button
            variant="link"
            className="h-auto p-0 text-xs text-foreground underline underline-offset-2 hover:text-muted-foreground"
            onClick={onOpenSettings}
          >
            Settings → Power Management
          </Button>
          .
        </p>
      )}

      {(actionError || runtime?.connection.failure) && (
        <div className="mt-3 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {actionError ?? runtime?.connection.failure?.message}
        </div>
      )}

      <div className="mt-4 border-t border-border pt-4">
        <div className="flex items-center gap-2 text-xs font-medium text-foreground">
          <KeyRound size={14} />
          Capabilities
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {enabledCapabilities.length > 0 ? (
            enabledCapabilities.map((capability) => (
              <Badge key={capability.key} variant="secondary">
                {capability.label}
              </Badge>
            ))
          ) : (
            <span className="text-xs text-muted-foreground">Capabilities not reported.</span>
          )}
        </div>
      </div>

      {setup && <RelaySetupDetails event={setup} />}
    </div>
  );
}

function ProviderToggle({
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      <Switch
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

function RelaySetupDetails({ event }: { event: RelayProviderSetupEvent }) {
  const { snapshot } = event;
  const qrPayload = snapshot.qr?.payload;
  const renderedQr = useQuery({
    queryKey: [
      "relay-provider-settings",
      "qr",
      event.providerKey,
      snapshot.account.accountId,
      qrPayload,
    ],
    queryFn: () =>
      QRCode.toDataURL(qrPayload!, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 240,
      }),
    enabled: Boolean(qrPayload && !qrPayload.startsWith("data:image/")),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const qrImage = qrPayload?.startsWith("data:image/") === true ? qrPayload : renderedQr.data;

  return (
    <div className="mt-4 rounded-lg bg-muted/50 p-3 text-sm" data-testid="relay-setup-detail">
      <div className="font-medium text-foreground">Setup: {snapshot.state}</div>
      <p className="mt-1 text-xs text-muted-foreground">Updated {snapshot.updatedAt}</p>
      {snapshot.failure && <p className="mt-1 text-destructive">{snapshot.failure.message}</p>}
      {qrImage && (
        <img
          src={qrImage}
          alt="WhatsApp pairing QR code"
          className="mt-3 size-48 rounded-md bg-white p-2"
        />
      )}
      {snapshot.pairingAttemptId && (
        <p className="mt-2 text-xs break-all text-muted-foreground">
          Pairing reference: {snapshot.pairingAttemptId}
        </p>
      )}
      {qrPayload && !qrImage && (
        <pre className="mt-2 max-h-28 overflow-auto rounded-sm bg-background p-2 text-xs break-all whitespace-pre-wrap text-foreground">
          {qrPayload}
        </pre>
      )}
    </div>
  );
}

function getProviderStatus(
  settings: MSettings,
  providerKey: RelayProviderKey,
  runtime: RelayProviderRuntimeSnapshot | undefined,
): BotStatus {
  if (
    runtime &&
    ["connected", "connecting", "reconnecting", "disconnecting"].includes(runtime.connection.state)
  ) {
    return runtime.connection.state;
  }
  if (!getRelayProviderConfig(settings, providerKey).enabled) return "disabled";
  return runtime?.connection.state ?? "unavailable";
}

function isActiveProviderStatus(status: BotStatus): boolean {
  return ["connected", "connecting", "reconnecting", "disconnecting"].includes(status);
}

function getStatusContent(providerKey: RelayProviderKey, status: BotStatus) {
  const providerName = PROVIDERS.find((p) => p.providerKey === providerKey)?.name ?? "Relay";
  switch (status) {
    case "connected":
      return {
        label: "Connected",
        detail: `${providerName} is paired and ready for Marshal messages.`,
      };
    case "connecting":
      return { label: "Connecting…", detail: `Connecting the ${providerName} relay…` };
    case "reconnecting":
      return {
        label: "Reconnecting…",
        detail: `Restoring the ${providerName} relay after an interruption…`,
      };
    case "disconnecting":
      return { label: "Disconnecting…", detail: `Stopping the ${providerName} relay…` };
    case "error":
      return { label: "Connection Error", detail: `${providerName} needs attention.` };
    case "displaced":
      return {
        label: "Another Client Connected",
        detail: "Another Marshal instance took over the relay connection",
      };
    case "disabled":
      return { label: "Disabled", detail: `Enable ${providerName} to configure its relay.` };
    case "unavailable":
      return {
        label: "Unavailable",
        detail: `${providerName} runtime integration is not available in this build.`,
      };
    default:
      return {
        label: "Disconnected",
        detail: `Connect ${providerName} to start pairing this device.`,
      };
  }
}

function getStatusColor(status: BotStatus): string {
  switch (status) {
    case "connected":
      return "text-success";
    case "error":
      return "text-destructive";
    case "connecting":
    case "reconnecting":
    case "disconnecting":
    case "displaced":
      return "text-(--color-warning-text)";
    default:
      return "text-muted-foreground";
  }
}

function getStatusIcon(status: BotStatus): ReactNode {
  switch (status) {
    case "connected":
      return <CircleCheck size={20} />;
    case "error":
      return <CircleX size={20} />;
    case "displaced":
      return <MonitorX size={20} />;
    case "disabled":
    case "unavailable":
      return <Link2Off size={20} />;
    default:
      return <PlugZap size={20} />;
  }
}
