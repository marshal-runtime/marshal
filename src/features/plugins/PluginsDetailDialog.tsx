import type { CatalogItem } from "@common/extensions-catalog/marshal-extension-catalog";
import type { ExtensionsCategory as PluginsCategory } from "@common/extensions-catalog/marshal-extension-catalog";
import type { ReactNode } from "react";
import { useState } from "react";

import { Download, LogIn, LogOut, Pencil, Save, Trash2 } from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/marshal-ui/input";
import { Label } from "@/components/marshal-ui/label";
import {
  InteractiveElementMonitor_EditSkill,
  InteractiveElementMonitor_ExportSkill,
  InteractiveElementMonitor_InstallMcpServer,
  InteractiveElementMonitor_InstallSkill,
  InteractiveElementMonitor_RemoveMcpServer,
  InteractiveElementMonitor_RemoveSkill,
  InteractiveElementMonitor_SaveMcpServerConfig,
  InteractiveElementMonitor_SaveSkillConfig,
  InteractiveElementMonitor_UninstallMcpServer,
  InteractiveElementMonitor_UninstallSkill,
  InteractiveElementMonitor_UseSkill,
  TelemetryPath_ExtensionMcpServer,
  TelemetryPath_ExtensionSkill,
  TelemetryPath_McpTab,
  TelemetryPath_SkillsTab,
} from "@/services/telemetry/schema";

import type { InstallState } from "./PluginsCard";

type DetailItem = { label: string; value: string; linkify?: boolean };

interface DetailDialogProps {
  item: CatalogItem | null;
  installState: InstallState;
  /** Full skill instructions to display in a scrollable area. */
  instructions?: string;
  /** Current config values for items with configParams. */
  configValues?: Record<string, string>;
  onClose: () => void;
  onInstall: (item: CatalogItem) => void;
  onUninstall?: (item: CatalogItem) => void;
  onOpenFile?: (item: CatalogItem) => void;
  onSaveConfig?: (item: CatalogItem, values: Record<string, string>) => void;
  onUse?: (item: CatalogItem) => void;
}

export function CatalogDetailDialog({
  item,
  installState,
  instructions,
  configValues,
  onClose,
  onInstall,
  onUninstall,
  onOpenFile,
  onSaveConfig,
  onUse,
}: DetailDialogProps) {
  const [localConfig, setLocalConfig] = useState(configValues ?? {});

  if (!item) return null;

  const hasConfigParams = item.configParams && item.configParams.length > 0;
  const isConfigured = installState === "installed" || installState === "needs-config";

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[80vh] max-w-[576px]! flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold">
            {item.displayName}
            {hasConfigParams ? " - Configuration" : ""}
          </DialogTitle>
          <DialogDescription className="text-xs text-foreground-secondary">
            {item.author}
          </DialogDescription>
        </DialogHeader>

        <p className="text-sm text-foreground">{item.description}</p>

        {instructions && (
          <div className="min-h-0 flex-1 overflow-y-auto rounded-md bg-muted p-3">
            <pre className="text-xs/relaxed whitespace-pre-wrap text-muted-foreground">
              {instructions}
            </pre>
          </div>
        )}

        {hasConfigParams && isConfigured && (
          <div className="flex flex-col gap-2">
            {item.configParams!.map((param) => (
              <div key={param.key} className="flex flex-col gap-2">
                <Label htmlFor={`config-${param.key}`} className="gap-0 text-sm font-semibold">
                  {param.label}
                  {param.required && <span className="text-destructive">&nbsp;*</span>}
                </Label>
                <Input
                  id={`config-${param.key}`}
                  className="rounded-xl"
                  placeholder={param.placeholder}
                  value={localConfig[param.key] ?? ""}
                  onChange={(e) =>
                    setLocalConfig((prev) => ({ ...prev, [param.key]: e.target.value }))
                  }
                />
              </div>
            ))}
          </div>
        )}

        {item.tags.length > 0 && (
          <div className="flex flex-wrap gap-3">
            {item.tags.map((tag) => (
              <span key={tag} className="text-xs text-foreground-secondary">
                {tag}
              </span>
            ))}
          </div>
        )}

        <CatalogDialogFooter
          item={item}
          installState={installState}
          hasConfigParams={!!hasConfigParams}
          localConfig={localConfig}
          onClose={onClose}
          onInstall={onInstall}
          onUninstall={onUninstall}
          onOpenFile={onOpenFile}
          onSaveConfig={onSaveConfig}
          onUse={onUse}
        />
      </DialogContent>
    </Dialog>
  );
}

