import type { UseInteractiveElementMonitorProps } from "@/services/telemetry/opensource";
import { useInteractiveElementMonitor } from "@/services/telemetry/opensource";

import { contextPickerElement } from "./context-picker-telemetry-shared";

const ContextPickerSelectEntityInteractiveElement = contextPickerElement(
  "ContextPickerSelectEntity",
  "Multi",
);
const ContextPickerSwitchTabInteractiveElement = contextPickerElement(
  "ContextPickerSwitchTab",
  "Multi",
);

export const useInteractiveElementMonitor_ContextPickerSelectEntity = <
  ParamsType extends Array<unknown>,
  CallbackType,
  MiscType extends string,
>(
  props: UseInteractiveElementMonitorProps<ParamsType, CallbackType, MiscType>,
): ((...params: ParamsType) => CallbackType) =>
  useInteractiveElementMonitor({
    id: ContextPickerSelectEntityInteractiveElement,
    ...props,
  });

export const useInteractiveElementMonitor_ContextPickerSwitchTab = <
  ParamsType extends Array<unknown>,
  CallbackType,
  MiscType extends string,
>(
  props: UseInteractiveElementMonitorProps<ParamsType, CallbackType, MiscType>,
): ((...params: ParamsType) => CallbackType) =>
  useInteractiveElementMonitor({
    id: ContextPickerSwitchTabInteractiveElement,
    ...props,
  });
