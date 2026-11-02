// Ownership: Gateway device authentication renderer module.
import type { GatewayAuthIdentity } from "@common/marshal-ipc-contract";
import { createLogger } from "@common/marshal-logger";
import { useState, type ReactNode } from "react";

import { GatewayLoginScreen } from "./GatewayLoginScreen";
import { LocalDeviceApprovalPanel } from "./LocalDeviceApprovalPanel";
import { PairingDialog } from "./PairingDialog";
import { useGatewayAuth } from "./useGatewayDeviceAuth";

const log = createLogger("GatewayAuthGate");

export function GatewayAuthGate({ children }: { children: ReactNode }) {
  const {
    status,
    identity,
    error,
    pairingRequestId,
    signIn,
    cancelPairing,
    isPending,
    cancelPairingPending,
  } = useGatewayAuth();
  // Derived (not cleared) so we don't setState-during-render when status
  // leaves "pairing". onCancel resets cancelError on re-entry.
  const [cancelError, setCancelError] = useState<string | null>(null);
  const displayCancelError = status === "pairing" ? cancelError : null;

  // `isPending` covers the gap between mutateAsync firing and the first
  // `stateChange` push arriving. `status === "connecting"` and "pairing"
  // keep us in the busy state through both the WS handshake and the
  // pairing-wait loop. signInMutation.isPending stays true the whole time
  // login() runs (including the pairing-wait), so this is mostly belt-and-
  // braces against a slow first stateChange push, but it's cheap.
  const busy = isPending || status === "connecting" || status === "pairing";

  if (status === "signed-in") {
    // LocalDeviceApprovalPanel self-hides on a non-local gateway and on an
    // empty pending list, so it's safe to mount unconditionally here. The
    // wrapper div is absolute-positioned so the panel floats above the
    // existing app shell without re-laying-out the chat layout — the panel
    // is local-dev-only, the main UI shouldn't shift to make room for it.
    return (
      <>
        <div
          className="pointer-events-none fixed top-14 right-4 z-40 w-80"
          data-testid="local-device-approval-panel-mount"
        >
          <div className="pointer-events-auto">
            <LocalDeviceApprovalPanel />
          </div>
        </div>
        {children}
      </>
    );
  }

  // Surface sign-in rejections from the mutation. The IPC handler itself
  // never throws (it returns {success:false, error}), but network-level
  // failures before the IPC reaches main would leave status stuck — the
  // mutation's rejection handler ensures we don't swallow them silently.
  const handleSignIn = (cred: GatewayAuthIdentity) => {
    signIn(cred).catch((err) => {
      log.warn("signIn failed:", err);
    });
  };
  const handleRetry = status === "error" && identity ? () => handleSignIn(identity) : undefined;

  // PairingDialog is rendered as an overlay so the picker stays visible
  // (disabled via `busy`) behind it. Routing on `status === "pairing"`
  // alone — `pairingRequestId` may briefly be undefined between the status
  // push and the requestId push, and `PairingDialog` handles the
  // null-requestId case with a "Connecting…" placeholder rather than
  // silently dropping the user back onto the picker.
  return (
    <>
      <GatewayLoginScreen
        onSignIn={handleSignIn}
        error={status === "error" ? error : undefined}
        onRetry={handleRetry}
        busy={busy}
      />
      {status === "pairing" && (
        <PairingDialog
          requestId={pairingRequestId ?? null}
          onCancel={() => {
            setCancelError(null);
            cancelPairing().catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              log.warn("cancelPairing failed:", err);
              setCancelError(message);
            });
          }}
          cancelPending={cancelPairingPending}
          cancelError={displayCancelError ?? undefined}
        />
      )}
    </>
  );
}
