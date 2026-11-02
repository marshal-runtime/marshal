// src/features/workflows/SchemaForm.tsx
//
// Zod 4 → React form generator. Operates against the lightweight
// `WorkflowJSONSchema` shape that the main process derives from each
// workflow's `inputSchema` via `z.toJSONSchema()` (R1-FIXES C-UI §12).
//
// Mapping table (V1):
//   string                → <Input>             (email/url get type=email|url)
//   number / integer       → <Input type=number>
//   boolean                → <Switch>
//   enum / oneOf-literals  → <Select>
//   array<string>          → comma-separated <Input>
//   array<object>          → repeater of nested forms
//   object                 → nested fieldset
//   anything else          → <Textarea> JSON editor (Monaco fallback deferred
//                            to V1.1; per CLAUDE.md test policy we keep the
//                            renderer dep-free to keep tests fast).
//
// Validation: best-effort using JSON-Schema metadata. The submit button is
// always enabled — the engine re-validates via the real Zod parser at the
// `workflowRun` boundary, which is the authoritative gate. The form
// surfaces inline hints (required, min/max) but does NOT reimplement Zod.

import type { WorkflowJSONSchema } from "@common/workflows-contract";
import { useCallback, useId, useMemo, useState } from "react";

import { Button } from "@/components/marshal-ui/marshal-button";
import { Input } from "@/components/marshal-ui/input";
import { Label } from "@/components/marshal-ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/marshal-ui/marshal-switch";
import { Textarea } from "@/components/marshal-ui/textarea";

interface SchemaFormProps {
  schema: WorkflowJSONSchema;
  initialValue?: unknown;
  onSubmit: (value: unknown) => void;
  onCancel?: () => void;
  submitLabel?: string;
  /** Whether the submit button is currently in-flight (disables it). */
  submitting?: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function defaultFor(schema: WorkflowJSONSchema): unknown {
  if (schema.default !== undefined) return schema.default;
  switch (schema.type) {
    case "string":
      return "";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object": {
      const out: Record<string, unknown> = {};
      const props = schema.properties ?? {};
      for (const [k, sub] of Object.entries(props)) out[k] = defaultFor(sub);
      return out;
    }
    default:
      return null;
  }
}

function isStringEnum(
  schema: WorkflowJSONSchema,
): schema is WorkflowJSONSchema & { enum: ReadonlyArray<string> } {
  return Array.isArray(schema.enum) && schema.enum.every((v) => typeof v === "string");
}

function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as T; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
}

// ── Field renderer ─────────────────────────────────────────────────────────

interface FieldProps {
  schema: WorkflowJSONSchema;
  value: unknown;
  onChange: (v: unknown) => void;
  required?: boolean;
  /** Used as the id base for label/control linking and as the path label. */
  path: string;
  label: string;
}

function Field({ schema, value, onChange, required, path, label }: FieldProps) {
  const id = useId();
  const description = schema.description;

  // ── enum (string) → Select ────────────────────────────────────────────────
  if (isStringEnum(schema)) {
    const enumValues: ReadonlyArray<string> = schema.enum as ReadonlyArray<string>;
    return (
      <FieldShell id={id} label={label} required={required} description={description}>
        <Select value={typeof value === "string" ? value : ""} onValueChange={onChange}>
          <SelectTrigger id={id} aria-label={label}>
            <SelectValue placeholder={`Select ${label}`} />
          </SelectTrigger>
          <SelectContent>
            {enumValues.map((v) => (
              <SelectItem key={v} value={v}>
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldShell>
    );
  }

  // ── boolean → Switch ─────────────────────────────────────────────────────
  if (schema.type === "boolean") {
    return (
      <FieldShell id={id} label={label} required={required} description={description} inline>
        <Switch
          id={id}
          checked={value === true}
          onCheckedChange={(checked) => onChange(checked)}
          aria-label={label}
        />
      </FieldShell>
    );
  }

  // ── number / integer → number input ──────────────────────────────────────
  if (schema.type === "number" || schema.type === "integer") {
    return (
      <FieldShell id={id} label={label} required={required} description={description}>
        <Input
          id={id}
          type="number"
          step={schema.type === "integer" ? 1 : "any"}
          min={schema.minimum}
          max={schema.maximum}
          value={typeof value === "number" ? value : ""}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") {
              onChange(undefined);
            } else {
              const n = Number(raw);
              onChange(Number.isFinite(n) ? n : raw);
            }
          }}
        />
      </FieldShell>
    );
  }

  // ── string → text input ──────────────────────────────────────────────────
  if (schema.type === "string") {
    const format = schema.format;
    const inputType = format === "email" ? "email" : format === "uri" ? "url" : "text";
    return (
      <FieldShell id={id} label={label} required={required} description={description}>
        <Input
          id={id}
          type={inputType}
          minLength={schema.minLength}
          maxLength={schema.maxLength}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={typeof schema.default === "string" ? schema.default : undefined}
        />
      </FieldShell>
    );
  }

  // ── array ────────────────────────────────────────────────────────────────
  if (schema.type === "array") {
    const item = schema.items ?? { type: "string" };
    // Special case: array<string> → comma-separated input (more compact).
    if (item.type === "string" && !isStringEnum(item)) {
      const arr: string[] = Array.isArray(value)
        ? (value as unknown[]).filter((v): v is string => typeof v === "string")
        : [];
      return (
        <FieldShell id={id} label={label} required={required} description={description}>
          <Input
            id={id}
            value={arr.join(", ")}
            onChange={(e) =>
              onChange(
                e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0),
              )
            }
            placeholder="Comma-separated"
          />
        </FieldShell>
      );
    }
    return (
      <ArrayField
        schema={schema}
        itemSchema={item}
        value={Array.isArray(value) ? value : []}
        onChange={onChange}
        path={path}
        label={label}
        required={required}
        description={description}
      />
    );
  }

  // ── object → nested fieldset ─────────────────────────────────────────────
  if (schema.type === "object" && schema.properties) {
    const objectValue: Record<string, unknown> =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>) // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
        : {};
    return (
      <ObjectField
        schema={schema}
        value={objectValue}
        onChange={onChange}
        path={path}
        label={label}
        description={description}
      />
    );
  }

  // ── fallback → JSON textarea ─────────────────────────────────────────────
  return (
    <FieldShell id={id} label={label} required={required} description={description}>
      <Textarea
        id={id}
        rows={6}
        className="font-mono text-xs"
        value={(() => {
          try {
            return JSON.stringify(value ?? null, null, 2);
          } catch {
            return "";
          }
        })()}
        onChange={(e) => {
          try {
            onChange(JSON.parse(e.target.value));
          } catch {
            // Defer; user is mid-edit. Keep the literal text in DOM and
            // re-parse on next keystroke.
            onChange(e.target.value);
          }
        }}
      />
    </FieldShell>
  );
}

