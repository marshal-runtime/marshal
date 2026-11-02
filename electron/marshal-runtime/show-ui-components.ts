/**
 * The four built-in generic components `runtimeShowUi` can render without an
 * agent writing any TSX (data-table, key-value, checklist, diff-list).
 * Sources live as real, standalone `.tsx` files under `ui-components/` — the
 * SAME files an agent would author by hand — loaded here as raw text via
 * Vite's `?raw` import so the compiled electron bundle carries them without
 * any extra packaging step (see electron/electron-env.d.ts for the ambient
 * `?raw` module type). Each has a small hand-written prop validator: no
 * schema library, just enough to fail fast with an actionable message before
 * we ever touch the runtime workspace or the compiler.
 */
import checklistSource from "./ui-components/checklist.tsx?raw";
import dataTableSource from "./ui-components/data-table.tsx?raw";
import diffListSource from "./ui-components/diff-list.tsx?raw";
import keyValueSource from "./ui-components/key-value.tsx?raw";

export const BUILTIN_UI_COMPONENT_NAMES = Object.freeze([
  "data-table",
  "key-value",
  "checklist",
  "diff-list",
] as const);

export type BuiltinUiComponentName = (typeof BUILTIN_UI_COMPONENT_NAMES)[number];

const BUILTIN_UI_COMPONENT_SOURCE: Readonly<Record<BuiltinUiComponentName, string>> = Object.freeze(
  {
    "data-table": dataTableSource,
    "key-value": keyValueSource,
    checklist: checklistSource,
    "diff-list": diffListSource,
  },
);

export function isBuiltinUiComponentName(value: unknown): value is BuiltinUiComponentName {
  return (
    typeof value === "string" && (BUILTIN_UI_COMPONENT_NAMES as readonly string[]).includes(value)
  );
}

export function getBuiltinComponentSource(name: BuiltinUiComponentName): string {
  return BUILTIN_UI_COMPONENT_SOURCE[name];
}

export interface PropsValidationError {
  readonly message: string;
}

export type PropsValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: PropsValidationError };

const VALID = { ok: true } as const;

function invalid(message: string): PropsValidationResult {
  return { ok: false, error: { message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function validateDataTableProps(props: Record<string, unknown>): PropsValidationResult {
  const { columns, rows, caption, sortable } = props;
  if (!Array.isArray(columns) || columns.length === 0) {
    return invalid("data-table props.columns must be a non-empty array.");
  }
  for (const [index, column] of columns.entries()) {
    if (!isRecord(column) || !isNonEmptyString(column.key) || !isNonEmptyString(column.label)) {
      return invalid(`data-table props.columns[${index}] needs a non-empty key and label.`);
    }
    if (
      column.align !== undefined &&
      column.align !== "left" &&
      column.align !== "center" &&
      column.align !== "right"
    ) {
      return invalid(`data-table props.columns[${index}].align must be left, center, or right.`);
    }
  }
  if (!Array.isArray(rows) || !rows.every((row) => isRecord(row))) {
    return invalid("data-table props.rows must be an array of objects.");
  }
  if (!isOptionalString(caption)) return invalid("data-table props.caption must be a string.");
  if (!isOptionalBoolean(sortable)) return invalid("data-table props.sortable must be a boolean.");
  return VALID;
}

const KEY_VALUE_TONES = new Set(["neutral", "positive", "negative", "warning"]);

function validateKeyValueProps(props: Record<string, unknown>): PropsValidationResult {
  const { title, items } = props;
  if (!isOptionalString(title)) return invalid("key-value props.title must be a string.");
  if (!Array.isArray(items)) return invalid("key-value props.items must be an array.");
  for (const [index, item] of items.entries()) {
    if (!isRecord(item) || !isNonEmptyString(item.label)) {
      return invalid(`key-value props.items[${index}] needs a non-empty label.`);
    }
    const valueType = typeof item.value;
    if (valueType !== "string" && valueType !== "number" && valueType !== "boolean") {
      return invalid(`key-value props.items[${index}].value must be a string, number, or boolean.`);
    }
    if (
      item.tone !== undefined &&
      (typeof item.tone !== "string" || !KEY_VALUE_TONES.has(item.tone))
    ) {
      return invalid(`key-value props.items[${index}].tone is invalid.`);
    }
  }
  return VALID;
}

const CHECKLIST_STATUSES = new Set(["todo", "doing", "done", "blocked"]);

function validateChecklistProps(props: Record<string, unknown>): PropsValidationResult {
  const { items } = props;
  if (!Array.isArray(items)) return invalid("checklist props.items must be an array.");
  for (const [index, item] of items.entries()) {
    if (!isRecord(item) || !isNonEmptyString(item.id) || !isNonEmptyString(item.label)) {
      return invalid(`checklist props.items[${index}] needs a non-empty id and label.`);
    }
    if (typeof item.status !== "string" || !CHECKLIST_STATUSES.has(item.status)) {
      return invalid(
        `checklist props.items[${index}].status must be todo, doing, done, or blocked.`,
      );
    }
    if (!isOptionalString(item.detail)) {
      return invalid(`checklist props.items[${index}].detail must be a string.`);
    }
  }
  return VALID;
}

function validateDiffListProps(props: Record<string, unknown>): PropsValidationResult {
  const { files } = props;
  if (!Array.isArray(files)) return invalid("diff-list props.files must be an array.");
  for (const [index, file] of files.entries()) {
    if (!isRecord(file) || !isNonEmptyString(file.path) || !isNonEmptyString(file.status)) {
      return invalid(`diff-list props.files[${index}] needs a non-empty path and status.`);
    }
    if (!isOptionalNumber(file.additions)) {
      return invalid(`diff-list props.files[${index}].additions must be a number.`);
    }
    if (!isOptionalNumber(file.deletions)) {
      return invalid(`diff-list props.files[${index}].deletions must be a number.`);
    }
    if (file.hunks !== undefined) {
      if (!Array.isArray(file.hunks)) {
        return invalid(`diff-list props.files[${index}].hunks must be an array.`);
      }
      for (const [hunkIndex, hunk] of file.hunks.entries()) {
        if (
          !isRecord(hunk) ||
          !isNonEmptyString(hunk.header) ||
          !Array.isArray(hunk.lines) ||
          !hunk.lines.every((line) => typeof line === "string")
        ) {
          return invalid(
            `diff-list props.files[${index}].hunks[${hunkIndex}] needs a header and string[] lines.`,
          );
        }
      }
    }
  }
  return VALID;
}

const VALIDATORS: Readonly<
  Record<BuiltinUiComponentName, (props: Record<string, unknown>) => PropsValidationResult>
> = Object.freeze({
  "data-table": validateDataTableProps,
  "key-value": validateKeyValueProps,
  checklist: validateChecklistProps,
  "diff-list": validateDiffListProps,
});

export function validateBuiltinComponentProps(
  name: BuiltinUiComponentName,
  props: unknown,
): PropsValidationResult {
  if (!isRecord(props)) {
    return invalid(`${name} props must be a JSON object.`);
  }
  return VALIDATORS[name](props);
}
