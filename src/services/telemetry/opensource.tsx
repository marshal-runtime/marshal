/* eslint-disable react/only-export-components -- compatibility module intentionally exposes the complete telemetry API */

import { createLogger } from "@common/marshal-logger";
import type {
  ErrorFamily,
  EventType,
  MidgardError,
  TelemetryCallbacks,
  TelemetryEvent,
  TelemetryEventMiddleware,
  TelemetryFieldValue,
  TelemetrySink,
  TelemetrySinkManager,
} from "@common/telemetry/types";
import { trace, type Attributes } from "@opentelemetry/api";
import * as React from "react";
import { v4 as uuidv4 } from "uuid";

import { finalizeTelemetrySync, registerTelemetryFinalizer } from "./finalization";

export type {
  ErrorFamily,
  EventType,
  MidgardError,
  TelemetryCallbacks,
  TelemetryEvent,
  TelemetryEventMiddleware,
  TelemetrySink,
  TelemetrySinkManager,
};

const log = createLogger("OpenTelemetry");
const tracer = trace.getTracer("marshal-renderer");

export type GUID = string;
export type Gesture =
  | "click"
  | "doubleClick"
  | "doubleTap"
  | "focusLeave"
  | "hostApp"
  | "hover"
  | "keypress"
  | "longPress"
  | "rightClick"
  | "scroll"
  | "tap";

export interface Component {
  name: string;
  dataContractId?: GUID;
}

export interface TelemetryPathItem {
  name?: string;
  index?: number;
  dataContractId?: GUID;
}

export interface TelemetryPathProps {
  pathItems: TelemetryPathItem[];
}

export interface TelemetryContextProps {
  getAccountType(): string | undefined;
  getAppName(): string;
  getAppVersion(): string;
  getComplianceEnvironment(): string | undefined;
  getEcsConfigIds(): string;
  getFlights(): string;
  getClientType(): string | undefined;
  getHostApp(): string | undefined;
  getHostAppApp(): string;
  getHostAppPlatform(): string | undefined;
  getHostAppContext(): string;
  getHostAppRing(): string;
  getHostAppSessionCorrelationId(): string;
  getHostAppSubSessionCorrelationId(): string;
  getHostAppVariant(): string;
  getHostAppVersion(): string;
  getIsGlobalSettingsAccount(): boolean | undefined;
  getParentSessionCorrelationId(): string;
  getPreRenderStartTime(): number;
  getSessionCorrelationId(): string;
  getSessionStartGesture(): Gesture;
  getTenantId(): string;
  getUserId(): string;
  getUserPuid(): string;
  isDebugEventsEnabled?(): boolean;
}

export interface Telemetry {
  telemetryCallbacks: TelemetryCallbacks;
  telemetryContextProps: TelemetryContextProps;
  isRootInstance?: boolean;
}

export interface TelemetryOptions {
  sinkManagers: TelemetrySinkManager[];
  middlewares: TelemetryEventMiddleware[];
}

type MeasurementBase<T> = {
  name: string;
  dataContractId: GUID;
  value?: T;
  aggregation: "Single" | "Multi";
  checkpoints: Checkpoint[];
  expectedPaths: string[];
};

export type InteractiveElement = MeasurementBase<{ hasContent: boolean }> & {
  type: "InteractiveElement";
  getMisc?: (...params: unknown[]) => Record<string, unknown> | undefined;
};

export type NonInteractiveElement = MeasurementBase<{ hasContent: boolean }> & {
  type: "NonInteractiveElement";
};

export type SimpleProperty<T> = MeasurementBase<T> & {
  type: "Boolean" | "Number" | "StringLiteral" | "String" | "GUID";
};

export interface Checkpoint {
  name: string;
  propertyLatencyAggregationType: "max";
  componentLatencyAggregationType: "max";
}

export const primaryContentReadyCheckpoint = {
  name: "PrimaryContentReady",
  propertyLatencyAggregationType: "max",
  componentLatencyAggregationType: "max",
} as const satisfies Checkpoint;

export const allContentReadyCheckpoint = {
  name: "AllContentReady",
  propertyLatencyAggregationType: "max",
  componentLatencyAggregationType: "max",
} as const satisfies Checkpoint;