/** Detail dialog for custom (user-created) items — skill or MCP server. */
export function CustomDetailDialog({
  open,
  title,
  icon,
  description,
  instructions,
  details,
  bundleDirs,
  itemType,
  onClose,
  onRemove,
  onUse,
  onExport,
  onEdit,
  primaryActionLabel,
  primaryActionInput,
  primaryActionDisabled,
  onPrimaryAction,
  secondaryActionLabel,
  secondaryActionDisabled,
  onSecondaryAction,
}: {
  open: boolean;
  title: string;
  icon: string;
  description?: string;
  instructions?: string;
  details?: DetailItem[];
  bundleDirs?: string[];
  itemType: PluginsCategory;
  onClose: () => void;
  onRemove?: () => void;
  onUse?: () => void;
  onExport?: () => void;
  onEdit?: () => void;
  primaryActionLabel?: string;
  primaryActionInput?: {
    label: string;
    placeholder: string;
    description?: string;
  };
  onPrimaryAction?: (inputValue?: string) => void | Promise<void>;
  /** Disable the primary action button (e.g. while a sign-out IPC is
   *  in flight) without removing it. Distinct from the dialog's internal
   *  `isPrimaryActionRunning` "Signing in..." state — that one fires only
   *  while a click is awaiting the user's callback; this one tracks an
   *  external mutation owned by the parent. */
  primaryActionDisabled?: boolean;
  /** Label for a secondary action (e.g. "Log out"). When provided alongside
   * `onSecondaryAction`, the dialog renders an outline button with a leading
   * `LogOut` icon in the left-hand cluster, grouped with Remove / Edit /
   * Export. Only rendered when both label and handler are provided. */
  secondaryActionLabel?: string;
  /** Disable the secondary action button (e.g. while a sign-out IPC is
   *  in flight) without removing it. */
  secondaryActionDisabled?: boolean;
  onSecondaryAction?: () => void | Promise<void>;
}) {
  const isSkill = itemType === "skills";
  const [isPrimaryActionRunning, setIsPrimaryActionRunning] = useState(false);
  const [primaryActionInputValue, setPrimaryActionInputValue] = useState("");
  const handlePrimaryAction = onPrimaryAction
    ? async () => {
        setIsPrimaryActionRunning(true);
        try {
          await onPrimaryAction(primaryActionInputValue.trim() || undefined);
        } finally {
          setIsPrimaryActionRunning(false);
        }
      }
    : undefined;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[80vh] max-w-lg! flex-col overflow-hidden">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <span className="text-3xl">{icon}</span>
            <DialogTitle>{title}</DialogTitle>
          </div>
        </DialogHeader>

        {description && <p className="text-sm text-foreground">{description}</p>}

        {instructions && (
          <div className="min-h-0 flex-1 overflow-y-auto rounded-md bg-muted p-3">
            <pre className="text-xs/relaxed whitespace-pre-wrap text-muted-foreground">
              {instructions}
            </pre>
          </div>
        )}

        {bundleDirs && bundleDirs.length > 0 && (
          <div>
            <span className="text-xs font-medium text-muted-foreground">Included directories</span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {bundleDirs.map((dir) => (
                <span
                  key={dir}
                  className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {dir}/
                </span>
              ))}
            </div>
          </div>
        )}

        {details?.map((d) => (
          <div key={d.label}>
            <span className="text-xs font-medium text-muted-foreground">{d.label}</span>
            <p className="mt-0.5 text-sm">{renderDetailValue(d.value, d.linkify !== false)}</p>
          </div>
        ))}

        {primaryActionLabel && primaryActionInput && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="mcp-primary-action-input" className="text-sm font-semibold">
              {primaryActionInput.label}
            </Label>
            <Input
              id="mcp-primary-action-input"
              className="rounded-xl"
              placeholder={primaryActionInput.placeholder}
              value={primaryActionInputValue}
              onChange={(e) => setPrimaryActionInputValue(e.target.value)}
            />
            {primaryActionInput.description && (
              <p className="text-xs text-muted-foreground">{primaryActionInput.description}</p>
            )}
          </div>
        )}

        {isSkill ? (
          <TelemetryPath_SkillsTab>
            <TelemetryPath_ExtensionSkill>
              <CustomDialogFooter
                onRemove={onRemove}
                onEdit={onEdit}
                onExport={onExport}
                onUse={onUse}
                onClose={onClose}
                RemoveMonitor={InteractiveElementMonitor_RemoveSkill}
                EditMonitor={InteractiveElementMonitor_EditSkill}
                ExportMonitor={InteractiveElementMonitor_ExportSkill}
                UseMonitor={InteractiveElementMonitor_UseSkill}
              />
            </TelemetryPath_ExtensionSkill>
          </TelemetryPath_SkillsTab>
        ) : (
          <TelemetryPath_McpTab>
            <TelemetryPath_ExtensionMcpServer>
              <CustomDialogFooter
                onRemove={onRemove}
                onClose={onClose}
                RemoveMonitor={InteractiveElementMonitor_RemoveMcpServer}
                primaryActionLabel={primaryActionLabel}
                onPrimaryAction={handlePrimaryAction}
                primaryActionBusy={isPrimaryActionRunning}
                primaryActionDisabled={primaryActionDisabled}
                secondaryActionLabel={secondaryActionLabel}
                secondaryActionDisabled={secondaryActionDisabled}
                onSecondaryAction={onSecondaryAction}
              />
            </TelemetryPath_ExtensionMcpServer>
          </TelemetryPath_McpTab>
        )}
      </DialogContent>
    </Dialog>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic monitor component type
