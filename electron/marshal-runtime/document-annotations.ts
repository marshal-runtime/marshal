import type {
  RuntimeUiDocumentAnnotation,
  RuntimeUiDocumentAnnotationTone,
} from "../../common/runtime-ui";

export const MAX_DOCUMENT_ANNOTATIONS = 300;
const MAX_LINE = 1_000_000;
const MAX_LABEL_LENGTH = 120;
const MAX_DETAIL_LENGTH = 2_000;
const TONES: readonly RuntimeUiDocumentAnnotationTone[] = ["info", "positive", "warning", "muted"];

const LINE_SCHEMA = { type: "integer", minimum: 1, maximum: MAX_LINE } as const;

export const DOCUMENT_ANNOTATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["startLine", "tone", "label"],
  properties: {
    startLine: LINE_SCHEMA,
    endLine: LINE_SCHEMA,
    tone: { enum: TONES },
    label: { type: "string", minLength: 1, maxLength: MAX_LABEL_LENGTH },
    detail: { type: "string", maxLength: MAX_DETAIL_LENGTH },
  },
} as const;

export const DOCUMENT_EXTRAS_PROPERTIES = {
  revealLine: LINE_SCHEMA,
  annotations: {
    type: "array",
    maxItems: MAX_DOCUMENT_ANNOTATIONS,
    items: DOCUMENT_ANNOTATION_SCHEMA,
  },
} as const;

export interface DocumentExtras {
  readonly revealLine?: number;
  readonly annotations?: readonly RuntimeUiDocumentAnnotation[];
}

type Fail = (message: string) => Error;

function line(value: unknown, field: string, fail: Fail): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_LINE) {
    throw fail(`Document ${field} must be an integer line number from 1 to ${MAX_LINE}.`);
  }
  return value;
}

function boundedText(value: unknown, field: string, max: number, fail: Fail): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw fail(`Document annotation ${field} must be a non-empty string of at most ${max} chars.`);
  }
  return value;
}

function isTone(value: unknown): value is RuntimeUiDocumentAnnotationTone {
  return TONES.some((tone) => tone === value);
}

function annotation(value: unknown, fail: Fail): RuntimeUiDocumentAnnotation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw fail("Document annotations must be objects.");
  }
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  for (const key of Object.keys(record)) {
    if (!(key in DOCUMENT_ANNOTATION_SCHEMA.properties)) {
      throw fail(`Document annotation key "${key}" is not allowed.`);
    }
  }
  const startLine = line(record.startLine, "annotation startLine", fail);
  const endLine =
    record.endLine === undefined ? undefined : line(record.endLine, "annotation endLine", fail);
  if (endLine !== undefined && endLine < startLine) {
    throw fail("Document annotation endLine must not precede startLine.");
  }
  const tone = record.tone;
  if (!isTone(tone)) {
    throw fail(`Document annotation tone must be one of ${TONES.join(", ")}.`);
  }
  return {
    startLine,
    ...(endLine === undefined ? {} : { endLine }),
    tone,
    label: boundedText(record.label, "label", MAX_LABEL_LENGTH, fail),
    ...(record.detail === undefined
      ? {}
      : { detail: boundedText(record.detail, "detail", MAX_DETAIL_LENGTH, fail) }),
  };
}

/** Validates the optional reveal line and annotations carried on file content. */
export function normalizeDocumentExtras(
  source: { readonly revealLine?: unknown; readonly annotations?: unknown },
  fail: Fail,
): DocumentExtras {
  const extras: { revealLine?: number; annotations?: RuntimeUiDocumentAnnotation[] } = {};
  if (source.revealLine !== undefined)
    extras.revealLine = line(source.revealLine, "revealLine", fail);
  if (source.annotations !== undefined) {
    if (!Array.isArray(source.annotations)) throw fail("Document annotations must be an array.");
    if (source.annotations.length > MAX_DOCUMENT_ANNOTATIONS) {
      throw fail(`At most ${MAX_DOCUMENT_ANNOTATIONS} document annotations are allowed.`);
    }
    extras.annotations = source.annotations.map((item) => annotation(item, fail));
  }
  return extras;
}
