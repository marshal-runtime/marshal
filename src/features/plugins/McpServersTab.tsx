import type { CatalogItem } from "@common/extensions-catalog/marshal-extension-catalog";
import { createLogger } from "@common/marshal-logger";
import { managedMcpEnvServerKey } from "@common/marshal-mcp-env-file";
import { toMcpServerKey } from "@common/mcp-server-key-normalization";
import { useSyncExternalStore } from "react";

import { Plus } from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import { TabsContent } from "@/components/marshal-ui/marshal-tabs";
import { SectionHeader } from "@/components/marshal-ui/section-header";
import { mcpOAuthStore, openMcpOAuthPrompt, type McpOAuthUiState } from "@/hooks/mcp-oauth-store";
import {
  InteractiveElementMonitor_AddMcpServer,
  TelemetryPath_ExtensionMcpServer,
  useInteractiveElementMonitor_InstallMcpServer,
} from "@/services/telemetry/schema";
import type { McpServerInfo } from "@/types/electron";

import { AddMcpDialog } from "./AddMcpDialog";
import { HorizontalCarousel } from "./HorizontalCarousel";
import {
  getMcpOAuthAction,
  getMcpServerStatusLabel,
  isMcpServerSignedIn,
} from "./mcp-server-utils";
import { CatalogCard, CustomItemCard, type InstallState } from "./PluginsCard";

const log = createLogger("McpServersTab");

interface McpServersTabProps {
  filteredCatalogMcpServers: CatalogItem[];
  filteredMcpServers: McpServerInfo[];
  search: string;
  getInstallState: (item: CatalogItem) => InstallState;
  onInstallCatalogItem: (item: CatalogItem) => void;
  onSelectCatalogItem: (item: CatalogItem) => void;
  onSelectCustomServer: (server: McpServerInfo) => void;
  /** Opens the global MCP servers config file in the user's OS editor. */
  onOpenServerFile?: () => void;
  onRemoveServer?: (name: string) => void;
  addingMcp: boolean;
  onAddMcpOpen: () => void;
  newMcpName: string;
  newMcpUrl: string;
  newMcpCommand: string;
  newMcpBearerToken: string;
  newMcpTimeoutSeconds: string;
  newMcpEnvFile: string;
  newMcpMode: "url" | "command";
  newMcpTransport: "http" | "sse";
  onNameChange: (name: string) => void;
  onUrlChange: (url: string) => void;
  onCommandChange: (cmd: string) => void;
  onBearerTokenChange: (token: string) => void;
  onTimeoutSecondsChange: (seconds: string) => void;
  onEnvFileChange: (envFile: string) => void;
  onModeChange: (mode: "url" | "command") => void;
  onTransportChange: (t: "http" | "sse") => void;
  onAddMcpSave: () => Promise<void>;
  onAddMcpClose: () => void;
}

export function McpServersTab({
  filteredCatalogMcpServers,
  filteredMcpServers,
  search,
  getInstallState,
  onInstallCatalogItem,
  onSelectCatalogItem,
  onSelectCustomServer,
  onOpenServerFile,
  onRemoveServer,
  addingMcp,
  onAddMcpOpen,
  newMcpName,
  newMcpUrl,
  newMcpCommand,
  newMcpBearerToken,
  newMcpTimeoutSeconds,
  newMcpEnvFile,
  newMcpMode,
  newMcpTransport,
  onNameChange,
  onUrlChange,
  onCommandChange,
  onBearerTokenChange,
  onTimeoutSecondsChange,
  onEnvFileChange,
  onModeChange,
  onTransportChange,
  onAddMcpSave,
  onAddMcpClose,
}: McpServersTabProps) {
  const oauthUiState = useSyncExternalStore(
    mcpOAuthStore.subscribe,
    mcpOAuthStore.getUiStateSnapshot,
  );

  return (
    <TabsContent value="mcp-servers" className="mt-0 space-y-5">
      {filteredCatalogMcpServers.length > 0 && (
        <section className="space-y-2">
          <SectionHeader divider={false}>Featured MCP Servers</SectionHeader>
          <HorizontalCarousel>
            {filteredCatalogMcpServers.map((item) => (
              <TelemetryPath_ExtensionMcpServer key={item.id}>
                <MonitoredCatalogMcpCard
                  item={item}
                  installState={getInstallState(item)}
                  onInstall={onInstallCatalogItem}
                  onClick={() => onSelectCatalogItem(item)}
                />
              </TelemetryPath_ExtensionMcpServer>
            ))}
          </HorizontalCarousel>
        </section>
      )}

      {/* MCP Servers from Catalog — hidden until remote catalog is configured */}

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <SectionHeader divider={false}>Your MCP Servers</SectionHeader>
          <div className="flex items-center gap-1.5">
            <InteractiveElementMonitor_AddMcpServer callback={onAddMcpOpen}>
              {(cb) => (
                <Button
                  size="xs"
                  className="bg-brand-action text-brand-action-fg hover:bg-brand-action-hover"
                  onClick={cb}
                >
                  <Plus className="mr-1 size-3" />
                  Add Server
                </Button>
              )}
            </InteractiveElementMonitor_AddMcpServer>
          </div>
        </div>
        {filteredMcpServers.length > 0 ? (
          <HorizontalCarousel>
            {filteredMcpServers.map((s) => (
              <McpServerCardItem
                key={s.name}
                server={s}
                uiState={oauthUiState[toMcpServerKey(s.name)]}
                onSelect={() => onSelectCustomServer(s)}
                onOpenFile={onOpenServerFile}
                onUninstall={onRemoveServer ? () => onRemoveServer(s.name) : undefined}
              />
            ))}
          </HorizontalCarousel>
        ) : (
          <p className="py-4 text-center text-base text-muted-foreground">
            {search ? "No servers match your search." : "No custom servers yet."}
          </p>
        )}
      </section>

      {addingMcp && (
        <AddMcpDialog
          name={newMcpName}
          url={newMcpUrl}
          command={newMcpCommand}
          bearerToken={newMcpBearerToken}
          timeoutSeconds={newMcpTimeoutSeconds}
          envFile={newMcpEnvFile}
          mode={newMcpMode}
          transport={newMcpTransport}
          onNameChange={onNameChange}
          onUrlChange={onUrlChange}
          onCommandChange={onCommandChange}
          onBearerTokenChange={onBearerTokenChange}
          onTimeoutSecondsChange={onTimeoutSecondsChange}
          onEnvFileChange={onEnvFileChange}
          onModeChange={onModeChange}
          onTransportChange={onTransportChange}
          onSave={onAddMcpSave}
          onClose={onAddMcpClose}
          canSave={
            !!newMcpName.trim() &&
            (newMcpMode === "url" ? !!newMcpUrl.trim() : !!newMcpCommand.trim())
          }
        />
      )}
    </TabsContent>
  );
}

