// src/features/workflows/DefaultRunRenderer.tsx
//
// 3-column default renderer for any workflow run that does NOT ship a
// custom renderer (which is 100% of workflows in V1 — custom renderers
// from user-installed workflows are deferred to V2 per R1-FIXES C-UI §16.1).
//
//   ┌─ Steps (300px) ───┬─ Center (flex) ─────────────┬─ Artifacts (320px) ┐
//   │ Phase-nav rail.   │ Sub-agent session, OR the   │ List of step/run    │
//   │ Click to scroll   │ selected artifact's Monaco  │ artifacts. Click a  │
//   │ to the unit grid. │ preview (with a Back btn).  │ row → center preview.│
//   └───────────────────┴─────────────────────────────┴─────────────────────┘
//
// Styling uses Marshal theme tokens only.

import type {
  AgentHandleSummary,
  ArtifactRefSummary,
  ExecutionUnitStatus,
  FanOutUnit,
  RunActions,
  RunSnapshot,
  StepStatus,
  StepView,
} from "@common/workflows-contract";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { ArrowLeft, Copy, Download } from "@/components/icons";
import { Badge } from "@/components/marshal-ui/badge";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/marshal-ui/marshal-tooltip";
import { Separator } from "@/components/marshal-ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChatPanel } from "@/features/chat";
import { cn } from "@/lib/marshal-class-names";
import { useDocumentTheme } from "@/shared/hooks/useTheme";

import { formatDuration, STEP_STATUS_GLYPH, UNIT_STATUS_GLYPH } from "./format";

// Lazy-load Monaco (keeps the ~4MB editor in its own chunk, shared with the
// Co-create file preview's MonacoEditor).
const MonacoEditor = lazy(() =>
  import("@/features/create/filepreview/MonacoEditor").then((m) => ({ default: m.MonacoEditor })),
);

/** The fanOut wrapper step is created internally with a `__fanOut` label. */
function displayStepLabel(label: string): string {
  return label === "__fanOut" ? "Fan-out" : label;
}

interface DefaultRunRendererProps {
  runSnapshot: RunSnapshot;
  actions: RunActions;
}

export function DefaultRunRenderer({ runSnapshot, actions }: DefaultRunRendererProps) {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [selectedArtifactKey, setSelectedArtifactKey] = useState<string | null>(null);
  const [selectedHandleId, setSelectedHandleId] = useState<string | null>(null);

  const activeStep = useMemo(() => {
    if (selectedStepId) {
      return runSnapshot.steps.find((s) => s.id === selectedStepId) ?? null;
    }
    // Default selection = newest running, falling back to newest step.
    const running = [...runSnapshot.steps].reverse().find((s) => s.status === "running");
    return running ?? runSnapshot.steps[runSnapshot.steps.length - 1] ?? null;
  }, [runSnapshot.steps, selectedStepId]);

  const activeAgents = useMemo(() => {
    if (!activeStep) return [];
    const byHandle = (handleId: string | undefined): AgentHandleSummary | null =>
      handleId ? (runSnapshot.agents[handleId] ?? null) : null;

    const collected = new Map<string, AgentHandleSummary>();
    const add = (a: AgentHandleSummary | null) => {
      if (a) collected.set(a.handleId, a);
    };

    // 1. Agents the reducer linked directly to this step.
    for (const sid of activeStep.directAgents ?? []) add(byHandle(sid));
    // 2. Agents from this step's own fanOut units (fanOut parent step).
    for (const u of activeStep.units ?? []) add(byHandle(u.handleId));
    // 3. Robust fallback: any agent whose stepKey IS this step or a descendant
    //    of it. Covers fanOut UNIT inner steps (selected from the left rail)
    //    and failed/stalled agents that never got linked via directAgents.
    for (const a of Object.values(runSnapshot.agents)) {
      if (a.stepKey && (a.stepKey === activeStep.id || a.stepKey.startsWith(`${activeStep.id}/`))) {
        add(a);
      }
    }
    return [...collected.values()];
  }, [activeStep, runSnapshot.agents]);

  // Which sub-agent session is mounted in the center pane. Defaults to the
  // active step's running (or first) agent and falls back automatically when
  // the selected handle isn't part of the active step (e.g. after switching
  // steps), so the embedded session always tracks the visible step.
  const selectedAgent = useMemo(() => {
    if (activeAgents.length === 0) return null;
    return (
      activeAgents.find((a) => a.handleId === selectedHandleId) ??
      activeAgents.find((a) => a.status === "running") ??
      activeAgents[0]
    );
  }, [activeAgents, selectedHandleId]);

  const selectedArtifact = useMemo(
    () =>
      selectedArtifactKey
        ? (runSnapshot.artifacts.find((a) => a.key === selectedArtifactKey) ?? null)
        : null,
    [runSnapshot.artifacts, selectedArtifactKey],
  );

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      <PhaseNavigationPanel
        steps={runSnapshot.steps}
        selectedStepId={activeStep?.id ?? null}
        onSelect={setSelectedStepId}
      />
      <Separator orientation="vertical" />
      <div className="flex min-w-0 flex-1 flex-col">
        {selectedArtifact ? (
          <ArtifactPreviewPane
            runId={runSnapshot.runId}
            artifact={selectedArtifact}
            onBack={() => setSelectedArtifactKey(null)}
          />
        ) : (
          <AgentSessionPane
            step={activeStep}
            agents={activeAgents}
            units={activeStep?.units ?? []}
            selectedAgent={selectedAgent}
            onSelectAgent={setSelectedHandleId}
            onOpenChat={actions.openSubagentChat}
          />
        )}
      </div>
      <Separator orientation="vertical" />
      <WorkflowArtifactsPanel
        artifacts={runSnapshot.artifacts}
        stepArtifactKeys={activeStep?.artifacts ?? []}
        stepLabel={activeStep ? displayStepLabel(activeStep.label) : null}
        selectedKey={selectedArtifactKey}
        onSelect={setSelectedArtifactKey}
      />
    </div>
  );
}

