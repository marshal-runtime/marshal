/* eslint-disable react/only-export-components -- selection context belongs to native frame chrome */
import {
  MARSHAL_RUNTIME_DEFAULT_WORKSPACE,
  type RuntimeUiInstance,
  type RuntimeUiSelectedSession,
} from "@common/runtime-ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, use, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/marshal-ui/marshal-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SessionMetadata } from "@/types/electron";

export const RuntimeUiSessionsContext = createContext<readonly SessionMetadata[]>([]);
export const RuntimeUiSelectedSessionContext = createContext<RuntimeUiSelectedSession | null>(null);
/** Reveals the opened chat after an application opens a session. */
export const RuntimeUiSessionOpenedContext = createContext<(() => void) | null>(null);

/**
 * OMR2-1: the assistant-session picker is on-demand chrome, not a permanently
 * docked strip. Descendants (the application renderer, on behalf of the
 * sandboxed app) summon it when a flow needs a session grant; §7 still holds —
 * only a user-performed selection in the visible picker mints a grant.
 */
export interface RuntimeUiSessionPickerController {
  readonly visible: boolean;
  readonly summon: () => void;
  readonly dismiss: () => void;
}

export const RuntimeUiSessionPickerContext = createContext<RuntimeUiSessionPickerController | null>(
  null,
);

export function RuntimeUiSessionSelection({
  instance,
  children,
}: {
  readonly instance: RuntimeUiInstance;
  readonly children: ReactNode;
}) {
  const sessions = use(RuntimeUiSessionsContext);
  const queryClient = useQueryClient();
  const [summoned, setSummoned] = useState(false);
  const controller = useMemo<RuntimeUiSessionPickerController>(
    () => ({
      visible: summoned,
      summon: () => setSummoned(true),
      dismiss: () => setSummoned(false),
    }),
    [summoned],
  );
  const request = { ...instance.owner, instanceId: instance.instanceId };
  const queryKey = ["runtime-ui", "selected-session", request] as const;
  // Session-owned instances receive a trusted host-generated binding for their
  // originating session. They use the same selected-session context as
  // persistent apps, but never expose the cross-session picker.
  const available =
    instance.content.kind === "application" &&
    (instance.owner.applicationScope !== undefined || instance.owner.sessionId !== undefined) &&
    Boolean(window.runtimeUiAPI?.getSelectedSession && window.runtimeUiAPI?.selectSession);
  const query = useQuery({
    queryKey,
    enabled: available,
    queryFn: async () => {
      const result = await window.runtimeUiAPI!.getSelectedSession!(request);
      if (!result.success) throw new Error(result.error.message);
      return result.value;
    },
  });
  const mutation = useMutation({
    mutationFn: async (targetSessionId: string | undefined) => {
      const result = await window.runtimeUiAPI!.selectSession!({
        ...request,
        ...(targetSessionId ? { targetSessionId } : {}),
      });
      if (!result.success) throw new Error(result.error.message);
      return result.value;
    },
    onSuccess: (selection) => {
      queryClient.setQueryData(queryKey, selection);
      // On-demand chrome (OMR2-1): the picker's job ends with the selection.
      setSummoned(false);
    },
    onError: (error) => toast.error(error.message),
  });
  const selected = query.data ?? null;
  const candidates = sessions.filter(
    (session) =>
      instance.owner.applicationScope === "user" ||
      (session.workspaceName?.trim() || MARSHAL_RUNTIME_DEFAULT_WORKSPACE) ===
        instance.owner.workspaceName,
  );
  return (
    <RuntimeUiSelectedSessionContext value={selected}>
      <RuntimeUiSessionPickerContext value={controller}>
        {available && instance.owner.applicationScope !== undefined && summoned && (
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="text-xs text-muted-foreground">Assistant session</span>
            <Select
              value={selected?.sessionId ?? "none"}
              onValueChange={(value) => mutation.mutate(value === "none" ? undefined : value)}
              disabled={mutation.isPending || query.isLoading}
            >
              <SelectTrigger className="max-w-80 min-w-48" aria-label="Assistant session">
                <SelectValue placeholder="Choose a session" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No session selected</SelectItem>
                {selected && !candidates.some((session) => session.id === selected.sessionId) && (
                  <SelectItem value={selected.sessionId}>
                    {selected.title ?? selected.sessionId}
                  </SelectItem>
                )}
                {candidates.map((session) => (
                  <SelectItem key={session.id} value={session.id}>
                    {session.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {query.error && (
              <span role="alert" className="text-xs text-destructive">
                Session selection is unavailable.
              </span>
            )}
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-label="Hide session picker"
              onClick={() => setSummoned(false)}
            >
              Dismiss
            </Button>
          </div>
        )}
        {children}
      </RuntimeUiSessionPickerContext>
    </RuntimeUiSelectedSessionContext>
  );
}
