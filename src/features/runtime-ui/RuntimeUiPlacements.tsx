/* eslint-disable react/only-export-components -- provider and placement hooks share one context */
import {
  RUNTIME_UI_HOST_PLACEMENTS,
  type RuntimeUiPlacementApplication,
  type RuntimeUiPlacementResolution,
  type RuntimeUiPlacementSnapshot,
  type RuntimeUiScope,
} from "@common/runtime-ui";
import { useQuery } from "@tanstack/react-query";
import { createContext, use, useMemo, type ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/marshal-ui/alert";

const PLACEMENT_QUERY_KEY = ["runtime-ui", "placements"] as const;
const EMPTY_PLACEMENT_SNAPSHOT: RuntimeUiPlacementSnapshot = Object.freeze({
  revision: 0,
  generatedAt: new Date(0).toISOString(),
  placements: Object.freeze(
    RUNTIME_UI_HOST_PLACEMENTS.map((metadata) =>
      Object.freeze({
        metadata,
        applications: Object.freeze([]),
      }),
    ),
  ),
  diagnostics: Object.freeze([]),
});

interface RuntimeUiPlacementsModel {
  readonly snapshot: RuntimeUiPlacementSnapshot;
}

const RuntimeUiPlacementsContext = createContext<RuntimeUiPlacementsModel | null>(null);

export function RuntimeUiPlacementsProvider({
  children,
  scope,
}: {
  readonly children: ReactNode;
  readonly scope?: RuntimeUiScope | null;
}) {
  const snapshot = useRuntimeUiPlacementSnapshot(scope);
  const model = useMemo<RuntimeUiPlacementsModel>(() => ({ snapshot }), [snapshot]);

  return (
    <RuntimeUiPlacementsContext value={model}>
      {children}
      <RuntimeUiPlacementDiagnostics />
    </RuntimeUiPlacementsContext>
  );
}

export function useRuntimeUiPlacementSnapshot(
  scope?: RuntimeUiScope | null,
): RuntimeUiPlacementSnapshot {
  const query = useQuery({
    queryKey: [...PLACEMENT_QUERY_KEY, scope],
    enabled: Boolean(scope && window.runtimeUiAPI),
    queryFn: async () => window.runtimeUiAPI!.getPlacements(scope!),
    placeholderData: EMPTY_PLACEMENT_SNAPSHOT,
    staleTime: Number.POSITIVE_INFINITY,
  });

  return query.data ?? EMPTY_PLACEMENT_SNAPSHOT;
}

export function useRuntimeUiPlacement(placementId: string): RuntimeUiPlacementResolution {
  const model = use(RuntimeUiPlacementsContext);
  const snapshot = model?.snapshot ?? EMPTY_PLACEMENT_SNAPSHOT;
  const resolved = snapshot.placements.find((candidate) => candidate.metadata.id === placementId);
  if (resolved) return resolved;
  const metadata = RUNTIME_UI_HOST_PLACEMENTS.find((candidate) => candidate.id === placementId);
  if (!metadata) {
    throw new Error(`Unknown runtime UI placement: ${placementId}`);
  }
  return { metadata, applications: [] };
}

export function useRuntimeUiPlacementApplications(
  placementId: string,
): readonly RuntimeUiPlacementApplication[] {
  return useRuntimeUiPlacement(placementId).applications;
}

function RuntimeUiPlacementDiagnostics() {
  const model = use(RuntimeUiPlacementsContext);
  const diagnostics = model?.snapshot.diagnostics ?? [];
  if (diagnostics.length === 0) return null;
  return (
    <Alert
      variant="destructive"
      className="fixed right-4 bottom-4 z-90 w-[min(34rem,calc(100vw-2rem))] border-destructive bg-destructive/10 text-destructive shadow-lg"
      role="alert"
      data-testid="runtime-ui-placement-diagnostics"
    >
      <AlertTitle>Runtime UI placement error</AlertTitle>
      <AlertDescription>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          {diagnostics.map((diagnostic) => (
            <li key={diagnostic.id} data-diagnostic-code={diagnostic.code}>
              <span>{diagnostic.message}</span>
              <span className="block text-xs">{diagnostic.repairHint}</span>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