// ── PhaseNavigationPanel (left rail) ────────────────────────────────────────

function PhaseNavigationPanel({
  steps,
  selectedStepId,
  onSelect,
}: {
  steps: ReadonlyArray<StepView>;
  selectedStepId: string | null;
  onSelect: (stepId: string) => void;
}) {
  return (
    <aside aria-label="Workflow steps" className="flex w-[280px] shrink-0 flex-col bg-background">
      <div className="border-b border-border px-4 py-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Steps
      </div>
      <ScrollArea className="flex-1">
        <ol role="list" className="flex flex-col">
          {steps.length === 0 && (
            <li className="px-4 py-6 text-sm text-muted-foreground">No steps yet.</li>
          )}
          {steps.map((step) => (
            <li key={step.id} role="listitem">
              <StepRow
                step={step}
                selected={selectedStepId === step.id}
                onClick={() => onSelect(step.id)}
              />
            </li>
          ))}
        </ol>
      </ScrollArea>
    </aside>
  );
}

function StepRow({
  step,
  selected,
  onClick,
}: {
  step: StepView;
  selected: boolean;
  onClick: () => void;
}) {
  const elapsed =
    step.startedAt != null && step.endedAt != null
      ? formatDuration(step.endedAt - step.startedAt)
      : step.startedAt != null
        ? "running"
        : "—";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? "step" : undefined}
      aria-label={`Step ${step.label} (${step.status})`}
      className={cn(
        "flex w-full flex-col items-stretch gap-1 border-l-2 border-transparent px-4 py-2 text-left text-sm transition-colors hover:bg-muted",
        selected && "border-(--brand-border) bg-muted",
      )}
      style={{ paddingLeft: 16 + (step.depth ?? 0) * 12 }}
    >
      <div className="flex items-center gap-2">
        <span className={cn("font-mono text-base", statusColor(step.status))} aria-hidden="true">
          {STEP_STATUS_GLYPH[step.status]}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{displayStepLabel(step.label)}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{elapsed}</span>
      </div>
      {step.units && step.units.length > 0 && (
        <div className="ml-6 text-xs text-muted-foreground">
          {step.units.filter((u) => u.status === "succeeded").length}/{step.units.length} units
        </div>
      )}
      {step.error?.message && (
        <div className="ml-6 truncate text-xs text-(--warning-primary)">{step.error.message}</div>
      )}
    </button>
  );
}

function statusColor(status: StepStatus): string {
  switch (status) {
    case "succeeded":
      return "text-(--success-loud)";
    case "failed":
      return "text-(--warning-primary)";
    case "running":
      return "text-(--brand-border)";
    case "skipped-replay":
      return "text-muted-foreground";
    default:
      return "text-muted-foreground";
  }
}

