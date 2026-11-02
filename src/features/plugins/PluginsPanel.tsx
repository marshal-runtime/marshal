import type { CatalogItem } from "@common/extensions-catalog/marshal-extension-catalog";
import type { RuntimeExtensionsScope } from "@common/marshal-ipc-contract";
import { createLogger } from "@common/marshal-logger";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Search, X } from "@/components/icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/marshal-ui/alert";
import { Input } from "@/components/marshal-ui/input";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Tabs, TabsList, TabsTrigger } from "@/components/marshal-ui/marshal-tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SurfaceHeader } from "@/components/ui/surface-header";
import { mcpOAuthStore } from "@/hooks/mcp-oauth-store";
import { cn } from "@/lib/marshal-class-names";
import {
  TelemetryPath_Extensions,
  TelemetryPath_McpTab,
  TelemetryPath_SkillsTab,
} from "@/services/telemetry/schema";

import { UiExtensionsTab } from "../ui-extensions/UiExtensionsPanel";
import { AddSkillDialog } from "./AddSkillDialog";
import { ImportDialog } from "./ImportDialog";
import { getMcpServerDescription, getMcpServerDetails } from "./mcp-server-utils";
import type { SelectedCustomItem } from "./McpServerDetailDialog";
import { McpServerDetailDialog } from "./McpServerDetailDialog";
import { McpServersTab } from "./McpServersTab";
import { CatalogDetailDialog, CustomDetailDialog } from "./PluginsDetailDialog";
import { RuntimeExtensionsSection } from "./RuntimeExtensionsSection";
import { SkillsTab } from "./SkillsTab";
import { usePluginsActions } from "./usePluginsActions";
import { usePluginsData, type PluginsCategory } from "./usePluginsData";

const log = createLogger("PluginsPanel");

interface PluginsPanelProps {
  isOpen: boolean;
  onClose?: () => void;
  initialTab?: PluginsCategory;
  onInsertSkill?: (skillName: string) => void;
  /** Show the UI Plugins tab (gated on the extensionHost experiment flag). */
  showUiPluginsTab?: boolean;
  runtimeScope?: RuntimeExtensionsScope;
}

