import type { RuntimeUiPlacementApplication } from "@common/runtime-ui";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Puzzle } from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import { cn } from "@/lib/marshal-class-names";

export function RuntimeUiPlacementActionButton({
  application,
  sessionId,
  workspaceName,
  presentation,
  disabled = false,
  className,
}: {
  readonly application: RuntimeUiPlacementApplication;
  readonly sessionId: string;
  readonly workspaceName: string;
  readonly presentation: "icon" | "menu";
  readonly disabled?: boolean;
  readonly className?: string;
}) {
  const mutation = useMutation({
    mutationFn: async () => {
      const result = await window.runtimeUiAPI?.activatePlacement({
        sessionId,
        workspaceName,
        extensionId: application.extensionId,
        applicationId: application.applicationId,
        idempotencyKey: `placement-${application.extensionId}-${application.applicationId}-${Date.now()}`,
      });
      if (!result?.success)
        throw new Error(result?.error.message ?? "Placement activation failed.");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });
  const label = application.title;
  const Icon = Puzzle;
  return (
    <Button
      type="button"
      variant="ghost"
      size={presentation === "icon" ? "icon" : "default"}
      className={cn(
        presentation === "icon" ? "size-10 rounded-full" : "w-full justify-start gap-2 font-normal",
        className,
      )}
      disabled={disabled || mutation.isPending}
      aria-label={label}
      aria-busy={mutation.isPending}
      title={presentation === "icon" ? application.title : undefined}
      data-runtime-ui-application={`${application.extensionId}:${application.applicationId}`}
      onClick={() => mutation.mutate()}
    >
      <Icon size={presentation === "icon" ? 20 : 16} />
      {presentation === "menu" && application.title}
    </Button>
  );
}