// ── AgentSessionPane (center pane) ──────────────────────────────────────────
//
// The center column embeds the *exact same* `ChatPanel` the Chat tab uses,
// pointed at the selected sub-agent's session id — so a workflow agent's full
// transcript (streaming, tool calls, reasoning, timeline) renders here with no
// separate plumbing, and the input box lets you steer it in place. For fanOut
// steps the unit grid stays as an always-on overview/selector above the
// embedded session; non-agent steps show a minimal empty state.

function AgentSessionPane({
  step,
  agents,
  units,
  selectedAgent,
  onSelectAgent,
  onOpenChat,
}: {
  step: StepView | null;
  agents: AgentHandleSummary[];
  units: ReadonlyArray<FanOutUnit>;
  selectedAgent: AgentHandleSummary | null;
  onSelectAgent: (handleId: string) => void;
  onOpenChat: (sessionId: string) => void;
}) {
  if (!step) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Waiting for the first step to start…
      </div>
    );
  }

  const isFanOut = step.kind === "fanOut" && units.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-baseline justify-between border-b border-border px-6 py-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <h3 className="truncate text-lg font-semibold">{displayStepLabel(step.label)}</h3>
          {step.kind && (
            <Badge variant="outline" className="shrink-0 uppercase">
              {step.kind}
            </Badge>
          )}
        </div>
        <span className={cn("font-mono text-sm", statusColor(step.status))}>
          {STEP_STATUS_GLYPH[step.status]} {step.status}
        </span>
      </div>

      {isFanOut ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-border px-4 py-2">
            <ScrollArea className="max-h-40">
              <UnitGrid
                units={units}
                selectedHandleId={selectedAgent?.handleId ?? null}
                onSelect={onSelectAgent}
              />
            </ScrollArea>
          </div>
          <SessionRegion
            agent={selectedAgent}
            emptyHint="Select a unit above to view its sub-agent session."
            onOpenChat={onOpenChat}
          />
        </div>
      ) : agents.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {step.status === "running"
            ? "No sub-agents spawned yet for this step."
            : step.status === "failed"
              ? "This step failed before a sub-agent session was attached, or its agent was cancelled. Check the event log for the failure."
              : "This step ran no sub-agents."}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {agents.length > 1 && (
            <div className="flex shrink-0 flex-wrap gap-2 border-b border-border px-4 py-2">
              {agents.map((agent) => (
                <AgentChip
                  key={agent.handleId}
                  agent={agent}
                  selected={agent.handleId === selectedAgent?.handleId}
                  onSelect={() => onSelectAgent(agent.handleId)}
                />
              ))}
            </div>
          )}
          <SessionRegion agent={selectedAgent} onOpenChat={onOpenChat} />
        </div>
      )}
    </div>
  );
}

// Embeds the real session transcript for the selected sub-agent. Keyed on the
// session id so switching agents fully remounts (no cross-session bleed).
function SessionRegion({
  agent,
  emptyHint,
  onOpenChat,
}: {
  agent: AgentHandleSummary | null;
  emptyHint?: string;
  onOpenChat: (sessionId: string) => void;
}) {
  if (!agent || !agent.sessionId) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {agent && !agent.sessionId
          ? "Waiting for the sub-agent session to start…"
          : (emptyHint ?? "No sub-agent session selected.")}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-1.5">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" className="shrink-0">
            {agent.status}
          </Badge>
          <span className="truncate">{agent.identity ?? agent.agentName ?? "sub-agent"}</span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => onOpenChat(agent.sessionId)}>
          Open in Chat tab
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <ChatPanel key={agent.sessionId} sessionId={agent.sessionId} />
      </div>
    </div>
  );
}

function AgentChip({
  agent,
  selected,
  onSelect,
}: {
  agent: AgentHandleSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`Sub-agent ${agent.identity ?? agent.agentName ?? agent.handleId} (${agent.status})`}
      className={cn(
        "flex max-w-[220px] items-center gap-2 rounded-card border px-2.5 py-1.5 text-left text-xs",
        selected ? "border-(--brand-border) bg-muted" : "border-border hover:bg-muted",
      )}
    >
      <span className="truncate font-medium">
        {agent.identity ?? agent.agentName ?? "sub-agent"}
      </span>
      <Badge variant="outline" className="shrink-0">
        {agent.status}
      </Badge>
    </button>
  );
}

