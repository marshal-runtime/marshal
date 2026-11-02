import { AlertTriangle, Lock, Plus, X } from "@/components/icons";
import { useState } from "react";

import { Badge } from "@/components/marshal-ui/badge";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Input } from "@/components/marshal-ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/marshal-ui/marshal-tooltip";
import { cn } from "@/lib/marshal-class-names";
import type { PermissionsConfig } from "@/types/electron";

import { getToolDescription } from "./tool-descriptions";

interface ShellPatternsSectionProps {
  permissions: PermissionsConfig;
  onUpdate: (permissions: PermissionsConfig) => void;
  disabled?: boolean;
  /** Shell patterns that won't translate to marshal's safe-bins model. */
  unrepresentablePatterns?: string[];
}

export function ShellPatternsSection({
  permissions,
  onUpdate,
  disabled,
  unrepresentablePatterns,
}: ShellPatternsSectionProps) {
  const [newPattern, setNewPattern] = useState("");
  const [editing, setEditing] = useState<{ index: number; value: string } | null>(null);
  const patternsDescription = getToolDescription("shellAllowPatterns");

  const shellPatterns = permissions.allow.filter(
    (p) =>
      !p.startsWith("write:") &&
      !p.startsWith("url:") &&
      !p.startsWith("tool:") &&
      !p.startsWith("mcp:"),
  );

  const addPattern = () => {
    const trimmed = newPattern.trim();
    if (!trimmed || permissions.allow.includes(trimmed)) return;
    onUpdate({ ...permissions, allow: [...permissions.allow, trimmed] });
    setNewPattern("");
  };

  const removePattern = (pattern: string) => {
    onUpdate({ ...permissions, allow: permissions.allow.filter((p) => p !== pattern) });
  };

  const commitEdit = () => {
    if (!editing) return;
    const trimmed = editing.value.trim();
    if (!trimmed) {
      setEditing(null);
      return;
    }
    const oldPattern = shellPatterns[editing.index];
    if (trimmed === oldPattern) {
      setEditing(null);
      return;
    }
    // Drop an edit that would collide with another existing rule.
    if (permissions.allow.includes(trimmed)) {
      setEditing(null);
      return;
    }
    // Preserve array position by finding the index of oldPattern in the full allow list.
    const fullIndex = permissions.allow.indexOf(oldPattern);
    if (fullIndex === -1) {
      setEditing(null);
      return;
    }
    const next = [...permissions.allow];
    next[fullIndex] = trimmed;
    onUpdate({ ...permissions, allow: next });
    setEditing(null);
  };

  return (
    <div className={cn("space-y-1.5", disabled && "opacity-50")}>
      <div className="flex flex-col">
        <span className="text-xs font-medium text-muted-foreground">Approved patterns</span>
        {patternsDescription && (
          <span className="text-xs text-muted-foreground/70">{patternsDescription}</span>
        )}
      </div>
      {disabled && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Lock size={12} />
          <span>Locked by organization policy</span>
        </div>
      )}
      {shellPatterns.map((pattern, index) => {
        const isLiteral = !pattern.includes("*");
        const isEditing = editing?.index === index;
        return (
          <div
            key={pattern}
            data-testid={`pattern-row-${index}`}
            className="flex items-center justify-between gap-2 rounded-md bg-muted px-3 py-1.5"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {isEditing ? (
                <Input
                  autoFocus
                  value={editing.value}
                  onChange={(e) => setEditing({ index, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitEdit();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setEditing(null);
                    }
                  }}
                  onBlur={(e) => {
                    // Don't commit if the focus is moving to this row's Remove button —
                    // commitEdit would write an in-progress edit, then Remove's onClick
                    // would filter by the old pattern string (already gone from the array)
                    // and silently no-op.
                    if (
                      e.relatedTarget instanceof Element &&
                      e.relatedTarget.closest('[aria-label^="Remove"]')
                    ) {
                      setEditing(null);
                      return;
                    }
                    commitEdit();
                  }}
                  className="h-7 min-w-0 flex-1 font-mono text-xs"
                />
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  title={pattern}
                  className="h-auto min-w-0 flex-1 justify-start truncate p-0 font-mono text-xs"
                  onClick={() => setEditing({ index, value: pattern })}
                  disabled={disabled}
                >
                  <span className="block w-full truncate text-left">{pattern}</span>
                </Button>
              )}
              {isLiteral && !isEditing && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="outline" tabIndex={0} className="shrink-0 text-xs">
                      Literal
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    Matches only this exact command. Any variation will re-prompt.
                  </TooltipContent>
                </Tooltip>
              )}
              {unrepresentablePatterns?.includes(pattern) && !isEditing && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      tabIndex={0}
                      aria-label="Limited support in gateway mode"
                      className="inline-flex"
                    >
                      <AlertTriangle
                        size={12}
                        aria-hidden="true"
                        className="ml-1 text-amber-600 dark:text-amber-500"
                      />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    In gateway mode, only the leading binary translates (no glob/argument support).
                    Pattern stored verbatim for copilot mode.
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            {!isEditing && (
              <Button
                variant="ghost"
                size="icon"
                className="size-5 shrink-0"
                aria-label={`Remove ${pattern}`}
                onClick={() => removePattern(pattern)}
                disabled={disabled}
              >
                <X size={12} />
              </Button>
            )}
          </div>
        );
      })}
      <div className="flex gap-2">
        <Input
          value={newPattern}
          onChange={(e) => setNewPattern(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addPattern();
            }
          }}
          placeholder="e.g., npm run *"
          className="h-8 font-mono text-xs"
          disabled={disabled}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={addPattern}
          disabled={disabled || !newPattern.trim()}
          aria-label="Add pattern"
        >
          <Plus size={14} />
        </Button>
      </div>
    </div>
  );
}
