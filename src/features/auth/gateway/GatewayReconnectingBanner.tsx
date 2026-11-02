import { Loader2 } from "@/components/icons";

import { useGatewayAuth } from "./useGatewayDeviceAuth";

export function GatewayReconnectingBanner() {
  const { reconnecting, status } = useGatewayAuth();

  // Guard against a race where reconnecting=true arrives after signOut clears status.
  if (!reconnecting || status !== "signed-in") return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="gateway-reconnecting-banner"
      className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/15 px-4 py-1.5 text-xs text-foreground"
    >
      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      <span>Reconnecting to gateway…</span>
    </div>
  );
}
