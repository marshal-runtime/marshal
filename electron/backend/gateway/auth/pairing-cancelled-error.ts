/**
 * Thrown by `runPairingLoop` when `cancelPairing()` aborts the wait. The
 * gateway-auth controller catches it as a typed signal (rather than string-
 * matching `err.message === "Pairing cancelled"`, which would silently break
 * on a wording change) to drop the user back on the picker without surfacing
 * an error alert — cancellation is a user action, not a failure.
 *
 * Lives in its own module so the IPC layer (and its tests) can import the
 * error without pulling in the full GatewayBackend dependency graph
 * (automation orchestrator, desktop capabilities, electron `app`, ...).
 */
// Marshal ownership: relocated module identity.
export class PairingCancelledError extends Error {
  readonly name = "PairingCancelledError";
  constructor() {
    super("Pairing cancelled");
  }
}
