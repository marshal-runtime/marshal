/* eslint-disable react/only-export-components -- navigation provider and hooks share one context */
import {
  RUNTIME_UI_PLACEMENT,
  RUNTIME_UI_USER_SCOPE,
  type RuntimeUiInstance,
  type RuntimeUiPlacementApplication,
} from "@common/runtime-ui";
import { useMutation } from "@tanstack/react-query";
import { createContext, use, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Puzzle } from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/marshal-ui/marshal-tooltip";
import { cn } from "@/lib/marshal-class-names";

import { RuntimeUiContext } from "./runtimeUiContext";
import { RuntimeUiInstanceFrame } from "./RuntimeUiHost";
import { useRuntimeUiPlacementSnapshot } from "./RuntimeUiPlacements";
import { RuntimeUiSessionOpenedContext } from "./RuntimeUiSessionSelection";
import { useRuntimeUiScope, type RuntimeUiModel } from "./useRuntimeUi";

interface RuntimeUiNavigationModel {
  readonly model: RuntimeUiModel;
  readonly applications: readonly RuntimeUiPlacementApplication[];
  readonly selectedInstanceId: string | null;
  readonly pending: boolean;
  readonly activate: (application: RuntimeUiPlacementApplication) => void;
  readonly dismiss: () => void;
}

const EMPTY_APPLICATIONS: readonly RuntimeUiPlacementApplication[] = Object.freeze([]);

const RuntimeUiNavigationContext = createContext<RuntimeUiNavigationModel | null>(null);

export function RuntimeUiNavigationProvider({ children }: { readonly children: ReactNode }) {
  const model = useRuntimeUiScope(RUNTIME_UI_USER_SCOPE);
  const snapshot = useRuntimeUiPlacementSnapshot(RUNTIME_UI_USER_SCOPE);
  const applications =
    snapshot.placements.find(
      (placement) => placement.metadata.id === RUNTIME_UI_PLACEMENT.NAV_PRIMARY,
    )?.applications ?? EMPTY_APPLICATIONS;
  const newest = model.instances[0];
  const newestSignature = newest ? `${newest.instanceId}:${newest.focusedAt}` : null;
  const [selection, setSelection] = useState<{ id: string | null; observedFocus: string | null }>({
    id: null,
    observedFocus: null,
  });
  const focusChanged = selection.observedFocus !== newestSignature;
  // Remote-originated focus (phone activation) is observed but never followed:
  // user-scope instances are shared state, and auto-following them would make
  // a tap on the phone hijack the desktop window (M2). Only desktop-originated
  // focus drives this pane's selection.
  const followFocus = focusChanged && newest !== undefined && newest.focusedBy !== "remote";
  if (focusChanged)
    setSelection({
      id: followFocus ? newest.instanceId : selection.id,
      observedFocus: newestSignature,
    });
  const candidateId = focusChanged
    ? followFocus
      ? newest.instanceId
      : selection.id
    : selection.id;
  const selectedInstanceId = model.instances.some(
    (instance) =>
      instance.instanceId === candidateId && isPublishedInstance(instance, applications),
  )
    ? candidateId
    : null;
  const mutation = useMutation({
    mutationFn: async (application: RuntimeUiPlacementApplication) => {
      const result = await window.runtimeUiAPI?.activatePlacement({
        ...RUNTIME_UI_USER_SCOPE,
        placementId: RUNTIME_UI_PLACEMENT.NAV_PRIMARY,
        extensionId: application.extensionId,
        applicationId: application.applicationId,
        idempotencyKey: `navigation:${crypto.randomUUID()}`,
      });
      if (!result?.success)
        throw new Error(result?.error.message ?? "Application could not be opened.");
      const instance = result.value.instance;
      if (instance) setSelection({ id: instance.instanceId, observedFocus: newestSignature });
      await model.resync();
    },
    onError: (error) => toast.error(error.message),
  });
  const value = useMemo(
    () => ({
      model,
      applications,
      selectedInstanceId,
      pending: mutation.isPending,
      activate: mutation.mutate,
      dismiss: () => setSelection({ id: null, observedFocus: newestSignature }),
    }),
    [model, applications, selectedInstanceId, mutation.isPending, mutation.mutate, newestSignature],
  );
  return <RuntimeUiNavigationContext value={value}>{children}</RuntimeUiNavigationContext>;
}

export function useRuntimeUiNavigation() {
  return use(RuntimeUiNavigationContext);
}

export function RuntimeUiNavigationEntries({ compact = false }: { readonly compact?: boolean }) {
  const navigation = useRuntimeUiNavigation();
  if (!navigation) return null;
  const selected = navigation.model.instances.find(
    (instance) => instance.instanceId === navigation.selectedInstanceId,
  );
  return navigation.applications.map((application) => {
    const active =
      selected?.owner.extensionId === application.extensionId &&
      selected.owner.applicationId === application.applicationId;
    const button = (
      <Button
        type="button"
        variant="ghost"
        aria-label={application.title}
        aria-current={active ? "page" : undefined}
        disabled={navigation.pending}
        data-runtime-ui-navigation={`${application.extensionId}:${application.applicationId}`}
        className={cn(
          compact
            ? "size-10 rounded-xl"
            : "h-auto w-full justify-start gap-2 rounded-xl px-3 py-1.5 text-sm font-normal",
          active && "bg-(--bg-selected)",
        )}
        onClick={() => navigation.activate(application)}
      >
        <Puzzle className="size-5 shrink-0" aria-hidden="true" />
        {!compact && <span className="truncate">{application.title}</span>}
      </Button>
    );
    return compact ? (
      <Tooltip key={`${application.extensionId}:${application.applicationId}`}>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="right">{application.title}</TooltipContent>
      </Tooltip>
    ) : (
      <div key={`${application.extensionId}:${application.applicationId}`}>{button}</div>
    );
  });
}

function isPublishedInstance(
  instance: RuntimeUiInstance,
  applications: readonly RuntimeUiPlacementApplication[],
) {
  return applications.some(
    (application) =>
      application.extensionId === instance.owner.extensionId &&
      application.applicationId === instance.owner.applicationId,
  );
}

export function RuntimeUiApplicationWorkspace({ children }: { readonly children: ReactNode }) {
  const navigation = useRuntimeUiNavigation();
  if (!navigation) return children;
  const instances = navigation.model.instances.filter((instance) =>
    isPublishedInstance(instance, navigation.applications),
  );
  const selected = instances.find(
    (instance) => instance.instanceId === navigation.selectedInstanceId,
  );
  return (
    <>
      <div hidden={Boolean(selected)} className={cn("size-full", selected && "hidden")}>
        {children}
      </div>
      <RuntimeUiContext value={navigation.model}>
        <RuntimeUiSessionOpenedContext value={navigation.dismiss}>
          {instances.map((instance) => (
            <div
              key={instance.instanceId}
              hidden={selected?.instanceId !== instance.instanceId}
              className={cn("size-full", selected?.instanceId !== instance.instanceId && "hidden")}
            >
              <RuntimeUiInstanceFrame
                instances={[instance]}
                className="size-full bg-card"
                contentClassName="h-full"
                testId={`runtime-ui-application-${instance.owner.applicationId}`}
              />
            </div>
          ))}
        </RuntimeUiSessionOpenedContext>
      </RuntimeUiContext>
    </>
  );
}
