import { APP_NAME } from "@common/marshal-constants";

import { ArrowDown, ArrowUp, ChevronDown, HelpCircle, Plus, X } from "@/components/icons";
import { SectionHeader } from "@/components/marshal-ui/section-header";
import { Separator } from "@/components/marshal-ui/separator";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/marshal-ui/input";
import { Label } from "@/components/marshal-ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/marshal-ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/marshal-ui/marshal-tooltip";
import { useRelayAvailable } from "@/features/integrations/useRelayAvailability";
import { sortModels } from "@/runtime-ui/models/sort-models";
import { useAutomationCapabilities } from "@/shared/hooks/useAutomationCapabilities";
import { useDefaultModel, useModels } from "@/shared/hooks/useModels";

import { PermissionsSummary } from "../permissions/PermissionsSummary";
import type { AutomationFormState } from "./automation-form-state";

const CHECK_INTERVAL_OPTIONS = [
  { value: 5, label: "5 minutes" },
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 hour" },
] as const;

const GLOBAL_DEFAULT_MODEL_VALUE = "__global_default__";

export interface AutomationFormViewProps {
  mode: "create" | "edit";
  state: AutomationFormState;
  onChange: (patch: Partial<AutomationFormState>) => void;
  onManagePermissions: () => void;
  onCustomizePermissions: () => void;
  onSave: () => void;
  onCancel: () => void;
}

