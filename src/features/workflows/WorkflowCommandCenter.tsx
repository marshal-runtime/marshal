import type { RunHistoryEntry, RunSnapshot } from "@common/workflows-contract";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Badge } from "@/components/marshal-ui/badge";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/marshal-ui/marshal-tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChatPanel } from "@/features/chat/components/ChatPanel";
import { cn } from "@/lib/marshal-class-names";

import { formatRelative } from "./format";

interface WorkflowCommandCenterProps {
  runSnapshot: RunSnapshot;
}

type JsonRecord = Record<string, unknown>;

interface CommandCenterData {
  runs: RunHistoryEntry[];
  stateEntries: ReadonlyArray<{
    key: string;
    sizeBytes: number;
    writtenAt: number;
    runId?: string;
  }>;
  shiftLedger?: JsonRecord;
  stewardDecision?: JsonRecord;
  reasonerOutput?: JsonRecord;
  trackingReport?: string;
  buckets: JsonRecord[];
  trackingItems: JsonRecord[];
  investigations: JsonRecord[];
  actionCenterItems: JsonRecord[];
  loadErrors: string[];
}

const JSON_ARTIFACT_KEYS = [
  "shift-ledger-summary.json",
  "steward-decision.json",
  "reasoner-output.json",
  "incident-buckets.json",
  "incident-tracking-items.json",
  "incident-investigations.json",
] as const;

