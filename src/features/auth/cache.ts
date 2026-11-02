/**
 * Cancel-then-replace write for auth queries.
 *
 * `setQueryData` is synchronous, but a concurrent `queryFn` that started
 * before the write will settle afterwards and stomp the cached value.
 * Cancelling the in-flight query first is the guard. Every auth mutation
 * that writes the cache synchronously on success must route through here.
 */

import type { QueryClient, QueryKey } from "@tanstack/react-query";

export const AUTH_KEYS = {
  github: ["auth", "github"] as const,
} as const;

export type AuthQueryKey = (typeof AUTH_KEYS)[keyof typeof AUTH_KEYS];

export async function overwriteAuthCache(
  qc: QueryClient,
  key: QueryKey,
  data: unknown,
): Promise<void> {
  await qc.cancelQueries({ queryKey: key });
  qc.setQueryData(key, data);
}
