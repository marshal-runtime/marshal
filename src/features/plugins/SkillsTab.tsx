import type { CatalogItem } from "@common/extensions-catalog/marshal-extension-catalog";

import { Download, Plus } from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import { TabsContent } from "@/components/marshal-ui/marshal-tabs";
import { SectionHeader } from "@/components/marshal-ui/section-header";
import {
  InteractiveElementMonitor_AddSkill,
  InteractiveElementMonitor_ImportSkill,
  TelemetryPath_ExtensionSkill,
  useInteractiveElementMonitor_InstallSkill,
} from "@/services/telemetry/schema";

import { AddSkillDialog } from "./AddSkillDialog";
import { HorizontalCarousel } from "./HorizontalCarousel";
import { CatalogCard, CustomItemCard, type InstallState } from "./PluginsCard";

interface SkillsTabProps {
  filteredCatalogSkills: CatalogItem[];
  filteredCustomSkills: Array<{
    id: string;
    name: string;
    displayName?: string;
    description: string;
    instructions: string;
    enabled: boolean;
    scope: "local" | "global" | "bundled";
    bundleDirs?: string[];
  }>;
  search: string;
  getInstallState: (item: CatalogItem) => InstallState;
  onInstallCatalogItem: (item: CatalogItem) => void;
  onSelectCatalogItem: (item: CatalogItem) => void;
  onSelectCustomSkill: (skill: {
    id: string;
    name: string;
    displayName?: string;
    description: string;
    instructions: string;
    enabled: boolean;
    scope: "local" | "global" | "bundled";
    bundleDirs?: string[];
  }) => void;
  onOpenFile?: (item: CatalogItem) => void;
  onUninstall?: (item: CatalogItem) => void;
  onToggleSkill?: (id: string, enabled: boolean) => void;
  onUseSkill?: (name: string) => void;
  onEditSkill?: (skill: {
    name: string;
    displayName?: string;
    description: string;
    instructions: string;
  }) => void;
  onRemoveSkill?: (name: string) => void;
  onAddSkill: () => void;
  onImport: () => void;
  showAddSkill: boolean;
  onAddSkillSave: (
    name: string,
    description: string,
    instructions: string,
    displayName?: string,
  ) => void;
  onAddSkillClose: () => void;
}

export function SkillsTab({
  filteredCatalogSkills,
  filteredCustomSkills,
  search,
  getInstallState,
  onInstallCatalogItem,
  onSelectCatalogItem,
  onSelectCustomSkill,
  onOpenFile,
  onUninstall,
  onToggleSkill,
  onUseSkill,
  onEditSkill,
  onRemoveSkill,
  onAddSkill,
  onImport,
  showAddSkill,
  onAddSkillSave,
  onAddSkillClose,
}: SkillsTabProps) {
  return (
    <TabsContent value="skills" className="mt-0 space-y-5">
      <p className="text-sm text-foreground">
        Skills let you save a collection of tasks to run together. Invoke with{" "}
        <strong>/name</strong> or just ask naturally.
      </p>

      {filteredCatalogSkills.length > 0 && (
        <section className="space-y-2">
          <SectionHeader divider={false}>Bundled Skills</SectionHeader>
          <HorizontalCarousel>
            {filteredCatalogSkills.map((item) => (
              <TelemetryPath_ExtensionSkill key={item.id}>
                <MonitoredCatalogSkillCard
                  item={item}
                  installState={getInstallState(item)}
                  onInstall={onInstallCatalogItem}
                  onUse={onUseSkill ? (i) => onUseSkill(i.name) : undefined}
                  onClick={() => onSelectCatalogItem(item)}
                  onOpenFile={onOpenFile}
                  onUninstall={onUninstall}
                />
              </TelemetryPath_ExtensionSkill>
            ))}
          </HorizontalCarousel>
        </section>
      )}

      {/* Skills from Catalog — hidden until remote catalog is configured */}

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <SectionHeader divider={false}>Your Skills</SectionHeader>
          <div className="flex gap-1">
            <InteractiveElementMonitor_AddSkill callback={onAddSkill}>
              {(cb) => (
                <Button
                  size="xs"
                  className="bg-brand-action text-brand-action-fg hover:bg-brand-action-hover"
                  onClick={cb}
                >
                  <Plus className="mr-1 size-3" />
                  Add Skill
                </Button>
              )}
            </InteractiveElementMonitor_AddSkill>
            <InteractiveElementMonitor_ImportSkill callback={onImport}>
              {(cb) => (
                <Button variant="outline" size="xs" onClick={cb}>
                  <Download className="mr-1 size-3" />
                  Import
                </Button>
              )}
            </InteractiveElementMonitor_ImportSkill>
          </div>
        </div>
        {filteredCustomSkills.length > 0 ? (
          <HorizontalCarousel>
            {filteredCustomSkills.map((s) => (
              <CustomItemCard
                key={s.id}
                name={s.displayName ?? s.name}
                itemType="skills"
                slug={s.name}
                description={s.description}
                enabled={s.enabled}
                bundleDirs={s.bundleDirs}
                onClick={() => onSelectCustomSkill(s)}
                onToggle={onToggleSkill ? (enabled) => onToggleSkill(s.id, enabled) : undefined}
                onUse={onUseSkill ? () => onUseSkill(s.name) : undefined}
                onOpenFile={s.scope === "local" && onEditSkill ? () => onEditSkill(s) : undefined}
                onUninstall={
                  s.scope === "local" && onRemoveSkill ? () => onRemoveSkill(s.name) : undefined
                }
              />
            ))}
          </HorizontalCarousel>
        ) : (
          <p className="py-4 text-center text-base text-muted-foreground">
            {search ? "No skills match your search." : "No imported skills yet."}
          </p>
        )}
      </section>

      {showAddSkill && <AddSkillDialog onSave={onAddSkillSave} onClose={onAddSkillClose} />}
    </TabsContent>
  );
}

function MonitoredCatalogSkillCard({
  item,
  installState,
  onInstall,
  onUse,
  onClick,
  onOpenFile,
  onUninstall,
}: {
  item: CatalogItem;
  installState: InstallState;
  onInstall: (item: CatalogItem) => void;
  onUse?: (item: CatalogItem) => void;
  onClick: () => void;
  onOpenFile?: (item: CatalogItem) => void;
  onUninstall?: (item: CatalogItem) => void;
}) {
  const monitored = useInteractiveElementMonitor_InstallSkill({
    callback: onInstall,
    hasContent: installState === "available",
  });
  return (
    <CatalogCard
      item={item}
      installState={installState}
      onInstall={monitored}
      onUse={onUse}
      onClick={onClick}
      onOpenFile={onOpenFile}
      onUninstall={onUninstall}
    />
  );
}