export const guid = (value = uuidv4()): GUID => value;
export const generateGuid = (): string => uuidv4();

export const emptyTelemetryContextProps: TelemetryContextProps = {
  getAccountType: () => undefined,
  getAppName: () => "",
  getAppVersion: () => "",
  getComplianceEnvironment: () => undefined,
  getEcsConfigIds: () => "",
  getFlights: () => "",
  getClientType: () => undefined,
  getHostApp: () => undefined,
  getHostAppApp: () => "",
  getHostAppPlatform: () => undefined,
  getHostAppContext: () => "",
  getHostAppRing: () => "",
  getHostAppSessionCorrelationId: () => "",
  getHostAppSubSessionCorrelationId: () => "",
  getHostAppVariant: () => "",
  getHostAppVersion: () => "",
  getIsGlobalSettingsAccount: () => undefined,
  getParentSessionCorrelationId: () => "",
  getPreRenderStartTime: () => Number.NaN,
  getSessionCorrelationId: () => "",
  getSessionStartGesture: () => "hostApp",
  getTenantId: () => "",
  getUserId: () => "",
  getUserPuid: () => "",
};

function omitEmpty(
  fields: Record<string, TelemetryFieldValue>,
): Record<string, TelemetryFieldValue> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined && value !== ""),
  );
}

function toOpenTelemetryAttributes(fields: Record<string, TelemetryFieldValue>): Attributes {
  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      (Array.isArray(value) && value.every((item) => typeof item === "string"))
    ) {
      attributes[key] = value;
    } else {
      attributes[key] = JSON.stringify(value);
    }
  }
  return attributes;
}

function emitOpenTelemetryEvent(telemetryEvent: TelemetryEvent): void {
  const span = tracer.startSpan(telemetryEvent.eventType);
  span.setAttributes(toOpenTelemetryAttributes(telemetryEvent.fields));
  span.addEvent(telemetryEvent.eventType, toOpenTelemetryAttributes(telemetryEvent.fields));
  span.end();
}

function event(eventType: EventType, fields: Record<string, TelemetryFieldValue>): TelemetryEvent {
  return { eventType, fields: omitEmpty(fields) };
}

export const schema = {
  sessionStart: (fields: Record<string, TelemetryFieldValue>) =>
    event("Marshal.SessionStart", fields),
  sessionEnd: (fields: Record<string, TelemetryFieldValue>) => event("Marshal.SessionEnd", fields),
  userAction: (fields: Record<string, TelemetryFieldValue>) => event("Marshal.UserAction", fields),
  fetch: (fields: Record<string, TelemetryFieldValue>) => event("Marshal.Fetch", fields),
  fetchDebug: (fields: Record<string, TelemetryFieldValue>) => event("Marshal.FetchDebug", fields),
  render: (fields: Record<string, TelemetryFieldValue>) => event("Marshal.Render", fields),
  error: (fields: Record<string, TelemetryFieldValue>) => event("Marshal.Error", fields),
  errorDebug: (fields: Record<string, TelemetryFieldValue>) => event("Marshal.ErrorDebug", fields),
};

export const CopyTagsToFields: TelemetryEventMiddleware = (source) => ({
  ...source,
  fields: omitEmpty({ ...source.fields, ...source.tags }),
});

export function makeTelemetrySinkManager(): TelemetrySinkManager {
  let sink: TelemetrySink | null = null;
  const queue: TelemetryEvent[] = [];
  return {
    send: (telemetryEvent) => {
      if (sink) {
        sink.send(telemetryEvent);
      } else {
        queue.push(telemetryEvent);
      }
    },
    hasNoSink: () => sink === null,
    setSink: (nextSink) => {
      sink = nextSink;
      for (const queued of queue.splice(0)) nextSink.send(queued);
    },
  };
}

export function makeConsoleSink(_hostApp: string): TelemetrySinkManager {
  return {
    send: (telemetryEvent) => log.info(telemetryEvent.eventType),
    hasNoSink: () => false,
    setSink: () => {},
  };
}

