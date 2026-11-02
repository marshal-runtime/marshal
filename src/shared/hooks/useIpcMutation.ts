/**
 * `useIpcMutation` — `useMutation` wrapper that adapts m's IPC return shape
 * (`{ success: boolean; error?: string }`) into the throw/resolve contract
 * React Query expects.
 *
 * The hand-rolled save pattern that this replaces:
 *
 * ```ts
 * await window.someAPI.x(...);              // result.success ignored
 * void queryClient.invalidateQueries(...);  // fires regardless
 * ```
 *
 * silently dead-letters every backend-reported failure. The helper turns
 * `success: false` into an `Error` throw so React Query routes it through
 * `onError`; the default `onError` toasts `error.message` (matching
 * `sonner`-based UX in `HeartbeatPanel` and `AutomationsPanel`).
 * Callers that surface the failure inline (e.g. import-bundle's local state)
 * pass `toastOnError: false`.
 *
 * Usage:
 *
 * ```ts
 * const saveMutation = useIpcMutation({
 *   mutationFn: (patch: Partial<HeartbeatSettings>) =>
 *     window.heartbeatAPI!.saveSettings(patch),
 *   fallbackErrorMessage: "Failed to save heartbeat settings",
 *   onSettled: () => qc.invalidateQueries({ queryKey: ["heartbeat", "settings"] }),
 * });
 *
 * // "Saving…" affordance for free:
 * <Button disabled={saveMutation.isPending}>Save</Button>
 *
 * // Or for a specific concurrent edit:
 * saveMutation.mutate({ prompt: nextPrompt });
 * ```
 */
import type { IpcResult } from "@common/marshal-ipc-contract";
import {
  useMutation,
  type UseMutationOptions,
  type UseMutationResult,
} from "@tanstack/react-query";
import { toast } from "sonner";

export interface UseIpcMutationOptions<
  TData extends IpcResult,
  TVariables = void,
  TOnMutateResult = unknown,
> extends Omit<UseMutationOptions<TData, Error, TVariables, TOnMutateResult>, "mutationFn"> {
  /** The IPC call. The helper inspects `result.success`; on `false` it throws
   * an `Error` (using `result.error` or `fallbackErrorMessage`) so React Query
   * routes the failure through `onError`. */
  mutationFn: (variables: TVariables) => Promise<TData>;

  /** Toast text when the IPC returns `success: false` without an `error`
   * (e.g. a missing handler stub). Otherwise `result.error` wins. */
  fallbackErrorMessage: string;

  /** Default `true`. Pass `false` to opt out of the default
   * `toast.error(error.message)` (e.g. when the caller surfaces the error
   * via local component state instead). The caller's `onError` still runs. */
  toastOnError?: boolean;
}

export function useIpcMutation<
  TData extends IpcResult,
  TVariables = void,
  TOnMutateResult = unknown,
>(
  options: UseIpcMutationOptions<TData, TVariables, TOnMutateResult>,
): UseMutationResult<TData, Error, TVariables, TOnMutateResult> {
  const { mutationFn, fallbackErrorMessage, toastOnError = true, onError, ...rest } = options;

  return useMutation<TData, Error, TVariables, TOnMutateResult>({
    ...rest,
    mutationFn: async (vars: TVariables) => {
      const result = await mutationFn(vars);
      if (!result.success) {
        throw new Error(result.error ?? fallbackErrorMessage);
      }
      return result;
    },
    onError: (err, vars, onMutateResult, mutationContext) => {
      if (toastOnError) toast.error(err.message);
      onError?.(err, vars, onMutateResult, mutationContext);
    },
  });
}