function UnitGrid({
  units,
  selectedHandleId,
  onSelect,
}: {
  units: ReadonlyArray<FanOutUnit>;
  selectedHandleId: string | null;
  onSelect: (handleId: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
      {units.map((unit) => (
        <UnitCard
          key={unit.itemKey}
          unit={unit}
          selected={!!unit.handleId && unit.handleId === selectedHandleId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function UnitCard({
  unit,
  selected,
  onSelect,
}: {
  unit: FanOutUnit;
  selected: boolean;
  onSelect: (handleId: string) => void;
}) {
  const enabled = !!unit.handleId;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={!enabled}
          onClick={() => unit.handleId && onSelect(unit.handleId)}
          aria-pressed={selected}
          className={cn(
            "flex flex-col items-stretch gap-1 rounded-card border bg-background p-2 text-left text-xs",
            selected ? "border-(--brand-border) bg-muted" : "border-border",
            enabled
              ? "cursor-pointer hover:border-(--brand-border) hover:bg-muted"
              : "cursor-default opacity-70",
          )}
          aria-label={`Unit ${unit.itemKey} (${unit.status})`}
        >
          <div className="flex items-center justify-between gap-1">
            <span className={cn("font-mono", unitStatusColor(unit.status))}>
              {UNIT_STATUS_GLYPH[unit.status]}
            </span>
            <span className="truncate text-[10px] text-muted-foreground">{unit.status}</span>
          </div>
          <div className="truncate font-medium">{unit.itemSummary ?? unit.itemKey}</div>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {unit.itemKey}
        {unit.sessionId && <div className="text-[10px] opacity-70">{unit.sessionId}</div>}
      </TooltipContent>
    </Tooltip>
  );
}

function unitStatusColor(status: ExecutionUnitStatus): string {
  switch (status) {
    case "succeeded":
      return "text-(--success-loud)";
    case "failed":
      return "text-(--warning-primary)";
    case "running":
      return "text-(--brand-border)";
    default:
      return "text-muted-foreground";
  }
}

// ── WorkflowArtifactsPanel (right pane) ────────────────────────────────────

function WorkflowArtifactsPanel({
  artifacts,
  stepArtifactKeys,
  stepLabel,
  selectedKey,
  onSelect,
}: {
  artifacts: ReadonlyArray<ArtifactRefSummary>;
  stepArtifactKeys: ReadonlyArray<string>;
  stepLabel: string | null;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
}) {
  // Default to the selected step's own artifacts; fall back to all-run when the
  // step produced none (so the panel is never misleadingly empty).
  const hasStepArtifacts = stepArtifactKeys.length > 0;
  const [scope, setScope] = useState<"step" | "all">("step");
  const effectiveScope = scope === "step" && hasStepArtifacts ? "step" : "all";

  const stepKeySet = useMemo(() => new Set(stepArtifactKeys), [stepArtifactKeys]);
  const shown = useMemo(
    () => (effectiveScope === "step" ? artifacts.filter((a) => stepKeySet.has(a.key)) : artifacts),
    [artifacts, effectiveScope, stepKeySet],
  );

  return (
    <aside
      aria-label="Workflow artifacts"
      className="flex w-[340px] shrink-0 flex-col bg-background"
    >
      <div className="border-b border-border px-4 py-3">
        <div className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Artifacts
        </div>
        <div className="mt-2 flex gap-1" role="tablist" aria-label="Artifact scope">
          <button
            type="button"
            role="tab"
            aria-selected={effectiveScope === "step"}
            disabled={!hasStepArtifacts}
            onClick={() => setScope("step")}
            className={cn(
              "rounded-sm px-2 py-0.5 text-xs",
              effectiveScope === "step"
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted",
              !hasStepArtifacts && "cursor-default opacity-50 hover:bg-transparent",
            )}
          >
            This step ({stepArtifactKeys.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={effectiveScope === "all"}
            onClick={() => setScope("all")}
            className={cn(
              "rounded-sm px-2 py-0.5 text-xs",
              effectiveScope === "all"
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            All ({artifacts.length})
          </button>
        </div>
        {effectiveScope === "step" && stepLabel && (
          <div className="mt-1 truncate text-[11px] text-muted-foreground">{stepLabel}</div>
        )}
      </div>
      <ScrollArea className="flex-1">
        {shown.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            {effectiveScope === "step"
              ? "No artifacts from this step."
              : "No artifacts produced yet."}
          </p>
        ) : (
          <ul className="flex flex-col">
            {shown.map((a) => (
              <li key={a.key}>
                <button
                  type="button"
                  onClick={() => onSelect(a.key === selectedKey ? null : a.key)}
                  aria-pressed={a.key === selectedKey}
                  className={cn(
                    "flex w-full flex-col items-stretch gap-0.5 border-l-2 border-transparent px-4 py-2 text-left text-sm hover:bg-muted",
                    a.key === selectedKey && "border-(--brand-border) bg-muted",
                  )}
                >
                  <span className="truncate font-medium">{a.key}</span>
                  <span className="text-xs text-muted-foreground">
                    {humanBytes(a.sizeBytes)} · {a.mime}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </aside>
  );
}

// ── ArtifactPreviewPane (center pane, replaces the agent session) ───────────
//
// When an artifact row is clicked, the center column swaps from the sub-agent
// session to a full Monaco view of the artifact, with a Back button to return.
function ArtifactPreviewPane({
  runId,
  artifact,
  onBack,
}: {
  runId: string;
  artifact: ArtifactRefSummary;
  onBack: () => void;
}) {
  const theme = useDocumentTheme();
  const [preview, setPreview] = useState<{
    storageKey: string;
    content: string;
    encoding: "utf8" | "base64";
    error?: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.workflowsAPI
      ?.readArtifact?.(runId, artifact.storageKey)
      .then((result) => {
        if (cancelled) return;
        if (!result?.success || result.content === undefined || !result.encoding) {
          setPreview({
            storageKey: artifact.storageKey,
            content: "",
            encoding: "utf8",
            error: result?.error ?? "Read failed",
          });
          return;
        }
        setPreview({
          storageKey: artifact.storageKey,
          content: result.content,
          encoding: result.encoding,
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setPreview({
            storageKey: artifact.storageKey,
            content: "",
            encoding: "utf8",
            error: String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.storageKey, runId]);

  const ready = preview?.storageKey === artifact.storageKey ? preview : null;
  const isText = !!ready && !ready.error && ready.encoding === "utf8";

  const handleCopy = () => {
    if (!isText) return;
    void navigator.clipboard
      .writeText(ready.content)
      .then(() => toast.success("Artifact copied"))
      .catch(() => toast.error("Copy failed"));
  };

  const handleDownload = () => {
    if (!ready) return;
    const blob =
      ready.encoding === "utf8"
        ? new Blob([ready.content], { type: artifact.mime || "text/plain" })
        : base64ToBlob(ready.content, artifact.mime || "application/octet-stream");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = artifact.key;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="sm" className="shrink-0 gap-1.5" onClick={onBack}>
            <ArrowLeft className="size-4" />
            Back
          </Button>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{artifact.key}</div>
            <div className="truncate text-xs text-muted-foreground">
              {artifact.storageKey} · {humanBytes(artifact.sizeBytes)} · {artifact.mime}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={handleCopy}
            disabled={!isText}
          >
            <Copy className="size-4" />
            Copy
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={handleDownload}
            disabled={!ready}
          >
            <Download className="size-4" />
            Download
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {!ready && (
          <p className="px-6 py-4 text-sm text-muted-foreground italic">Loading preview…</p>
        )}
        {ready?.error && (
          <p className="px-6 py-4 text-sm text-(--warning-primary)">{ready.error}</p>
        )}
        {ready && !ready.error && ready.encoding === "base64" && (
          <p className="px-6 py-4 text-sm text-muted-foreground italic">
            Binary artifact — use Download to inspect it.
          </p>
        )}
        {isText && (
          <Suspense
            fallback={
              <p className="px-6 py-4 text-sm text-muted-foreground italic">Loading editor…</p>
            }
          >
            <MonacoEditor
              value={ready.content}
              language={artifactLanguage(artifact.key, artifact.mime)}
              theme={theme}
              testId="workflow-artifact-monaco"
              onChange={NOOP_ON_CHANGE}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

/** Monaco is read-only for artifacts (immutable run output); ignore edits. */
function NOOP_ON_CHANGE(): void {
  /* artifacts are immutable */
}

/** Infer a Monaco language id from the artifact key/extension or mime. */
function artifactLanguage(key: string, mime: string): string {
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "json":
      return "json";
    case "jsonl":
    case "ndjson":
      return "plaintext";
    case "md":
    case "markdown":
      return "markdown";
    case "yaml":
    case "yml":
      return "yaml";
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "html":
      return "html";
    case "css":
      return "css";
    default:
      if (mime.includes("json")) return "json";
      if (mime.includes("markdown")) return "markdown";
      return "plaintext";
  }
}

/** Decode a base64 string to a Blob for the Download affordance. */
function base64ToBlob(b64: string, mime: string): Blob {
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