export function makeTelemetryCallbacks(
  options: TelemetryOptions,
  _eventSchema: typeof schema,
): TelemetryCallbacks {
  const errorMap: Record<string, Record<number, string>> = {};
  const emit = (telemetryEvent: TelemetryEvent) => {
    const transformed = options.middlewares.reduce(
      (current, middleware) => middleware(current),
      telemetryEvent,
    );
    emitOpenTelemetryEvent(transformed);
    for (const manager of options.sinkManagers) manager.send(transformed);
  };
  const logger =
    (factory: (fields: Record<string, TelemetryFieldValue>) => TelemetryEvent) =>
    (fields: Record<string, TelemetryFieldValue>) =>
      emit(factory(fields));

  return {
    logSessionStartEvent: logger(schema.sessionStart),
    logSessionEndEvent: logger(schema.sessionEnd),
    logUserActionEvent: logger(schema.userAction),
    logFetchEvent: logger(schema.fetch),
    logFetchDebugEvent: logger(schema.fetchDebug),
    logRenderEvent: logger(schema.render),
    logErrorEvent: logger(schema.error),
    logErrorDebugEvent: logger(schema.errorDebug),
    registerErrors: (family, errors) => {
      const entries: Record<number, string> = {};
      for (const [key, value] of Object.entries(errors)) {
        const code = Number(key);
        if (Number.isInteger(code) && typeof value === "string") entries[code] = value;
      }
      errorMap[family] = entries;
    },
    lookupError: (telemetryError) => [
      telemetryError.family,
      telemetryError.code,
      errorMap[telemetryError.family]?.[telemetryError.code] ?? "Unknown",
    ],
    errorMap,
  };
}

const emptyCallbacks = makeTelemetryCallbacks({ sinkManagers: [], middlewares: [] }, schema);
export const emptyTelemetry: Telemetry = {
  telemetryCallbacks: emptyCallbacks,
  telemetryContextProps: { ...emptyTelemetryContextProps },
};

export const TelemetryContext = React.createContext<Telemetry>(emptyTelemetry);
const EMPTY_SIZE = () => "";
export const SizeContext = React.createContext<() => string>(EMPTY_SIZE);

export function useTelemetry(): Telemetry {
  return React.useContext(TelemetryContext);
}

function commonFields(context: TelemetryContextProps): Record<string, TelemetryFieldValue> {
  return {
    accountType: context.getAccountType(),
    appName: context.getAppName(),
    appVersion: context.getAppVersion(),
    clientType: context.getHostApp(),
    complianceEnvironment: context.getComplianceEnvironment(),
    eventUniqueIdentifier: generateGuid(),
    hostApp: context.getHostApp(),
    hostAppApp: context.getHostAppApp(),
    hostAppContext: context.getHostAppContext(),
    hostAppPlatform: context.getHostAppPlatform(),
    hostAppRing: context.getHostAppRing(),
    hostAppSessionCorrelationId: context.getHostAppSessionCorrelationId(),
    hostAppSubSessionCorrelationId: context.getHostAppSubSessionCorrelationId(),
    hostAppVariant: context.getHostAppVariant(),
    hostAppVersion: context.getHostAppVersion(),
    sessionCorrelationId: context.getSessionCorrelationId(),
    tenantId: context.getTenantId(),
    userId: context.getUserId(),
  };
}

export function startSession(
  context: TelemetryContextProps,
  callbacks: TelemetryCallbacks,
  getInitialSize: () => string,
): void {
  if (context.getSessionCorrelationId()) return;
  const sessionCorrelationId = generateGuid();
  context.getSessionCorrelationId = () => sessionCorrelationId;
  callbacks.logSessionStartEvent({
    ...commonFields(context),
    ecsConfigIds: context.getEcsConfigIds(),
    flights: context.getFlights(),
    gesture: context.getSessionStartGesture(),
    initialSize: getInitialSize(),
    isGlobalSettingsAccount: context.getIsGlobalSettingsAccount(),
    parentSessionCorrelationId: context.getParentSessionCorrelationId(),
    userPuid: context.getUserPuid(),
  });
}

