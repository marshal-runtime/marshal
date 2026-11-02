/**
 * Shared telemetry constants for the Context Picker. Lives in its own
 * module (separate from telemetry-hooks.ts and telemetry.tsx) so the
 * `only-export-components` lint rule on the consumer files doesn't
 * force the constants to be duplicated.
 */

import type { InteractiveElement } from "@/services/telemetry/opensource";
import { guid } from "@/services/telemetry/opensource";

export const contextPickerDataContractId = guid("33327c3f-d261-4da0-a8e6-224b4fdfbfc9");
export const contextPickerExpectedPaths = ["/App/Chat/Input"];

export function contextPickerElement(
  name: string,
  aggregation: "Single" | "Multi",
): InteractiveElement {
  return {
    name,
    type: "InteractiveElement",
    aggregation,
    checkpoints: [],
    expectedPaths: contextPickerExpectedPaths,
    dataContractId: contextPickerDataContractId,
  };
}
