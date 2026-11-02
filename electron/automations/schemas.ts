import { z } from "zod";

import { PermissionsConfigSchema } from "../settings-store";

const AutomationStepSchema = z
  .object({ id: z.string(), label: z.string(), prompt: z.string() })
  .strip();

const TimeOfDaySchema = z.object({
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
});

const DaysSchema = z.array(z.number().int().min(0).max(6));

const SingleScheduleSchema = z
  .object({
    kind: z.literal("single"),
    naturalLanguage: z.string(),
    days: DaysSchema,
    time: TimeOfDaySchema,
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  })
  .passthrough();

const IntervalScheduleSchema = z
  .object({
    kind: z.literal("interval"),
    naturalLanguage: z.string(),
    days: DaysSchema,
    intervalMinutes: z
      .number()
      .int()
      .positive()
      .refine((minutes) => minutes <= 1440 && 1440 % minutes === 0, {
        message: "intervalMinutes must divide 1440 evenly",
      }),
    anchor: TimeOfDaySchema,
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  })
  .passthrough();

const MultiScheduleSchema = z
  .object({
    kind: z.literal("multi"),
    naturalLanguage: z.string(),
    days: DaysSchema,
    times: z.array(TimeOfDaySchema).min(1),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  })
  .passthrough();

export const AutomationScheduleSchema = z.discriminatedUnion("kind", [
  SingleScheduleSchema,
  IntervalScheduleSchema,
  MultiScheduleSchema,
]);

/**
 * User-editable fields read from the bundle JSON, shared between the load
 * schema and the import schema. `workingDir` and `skillNames` are NOT here
 * — they're injected at import time from caller-side opts, not parsed from
 * JSON, so they live only in `AutomationSchema`.
 */
const AutomationFieldsSchema = z.object({
  description: z.string().optional(),
  schedule: AutomationScheduleSchema,
  condition: z.string().optional(),
  conditionCheckInterval: z.number().optional(),
  model: z.string().optional(),
  permissions: PermissionsConfigSchema.optional(),
  browserHeadless: z.boolean().optional(),
  teamsNotify: z.enum(["always", "auto", "never"]).optional(),
});

export const AutomationSchema = AutomationFieldsSchema.extend({
  id: z.string(),
  name: z.string(),
  steps: z.array(AutomationStepSchema),
  enabled: z.boolean(),
  oneShot: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  triggerType: z.enum(["schedule", "condition"]),
  workingDir: z.string().optional(),
  skillNames: z.array(z.string()).optional(),
  targetSessionId: z.string().optional(),
  workspaceName: z.string().optional(),
  repoPath: z.string().optional(),
  pinnedSessionId: z.string().optional(),
  applicationJob: z
    .object({
      ownerKey: z.string().max(256),
      jobKey: z.string().max(256),
      jobId: z.string().max(256),
      state: z.enum(["armed", "disarmed", "suspended-restart"]),
    })
    .strip()
    .optional(),
}).strip();

// Status enums must stay aligned with common/marshal-ipc-contract.ts; any value the
// contract permits must round-trip through loadHistory() without being dropped.
const StepResultSchema = z
  .object({
    stepId: z.string(),
    status: z.enum(["pending", "running", "completed", "failed", "skipped"]),
    output: z.string().optional(),
    error: z.string().optional(),
  })
  .strip();

export const AutomationRunSchema = z
  .object({
    id: z.string(),
    automationId: z.string(),
    automationName: z.string().optional(),
    sessionId: z.string().optional(),
    startedAt: z.string(),
    completedAt: z.string().optional(),
    status: z.enum(["running", "completed", "failed", "skipped"]),
    stepResults: z.array(StepResultSchema),
    finalOutput: z.string().optional(),
  })
  .strip();

/** Schema for the partial shape used during import (id/enabled/timestamps may be absent) */
export const AutomationImportSchema = AutomationFieldsSchema.extend({
  name: z.string().min(1),
  steps: z.array(AutomationStepSchema.partial({ id: true })),
  triggerType: z.enum(["schedule", "condition"]).optional(),
}).strip();