export function PluginsPanel({
  isOpen,
  onClose,
  initialTab = "skills",
  onInsertSkill,
  showUiPluginsTab = false,
  runtimeScope,
}: PluginsPanelProps) {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<PluginsCategory>(initialTab);
  const [search, setSearch] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [selectedCustom, setSelectedCustom] = useState<SelectedCustomItem | null>(null);
  const [selectedCatalogItem, setSelectedCatalogItem] = useState<CatalogItem | null>(null);
  const [installingIds, setInstallingIds] = useState(new Set<string>());

  const {
    installedSkills,
    allMcpServers,
    customMcpServerInfos,
    getInstallState,
    filteredCustomSkills,
    filteredMcpServers,
    filteredCatalogSkills,
    filteredCatalogMcpServers,
    runtimeCatalog,
    runtimeStatus,
    runtimeCatalogError,
  } = usePluginsData({ isOpen, search, installingIds, runtimeScope });

  const {
    importError,
    importSuccess,
    showImport,
    setShowImport,
    showAddSkill,
    setShowAddSkill,
    editingSkill,
    setEditingSkill,
    mcpFormProps,
    clearStatus,
    handleImportSkillUrl,
    handleImportSkillBundle,
    handleImportSkillContents,
    handleAddSkill,
    handleEditSkill,
    handleToggleSkill,
    handleRemoveCustomSkill,
    handleRemoveMcp,
    handleInstallCatalogItem,
    getConfigValues,
    handleSaveConfig,
    handleOpenFile,
    runtimeMutationPending,
    handleRuntimeInstallDetected,
    handleRuntimeInstallLocal,
    handleRuntimeInstall,
    handleRuntimeUpdate,
    handleRuntimeUpdateFromDirectory,
    handleRuntimeEnable,
    handleRuntimeDisable,
    handleRuntimeRemove,
    handleRuntimeConfigure,
    handleRuntimeChooseProvider,
    handleRuntimeClearProvider,
    handleRuntimeRepairContractConflict,
  } = usePluginsActions({
    queryClient,
    installedSkills,
    allMcpServers,
    setInstallingIds,
    runtimeScope,
  });

  // Subscribe to OAuth prompt rising edge — clear add/edit status banner when
  // a new OAuth prompt opens so a stale import/save message doesn't sit on
  // top of an unrelated sign-in flow. Subscribed at the panel level (rather
  // than inside McpServerDetailDialog) because the prompt can open from
  // anywhere — including the McpServersTab carousel — not just the detail
  // dialog.
  const oauthPrompt = useSyncExternalStore(
    mcpOAuthStore.subscribe,
    mcpOAuthStore.getPromptSnapshot,
  );
  const prevPromptRef = useRef<typeof oauthPrompt>(oauthPrompt);
  useEffect(() => {
    if (oauthPrompt !== null && prevPromptRef.current === null) clearStatus();
    prevPromptRef.current = oauthPrompt;
  }, [oauthPrompt, clearStatus]);

  // Stabilised so they can sit in `McpServerDetailDialog`'s rising-edge
  // `useEffect` deps without re-firing on every parent render — the parent
  // re-renders on every React Query poll + OAuth-store notification.
  const handleDetailDialogClose = useCallback(() => setSelectedCustom(null), []);
  // Auto-close path also clears the status banner because the rising-edge
  // close is a "we finished a sign-in flow" signal — any stale add/edit
  // banner would be misleading. User-initiated close (X button, sign-out
  // success) intentionally leaves the banner alone.
  const handleDetailDialogAutoClose = useCallback(() => {
    setSelectedCustom(null);
    clearStatus();
  }, [clearStatus]);

  if (!isOpen) return null;

  return (
    <TelemetryPath_Extensions>
      <div className="flex h-full flex-col bg-background">
        <SurfaceHeader title="Plugins" onClose={onClose} />

        <Tabs
          value={activeTab}
          onValueChange={(v) => {
            if (v === "skills" || v === "mcp-servers" || v === "ui-extensions")
              setActiveTab(v as PluginsCategory);
            clearStatus();
          }}
          className="flex flex-1 flex-col overflow-hidden"
        >
          <div className="px-6 pt-3">
            <div className="flex items-center justify-between">
              <TabsList className="gap-2 bg-transparent p-0">
                <TabsTrigger
                  value="skills"
                  className="flex-initial rounded-xl px-2.5 py-1.5 hover:bg-accent data-active:bg-foreground data-active:text-background data-active:shadow-none hover:data-active:bg-foreground hover:data-active:text-background dark:data-active:border-transparent dark:data-active:bg-foreground dark:data-active:text-card dark:hover:data-active:text-card"
                >
                  Skills
                </TabsTrigger>
                <TabsTrigger
                  value="mcp-servers"
                  className="flex-initial rounded-xl px-2.5 py-1.5 hover:bg-accent data-active:bg-foreground data-active:text-background data-active:shadow-none hover:data-active:bg-foreground hover:data-active:text-background dark:data-active:border-transparent dark:data-active:bg-foreground dark:data-active:text-card dark:hover:data-active:text-card"
                >
                  MCP Servers
                </TabsTrigger>
                {showUiPluginsTab && (
                  <TabsTrigger
                    value="ui-extensions"
                    className="flex-initial rounded-xl px-2.5 py-1.5 hover:bg-accent data-active:bg-foreground data-active:text-background data-active:shadow-none hover:data-active:bg-foreground hover:data-active:text-background dark:data-active:border-transparent dark:data-active:bg-foreground dark:data-active:text-card dark:hover:data-active:text-card"
                  >
                    UI Plugins
                  </TabsTrigger>
                )}
              </TabsList>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Search"
                className="rounded-full text-foreground"
                onClick={() => {
                  setShowSearch((prev) => {
                    if (prev) setSearch("");
                    return !prev;
                  });
                  if (!showSearch) {
                    // Defer focus until after React re-renders and removes the hidden class.
                    requestAnimationFrame(() => searchInputRef.current?.focus());
                  }
                }}
              >
                <Search className="size-5" />
              </Button>
            </div>

            <div className={cn("relative mt-2", !showSearch && "hidden")}>
              <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                placeholder={
                  activeTab === "skills"
                    ? "Search skills..."
                    : activeTab === "ui-extensions"
                      ? "Search UI plugins..."
                      : "Search MCP servers..."
                }
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onBlur={(e) => {
                  if (e.relatedTarget?.closest('[aria-label="Search"]')) return;
                  if (!search) setShowSearch(false);
                }}
                className="px-9"
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close search"
                className="absolute top-1/2 right-2 size-6 -translate-y-1/2 rounded-full text-muted-foreground"
                onClick={() => {
                  setSearch("");
                  setShowSearch(false);
                }}
              >
                <X className="size-4" />
              </Button>
            </div>
          </div>

          <ScrollArea className="flex-1">
            <div className="space-y-5 px-6 py-4">
              {runtimeCatalogError && (
                <Alert variant="destructive">
                  <AlertTitle>Runtime Extensions unavailable</AlertTitle>
                  <AlertDescription>
                    {runtimeCatalogError instanceof Error
                      ? runtimeCatalogError.message
                      : "The Runtime Extensions catalog could not be loaded."}
                  </AlertDescription>
                </Alert>
              )}
              <RuntimeExtensionsSection
                entries={runtimeCatalog}
                status={runtimeStatus}
                pending={runtimeMutationPending}
                onInstall={handleRuntimeInstall}
                onInstallDetected={handleRuntimeInstallDetected}
                onUpdate={handleRuntimeUpdate}
                onUpdateFromDirectory={handleRuntimeUpdateFromDirectory}
                onEnable={handleRuntimeEnable}
                onDisable={handleRuntimeDisable}
                onRemove={handleRuntimeRemove}
                onConfigure={handleRuntimeConfigure}
                onChooseProvider={handleRuntimeChooseProvider}
                onClearProvider={handleRuntimeClearProvider}
                onRepairContractConflict={handleRuntimeRepairContractConflict}
              />
              {runtimeScope && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={runtimeMutationPending}
                  onClick={() => void handleRuntimeInstallLocal()}
                >
                  Install local extension
                </Button>
              )}
              {(importError || importSuccess) && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={clearStatus}
                  className={`h-auto w-full justify-start rounded-xl border px-3 py-2 text-left text-xs font-normal whitespace-normal ${importError ? "border-destructive/20 bg-destructive/10 text-destructive hover:bg-destructive/10" : "border-(--status-success-border) bg-(--status-success-bg) text-(--status-success-fg) hover:bg-(--status-success-bg)"}`}
                >
                  {importError ?? importSuccess}
                </Button>
              )}

              <TelemetryPath_SkillsTab>
                <SkillsTab
                  filteredCatalogSkills={filteredCatalogSkills}
                  filteredCustomSkills={filteredCustomSkills}
                  search={search}
                  getInstallState={getInstallState}
                  onInstallCatalogItem={handleInstallCatalogItem}
                  onSelectCatalogItem={setSelectedCatalogItem}
                  onOpenFile={handleOpenFile}
                  onUninstall={(item) => handleRemoveCustomSkill(item.name)}
                  onToggleSkill={handleToggleSkill}
                  onUseSkill={onInsertSkill}
                  onEditSkill={(skill) => {
                    setEditingSkill({
                      name: skill.name,
                      displayName: skill.displayName ?? "",
                      description: skill.description,
                      instructions: skill.instructions,
                    });
                  }}
                  onRemoveSkill={handleRemoveCustomSkill}
                  onSelectCustomSkill={(s) =>
                    setSelectedCustom({
                      type: "skills",
                      id: s.id,
                      name: s.name,
                      icon: "📝",
                      description: s.description,
                      instructions: s.instructions,
                      displayName: s.displayName,
                      scope: s.scope,
                      bundleDirs: s.bundleDirs,
                    })
                  }
                  onAddSkill={() => setShowAddSkill(true)}
                  onImport={() => setShowImport(true)}
                  showAddSkill={showAddSkill}
                  onAddSkillSave={handleAddSkill}
                  onAddSkillClose={() => setShowAddSkill(false)}
                />
              </TelemetryPath_SkillsTab>

              <TelemetryPath_McpTab>
                <McpServersTab
                  filteredCatalogMcpServers={filteredCatalogMcpServers}
                  filteredMcpServers={filteredMcpServers}
                  search={search}
                  getInstallState={getInstallState}
                  onInstallCatalogItem={handleInstallCatalogItem}
                  onSelectCatalogItem={setSelectedCatalogItem}
                  onOpenServerFile={async () => {
                    const r = await window.mcpsAPI?.openFile();
                    if (r && !r.success) log.warn("openFile failed:", r.error);
                  }}
                  onRemoveServer={handleRemoveMcp}
                  onSelectCustomServer={(s) =>
                    setSelectedCustom({
                      type: "mcp-servers",
                      name: s.name,
                      icon: "🔌",
                      // Snapshot description + details for the
                      // "server vanished from live list" fallback rendered
                      // by McpServerDetailDialog. The live dialog re-derives
                      // these from the current MCP server info so OAuth
                      // status changes show up without reopening.
                      description: getMcpServerDescription(s),
                      details: getMcpServerDetails(s),
                    })
                  }
                  {...mcpFormProps}
                />
              </TelemetryPath_McpTab>

              {showUiPluginsTab && activeTab === "ui-extensions" && <UiExtensionsTab />}
            </div>
          </ScrollArea>
        </Tabs>

        {showImport && (
          <ImportDialog
            onClose={() => setShowImport(false)}
            onImportFiles={handleImportSkillContents}
            onUrlImport={handleImportSkillUrl}
            onImportBundle={handleImportSkillBundle}
          />
        )}

        {selectedCatalogItem && (
          <CatalogDetailDialog
            key={selectedCatalogItem.id}
            item={selectedCatalogItem}
            installState={getInstallState(selectedCatalogItem)}
            configValues={getConfigValues(selectedCatalogItem)}
            onClose={() => setSelectedCatalogItem(null)}
            onInstall={(item) => {
              handleInstallCatalogItem(item);
              setSelectedCatalogItem(null);
            }}
            onUninstall={(item) => {
              if (item.type === "skills") handleRemoveCustomSkill(item.name);
              else if (item.type === "mcp-servers") handleRemoveMcp(item.name);
              setSelectedCatalogItem(null);
            }}
            onOpenFile={handleOpenFile}
            onSaveConfig={handleSaveConfig}
            onUse={
              onInsertSkill
                ? (item) => {
                    if (item.type === "skills") onInsertSkill(item.name);
                  }
                : undefined
            }
          />
        )}

        {/* Custom item detail dialog — split by `type` so the MCP path can
            host its own OAuth-store wiring without bloating the skills
            render. `key` resets internal state in both children when the
            user switches selection. */}
        {selectedCustom?.type === "mcp-servers" && (
          <McpServerDetailDialog
            key={selectedCustom.name}
            selectedCustom={selectedCustom}
            customMcpServerInfos={customMcpServerInfos}
            onClose={handleDetailDialogClose}
            onAutoClose={handleDetailDialogAutoClose}
          />
        )}

        {selectedCustom?.type === "skills" && (
          <CustomDetailDialog
            key={selectedCustom.name}
            open={true}
            title={selectedCustom.displayName ?? selectedCustom.name}
            icon={selectedCustom.icon}
            description={selectedCustom.description}
            instructions={selectedCustom.instructions}
            details={selectedCustom.details}
            bundleDirs={selectedCustom.bundleDirs}
            itemType="skills"
            onClose={() => setSelectedCustom(null)}
            onRemove={
              selectedCustom.scope === "local"
                ? () => {
                    handleRemoveCustomSkill(selectedCustom.name);
                    setSelectedCustom(null);
                  }
                : undefined
            }
            onUse={onInsertSkill ? () => onInsertSkill(selectedCustom.name) : undefined}
            onExport={() => window.skillsAPI?.export(selectedCustom.name)}
            onEdit={
              selectedCustom.scope === "local"
                ? () => {
                    setEditingSkill({
                      name: selectedCustom.name,
                      displayName: selectedCustom.displayName ?? "",
                      description: selectedCustom.description ?? "",
                      instructions: selectedCustom.instructions ?? "",
                    });
                    setSelectedCustom(null);
                  }
                : undefined
            }
          />
        )}

        {editingSkill && (
          <AddSkillDialog
            initial={editingSkill}
            onSave={handleEditSkill}
            onClose={() => setEditingSkill(null)}
          />
        )}
      </div>
    </TelemetryPath_Extensions>
  );
}