type AnyMonitor = React.ComponentType<{ callback: any; children: (cb: any) => React.ReactNode }>;

function renderDetailValue(value: string, linkify = true): ReactNode {
  if (!linkify) return value;

  if (isLikelyUrl(value)) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noreferrer"
        className="text-primary underline underline-offset-2 hover:text-primary/80"
      >
        {value}
      </a>
    );
  }

  return value;
}

function isLikelyUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

function CustomDialogFooter({
  onRemove,
  onEdit,
  onExport,
  onUse,
  onClose,
  RemoveMonitor,
  EditMonitor,
  ExportMonitor,
  UseMonitor,
  primaryActionLabel,
  onPrimaryAction,
  primaryActionBusy = false,
  primaryActionDisabled,
  secondaryActionLabel,
  secondaryActionDisabled,
  onSecondaryAction,
}: {
  onRemove?: () => void;
  onEdit?: () => void;
  onExport?: () => void;
  onUse?: () => void;
  onClose: () => void;
  RemoveMonitor?: AnyMonitor;
  EditMonitor?: AnyMonitor;
  ExportMonitor?: AnyMonitor;
  UseMonitor?: AnyMonitor;
  primaryActionLabel?: string;
  onPrimaryAction?: () => void | Promise<void>;
  primaryActionBusy?: boolean;
  primaryActionDisabled?: boolean;
  secondaryActionLabel?: string;
  secondaryActionDisabled?: boolean;
  onSecondaryAction?: () => void | Promise<void>;
}) {
  // Layout mirrors CatalogDialogFooter:
  //   left  = outline-with-icon management/destructive actions
  //   right = brand-primary CTA (with icon) followed by neutral Close.
  // "Log out" is destructive so it lives in the left cluster alongside
  // Remove / Edit / Export rather than between Close and the primary CTA.
  return (
    <div className="flex w-full items-center justify-between pt-2">
      <div className="flex gap-3">
        {onRemove && (
          <MonitoredButton
            Monitor={RemoveMonitor}
            callback={() => {
              onRemove();
              onClose();
            }}
            variant="outline"
          >
            <Trash2 className="mr-2 size-4" />
            Remove
          </MonitoredButton>
        )}
        {onEdit && (
          <MonitoredButton
            Monitor={EditMonitor}
            callback={() => {
              onEdit();
              onClose();
            }}
            variant="outline"
          >
            <Pencil className="mr-2 size-4" />
            Edit
          </MonitoredButton>
        )}
        {onExport && (
          <MonitoredButton Monitor={ExportMonitor} callback={onExport} variant="outline">
            <Download className="mr-2 size-4" />
            Export
          </MonitoredButton>
        )}
        {onSecondaryAction && secondaryActionLabel && (
          <Button
            variant="outline"
            disabled={secondaryActionDisabled}
            onClick={() => void onSecondaryAction()}
          >
            <LogOut className="mr-2 size-4" />
            {secondaryActionLabel}
          </Button>
        )}
      </div>
      <div className="flex gap-3">
        {onUse && (
          <MonitoredButton
            Monitor={UseMonitor}
            callback={() => {
              onUse();
              onClose();
            }}
          >
            Use
          </MonitoredButton>
        )}
        {onPrimaryAction && primaryActionLabel && (
          <Button
            className="bg-brand-action text-brand-action-fg hover:bg-brand-action-hover"
            onClick={() => void onPrimaryAction()}
            disabled={primaryActionBusy || primaryActionDisabled}
          >
            <LogIn className="mr-2 size-4" />
            {primaryActionBusy ? "Signing in..." : primaryActionLabel}
          </Button>
        )}
        <DialogClose asChild>
          <Button variant="outline">Close</Button>
        </DialogClose>
      </div>
    </div>
  );
}