/**
 * Per-server carousel card. Status-only display for signed-in servers —
 * Re-authenticate / Log out are deliberately hidden because they're
 * infrequent maintenance actions that belong in the detail dialog (where
 * they get proper labels, icons, and primary/destructive styling). The
 * carousel card keeps inline actions only for the states where one-click
 * recovery actually matters: needs-auth ("Sign in"), failed ("Retry sign
 * in"), pending/connecting ("Connecting..."), and unknown ("Connect").
 * Clicking the card opens the detail dialog regardless.
 */
function McpServerCardItem({
  server,
  uiState,
  onSelect,
  onOpenFile,
  onUninstall,
}: {
  server: McpServerInfo;
  uiState: McpOAuthUiState | undefined;
  onSelect: () => void;
  onOpenFile?: () => void;
  onUninstall?: () => void;
}) {
  const oauthAction = isMcpServerSignedIn(server, uiState)
    ? null
    : getMcpOAuthAction(server, uiState);
  const action = oauthAction;
  const config = server.config;
  const envServerKey =
    config && "envFile" in config ? managedMcpEnvServerKey(config.envFile) : null;
  const onOpenEnvFile = envServerKey
    ? async () => {
        const r = await window.mcpsAPI?.openEnvFile(envServerKey, "default");
        if (r && !r.success) log.warn("openEnvFile failed:", r.error);
      }
    : undefined;
  return (
    <CustomItemCard
      name={server.name}
      itemType="mcp-servers"
      description={getServerDescription(server, uiState)}
      actionLabel={action?.label}
      actionDisabled={action?.disabled}
      onAction={
        oauthAction
          ? () =>
              openMcpOAuthPrompt({
                serverName: server.name,
                defaultLoginHint: uiState?.alias ?? server.oauthAlias,
                reason: oauthAction.reason,
                forceReauth: oauthAction.forceReauth,
              })
          : undefined
      }
      onClick={onSelect}
      onOpenFile={onOpenFile}
      onOpenEnvFile={onOpenEnvFile}
      onUninstall={onUninstall}
    />
  );
}

function getServerDescription(
  server: McpServerInfo,
  uiState?: McpOAuthUiState,
): string | undefined {
  const config = server.config;
  const endpoint = config && "url" in config ? config.url : config?.command;
  const statusLabel = getMcpServerStatusLabel(server, uiState);
  // Joined with " · " (not "\n") because CustomItemCard renders the description
  // inside a <p>, which collapses whitespace — newlines would render as a single
  // space, hiding the visual separation.
  if (statusLabel) return endpoint ? `${statusLabel} · ${endpoint}` : statusLabel;
  return endpoint;
}

function MonitoredCatalogMcpCard({
  item,
  installState,
  onInstall,
  onClick,
}: {
  item: CatalogItem;
  installState: InstallState;
  onInstall: (item: CatalogItem) => void;
  onClick: () => void;
}) {
  const monitored = useInteractiveElementMonitor_InstallMcpServer({
    callback: onInstall,
    hasContent: installState === "available",
  });
  return (
    <CatalogCard
      item={item}
      installState={installState}
      onInstall={monitored}
      onUse={() => onClick()}
      onClick={onClick}
    />
  );
}