interface FieldShellProps {
  id: string;
  label: string;
  required?: boolean;
  description?: string;
  inline?: boolean;
  children: React.ReactNode;
}

function FieldShell({ id, label, required, description, inline, children }: FieldShellProps) {
  return (
    <div className={inline ? "flex items-center gap-3" : "flex flex-col gap-1.5"}>
      <Label htmlFor={id} className="text-sm">
        {label}
        {required && <span className="ml-0.5 text-(--warning-primary)">*</span>}
      </Label>
      {children}
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}

function ArrayField({
  itemSchema,
  value,
  onChange,
  path,
  label,
  required,
  description,
}: {
  schema: WorkflowJSONSchema;
  itemSchema: WorkflowJSONSchema;
  value: unknown[];
  onChange: (v: unknown[]) => void;
  path: string;
  label: string;
  required?: boolean;
  description?: string;
}) {
  return (
    <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
      <legend className="px-1 text-sm font-medium">
        {label}
        {required && <span className="ml-0.5 text-(--warning-primary)">*</span>}
      </legend>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      {value.length === 0 && <p className="text-xs text-muted-foreground italic">No entries.</p>}
      {value.map((item, idx) => {
        // Repeater rows have no stable id; index is the natural key, and
        // re-ordering would simply remap which item lives at each index.
        // (no-array-index-key is the standard React anti-list-jumble rule
        //  — fine here, but we silence it explicitly to be honest about it.)
        // eslint-disable-next-line react/no-array-index-key
        const key = idx;
        return (
          <div key={key} className="flex items-start gap-2">
            <div className="flex-1">
              <Field
                schema={itemSchema}
                value={item}
                onChange={(v) => {
                  const next = value.slice();
                  next[idx] = v;
                  onChange(next);
                }}
                path={`${path}[${idx}]`}
                label={`Item ${idx + 1}`}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange(value.filter((_, i) => i !== idx))}
            >
              Remove
            </Button>
          </div>
        );
      })}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange([...value, defaultFor(itemSchema)])}
        >
          + Add
        </Button>
      </div>
    </fieldset>
  );
}

function ObjectField({
  schema,
  value,
  onChange,
  path,
  label,
  description,
}: {
  schema: WorkflowJSONSchema;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  path: string;
  label: string;
  description?: string;
}) {
  const entries = Object.entries(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3">
      <legend className="px-1 text-sm font-medium">{label}</legend>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      {entries.map(([key, sub]) => (
        <Field
          key={key}
          schema={sub}
          value={value[key]}
          onChange={(v) => onChange({ ...value, [key]: v })}
          required={required.has(key)}
          path={`${path}.${key}`}
          label={sub.description ? key : key}
        />
      ))}
    </fieldset>
  );
}

// ── Top-level export ──────────────────────────────────────────────────────

export function SchemaForm({
  schema,
  initialValue,
  onSubmit,
  onCancel,
  submitLabel = "Run",
  submitting,
}: SchemaFormProps) {
  const initial = useMemo(
    () => (initialValue !== undefined ? deepClone(initialValue) : defaultFor(schema)),
    [initialValue, schema],
  );
  const [value, setValue] = useState<unknown>(initial);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      onSubmit(value);
    },
    [onSubmit, value],
  );

  return (
    <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <Field
          schema={schema}
          value={value}
          onChange={setValue}
          path="$"
          label={typeof schema.title === "string" ? schema.title : "Input"}
        />
      </div>
      <div className="flex shrink-0 justify-end gap-2 border-t border-border pt-3">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={submitting}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
