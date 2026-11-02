import {
  validateUiDocument,
  type UiActionBinding,
  type UiNode,
} from "@marshal/runtime/ui/declarative/browser";
import { useState } from "react";

import { Badge } from "@/components/marshal-ui/badge";
import { Input } from "@/components/marshal-ui/input";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import type { RuntimeUiApplicationRenderer } from "./RuntimeUiApplicationRegistry";

/* oxlint-disable react/only-export-components -- the registry export intentionally owns its private renderer components */

const RUNTIME_UI_ACTION_STATUS_TEST_ID = "runtime-ui-action-status";
const DEFAULT_PAUSE_TITLE = "Pause";

export const declarativeRuntimeUiRenderer: RuntimeUiApplicationRenderer = ({ instance, host }) => {
  if (instance.content.kind !== "application") return null;
  try {
    const document = validateUiDocument(instance.content.state?.document);
    return (
      <DeclarativeRuntimeUiApplication
        root={document.root}
        actions={document.actions ?? []}
        host={host}
      />
    );
  } catch (error) {
    return (
      <p className="text-sm text-destructive" role="alert">
        Unable to render application: {error instanceof Error ? error.message : "invalid document"}.
      </p>
    );
  }
};

function DeclarativeRuntimeUiApplication({
  root,
  actions,
  host,
}: {
  readonly root: UiNode;
  readonly actions: readonly UiActionBinding[];
  readonly host: Parameters<RuntimeUiApplicationRenderer>[0]["host"];
}) {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<{ readonly message: string; readonly error: boolean }>();
  const [pauseAction, setPauseAction] = useState<UiActionBinding>();
  const [pauseReason, setPauseReason] = useState("");
  const [pauseError, setPauseError] = useState<string>();
  const [formValues, setFormValues] = useState<Readonly<Record<string, string>>>({});

  function setFormValue(name: string, value: string) {
    setFormValues((values) => ({ ...values, [name]: value }));
  }

  async function invoke(action: UiActionBinding, reason?: string) {
    const operation = action.operation;
    setPending(true);
    setOutcome(undefined);
    try {
      if (operation.endsWith(".open-session")) {
        const sessionId = action.input?.agentSessionId;
        if (typeof sessionId !== "string") throw new Error("Agent session is unavailable.");
        const result = await window.commandCenterAPI?.openSession(sessionId);
        if (!result?.success) throw new Error(result?.error ?? "Session could not be opened.");
        setOutcome({ message: "Session opened.", error: false });
        return;
      }
      const capabilityInput: Record<string, unknown> = { ...action.input };
      for (const [target, source] of Object.entries(action.eventMap ?? {})) {
        if (formValues[source] !== undefined) capabilityInput[target] = formValues[source];
      }
      if (operation.endsWith(".pause") && reason !== undefined) capabilityInput.reason = reason;
      const result = await host.invokeCapability({
        capability: operation,
        input: capabilityInput,
        idempotencyKey: capabilityIdempotencyKey(operation),
      });
      setOutcome({ message: formatActionOutcome(result.output), error: false });
    } catch (error) {
      setOutcome({
        message: error instanceof Error ? error.message : "Action failed.",
        error: true,
      });
    } finally {
      setPending(false);
    }
  }

  function requestAction(action: UiActionBinding) {
    if (action.operation.endsWith(".pause")) {
      setPauseAction(action);
      setPauseReason("");
      setPauseError(undefined);
      return;
    }
    void invoke(action);
  }

  function submitPause() {
    const reason = pauseReason.trim();
    if (!reason) {
      setPauseError("A pause reason is required.");
      return;
    }
    const action = pauseAction;
    setPauseAction(undefined);
    setPauseError(undefined);
    void (action && invoke(action, reason));
  }

  return (
    <>
      <DeclarativeNode
        node={root}
        actions={actions}
        host={host}
        pending={pending}
        onAction={requestAction}
        form={{ values: formValues, setValue: setFormValue }}
      />
      <div
        className={`mt-3 text-xs ${outcome?.error ? "text-destructive" : "text-muted-foreground"}`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid={RUNTIME_UI_ACTION_STATUS_TEST_ID}
      >
        {pending ? "Working…" : outcome?.message}
      </div>
      <Dialog
        open={pauseAction !== undefined}
        onOpenChange={(open) => !open && setPauseAction(undefined)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pauseAction?.confirmation?.title ?? DEFAULT_PAUSE_TITLE}</DialogTitle>
            <DialogDescription>Provide a reason for pausing this run.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submitPause();
            }}
          >
            <Input
              autoFocus
              value={pauseReason}
              onChange={(event) => setPauseReason(event.target.value)}
              aria-label="Pause reason"
              aria-invalid={pauseError ? true : undefined}
              aria-describedby={pauseError ? "runtime-ui-pause-error" : undefined}
            />
            {pauseError && (
              <p id="runtime-ui-pause-error" className="mt-2 text-xs text-destructive" role="alert">
                {pauseError}
              </p>
            )}
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setPauseAction(undefined)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                Pause
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface DeclarativeFormState {
  readonly values: Readonly<Record<string, string>>;
  readonly setValue: (name: string, value: string) => void;
}

function DeclarativeNode({
  node,
  actions,
  host,
  pending,
  onAction,
  form,
}: {
  readonly node: UiNode;
  readonly actions: readonly UiActionBinding[];
  readonly host: Parameters<RuntimeUiApplicationRenderer>[0]["host"];
  readonly pending: boolean;
  readonly onAction: (action: UiActionBinding) => void;
  readonly form: DeclarativeFormState;
}) {
  const [expanded, setExpanded] = useState(node.id === "compact");
  const children = "children" in node ? node.children : [];
  const renderChildren = (
    <div className={node.type === "stack" && node.gap === "small" ? "grid gap-2" : "grid gap-4"}>
      {children.map((child) => (
        <DeclarativeNode
          key={child.id}
          node={child}
          actions={actions}
          host={host}
          pending={pending}
          onAction={onAction}
          form={form}
        />
      ))}
    </div>
  );
  switch (node.type) {
    case "stack":
      return renderChildren;
    case "card":
      if (node.id !== "compact" && node.title) {
        return (
          <Card size="sm">
            <CardHeader className="p-3">
              <Button
                type="button"
                variant="ghost"
                className="h-auto justify-start p-0 text-sm font-medium"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? "Collapse" : "Expand"} {node.title}
              </Button>
            </CardHeader>
            {expanded && <CardContent>{renderChildren}</CardContent>}
          </Card>
        );
      }
      return (
        <Card size="sm">
          {node.title && (
            <CardHeader>
              <CardTitle>{node.title}</CardTitle>
            </CardHeader>
          )}
          <CardContent>{renderChildren}</CardContent>
        </Card>
      );
    case "heading": {
      const Tag = node.level === 1 ? "h1" : node.level === 3 ? "h3" : "h2";
      return <Tag className="text-sm font-medium">{node.text}</Tag>;
    }
    case "text":
      return (
        <p
          className={
            node.tone === "danger" ? "text-sm text-destructive" : "text-sm text-muted-foreground"
          }
        >
          {node.text}
        </p>
      );
    case "badge":
      return (
        <Badge variant={node.tone === "danger" ? "destructive" : "secondary"}>{node.text}</Badge>
      );
    case "divider":
      return <hr className="border-border" />;
    case "progress":
      return <progress className="w-full" max={100} value={node.value} aria-label={node.label} />;
    case "button":
      return <ActionButton node={node} actions={actions} pending={pending} onAction={onAction} />;
    case "input":
      return (
        <Input
          name={node.name}
          aria-label={node.label}
          placeholder={node.placeholder}
          value={
            form.values[node.name] ??
            (node.value === null || node.value === undefined ? "" : String(node.value))
          }
          onChange={(event) => form.setValue(node.name, event.target.value)}
        />
      );
    case "select":
      return (
        <Select
          value={form.values[node.name]}
          onValueChange={(value) => form.setValue(node.name, value)}
          defaultValue={
            node.value === null || node.value === undefined ? undefined : String(node.value)
          }
        >
          <SelectTrigger aria-label={node.label}>
            <SelectValue placeholder={node.label} />
          </SelectTrigger>
          <SelectContent>
            {node.options.map((option) => (
              <SelectItem key={String(option.value)} value={String(option.value)}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "table":
      return (
        <table className="w-full text-xs">
          <tbody>
            {tableRowsWithKeys(node).map(({ key, row }) => (
              <tr key={key}>
                {node.columns.map((column) => (
                  <td className="border-b border-border p-1" key={column.key}>
                    {row[column.key] === null ? "" : String(row[column.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
  }
  return null;
}

function ActionButton({
  node,
  actions,
  pending,
  onAction,
}: {
  readonly node: Extract<UiNode, { type: "button" }>;
  readonly actions: readonly UiActionBinding[];
  readonly pending: boolean;
  readonly onAction: (action: UiActionBinding) => void;
}) {
  const action = actions.find((candidate) => candidate.id === node.actionId);
  if (!action) return null;
  return (
    <Button
      type="button"
      variant={node.variant === "danger" ? "destructive" : "default"}
      disabled={pending}
      onClick={() => onAction(action)}
    >
      {node.label}
    </Button>
  );
}

let fallbackId = 0;

function capabilityIdempotencyKey(operation: string): string {
  const unique =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${(fallbackId++).toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `action-${operation}-${unique}`;
}

function formatActionOutcome(output: unknown): string {
  if (output === undefined) return "Action completed.";
  if (typeof output === "string")
    return output.length > 2000 ? `${output.slice(0, 1997)}…` : output;
  if (output && typeof output === "object") {
    const state = "state" in output ? output.state : "status" in output ? output.status : undefined;
    if (typeof state === "string") return `Run state: ${state}`;
    try {
      const json = JSON.stringify(output, null, 2);
      if (json) return `Action completed: ${json.length > 2000 ? `${json.slice(0, 1997)}…` : json}`;
    } catch {
      return "Action completed.";
    }
  }
  if (typeof output === "number" || typeof output === "boolean" || typeof output === "bigint") {
    return `Action completed: ${String(output)}`;
  }
  return "Action completed.";
}

function tableRowsWithKeys(
  table: Extract<UiNode, { type: "table" }>,
): Array<{ readonly key: string; readonly row: (typeof table.rows)[number] }> {
  const occurrences = new Map<string, number>();
  return table.rows.map((row) => {
    const contentKey = table.columns
      .map(({ key }) => `${key}=${JSON.stringify(row[key])}`)
      .join("|");
    const occurrence = occurrences.get(contentKey) ?? 0;
    occurrences.set(contentKey, occurrence + 1);
    return { key: `${table.id}:${contentKey}:${occurrence}`, row };
  });
}
