/* eslint-disable react/only-export-components -- attachment context belongs to native frame chrome */
import type { RuntimeUiImageHandle, RuntimeUiInstance } from "@common/runtime-ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useMemo, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/marshal-ui/marshal-button";

const EMPTY_IMAGES: readonly RuntimeUiImageHandle[] = Object.freeze([]);
export const RuntimeUiSelectedImagesContext =
  createContext<readonly RuntimeUiImageHandle[]>(EMPTY_IMAGES);
export const RuntimeUiRefreshImagesContext = createContext<
  (() => Promise<readonly RuntimeUiImageHandle[]>) | undefined
>(undefined);

export function RuntimeUiImageSelection({
  instance,
  children,
}: {
  readonly instance: RuntimeUiInstance;
  readonly children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const request = useMemo(
    () => ({ ...instance.owner, instanceId: instance.instanceId }),
    [instance.owner, instance.instanceId],
  );
  const queryKey = useMemo(() => ["runtime-ui", "selected-images", request] as const, [request]);
  const available =
    instance.content.kind === "application" &&
    // Attachment chrome exists only for applications that DECLARE the need
    // (manifest wantsImages) — undeclared apps never see the control, however
    // capable the host is.
    instance.content.descriptor.wantsImages === true &&
    Boolean(
      window.runtimeUiAPI?.listImages &&
      window.runtimeUiAPI?.selectImages &&
      window.runtimeUiAPI?.releaseImage,
    );
  const query = useQuery({
    queryKey,
    enabled: available,
    queryFn: async () => {
      const result = await window.runtimeUiAPI!.listImages!(request);
      if (!result.success) throw new Error(result.error.message);
      return result.value;
    },
  });
  const select = useMutation({
    mutationFn: async () => {
      const result = await window.runtimeUiAPI!.selectImages!(request);
      if (!result.success) throw new Error(result.error.message);
      return result.value;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: (error) => toast.error(error.message),
  });
  const release = useMutation({
    mutationFn: async (handle: string) => {
      const result = await window.runtimeUiAPI!.releaseImage!({ ...request, handle });
      if (!result.success) throw new Error(result.error.message);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: (error) => toast.error(error.message),
  });
  const images = query.data ?? EMPTY_IMAGES;
  // Even for declaring apps, controls appear only once the host proves it can
  // serve image listings; pending or failed listings render nothing — never a
  // control whose only outcome is an "unavailable" error.
  const attachable = available && query.isSuccess;
  const refreshImages = useCallback(async () => {
    if (!available) return EMPTY_IMAGES;
    const result = await window.runtimeUiAPI!.listImages!(request);
    if (!result.success) throw new Error(result.error.message);
    queryClient.setQueryData(queryKey, result.value);
    return result.value;
  }, [available, queryClient, queryKey, request]);
  return (
    <RuntimeUiSelectedImagesContext value={images}>
      {attachable && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={select.isPending}
            onClick={() => select.mutate()}
          >
            Attach images
          </Button>
          {images.map((image) => (
            <span
              key={image.handle}
              className="flex max-w-64 items-center gap-1 rounded-sm border border-border px-2 text-xs"
            >
              <span className="truncate">{image.displayName}</span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                aria-label={`Remove ${image.displayName}`}
                disabled={release.isPending}
                onClick={() => release.mutate(image.handle)}
              >
                Remove
              </Button>
            </span>
          ))}
        </div>
      )}
      <RuntimeUiRefreshImagesContext value={refreshImages}>
        {children}
      </RuntimeUiRefreshImagesContext>
    </RuntimeUiSelectedImagesContext>
  );
}