function MonitoredButton({
  Monitor,
  callback,
  variant,
  children,
}: {
  Monitor?: AnyMonitor;
  callback: () => void;
  variant?: "outline" | "ghost";
  children: React.ReactNode;
}) {
  if (!Monitor) {
    return (
      <Button variant={variant} onClick={callback}>
        {children}
      </Button>
    );
  }
  return (
    <Monitor callback={callback}>
      {(cb: () => void) => (
        <Button variant={variant} onClick={cb}>
          {children}
        </Button>
      )}
    </Monitor>
  );
}

function CatalogDialogFooter({
  item,
  installState,
  hasConfigParams,
  localConfig,
  onClose,
  onInstall,
  onUninstall,
  onOpenFile,
  onSaveConfig,
  onUse,
}: {
  item: CatalogItem;
  installState: InstallState;
  hasConfigParams: boolean;
  localConfig: Record<string, string>;
  onClose: () => void;
  onInstall: (item: CatalogItem) => void;
  onUninstall?: (item: CatalogItem) => void;
  onOpenFile?: (item: CatalogItem) => void;
  onSaveConfig?: (item: CatalogItem, values: Record<string, string>) => void;
  onUse?: (item: CatalogItem) => void;
}) {
  const isSkill = item.type === "skills";
  const isConfigured = installState === "installed" || installState === "needs-config";

  const SaveConfigMonitor = isSkill
    ? InteractiveElementMonitor_SaveSkillConfig
    : InteractiveElementMonitor_SaveMcpServerConfig;
  const UninstallMonitor = isSkill
    ? InteractiveElementMonitor_UninstallSkill
    : InteractiveElementMonitor_UninstallMcpServer;
  const InstallMonitor = isSkill
    ? InteractiveElementMonitor_InstallSkill
    : InteractiveElementMonitor_InstallMcpServer;

  const footer = (
    <div className="flex w-full items-center justify-between pt-2">
      <div className="flex gap-3">
        {isConfigured && onOpenFile && (
          <Button variant="outline" onClick={() => onOpenFile(item)}>
            <Pencil className="mr-2 size-4" />
            Open in Editor
          </Button>
        )}
        {isConfigured && onUninstall && (
          <UninstallMonitor callback={() => onUninstall(item)}>
            {(cb) => (
              <Button variant="outline" onClick={cb}>
                <Trash2 className="mr-2 size-4" />
                Uninstall
              </Button>
            )}
          </UninstallMonitor>
        )}
      </div>
      <div className="flex gap-3">
        {installState === "available" && (
          <InstallMonitor
            callback={() => {
              onInstall(item);
              onClose();
            }}
          >
            {(cb) => (
              <Button
                className="bg-brand-action text-brand-action-fg hover:bg-brand-action-hover"
                onClick={cb}
              >
                <Download className="mr-2 size-4" />
                Install
              </Button>
            )}
          </InstallMonitor>
        )}
        {(installState === "installed" || installState === "built-in") &&
          onUse &&
          item.type === "skills" && (
            <InteractiveElementMonitor_UseSkill
              callback={() => {
                onUse(item);
                onClose();
              }}
            >
              {(cb) => (
                <Button
                  className="bg-brand-action text-brand-action-fg hover:bg-brand-action-hover"
                  onClick={cb}
                >
                  Use
                </Button>
              )}
            </InteractiveElementMonitor_UseSkill>
          )}
        {hasConfigParams && isConfigured && onSaveConfig && (
          <SaveConfigMonitor
            callback={() => {
              onSaveConfig(item, localConfig);
              onClose();
            }}
          >
            {(cb) => (
              <Button
                className="bg-brand-action text-brand-action-fg hover:bg-brand-action-hover"
                onClick={cb}
                disabled={item.configParams!.some((p) => p.required && !localConfig[p.key]?.trim())}
              >
                <Save className="mr-2 size-4" />
                Save config
              </Button>
            )}
          </SaveConfigMonitor>
        )}
        <DialogClose asChild>
          <Button variant="outline">Close</Button>
        </DialogClose>
      </div>
    </div>
  );

  return isSkill ? (
    <TelemetryPath_SkillsTab>
      <TelemetryPath_ExtensionSkill>{footer}</TelemetryPath_ExtensionSkill>
    </TelemetryPath_SkillsTab>
  ) : (
    <TelemetryPath_McpTab>
      <TelemetryPath_ExtensionMcpServer>{footer}</TelemetryPath_ExtensionMcpServer>
    </TelemetryPath_McpTab>
  );
}
