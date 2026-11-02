import type { QueryClient } from "@tanstack/react-query";

export const GATEWAY_NODE_ACTIVITY_KEY = ["gateway-node", "activity"] as const;

export function wireGatewayNodeActivity(qc: QueryClient): () => void {
  const api = window.gatewayNodeAPI;
  if (!api) return () => undefined;
  // invalidateQueries (not setQueryData): a setQueryData write racing the
  // initial getActivity() resolve gets overwritten by the snapshot.
  return api.onActivity(() => {
    void qc.invalidateQueries({ queryKey: GATEWAY_NODE_ACTIVITY_KEY });
  });
}