export function AutomationFormView({
  mode,
  state,
  onChange,
  onManagePermissions,
  onCustomizePermissions,
  onSave,
  onCancel,
}: AutomationFormViewProps) {
  const caps = useAutomationCapabilities();
  const hasRelay = useRelayAvailable();
  const { data: models = [] } = useModels();
  const { data: defaultModel = "" } = useDefaultModel();
  // Note: caps.workingDir and caps.skills are defined here for future per-field
  // gating — the form doesn't render those fields today but consumers should
  // read the flags from this hook when they do.

  const {
    name,
    description,
    steps,
    schedule,
    scheduleReadOnly,
    error,
    triggerType,
    condition,
    checkInterval,
    isOneShot,
    model,
    permissions,
    browserHeadless,
    teamsNotify,
  } = state;

  const addStep = () => {
    onChange({ steps: [...steps, { id: String(steps.length + 1), label: "", prompt: "" }] });
  };

  const removeStep = (index: number) => {
    if (steps.length <= 1) return;
    onChange({ steps: steps.filter((_, i) => i !== index) });
  };

  const updateStep = (index: number, field: "label" | "prompt", value: string) => {
    const updated = [...steps];
    updated[index] = { ...updated[index], [field]: value };
    onChange({ steps: updated });
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= steps.length) return;
    const updated = [...steps];
    [updated[index], updated[newIndex]] = [updated[newIndex], updated[index]];
    onChange({ steps: updated });
  };

  const intervalLabel =
    CHECK_INTERVAL_OPTIONS.find((o) => o.value === checkInterval)?.label ??
    `${checkInterval} minutes`;
  const sortedModels = sortModels(models);
  const defaultModelName = models.find((m) => m.id === defaultModel)?.name || defaultModel;
  const modelIsAvailable = model ? models.some((m) => m.id === model) : false;
  const unavailableModel = model && !modelIsAvailable ? model : undefined;

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-bold">
        {mode === "create" ? "New Automation" : "Edit Automation"}
      </h3>

      {/* Name */}
      <div className="space-y-1.5">
        <Label className="text-sm font-semibold">Name</Label>
        <Input
          value={name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="e.g. Morning Briefing"
        />
      </div>

      {/* Description */}
      <div className="space-y-1.5">
        <Label className="text-sm font-semibold">Description (optional)</Label>
        <Input
          value={description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="e.g. Check calendar and emails each morning"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="automation-model" className="text-sm font-semibold">
          Model
        </Label>
        <Select
          value={model ?? GLOBAL_DEFAULT_MODEL_VALUE}
          onValueChange={(value) =>
            onChange({
              model: value === GLOBAL_DEFAULT_MODEL_VALUE ? undefined : value,
            })
          }
        >
          <SelectTrigger id="automation-model" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={GLOBAL_DEFAULT_MODEL_VALUE}>
              {defaultModelName ? `Use global default (${defaultModelName})` : "Use global default"}
            </SelectItem>
            {unavailableModel && (
              <SelectItem value={unavailableModel} disabled>
                {unavailableModel} (no longer available - switch to clear)
              </SelectItem>
            )}
            {sortedModels.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name || m.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Choose a model for this automation, or inherit the global default.
        </p>
      </div>

      {/* Trigger toggle — only shown when the backend supports condition triggers */}
      {caps.conditionTrigger && (
        <div className="space-y-1.5">
          <Label className="text-sm font-semibold">Trigger</Label>
          <div
            className="flex rounded-full border border-border p-0.5"
            role="radiogroup"
            aria-label="Trigger type"
          >
            <button
              type="button"
              role="radio"
              aria-checked={triggerType === "schedule"}
              className={`flex-1 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                triggerType === "schedule"
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => onChange({ triggerType: "schedule" })}
            >
              Schedule
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={triggerType === "condition"}
              className={`flex-1 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                triggerType === "condition"
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => onChange({ triggerType: "condition" })}
            >
              Condition
            </button>
          </div>
        </div>
      )}

      {/* Schedule / Condition fields */}
      {triggerType === "schedule" ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Label className="text-sm font-semibold">Schedule</Label>
            {!scheduleReadOnly && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="Schedule format help"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <HelpCircle size={14} />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="block w-80 max-w-[90vw] p-3 text-xs whitespace-normal">
                  <div className="space-y-2">
                    <p className="font-semibold text-foreground">Schedule formats</p>
                    <p className="text-muted-foreground">
                      Schedules are written as plain English. The first phrase that matches one of
                      the supported patterns wins — anything else is rejected. Times accept{" "}
                      <code>9am</code>, <code>2:30pm</code>, or 24-hour <code>14:30</code>.
                    </p>
                    <p className="font-semibold text-foreground">Examples</p>
                    {isOneShot ? (
                      <ul className="space-y-1.5 text-muted-foreground">
                        <li>
                          <span className="block">Specific weekday:</span>
                          <code className="block text-foreground">Monday at 9am</code>
                        </li>
                        <li>
                          <span className="block">Specific weekday + minutes:</span>
                          <code className="block text-foreground">Friday at 2:30pm</code>
                        </li>
                      </ul>
                    ) : (
                      <ul className="space-y-1.5 text-muted-foreground">
                        <li>
                          <span className="block">Once a day:</span>
                          <code className="block text-foreground">every weekday at 9am</code>
                        </li>
                        <li>
                          <span className="block">Several times a day:</span>
                          <code className="block text-foreground">
                            every day at 9am, 12pm, and 5pm
                          </code>
                        </li>
                        <li>
                          <span className="block">Sub-hourly (intervals must divide a day):</span>
                          <code className="block text-foreground">
                            every 30 minutes during weekdays
                          </code>
                        </li>
                      </ul>
                    )}
                  </div>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          {scheduleReadOnly ? (
            <>
              <div
                className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
                aria-label="Schedule (read-only)"
                aria-readonly="true"
              >
                {schedule || "—"}
              </div>
              <p className="text-xs text-muted-foreground">
                {"This schedule isn’t editable here — update it in the source system."}
              </p>
            </>
          ) : (
            <Input
              value={schedule}
              onChange={(e) => onChange({ schedule: e.target.value })}
              placeholder={isOneShot ? "e.g. Monday at 9am" : "e.g. every weekday at 9am"}
            />
          )}
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label className="text-sm font-semibold">Condition</Label>
            <Textarea
              value={condition}
              onChange={(e) => onChange({ condition: e.target.value })}
              placeholder='e.g. "PR #123 in repo X is approved"'
              rows={2}
            />
            <p className="text-xs text-muted-foreground">
              Describe when this automation should run. Marshal checks this condition periodically
              using its own timer.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-sm font-semibold">Check every</Label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="w-full justify-between">
                  {intervalLabel}
                  <ChevronDown size={14} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-(--radix-dropdown-menu-trigger-width)"
              >
                {CHECK_INTERVAL_OPTIONS.map((opt) => (
                  <DropdownMenuItem
                    key={opt.value}
                    onSelect={() => onChange({ checkInterval: opt.value })}
                  >
                    {opt.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </>
      )}

      {/* Steps */}
      <div className="space-y-1.5">
        <Label className="text-sm font-semibold">Steps</Label>
        <div className="space-y-2">
          {steps.map((step, i) => (
            <div key={step.id} className="space-y-2 rounded-xl bg-muted/50 p-3">
              <div className="flex items-center gap-2">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-sm font-medium text-background">
                  {i + 1}
                </span>
                <Input
                  className="h-8"
                  value={step.label}
                  onChange={(e) => updateStep(i, "label", e.target.value)}
                  placeholder={`Step ${i + 1} label`}
                />
                <div className="flex gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => moveStep(i, -1)}
                    disabled={i === 0}
                    aria-label="Move step up"
                  >
                    <ArrowUp size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => moveStep(i, 1)}
                    disabled={i === steps.length - 1}
                    aria-label="Move step down"
                  >
                    <ArrowDown size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => removeStep(i)}
                    disabled={steps.length <= 1}
                    aria-label="Remove step"
                  >
                    <X size={14} />
                  </Button>
                </div>
              </div>
              <Textarea
                value={step.prompt}
                onChange={(e) => updateStep(i, "prompt", e.target.value)}
                placeholder={`What should ${APP_NAME} do in this step?`}
                rows={3}
              />
            </div>
          ))}
          {caps.multiStep ? (
            <Button variant="outline" className="w-full border-dashed" onClick={addStep}>
              <Plus size={14} />
              Add step
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="block">
                  <Button
                    variant="outline"
                    className="w-full border-dashed"
                    disabled
                    aria-label="Add step"
                  >
                    <Plus size={14} />
                    Add step
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>Multi-step automations require copilot mode.</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Browser — runtime launch behavior, independent of permissions. */}
      <Separator />
      <SectionHeader divider={false}>Browser</SectionHeader>
      <div className="flex items-start gap-2 pt-1">
        <Checkbox
          id="browser-headless"
          aria-describedby="browser-headless-desc"
          checked={browserHeadless}
          onCheckedChange={(v) => onChange({ browserHeadless: v === true })}
        />
        <div className="flex-1">
          <Label htmlFor="browser-headless" className="cursor-pointer">
            Run browser headless
          </Label>
          <p id="browser-headless-desc" className="text-xs text-(--color-text-secondary)">
            This automation&apos;s browser runs invisibly in the background — useful for unattended
            automations that don&apos;t need user interaction. Applies to all runs (scheduled,
            condition-triggered, and Run now).
          </p>
        </div>
      </div>

      {hasRelay && (
        <>
          <Separator />
          <SectionHeader divider={false}>Relay notifications</SectionHeader>
          <div className="flex items-start gap-3 pt-1">
            <div className="flex-1">
              {/* No `htmlFor` on this Label: Radix renders SelectTrigger as a
                  <button>, which isn't a labelable element. Wire the trigger to
                  the label via `aria-labelledby` instead — same pattern as the
                  "Sync now" / "Manage Permissions" rows in CloudSyncSection. */}
              <Label id="relay-notify-mode-label">Notify on relay</Label>
              <p id="relay-notify-mode-desc" className="text-xs text-(--color-text-secondary)">
                Controls whether this automation&apos;s results are sent to your connected relay.
                <br />
                <span className="font-medium">Always</span> — send the result every run
                (today&apos;s behavior). <span className="font-medium">Auto</span> — let the agent
                decide per run; nothing is sent unless the run produced something worth surfacing.{" "}
                <span className="font-medium">Never</span> — never send to the relay (the run still
                appears in history).
              </p>
            </div>
            <Select
              value={teamsNotify}
              onValueChange={(v) => {
                if (v === "always" || v === "auto" || v === "never") {
                  onChange({ teamsNotify: v });
                }
              }}
            >
              <SelectTrigger
                aria-labelledby="relay-notify-mode-label"
                aria-describedby="relay-notify-mode-desc"
                data-testid="relay-notify-select"
                className="w-[140px] rounded-xl"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="always">Always</SelectItem>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="never">Never</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </>
      )}

      {/* Permissions */}
      {caps.perAutomationPermissions && (
        <>
          <Separator />
          <SectionHeader divider={false}>
            {permissions ? "Permissions — Custom" : "Permissions — Global defaults"}
          </SectionHeader>
          <PermissionsSummary
            permissions={permissions}
            onManagePermissions={onManagePermissions}
            onCustomize={onCustomizePermissions}
            onReset={() => onChange({ permissions: undefined })}
            defaultsLabel="Using global permissions"
          />
        </>
      )}

      {/* Error */}
      {error && (
        <div
          role="alert"
          aria-live="polite"
          className="rounded-lg border border-brand-border bg-(--color-danger-bg) p-3 text-sm text-(--color-danger)"
        >
          {error}
        </div>
      )}

      {/* Footer actions */}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          className="bg-brand-action text-brand-action-fg hover:bg-brand-action-hover"
          onClick={onSave}
        >
          {mode === "create" ? "Create Automation" : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}