export function WorkflowCommandCenter({ runSnapshot }: WorkflowCommandCenterProps) {
  const [selectedChat, setSelectedChat] = useState<{ sessionId: string; label?: string } | null>(
    null,
  );
  const { data, isLoading } = useQuery<CommandCenterData>({
    queryKey: ["workflows", "command-center", runSnapshot],
    queryFn: () => loadCommandCenterData(runSnapshot),
    enabled: Boolean(runSnapshot.runId),
  });

  const center = data ?? emptyCommandCenterData();
  const steward = center.stewardDecision;
  const reasoner = center.reasonerOutput;
  const ledger = center.shiftLedger;
  const failedSteps = runSnapshot.steps.filter((step) => step.status === "failed");
  const proposals = arrayOfRecords(steward?.workItemProposals);
  const actionLedger = arrayOfRecords(steward?.actionLedger);
  const actionCenterItems = [
    ...center.actionCenterItems,
    ...arrayOfRecords(steward?.actionCenter),
    ...arrayOfRecords(runSnapshot.actionCenterItems),
  ];
  const actionCenter = arrayOfRecords(steward?.actionCenter);
  const correlations = arrayOfRecords(steward?.correlations);
  const rootCauses = arrayOfRecords(reasoner?.rootCauseConclusions);
  const daoItems = arrayOfRecords(reasoner?.daoItems);
  const bugItems = arrayOfRecords(reasoner?.bugItems);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b border-border px-5 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Workflow command center</h2>
            <p className="text-sm text-muted-foreground">
              Operational context, decisions, and work queue for this workflow.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">{runSnapshot.workflowId}</Badge>
            <Badge className={statusClass(runSnapshot.status)}>{runSnapshot.status}</Badge>
          </div>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-5">
          {isLoading && <MutedPanel>Loading command-center context…</MutedPanel>}
          {center.loadErrors.length > 0 && (
            <Card className="border-(--warning-primary)/40 bg-(--warning-subtle)" size="sm">
              <CardHeader>
                <CardTitle>Partial command-center data</CardTitle>
                <CardDescription>{center.loadErrors.slice(0, 3).join(" · ")}</CardDescription>
              </CardHeader>
            </Card>
          )}
          {failedSteps.length > 0 && (
            <Card className="border-(--warning-primary)/40 bg-(--warning-subtle)" size="sm">
              <CardHeader>
                <CardTitle>Run caveats</CardTitle>
                <CardDescription>
                  {failedSteps.length} step(s) failed or fell back; downstream phases may still have
                  completed.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-1">
                {failedSteps.slice(0, 4).map((step) => (
                  <div key={step.id} className="text-sm">
                    <span className="font-medium">{step.label}</span>
                    {step.error?.message && (
                      <span className="text-muted-foreground"> — {step.error.message}</span>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Incidents" value={numberText(ledger?.incidentCount)} />
            <MetricCard label="Buckets" value={numberText(ledger?.bucketCount)} />
            <MetricCard label="Tracking items" value={numberText(ledger?.trackingItemCount)} />
            <MetricCard label="Cursor advanced" value={boolText(ledger?.cursorAdvanced)} />
          </div>

          <div
            className={cn(
              "grid gap-4",
              selectedChat && "xl:grid-cols-[minmax(0,1fr)_minmax(360px,520px)]",
            )}
          >
            <Tabs defaultValue="overview" className="min-h-[560px]">
              <TabsList variant="line" className="w-full justify-start overflow-x-auto">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="issues">Issues & roots</TabsTrigger>
                <TabsTrigger value="actions">Actions</TabsTrigger>
                <TabsTrigger value="history">History & state</TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="space-y-4 pt-4">
                <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
                  <SummaryCard title="Steward summary" value={stringValue(steward?.summary)} />
                  <SummaryCard title="Tracking report" value={center.trackingReport} />
                </div>
                <div className="grid gap-4 lg:grid-cols-3">
                  <ListCard
                    title="Investigations"
                    count={center.investigations.length}
                    items={center.investigations}
                    renderItem={(item) => (
                      <CompactItem
                        title={
                          stringValue(item.incidentId) || stringValue(item.title) || "Incident"
                        }
                        description={stringValue(item.summary)}
                        badge={truthy(item.worthTracking) ? "tracking" : undefined}
                      />
                    )}
                  />
                  <ListCard
                    title="Buckets"
                    count={center.buckets.length}
                    items={center.buckets}
                    renderItem={(item) => (
                      <CompactItem
                        title={stringValue(item.name) || "Bucket"}
                        description={stringValue(item.description)}
                        badge={stringValue(item.confidence)}
                      >
                        <EvidenceReferences item={item} onSelect={setSelectedChat} />
                      </CompactItem>
                    )}
                  />
                  <ListCard
                    title="Tracking candidates"
                    count={center.trackingItems.length}
                    items={center.trackingItems}
                    renderItem={(item) => (
                      <CompactItem
                        title={stringValue(item.title) || "Tracking item"}
                        description={stringValue(item.nextAction) || stringValue(item.rationale)}
                        badge={stringValue(item.priority)}
                      />
                    )}
                  />
                </div>
              </TabsContent>

              <TabsContent value="issues" className="space-y-4 pt-4">
                <div className="grid gap-4 lg:grid-cols-2">
                  <ListCard
                    title="Root-cause conclusions"
                    count={rootCauses.length}
                    items={rootCauses}
                    renderItem={(item) => (
                      <CompactItem
                        title={
                          stringValue(item.rootCause) || stringValue(item.bucket) || "Root cause"
                        }
                        description={stringValue(item.rationale)}
                        badge={stringValue(item.status) || stringValue(item.confidence)}
                      />
                    )}
                  />
                  <ListCard
                    title="Correlations"
                    count={correlations.length}
                    items={correlations}
                    renderItem={(item) => (
                      <CompactItem
                        title={stringValue(item.correlationType) || "Correlation"}
                        description={stringValue(item.rationale)}
                        badge={stringValue(item.confidence)}
                      />
                    )}
                  />
                  <ListCard
                    title="DAO items"
                    count={daoItems.length}
                    items={daoItems}
                    renderItem={(item) => (
                      <CompactItem
                        title={stringValue(item.title) || "DAO item"}
                        description={stringValue(item.nextAction) || stringValue(item.rationale)}
                        badge={stringValue(item.priority)}
                      />
                    )}
                  />
                  <ListCard
                    title="Bug items"
                    count={bugItems.length}
                    items={bugItems}
                    empty="No bug-ready items."
                    renderItem={(item) => (
                      <CompactItem
                        title={stringValue(item.title) || "Bug item"}
                        description={stringValue(item.rationale)}
                        badge={stringValue(item.priority)}
                      />
                    )}
                  />
                </div>
              </TabsContent>

              <TabsContent value="actions" className="space-y-4 pt-4">
                <div className="grid gap-4 lg:grid-cols-3">
                  <ListCard
                    title="Work-item proposals"
                    count={proposals.length}
                    items={proposals}
                    renderItem={(item) => (
                      <CompactItem
                        title={stringValue(item.title) || stringValue(item.kind) || "Proposal"}
                        description={stringValue(item.why) || stringValue(item.rationale)}
                        badge={truthy(item.safeToExecute) ? "safe" : "queued"}
                      >
                        <ExpansionDetails item={item} onChatSelect={setSelectedChat} />
                      </CompactItem>
                    )}
                  />
                  <ListCard
                    title="Action center"
                    count={actionCenterItems.length}
                    items={actionCenterItems}
                    renderItem={(item) => (
                      <CompactItem
                        title={stringValue(item.title) || stringValue(item.id) || "Action item"}
                        description={stringValue(item.why)}
                        badge={
                          stringValue(item.status) ||
                          (truthy(item.safeToSend) ? "sendable" : undefined)
                        }
                      >
                        <ExpansionDetails item={item} onChatSelect={setSelectedChat} />
                      </CompactItem>
                    )}
                  />
                  <ListCard
                    title="Action ledger"
                    count={actionLedger.length}
                    items={actionLedger}
                    renderItem={(item) => (
                      <CompactItem
                        title={stringValue(item.kind) || "Action"}
                        description={stringValue(item.target) || stringValue(item.externalRef)}
                        badge={stringValue(item.status)}
                      />
                    )}
                  />
                  <ListCard
                    title="Action Center"
                    count={actionCenter.length}
                    items={actionCenter}
                    renderItem={(item) => (
                      <CompactItem
                        title={stringValue(item.title) || stringValue(item.kind) || "Action"}
                        description={stringValue(item.summary) || stringValue(item.prompt)}
                        badge={
                          stringValue(item.status) ||
                          stringValue(recordOrUndefined(item.dispatch)?.status)
                        }
                      />
                    )}
                  />
                </div>
              </TabsContent>

              <TabsContent value="history" className="space-y-4 pt-4">
                <div className="grid gap-4 lg:grid-cols-2">
                  <RunHistoryCard runs={center.runs} currentRunId={runSnapshot.runId} />
                  <StateCard entries={center.stateEntries} />
                </div>
              </TabsContent>
            </Tabs>
            {selectedChat && (
              <Card className="min-h-[520px] overflow-hidden" size="sm">
                <CardHeader className="border-b">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="truncate">
                        {selectedChat.label ?? "Evidence chat"}
                      </CardTitle>
                      <CardDescription className="truncate">
                        {selectedChat.sessionId}
                      </CardDescription>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => setSelectedChat(null)}>
                      Close
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="h-[560px] p-0">
                  <ChatPanel
                    sessionId={selectedChat.sessionId}
                    hideAttachments
                    hideTokenCounter
                    inputPlaceholder="Send a follow-up to this workflow agent"
                  />
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

async function loadCommandCenterData(runSnapshot: RunSnapshot): Promise<CommandCenterData> {
  const api = window.workflowsAPI;
  const loadErrors: string[] = [];
  if (!api) {
    return { ...emptyCommandCenterData(), loadErrors: ["Workflows API unavailable"] };
  }

  const jsonArtifacts = await Promise.all(
    JSON_ARTIFACT_KEYS.map(
      async (key) => [key, await readJsonArtifact(api, runSnapshot.runId, key)] as const,
    ),
  );
  const artifactMap = Object.fromEntries(jsonArtifacts);
  const report = await readTextArtifact(api, runSnapshot.runId, "tracking-report.md").catch(
    (error: unknown) => {
      loadErrors.push(String(error));
      return undefined;
    },
  );

  const runsResult = await api.listRuns?.(
    runSnapshot.workflowId,
    runSnapshot.repoPath ?? undefined,
  );
  if (runsResult && !runsResult.success) {
    loadErrors.push(runsResult.error ?? "Run history unavailable");
  }

  const stateResult = await api.listState?.(
    runSnapshot.workflowId,
    runSnapshot.repoPath ?? undefined,
  );
  if (stateResult && !stateResult.success) {
    loadErrors.push(stateResult.error ?? "Workflow state unavailable");
  }

  return {
    runs: runsResult?.success ? (runsResult.runs ?? []) : [],
    stateEntries: stateResult?.success ? (stateResult.entries ?? []) : [],
    shiftLedger: recordOrUndefined(artifactMap["shift-ledger-summary.json"]),
    stewardDecision: recordOrUndefined(artifactMap["steward-decision.json"]),
    reasonerOutput: recordOrUndefined(artifactMap["reasoner-output.json"]),
    trackingReport: report,
    buckets: arrayOfRecords(artifactMap["incident-buckets.json"]),
    trackingItems: arrayOfRecords(artifactMap["incident-tracking-items.json"]),
    investigations: arrayOfRecords(artifactMap["incident-investigations.json"]),
    actionCenterItems: [],
    loadErrors,
  };
}

async function readJsonArtifact(
  api: NonNullable<typeof window.workflowsAPI>,
  runId: string,
  key: string,
): Promise<unknown> {
  const result = await api.readArtifactByKey?.(runId, key);
  if (!result?.success || result.encoding !== "utf8" || result.content === undefined) {
    return undefined;
  }
  return JSON.parse(result.content);
}

async function readTextArtifact(
  api: NonNullable<typeof window.workflowsAPI>,
  runId: string,
  key: string,
): Promise<string | undefined> {
  const result = await api.readArtifactByKey?.(runId, key);
  if (!result?.success || result.encoding !== "utf8" || result.content === undefined) {
    return undefined;
  }
  return result.content;
}

function emptyCommandCenterData(): CommandCenterData {
  return {
    runs: [],
    stateEntries: [],
    buckets: [],
    trackingItems: [],
    investigations: [],
    actionCenterItems: [],
    loadErrors: [],
  };
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}

function SummaryCard({ title, value }: { title: string; value?: string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="line-clamp-6 text-sm whitespace-pre-wrap text-muted-foreground">
          {value || "No summary artifact yet."}
        </p>
      </CardContent>
    </Card>
  );
}

function ListCard<T>({
  title,
  count,
  items,
  renderItem,
  empty = "No items.",
}: {
  title: string;
  count: number;
  items: T[];
  renderItem: (item: T) => React.ReactNode;
  empty?: string;
}) {
  return (
    <Card size="sm">
      <CardHeader className="border-b">
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{title}</CardTitle>
          <Badge variant="secondary">{count}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          itemsWithKeys(items.slice(0, 8)).map(({ item, key }) => (
            <div key={key} className="border-b border-border pb-3 last:border-0 last:pb-0">
              {renderItem(item)}
            </div>
          ))
        )}
        {items.length > 8 && (
          <p className="text-xs text-muted-foreground">+{items.length - 8} more in artifacts</p>
        )}
      </CardContent>
    </Card>
  );
}

function CompactItem({
  title,
  description,
  badge,
  children,
}: {
  title: string;
  description?: string;
  badge?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 font-medium">{title}</div>
        {badge && (
          <Badge variant="outline" className="shrink-0">
            {badge}
          </Badge>
        )}
      </div>
      {description && <p className="line-clamp-3 text-sm text-muted-foreground">{description}</p>}
      {children}
    </div>
  );
}

function ExpansionDetails({
  item,
  onChatSelect,
}: {
  item: JsonRecord;
  onChatSelect: (chat: { sessionId: string; label?: string }) => void;
}) {
  const details = arrayOfStrings(item.supportingDetails);
  const evidence = arrayOfRecords(item.evidence);
  return (
    <div className="space-y-2 pt-1">
      {details.length > 0 && (
        <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
          {itemsWithKeys(details.slice(0, 4)).map(({ item: detail, key }) => (
            <li key={key}>{detail}</li>
          ))}
        </ul>
      )}
      {itemsWithKeys(evidence.slice(0, 3)).map(({ item: entry, key }) => (
        <div key={key} className="rounded-md bg-muted px-2 py-1.5 text-xs">
          <div className="font-medium">{stringValue(entry.label) ?? "Evidence"}</div>
          {stringValue(entry.detail) && (
            <div className="text-muted-foreground">{stringValue(entry.detail)}</div>
          )}
          <EvidenceReferences item={entry} onSelect={onChatSelect} />
        </div>
      ))}
      <EvidenceReferences item={item} onSelect={onChatSelect} />
    </div>
  );
}

function EvidenceReferences({
  item,
  onSelect,
}: {
  item: JsonRecord;
  onSelect: (chat: { sessionId: string; label?: string }) => void;
}) {
  const chats = arrayOfRecords(item.chats);
  const artifacts = arrayOfRecords(item.artifacts);
  const files = arrayOfRecords(item.files);
  if (chats.length === 0 && artifacts.length === 0 && files.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 pt-1">
      {itemsWithKeys(chats.slice(0, 4)).map(({ item: chat, key, ordinal }) => {
        const sessionId = stringValue(chat.sessionId);
        if (!sessionId) return null;
        const label = stringValue(chat.label) ?? stringValue(chat.reason) ?? `Chat ${ordinal + 1}`;
        return (
          <Button
            key={key}
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => onSelect({ sessionId, label })}
          >
            {label}
          </Button>
        );
      })}
      {itemsWithKeys(artifacts.slice(0, 4)).map(({ item: artifact, key: itemKey, ordinal }) => {
        const key = stringValue(artifact.key);
        const runId = stringValue(artifact.runId);
        const storageKey = stringValue(artifact.storageKey);
        const label = stringValue(artifact.label) ?? key ?? `Artifact ${ordinal + 1}`;
        return (
          <span
            key={itemKey}
            className="max-w-full rounded-sm border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground select-text"
            title={[runId, key, storageKey].filter(Boolean).join(" · ")}
          >
            Artifact: {label}
            {key && label !== key ? <span className="font-mono"> · {key}</span> : null}
            {runId ? <span className="font-mono"> · {runId}</span> : null}
          </span>
        );
      })}
      {itemsWithKeys(files.slice(0, 4)).map(({ item: file, key, ordinal }) => {
        const path = stringValue(file.path);
        const label = stringValue(file.label) ?? path ?? `File ${ordinal + 1}`;
        const reason = stringValue(file.reason);
        const content = (
          <>
            File: {label}
            {path && label !== path ? <span className="font-mono"> · {path}</span> : null}
            {reason ? <span> · {reason}</span> : null}
          </>
        );
        if (path && window.workspaceAPI?.openFile) {
          return (
            <Button
              key={key}
              variant="outline"
              size="sm"
              className="h-6 max-w-full px-2 text-xs"
              onClick={() => void window.workspaceAPI?.openFile(path)}
              title={path}
            >
              {content}
            </Button>
          );
        }
        return (
          <span
            key={key}
            className="max-w-full rounded-sm border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground select-text"
            title={path}
          >
            {content}
          </span>
        );
      })}
    </div>
  );
}

function RunHistoryCard({ runs, currentRunId }: { runs: RunHistoryEntry[]; currentRunId: string }) {
  return (
    <Card size="sm">
      <CardHeader className="border-b">
        <CardTitle>Run history</CardTitle>
        <CardDescription>{runs.length} run(s) for this workflow/repository.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        {runs.slice(0, 12).map((run) => (
          <div
            key={run.runId}
            className={cn(
              "flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2",
              run.runId === currentRunId && "border-(--brand-border) bg-muted",
            )}
          >
            <div className="min-w-0">
              <div className="truncate font-mono text-xs">{run.runId}</div>
              <div className="text-xs text-muted-foreground">
                {formatRelative(run.startedAt)}
                {run.finishedAt ? ` · finished ${formatRelative(run.finishedAt)}` : ""}
              </div>
            </div>
            <Badge className={statusClass(run.status)}>{run.status}</Badge>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function StateCard({
  entries,
}: {
  entries: ReadonlyArray<{ key: string; sizeBytes: number; writtenAt: number; runId?: string }>;
}) {
  return (
    <Card size="sm">
      <CardHeader className="border-b">
        <CardTitle>Durable state</CardTitle>
        <CardDescription>{entries.length} stored key(s) for this workflow.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        {entries.slice(0, 14).map((entry) => (
          <div key={entry.key} className="rounded-md border border-border px-3 py-2">
            <div className="truncate font-mono text-xs">{entry.key}</div>
            <div className="text-xs text-muted-foreground">
              {humanBytes(entry.sizeBytes)} · {formatRelative(entry.writtenAt)}
            </div>
          </div>
        ))}
        {entries.length === 0 && (
          <p className="text-sm text-muted-foreground">No durable state yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

function MutedPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function recordOrUndefined(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function itemsWithKeys<T>(
  items: readonly T[],
): Array<{ readonly item: T; readonly key: string; readonly ordinal: number }> {
  const occurrences = new Map<string, number>();
  return items.map((item, ordinal) => {
    const contentKey = JSON.stringify(item) ?? "item";
    const occurrence = occurrences.get(contentKey) ?? 0;
    occurrences.set(contentKey, occurrence + 1);
    return { item, key: `${contentKey}:${String(occurrence)}`, ordinal };
  });
}

function arrayOfRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is JsonRecord =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
}

function boolText(value: unknown): string {
  return typeof value === "boolean" ? (value ? "yes" : "no") : "—";
}

function truthy(value: unknown): boolean {
  return value === true;
}

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function statusClass(status: string): string {
  switch (status) {
    case "succeeded":
    case "completed":
      return "border-(--success-loud)/30 bg-(--success-muted) text-(--success-loud)";
    case "running":
    case "pending":
      return "border-(--brand-border)/30 bg-(--brand-muted) text-(--brand-border)";
    case "failed":
    case "cancelled":
    case "crashed":
      return "border-(--warning-primary)/30 bg-(--warning-subtle) text-(--warning-primary)";
    default:
      return "";
  }
}
