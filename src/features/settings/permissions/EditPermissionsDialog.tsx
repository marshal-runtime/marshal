import { useState } from "react";

import { Button } from "@/components/marshal-ui/marshal-button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/marshal-ui/textarea";
import type { PermissionsConfig } from "@/types/electron";

interface EditPermissionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  permissions: PermissionsConfig;
  onSave: (permissions: PermissionsConfig) => void;
}

function isPermissionsConfig(value: unknown): value is PermissionsConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const candidate = value as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrowed to a non-array object before field validation
  const isRecord = (entry: unknown): entry is Record<string, unknown> =>
    !!entry && typeof entry === "object" && !Array.isArray(entry);
  const isBooleanRecord = (entry: unknown): entry is Record<string, boolean> =>
    isRecord(entry) && Object.values(entry).every((item) => typeof item === "boolean");
  const isServerRecord = (entry: unknown): entry is PermissionsConfig["servers"] =>
    isRecord(entry) &&
    Object.values(entry).every(
      (server) =>
        isRecord(server) &&
        typeof server.enabled === "boolean" &&
        typeof server.autoApprove === "boolean",
    );
  const isNestedBooleanRecord = (
    entry: unknown,
  ): entry is Record<string, Record<string, boolean>> =>
    isRecord(entry) && Object.values(entry).every(isBooleanRecord);

  return (
    (candidate.autoApproveReadOnly === undefined ||
      typeof candidate.autoApproveReadOnly === "boolean") &&
    (candidate.allow === undefined ||
      (Array.isArray(candidate.allow) &&
        candidate.allow.every((entry) => typeof entry === "string"))) &&
    (candidate.tools === undefined || isBooleanRecord(candidate.tools)) &&
    (candidate.servers === undefined || isServerRecord(candidate.servers)) &&
    (candidate.autopilotMode === undefined || typeof candidate.autopilotMode === "boolean") &&
    (candidate.denyPatterns === undefined ||
      (Array.isArray(candidate.denyPatterns) &&
        candidate.denyPatterns.every((entry) => typeof entry === "string"))) &&
    (candidate.allowModelPermissionsChange === undefined ||
      typeof candidate.allowModelPermissionsChange === "boolean") &&
    (candidate.allowedSensitivePaths === undefined ||
      (Array.isArray(candidate.allowedSensitivePaths) &&
        candidate.allowedSensitivePaths.every((entry) => typeof entry === "string"))) &&
    (candidate.allowedReadFolders === undefined ||
      (Array.isArray(candidate.allowedReadFolders) &&
        candidate.allowedReadFolders.every((entry) => typeof entry === "string"))) &&
    (candidate.allowedWriteFolders === undefined ||
      (Array.isArray(candidate.allowedWriteFolders) &&
        candidate.allowedWriteFolders.every((entry) => typeof entry === "string"))) &&
    (candidate.previousTools === undefined || isNestedBooleanRecord(candidate.previousTools))
  );
}

function InstructionText() {
  return (
    <div className="rounded-lg border border-border bg-muted px-3 py-2.5 text-xs/relaxed text-muted-foreground">
      Add shell command patterns to{" "}
      <code className="rounded-sm bg-background px-1 py-0.5 font-mono text-foreground">allow</code>.
      Use <code className="rounded-sm bg-background px-1 py-0.5 font-mono text-foreground">*</code>{" "}
      as a wildcard. Use{" "}
      <code className="rounded-sm bg-background px-1 py-0.5 font-mono text-foreground">tool:</code>{" "}
      for custom tools and{" "}
      <code className="rounded-sm bg-background px-1 py-0.5 font-mono text-foreground">
        mcp:server:tool
      </code>{" "}
      for MCP tools. Compound commands (with <code>|</code>, <code>&&</code>, <code>;</code>,{" "}
      <code>&gt;</code>) are split into segments; each must match a pattern.
    </div>
  );
}

export function EditPermissionsDialog({
  open,
  onOpenChange,
  permissions,
  onSave,
}: EditPermissionsDialogProps) {
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  if (open && !initialized) {
    setJson(JSON.stringify(permissions, null, 2));
    setError(null);
    setInitialized(true);
  } else if (!open && initialized) {
    setInitialized(false);
  }

  const handleSave = () => {
    try {
      const parsed: unknown = JSON.parse(json);
      if (!parsed || typeof parsed !== "object") {
        setError("Invalid JSON. Expected an object.");
        return;
      }
      if (!isPermissionsConfig(parsed)) {
        setError("Invalid JSON. Expected an object.");
        return;
      }
      setError(null);
      onSave(parsed);
      onOpenChange(false);
    } catch {
      setError("Invalid JSON. Please fix syntax errors before saving.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] max-w-2xl flex-col gap-5 sm:max-w-2xl">
        <DialogHeader className="gap-1">
          <DialogTitle className="text-lg">Edit Permissions</DialogTitle>
        </DialogHeader>
        <InstructionText />
        <Textarea
          aria-label="Permissions JSON"
          className="min-h-[200px] w-full flex-1 border-border bg-background font-mono text-sm/relaxed shadow-md"
          value={json}
          onChange={(e) => {
            setJson(e.target.value);
            setError(null);
          }}
          spellCheck={false}
        />
        {error && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        )}
        <DialogFooter className="border-t border-border pt-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
