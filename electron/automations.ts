// Barrel re-export — keeps all external imports unchanged.
// Internal modules live in electron/automations/*.ts

export type {
  Automation,
  AutomationRun,
  AutomationStep,
  IntervalSchedule,
  StepResult,
  StrictAutomationSchedule,
} from "./automations/domain/contracts";

export {
  normalizeSchedule,
  parseSchedule,
  requireSchedule,
  resolveOneOffInstant,
  resolveOneOffSchedule,
  SCHEDULE_FORMAT_HINT,
} from "./automations/schedule";

export { normalizeModelOverride } from "./automations/domain/model-override";

export {
  addLocalDays,
  sameLocalDay,
  shouldTriggerSchedule,
  startOfLocalDay,
} from "./automations/triggering";

export { AutomationManager } from "./automations/manager";