export function TelemetryContextProvider({
  telemetry,
  getSize = EMPTY_SIZE,
  children,
}: {
  telemetry: Telemetry;
  getSize?: () => string;
  children: React.ReactNode;
}): React.ReactElement {
  const getSizeRef = React.useRef(getSize);
  React.useEffect(() => {
    getSizeRef.current = getSize;
  }, [getSize]);

  React.useEffect(() => {
    startSession(telemetry.telemetryContextProps, telemetry.telemetryCallbacks, getSizeRef.current);
    let finalized = false;
    const finalizeSession = () => {
      if (finalized) return;
      finalized = true;
      if (!telemetry.telemetryContextProps.getSessionCorrelationId()) return;
      telemetry.telemetryCallbacks.logSessionEndEvent({
        ...commonFields(telemetry.telemetryContextProps),
        finalSize: getSizeRef.current(),
        gesture: "focusLeave",
        misc: undefined,
      });
      telemetry.telemetryContextProps.getSessionCorrelationId = () => "";
    };
    const unregister = registerTelemetryFinalizer(0, finalizeSession);
    return () => {
      finalizeTelemetrySync();
      unregister();
    };
  }, [telemetry]);

  return (
    <TelemetryContext.Provider value={telemetry}>
      <SizeContext.Provider value={getSize}>{children}</SizeContext.Provider>
    </TelemetryContext.Provider>
  );
}

export const TelemetryPathContext = React.createContext<Readonly<TelemetryPathProps>>({
  pathItems: [],
});

export function useTelemetryPath(): TelemetryPathProps {
  return React.useContext(TelemetryPathContext);
}

export interface TelemetryPathContextProviderProps {
  children: React.ReactNode;
}

export function TelemetryPath({
  id,
  children,
}: TelemetryPathContextProviderProps & {
  id: Component | number | undefined;
}): React.ReactElement {
  const parent = useTelemetryPath();
  const pathItems = React.useMemo(() => {
    if (id === undefined) return parent.pathItems;
    return [
      ...parent.pathItems,
      typeof id === "number" ? { index: id } : { name: id.name, dataContractId: id.dataContractId },
    ];
  }, [id, parent.pathItems]);
  const contextValue = React.useMemo(() => ({ pathItems }), [pathItems]);
  return (
    <TelemetryPathContext.Provider value={contextValue}>{children}</TelemetryPathContext.Provider>
  );
}

export function withTelemetryPath<Props>(
  id: Component | number | undefined,
  WrappedComponent: React.ComponentType<Props>,
): React.ComponentType<Props & React.JSX.IntrinsicAttributes> {
  function WithTelemetryPath(props: Props & React.JSX.IntrinsicAttributes) {
    return (
      <TelemetryPath id={id}>
        <WrappedComponent {...props} />
      </TelemetryPath>
    );
  }
  return WithTelemetryPath;
}

function getTelemetryPathAndComponentName(pathItems: TelemetryPathItem[]) {
  let componentIndex = -1;
  for (let index = pathItems.length - 1; index >= 0; index -= 1) {
    if (typeof pathItems[index]?.name === "string") {
      componentIndex = index;
      break;
    }
  }
  const component = componentIndex >= 0 ? pathItems[componentIndex] : undefined;
  const ancestors = componentIndex >= 0 ? pathItems.slice(0, componentIndex) : pathItems;
  const pathSegments = ancestors.flatMap((item) => {
    if (typeof item.name === "string") return [item.name];
    if (typeof item.index === "number") return [String(item.index)];
    return [];
  });
  return {
    path: pathSegments.length ? `/${pathSegments.join("/")}` : "",
    pathDataContractIds: ancestors
      .map((item) => item.dataContractId)
      .filter((value): value is GUID => value !== undefined),
    componentName: component?.name ?? "",
    componentDataContractId: component?.dataContractId ?? "",
  };
}

export interface RenderScenario {
  renderScenarioCorrelationId: string;
  action: RenderScenarioAction;
  targetView: string;
  preRenderStartTime: number;
  renderStartTime: number;
  intendedSize?: string;
  checkpoints?: Record<string, Record<string, number | undefined>>;
  components?: Record<string, unknown>;
  componentsWithError?: string[];
  didScroll: boolean | undefined;
  duration: number;
  errorsByInstanceCorrelationId: Record<string, unknown>;
  measurementsByInstanceCorrelationId: Record<string, unknown>;
  personaCorrelationId: string;
  personaType: string;
  state: "Success" | "Failure";
  size: string;
}

export type RenderScenarioAction = "Open" | "Navigate" | "ChangePersona" | "Refine";

