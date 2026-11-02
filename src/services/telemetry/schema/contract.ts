import type * as React from "react";

import type {
  Checkpoint,
  Component,
  InteractiveElement,
  InteractiveElementMonitorProps,
  NonInteractiveElement,
  NonInteractiveElementMonitorProps,
  SimpleProperty,
  SimplePropertyMonitorProps,
  TelemetryPathContextProviderProps,
  UseInteractiveElementMonitorProps,
} from "../opensource";
import {
  allContentReadyCheckpoint,
  guid,
  InteractiveElementMonitor,
  NonInteractiveElementMonitor,
  primaryContentReadyCheckpoint,
  SimplePropertyMonitor,
  TelemetryPath,
  useInteractiveElementMonitor,
} from "../opensource";

/**
 * Data contract identifier stamped on every component and measure. Kept
 * byte-identical to the value the previous generated vocabulary emitted so
 * events already on disk in the local JSONL sink stay joinable with new ones.
 */
export const MARSHAL_DATA_CONTRACT_ID = guid("33327c3f-d261-4da0-a8e6-224b4fdfbfc9");

export const NO_CHECKPOINT: Checkpoint[] = [];
export const CONTENT_READY: Checkpoint[] = [allContentReadyCheckpoint];
export const PRIMARY_AND_CONTENT_READY: Checkpoint[] = [
  primaryContentReadyCheckpoint,
  allContentReadyCheckpoint,
];

/**
 * One row of a measure table: `[aggregation, checkpoints, expectedPaths]`.
 * Only `name` and `dataContractId` reach the sink; the rest is contract
 * metadata that `schema.test.tsx` validates against `components.ts`.
 */
export type MeasureSpec = readonly [
  aggregation: "Single" | "Multi",
  checkpoints: Checkpoint[],
  expectedPaths: readonly string[],
];

type PathProvider = (props: TelemetryPathContextProviderProps) => React.ReactNode;

function measure<Name extends string, Type extends string>(
  name: Name,
  type: Type,
  [aggregation, checkpoints, expectedPaths]: MeasureSpec,
) {
  return {
    name,
    type,
    aggregation,
    checkpoints,
    expectedPaths: [...expectedPaths],
    dataContractId: MARSHAL_DATA_CONTRACT_ID,
  };
}

function mapTable<Name extends string, Value>(
  table: Readonly<Record<Name, MeasureSpec>>,
  build: (name: Name, spec: MeasureSpec) => Value,
): Record<Name, Value> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.entries loses the key union from the typed table
  const entries = Object.entries(table) as [Name, MeasureSpec][];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every input key is mapped exactly once above
  return Object.fromEntries(entries.map(([name, spec]) => [name, build(name, spec)])) as Record<
    Name,
    Value
  >;
}

/** Builds one path provider per component name, keyed by that name. */
export function telemetryComponents<Name extends string>(
  ...names: Name[]
): Record<Name, PathProvider> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every supplied component name is mapped exactly once
  return Object.fromEntries(
    names.map((name) => {
      const component: Component = { name, dataContractId: MARSHAL_DATA_CONTRACT_ID };
      return [
        name,
        (props: TelemetryPathContextProviderProps) => TelemetryPath({ ...props, id: component }),
      ];
    }),
  ) as Record<Name, PathProvider>;
}

export function defineInteractiveElements<Name extends string>(
  table: Readonly<Record<Name, MeasureSpec>>,
): Record<Name, InteractiveElement> {
  return mapTable(table, (name, spec) => measure(name, "InteractiveElement", spec));
}

export function defineNonInteractiveElements<Name extends string>(
  table: Readonly<Record<Name, MeasureSpec>>,
): Record<Name, NonInteractiveElement> {
  return mapTable(table, (name, spec) => measure(name, "NonInteractiveElement", spec));
}

export function defineBooleanProperties<Name extends string>(
  table: Readonly<Record<Name, MeasureSpec>>,
): Record<Name, SimpleProperty<boolean>> {
  return mapTable(table, (name, spec) => measure(name, "Boolean", spec));
}

export function defineStringProperties<Name extends string>(
  table: Readonly<Record<Name, MeasureSpec>>,
): Record<Name, SimpleProperty<string>> {
  return mapTable(table, (name, spec) => measure(name, "StringLiteral", spec));
}

export function interactiveMonitor(id: InteractiveElement) {
  return function Monitor<ParamsType extends unknown[], CallbackType, MiscType extends string>(
    props: InteractiveElementMonitorProps<ParamsType, CallbackType, MiscType>,
  ): React.ReactNode {
    return InteractiveElementMonitor({ id, ...props });
  };
}

export function interactiveMonitorHook(id: InteractiveElement) {
  return function useMonitor<ParamsType extends unknown[], CallbackType, MiscType extends string>(
    props: UseInteractiveElementMonitorProps<ParamsType, CallbackType, MiscType>,
  ): (...params: ParamsType) => CallbackType {
    return useInteractiveElementMonitor({ id, ...props });
  };
}

export function nonInteractiveMonitor(id: NonInteractiveElement) {
  return function Monitor(props: NonInteractiveElementMonitorProps): React.ReactNode {
    return NonInteractiveElementMonitor({ id, ...props });
  };
}

export function simplePropertyMonitor<ValueType extends boolean | string>(
  id: SimpleProperty<ValueType>,
) {
  return function Monitor(
    props: SimplePropertyMonitorProps<SimpleProperty<ValueType>, ValueType>,
  ): React.ReactNode {
    return SimplePropertyMonitor({ id, ...props });
  };
}
