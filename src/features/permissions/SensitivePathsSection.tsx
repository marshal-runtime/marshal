import { useState } from "react";

import { X, Plus } from "@/components/icons";
import { Input } from "@/components/marshal-ui/input";
import { Button } from "@/components/marshal-ui/marshal-button";
import type { PermissionsConfig } from "@/types/electron";

interface SensitivePathsSectionProps {
  permissions: PermissionsConfig;
  onUpdate: (permissions: PermissionsConfig) => void;
  disabled?: boolean;
}

export function SensitivePathsSection({
  permissions,
  onUpdate,
  disabled,
}: SensitivePathsSectionProps) {
  const [newPath, setNewPath] = useState("");
  const allowed = permissions.allowedSensitivePaths ?? [];

  const add = () => {
    if (disabled) return;
    const trimmed = newPath.trim();
    if (!trimmed || allowed.includes(trimmed)) return;
    onUpdate({ ...permissions, allowedSensitivePaths: [...allowed, trimmed] });
    setNewPath("");
  };

  const remove = (entry: string) => {
    if (disabled) return;
    onUpdate({
      ...permissions,
      allowedSensitivePaths: allowed.filter((p) => p !== entry),
    });
  };

  return (
    <div className="flex flex-col gap-2">
      {allowed.length === 0 ? (
        <p className="text-xs text-muted-foreground">No exceptions added.</p>
      ) : (
        <ul className="space-y-1">
          {allowed.map((entry) => (
            <li
              key={entry}
              className="flex items-center justify-between gap-2 rounded-md bg-muted px-3 py-1"
            >
              <span className="truncate font-mono text-xs">{entry}</span>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                aria-label={`Remove ${entry}`}
                onClick={() => remove(entry)}
                disabled={disabled}
              >
                <X size={12} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="e.g. ~/.ssh/*"
          className="h-7 text-xs"
          disabled={disabled}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={add}
          aria-label="Add"
          disabled={disabled || !newPath.trim()}
        >
          <Plus size={12} className="mr-1" />
          Add
        </Button>
      </div>
    </div>
  );
}