export function getEmptyRenderScenarioAggregates(): Omit<
  RenderScenario,
  | "renderScenarioCorrelationId"
  | "preRenderStartTime"
  | "renderStartTime"
  | "action"
  | "targetView"
  | "intendedSize"
> {
  return {
    didScroll: undefined,
    duration: 0,
    errorsByInstanceCorrelationId: {},
    measurementsByInstanceCorrelationId: {},
    personaCorrelationId: "",
    personaType: "",
    state: "Success",
    size: "",
  };
}

export interface RenderMonitor {
  setRenderScenarioState(componentName: string, state: "Success" | "Failure"): void;
  updateAnalytics(component: string, properties: Record<string, unknown>): void;
  updateCheckpoints(component: string, renderStopTime: number, checkpoints: unknown[]): void;
  updateOtherAggregates(componentName: string, aggregates: Record<string, string>): void;
  updateSimpleProperty(...args: unknown[]): void;
  updateNonInteractiveElement(...args: unknown[]): void;
  updateInteractiveElement(...args: unknown[]): void;
  updateRenderScenarioState(...args: unknown[]): void;
  setInteractiveElementInteraction(instanceCorrelationId: string): void;
  setMeasureIsUnmounted(instanceCorrelationId: string): void;
  getSize(): string;
  getPersonaCorrelationId(): string;
  getPersonaType(): string;
  setDidScroll(value: boolean): void;
  getRenderScenarioCorrelationId(): string;
  hasSession(): boolean;
  endSession(): void;
}

export const emptyRenderMonitor: RenderMonitor = {
  setRenderScenarioState: () => {},
  updateAnalytics: () => {},
  updateCheckpoints: () => {},
  updateOtherAggregates: () => {},
  updateSimpleProperty: () => {},
  updateNonInteractiveElement: () => {},
  updateInteractiveElement: () => {},
  updateRenderScenarioState: () => {},
  setInteractiveElementInteraction: () => {},
  setMeasureIsUnmounted: () => {},
  getSize: () => "",
  getPersonaCorrelationId: () => "",
  getPersonaType: () => "",
  setDidScroll: () => {},
  getRenderScenarioCorrelationId: () => "",
  hasSession: () => false,
  endSession: () => {},
};

export const RenderMonitorContext = React.createContext<RenderMonitor>(emptyRenderMonitor);

function renderFields(
  telemetry: Telemetry,
  scenario: RenderScenario,
): Record<string, TelemetryFieldValue> {
  return {
    ...commonFields(telemetry.telemetryContextProps),
    action: scenario.action,
    checkpoints: scenario.checkpoints ? JSON.stringify(scenario.checkpoints) : undefined,
    components: scenario.components ? JSON.stringify(scenario.components) : undefined,
    componentsWithError: scenario.componentsWithError
      ? JSON.stringify(scenario.componentsWithError)
      : undefined,
    didScroll: scenario.didScroll,
    duration: scenario.duration,
    errors:
      Object.keys(scenario.errorsByInstanceCorrelationId).length > 0
        ? JSON.stringify(scenario.errorsByInstanceCorrelationId)
        : undefined,
    intendedSize: scenario.intendedSize,
    measurements:
      Object.keys(scenario.measurementsByInstanceCorrelationId).length > 0
        ? JSON.stringify(scenario.measurementsByInstanceCorrelationId)
        : undefined,
    personaCorrelationId: scenario.personaCorrelationId,
    personaType: scenario.personaType,
    preRenderLatency: Number.isFinite(scenario.preRenderStartTime)
      ? Math.max(0, scenario.renderStartTime - scenario.preRenderStartTime)
      : undefined,
    renderScenarioCorrelationId: scenario.renderScenarioCorrelationId,
    size: scenario.size,
    state: scenario.state,
    targetView: scenario.targetView,
  };
}

