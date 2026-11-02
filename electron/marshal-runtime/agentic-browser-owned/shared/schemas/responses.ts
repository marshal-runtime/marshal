import { z } from 'zod';

/** Zod schema for the error portion of a command response. */
export const ResponseErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

/** Zod schema for response metadata. */
export const ResponseMetadataSchema = z.object({
  duration: z.number().nonnegative(),
  timestamp: z.number(),
  commandId: z.string().optional(),
});

/** Zod schema for the command response envelope. */
export const CommandResponseSchema = z.object({
  id: z.string().min(1),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: ResponseErrorSchema.optional(),
  metadata: ResponseMetadataSchema.optional(),
});

/** Inferred type from CommandResponseSchema. */
export type CommandResponseParsed = z.infer<typeof CommandResponseSchema>;

/** Zod schema for the navigate tool response data. */
export const NavigateResponseSchema = z.object({
  url: z.string(),
  title: z.string(),
  status: z.number().int().nonnegative(),
});

/** Inferred type from NavigateResponseSchema. */
export type NavigateResponseData = z.infer<typeof NavigateResponseSchema>;

/** Zod schema for the interact tool response data. */
export const InteractResponseSchema = z.object({
  action: z.string(),
  selector: z.string().optional(),
  success: z.boolean(),
  data: z.unknown().optional(),
});

/** Inferred type from InteractResponseSchema. */
export type InteractResponseData = z.infer<typeof InteractResponseSchema>;

/** Zod schema for the dialog tool response data. */
export const DialogResponseSchema = z.object({
  dialogType: z.enum(['alert', 'confirm', 'prompt', 'beforeunload']),
  message: z.string(),
  defaultPrompt: z.string().optional(),
  handled: z.boolean(),
});

/** Inferred type from DialogResponseSchema. */
export type DialogResponseData = z.infer<typeof DialogResponseSchema>;

/** Zod schema for the screenshot tool response data. */
export const ScreenshotResponseSchema = z.object({
  data: z.string(),
  mimeType: z.string(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
});

/** Inferred type from ScreenshotResponseSchema. */
export type ScreenshotResponseData = z.infer<typeof ScreenshotResponseSchema>;

/** Zod schema for a bounding box. */
export const BoundingBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

/** Inferred type for a bounding box. */
export type BoundingBoxData = z.infer<typeof BoundingBoxSchema>;

/** Zod schema for an accessibility tree node. */
export const AccessibilityNodeSchema: z.ZodType<AccessibilityNodeData> = z.lazy(() =>
  z.object({
    role: z.string(),
    name: z.string(),
    value: z.string().optional(),
    description: z.string().optional(),
    ref: z.string().optional(),
    selector: z.string().optional(),
    states: z.array(z.string()).optional(),
    boundingBox: BoundingBoxSchema.optional(),
    offScreen: z.boolean().optional(),
    children: z.array(AccessibilityNodeSchema).optional(),
  }),
);

/** Inferred type for an accessibility tree node. */
export interface AccessibilityNodeData {
  readonly role: string;
  readonly name: string;
  readonly value?: string;
  readonly description?: string;
  readonly ref?: string;
  readonly selector?: string;
  readonly states?: readonly string[];
  readonly boundingBox?: BoundingBoxData;
  readonly offScreen?: boolean;
  readonly children?: readonly AccessibilityNodeData[];
}

/** Zod schema for the ref info (bounding box of an interactable element). */
export const RefInfoSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  offScreen: z.boolean().optional(),
});

/** Zod schema for the accessibility tree response data. */
export const AccessibilityTreeResponseSchema = z.object({
  snapshot: z.string(),
  refs: z.record(z.string(), RefInfoSchema).optional(),
});

/** Inferred type from AccessibilityTreeResponseSchema. */
export type AccessibilityTreeResponseData = z.infer<typeof AccessibilityTreeResponseSchema>;

/** Zod schema for the getHTML tool response data. */
export const HTMLResponseSchema = z.object({
  html: z.string(),
  selector: z.string().optional(),
  length: z.number().int().nonnegative(),
});

/** Inferred type from HTMLResponseSchema. */
export type HTMLResponseData = z.infer<typeof HTMLResponseSchema>;

/** Zod schema for a table row in extract-data response. */
export const TableDataSchema = z.object({
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
  selector: z.string().optional(),
});

/** Zod schema for the extractData tool response data. */
export const ExtractDataResponseSchema = z.object({
  type: z.enum(['table', 'attributes', 'structured']),
  data: z.union([
    z.array(TableDataSchema),
    z.array(z.record(z.string(), z.string())),
    z.unknown(),
  ]),
});

/** Inferred type from TableDataSchema. */
export type TableData = z.infer<typeof TableDataSchema>;

/** Inferred type from ExtractDataResponseSchema. */
export type ExtractDataResponseData = z.infer<typeof ExtractDataResponseSchema>;

/** Zod schema for a single console output entry. */
export const ConsoleEntrySchema = z.object({
  level: z.enum(['log', 'warn', 'error', 'info', 'debug']),
  args: z.array(z.unknown()),
  timestamp: z.number(),
});

/** Inferred type from ConsoleEntrySchema. */
export type ConsoleEntry = z.infer<typeof ConsoleEntrySchema>;

/** Zod schema for the executeConsoleCommand response data. */
export const ConsoleCommandResponseSchema = z.object({
  returnValue: z.unknown(),
  consoleOutput: z.array(ConsoleEntrySchema),
});

/** Inferred type from ConsoleCommandResponseSchema. */
export type ConsoleCommandResponseData = z.infer<typeof ConsoleCommandResponseSchema>;
