import { useHotkeys } from "@tanstack/react-hotkeys";
import type { HotkeyCallback } from "@tanstack/react-hotkeys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";

import { DEFAULT_ZOOM, getAdjacentZoomLevel, normalizeZoom } from "../helpers/zoom";

export { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM, ZOOM_EPSILON, ZOOM_LEVELS } from "../helpers/zoom";

const PREFERENCE_KEY = "cocreate.zoom";
const QUERY_KEY = ["preferences", PREFERENCE_KEY] as const;

export interface UseZoomResult {
  zoom: number;
  /** True once the queryFn has resolved (success or fallback). False on the
   *  first render or two while preferencesAPI hydration is in flight — gate
   *  rendering of zoomed surfaces on this to avoid a 100% → preferred-zoom
   *  flash on Co-Create open. */
  isHydrated: boolean;
  setZoom: (value: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
}

export function useZoom(): UseZoomResult {
  const queryClient = useQueryClient();

  const { data: zoom = DEFAULT_ZOOM, isPending } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const result = await window.preferencesAPI?.get(PREFERENCE_KEY);
      if (!result?.success || result.value == null) return DEFAULT_ZOOM;
      const parsed = parseFloat(result.value);
      return Number.isFinite(parsed) ? normalizeZoom(parsed) : DEFAULT_ZOOM;
    },
    staleTime: Infinity,
  });

  const { mutate } = useMutation({
    mutationFn: (value: number) =>
      window.preferencesAPI?.set(PREFERENCE_KEY, String(normalizeZoom(value))) ??
      Promise.resolve({ success: true }),
    onMutate: async (value: number) => {
      // Cancel in-flight hydration; otherwise queryFn resolution clobbers the optimistic write.
      await queryClient.cancelQueries({ queryKey: QUERY_KEY });
      const prev = queryClient.getQueryData<number>(QUERY_KEY);
      queryClient.setQueryData(QUERY_KEY, normalizeZoom(value));
      return { prev };
    },
    onError: (_err, _value, ctx) => {
      // Guard: if mutation fired before hydration, prev is undefined and
      // writing it back would delete the cache entry and trigger a refetch.
      if (ctx?.prev !== undefined) queryClient.setQueryData(QUERY_KEY, ctx.prev);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  // Step callbacks read latest from cache so they stay stable across zoom changes.
  const zoomIn = useCallback(() => {
    const current = queryClient.getQueryData<number>(QUERY_KEY) ?? DEFAULT_ZOOM;
    mutate(getAdjacentZoomLevel(current, 1));
  }, [queryClient, mutate]);
  const zoomOut = useCallback(() => {
    const current = queryClient.getQueryData<number>(QUERY_KEY) ?? DEFAULT_ZOOM;
    mutate(getAdjacentZoomLevel(current, -1));
  }, [queryClient, mutate]);
  const reset = useCallback(() => mutate(DEFAULT_ZOOM), [mutate]);

  return { zoom, isHydrated: !isPending, setZoom: mutate, zoomIn, zoomOut, reset };
}

function isEditableZoomTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "input, textarea, [contenteditable=''], [contenteditable='true'], .monaco-editor",
    ) !== null
  );
}

function handleZoomShortcut(event: KeyboardEvent, action: () => void): void {
  if (event.altKey || isEditableZoomTarget(event.target)) return;
  event.preventDefault();
  action();
}

/** Ctrl/Cmd + =/+/-/_/0 (incl. numpad) → zoom controls. */
export function useZoomKeyboardShortcuts(
  handlers: Pick<UseZoomResult, "zoomIn" | "zoomOut" | "reset">,
  enabled = true,
): void {
  const { zoomIn, zoomOut, reset } = handlers;
  const options = {
    enabled,
    ignoreInputs: false,
    preventDefault: false,
    stopPropagation: false,
  } as const;

  const handleZoomIn = useCallback<HotkeyCallback>(
    (event) => {
      handleZoomShortcut(event, zoomIn);
    },
    [zoomIn],
  );
  const handleZoomOut = useCallback<HotkeyCallback>(
    (event) => {
      handleZoomShortcut(event, zoomOut);
    },
    [zoomOut],
  );
  const handleReset = useCallback<HotkeyCallback>(
    (event) => {
      handleZoomShortcut(event, reset);
    },
    [reset],
  );

  useHotkeys(
    [
      { hotkey: { key: "=", mod: true }, callback: handleZoomIn },
      { hotkey: { key: "-", mod: true }, callback: handleZoomOut },
      { hotkey: { key: "0", mod: true }, callback: handleReset },
    ],
    options,
  );

  useEffect(() => {
    const handleNumpadAdd = (event: KeyboardEvent) => {
      if (!enabled) return;
      if (event.code !== "NumpadAdd" || (!event.ctrlKey && !event.metaKey)) return;
      if (event.shiftKey) return;
      handleZoomShortcut(event, zoomIn);
    };

    // TanStack Hotkeys currently normalizes plus-key raw hotkeys incorrectly for NumpadAdd.
    // Track upstream before removing this escape hatch: https://github.com/TanStack/hotkeys/issues/127
    document.addEventListener("keydown", handleNumpadAdd);
    return () => document.removeEventListener("keydown", handleNumpadAdd);
  }, [enabled, zoomIn]);
}