export function useRenderMonitorInitializer(
  telemetry: Telemetry,
  callbacks: {
    getRenderScenario(): RenderScenario;
    getPersonaCorrelationId?: () => string;
    getPersonaType?: () => string;
    getSize?: () => string;
    setInteractionHappened?: React.Dispatch<React.SetStateAction<boolean>>;
  },
): RenderMonitor {
  const scenario = callbacks.getRenderScenario();
  const activeScenarioRef = React.useRef<RenderScenario | null>(scenario);
  const emitScenario = React.useCallback(
    (completedScenario: RenderScenario) => {
      telemetry.telemetryCallbacks.logRenderEvent(
        renderFields(telemetry, {
          ...completedScenario,
          duration: Math.max(0, Date.now() - completedScenario.renderStartTime),
        }),
      );
    },
    [telemetry],
  );

  React.useEffect(() => {
    const activeScenario = activeScenarioRef.current;
    if (
      activeScenario &&
      activeScenario.renderScenarioCorrelationId !== scenario.renderScenarioCorrelationId
    ) {
      emitScenario(activeScenario);
      activeScenarioRef.current = scenario;
    } else if (!activeScenario) {
      activeScenarioRef.current = scenario;
    }
  }, [emitScenario, scenario]);

  const flushActiveScenario = React.useCallback(() => {
    const activeScenario = activeScenarioRef.current;
    if (!activeScenario) return;
    activeScenarioRef.current = null;
    emitScenario(activeScenario);
  }, [emitScenario]);

  React.useEffect(() => {
    const unregister = registerTelemetryFinalizer(10, flushActiveScenario);
    return () => {
      flushActiveScenario();
      unregister();
    };
  }, [flushActiveScenario]);

  return React.useMemo(
    () => ({
      ...emptyRenderMonitor,
      getSize: () => callbacks.getSize?.() ?? activeScenarioRef.current?.size ?? scenario.size,
      getPersonaCorrelationId: () =>
        callbacks.getPersonaCorrelationId?.() ??
        activeScenarioRef.current?.personaCorrelationId ??
        scenario.personaCorrelationId,
      getPersonaType: () =>
        callbacks.getPersonaType?.() ??
        activeScenarioRef.current?.personaType ??
        scenario.personaType,
      getRenderScenarioCorrelationId: () =>
        activeScenarioRef.current?.renderScenarioCorrelationId ??
        scenario.renderScenarioCorrelationId,
      hasSession: () => true,
      endSession: flushActiveScenario,
    }),
    [callbacks, flushActiveScenario, scenario],
  );
}

export interface UseInteractiveElementMonitorProps<
  ParamsType extends unknown[],
  CallbackType,
  MiscType extends string,
> {
  callback: (...params: ParamsType) => CallbackType;
  index?: number;
  hasContent: boolean;
  interactionDisabled?: boolean;
  getMisc?: (...params: ParamsType) => Record<string, unknown>;
  readonly __miscType?: MiscType;
}

export interface InteractiveElementMonitorProps<
  ParamsType extends unknown[],
  CallbackType,
  MiscType extends string,
> {
  children:
    | ((
        measurementHandler: (...params: ParamsType) => CallbackType,
        interactionDisabled: boolean,
      ) => React.ReactNode)
    | null
    | undefined;
  callback: (...params: ParamsType) => CallbackType;
  interactionDisabled?: boolean;
  index?: number;
  getMisc?: (...params: ParamsType) => Record<string, unknown>;
  readonly __miscType?: MiscType;
}

export function useInteractiveElementMonitor<
  ParamsType extends unknown[],
  CallbackType,
  MiscType extends string,
>(
  props: UseInteractiveElementMonitorProps<ParamsType, CallbackType, MiscType> & {
    id: InteractiveElement | undefined;
  },
): (...params: ParamsType) => CallbackType {
  const telemetry = useTelemetry();
  const path = useTelemetryPath();
  const renderMonitor = React.useContext(RenderMonitorContext);
  return React.useCallback(
    (...params: ParamsType) => {
      if (props.id && props.hasContent && !props.interactionDisabled) {
        const pathFields = getTelemetryPathAndComponentName(path.pathItems);
        const misc = props.getMisc?.(...params) ?? props.id.getMisc?.(...params);
        telemetry.telemetryCallbacks.logUserActionEvent({
          ...commonFields(telemetry.telemetryContextProps),
          action: props.id.name,
          component: pathFields.componentName,
          componentDataContractId: pathFields.componentDataContractId,
          dataContractId: props.id.dataContractId,
          gesture: "click",
          index: props.index ?? 0,
          misc: misc ? JSON.stringify(misc) : undefined,
          moduleName: pathFields.componentName,
          path: pathFields.path,
          pathDataContractIds: JSON.stringify(pathFields.pathDataContractIds),
          renderScenarioCorrelationId: renderMonitor.getRenderScenarioCorrelationId(),
          size: renderMonitor.getSize(),
        });
      }
      return props.callback(...params);
    },
    [path.pathItems, props, renderMonitor, telemetry],
  );
}

