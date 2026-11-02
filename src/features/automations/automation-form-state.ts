// Lives in its own module (rather than alongside AutomationFormView) so the
// component file stays a pure component export — keeps react-refresh happy.
import type { AutomationStep, PermissionsConfig } from "@/types/electron";

export interface AutomationFormState {
  name: string;
  description: string;
  steps: AutomationStep[];
  schedule: string;
  /** True when the schedule isn't round-trippable back to the active backend
   *  (set by the gateway inverse-mapper). Render the schedule as read-only
   *  text and block edits. */
  scheduleReadOnly: boolean;
  error: string;
  triggerType: "schedule" | "condition";
  condition: string;
  checkInterval: number;
  isOneShot: boolean;
  model: string | undefined;
  permissions: PermissionsConfig | undefined;
  browserHeadless: boolean;
  /** Per-automation relay notification mode.
   *  - "always": framework auto-sends the run's final output to the relay (default).
   *  - "auto":   agent decides per-run via sendNotification.
   *  - "never":  framework never sends; nothing reaches the relay. */
  teamsNotify: "always" | "auto" | "never";
}

export const INITIAL_AUTOMATION_FORM_STATE: AutomationFormState = {
  name: "",
  description: "",
  steps: [{ id: "1", label: "", prompt: "" }],
  schedule: "",
  scheduleReadOnly: false,
  error: "",
  triggerType: "schedule",
  condition: "",
  checkInterval: 15,
  isOneShot: false,
  model: undefined,
  permissions: undefined,
  browserHeadless: false,
  teamsNotify: "always",
};
