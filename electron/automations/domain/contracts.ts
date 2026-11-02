import type { z } from "zod";

import type { AutomationStep } from "../../../common/marshal-ipc-contract";
import type { AutomationRunSchema, AutomationScheduleSchema, AutomationSchema } from "../schemas";

export type { AutomationStep };

export type Automation = z.infer<typeof AutomationSchema>;
export type AutomationRun = z.infer<typeof AutomationRunSchema>;
export type StepResult = AutomationRun["stepResults"][number];

export type StrictAutomationSchedule = z.infer<typeof AutomationScheduleSchema>;

export type TimeOfDay = Extract<StrictAutomationSchedule, { kind: "single" }>["time"];
export type IntervalSchedule = Extract<StrictAutomationSchedule, { kind: "interval" }>;
export type MultiSchedule = Extract<StrictAutomationSchedule, { kind: "multi" }>;
export type SingleSchedule = Extract<StrictAutomationSchedule, { kind: "single" }>;