export function InteractiveElementMonitor<
  ParamsType extends unknown[],
  CallbackType,
  MiscType extends string,
>(
  props: InteractiveElementMonitorProps<ParamsType, CallbackType, MiscType> & {
    id: InteractiveElement | undefined;
  },
): React.ReactNode | null | undefined {
  const handler = useInteractiveElementMonitor({
    ...props,
    hasContent: props.children != null,
  });
  return props.children?.(handler, props.interactionDisabled ?? false);
}

export interface UseNonInteractiveElementMonitorProps {
  hasContent: boolean;
  index?: number;
}

export interface NonInteractiveElementMonitorProps {
  children?: React.ReactNode | null;
  index?: number;
}

export function useNonInteractiveElementMonitor(
  _props: UseNonInteractiveElementMonitorProps & { id: NonInteractiveElement | undefined },
): void {}

export function NonInteractiveElementMonitor(
  props: NonInteractiveElementMonitorProps & { id: NonInteractiveElement | undefined },
): React.ReactNode | null | undefined {
  return props.children;
}

export interface UseSimplePropertyMonitorProps<
  SimplePropertyType extends SimpleProperty<boolean | number | string>,
  ValueType extends SimplePropertyType["value"],
> {
  value: Exclude<ValueType, undefined>;
  index?: number;
}

export interface SimplePropertyMonitorProps<
  SimplePropertyType extends SimpleProperty<boolean | number | string>,
  ValueType extends SimplePropertyType["value"],
> extends UseSimplePropertyMonitorProps<SimplePropertyType, ValueType> {
  children?: React.ReactNode | null;
}

export function useSimplePropertyMonitor<
  SimplePropertyType extends SimpleProperty<boolean | number | string>,
  ValueType extends SimplePropertyType["value"],
>(
  _props: UseSimplePropertyMonitorProps<SimplePropertyType, ValueType> & {
    id: SimplePropertyType | undefined;
  },
): void {}

export function SimplePropertyMonitor<
  SimplePropertyType extends SimpleProperty<boolean | number | string>,
  ValueType extends SimplePropertyType["value"],
>(
  props: SimplePropertyMonitorProps<SimplePropertyType, ValueType> & {
    id: SimplePropertyType | undefined;
  },
): React.ReactNode | null | undefined {
  return props.children;
}

export interface UseRenderErrorProps {
  dataContractId: GUID;
  hasError: boolean;
  index?: number;
}

export interface RenderErrorMonitorProps {
  children?: React.ReactNode | null;
}

export function RenderErrorMonitor(
  props: RenderErrorMonitorProps & { id: UseRenderErrorProps },
): React.ReactNode | null {
  return props.children ?? null;
}

function errorFields(
  telemetryError: MidgardError,
  callbacks: TelemetryCallbacks,
  context: TelemetryContextProps,
): Record<string, TelemetryFieldValue> {
  const [family, code, message] = callbacks.lookupError(telemetryError);
  return {
    ...commonFields(context),
    code,
    family,
    message,
    midgardError: telemetryError,
    moduleName: "",
    component: "",
    componentDataContractId: "",
    path: "",
    pathDataContractIds: "",
  };
}

export function useGetLogErrorTelemetry(): (telemetryError?: MidgardError) => void {
  const telemetry = useTelemetry();
  return React.useCallback(
    (telemetryError?: MidgardError) => {
      if (!telemetryError) return;
      telemetry.telemetryCallbacks.logErrorEvent(
        errorFields(telemetryError, telemetry.telemetryCallbacks, telemetry.telemetryContextProps),
      );
    },
    [telemetry],
  );
}

export function logErrorEventOutsideAppSession(
  props: { midgardError: MidgardError },
  callbacks: TelemetryCallbacks,
  context: TelemetryContextProps,
): void {
  callbacks.logErrorEvent(errorFields(props.midgardError, callbacks, context));
}

export function neverGuardDefault<T>(_value: never, fallback: T): T {
  return fallback;
}
