import type { GatewayAuthIdentity } from "@common/marshal-ipc-contract";

import { Loader2 } from "@/components/icons";
import { Alert, AlertDescription } from "@/components/marshal-ui/alert";
import { Button } from "@/components/marshal-ui/marshal-button";
import { InteractiveElementMonitor_SignIn } from "@/services/telemetry/schema";

import { AuthCardShell } from "../AuthCardShell";
import { TermsFooter } from "../TermsFooter";
import { MarshalSecureAccessIcon } from "../visuals/components/MarshalSecureAccessIcon";
import { HostedOptionsForm } from "./HostedOptionsForm";

interface LoginErrorAlertProps {
  error?: string;
  onRetry?: () => void;
  busy?: boolean;
}

function LoginErrorAlert({ error, onRetry, busy }: LoginErrorAlertProps) {
  if (!error) return null;
  return (
    <Alert variant="destructive" data-testid="gateway-login-error">
      <AlertDescription className="flex items-center justify-between gap-4">
        <span>{error}</span>
        {onRetry ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onRetry}
            disabled={busy}
            data-testid="gateway-login-retry"
          >
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Connecting…
              </>
            ) : (
              "Try again"
            )}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

interface GatewayLoginScreenProps {
  onSignIn: (cred: GatewayAuthIdentity) => void;
  error?: string;
  onRetry?: () => void;
  busy?: boolean;
  defaultNodeName?: string;
  /** Test-only opt-out from the dev-only no-auth link. The link is gated
   *  by `!__IS_RELEASE_BUILD__ && !__hideDevGate`; Vite dead-code-eliminates
   *  it from release builds. */
  __hideDevGate?: boolean;
}

export function GatewayLoginScreen({
  onSignIn,
  error,
  onRetry,
  busy = false,
  defaultNodeName,
  __hideDevGate = false,
}: GatewayLoginScreenProps) {
  return (
    <>
      <AuthCardShell ariaLiveLabel="Sign in to Lobster" width="380">
        <MarshalSecureAccessIcon size={48} />
        <div className="flex w-full flex-col items-center gap-3 text-center text-foreground">
          <h1 className="text-2xl/[1.2] font-semibold">Sign in</h1>
          <p className="text-sm leading-[1.4]">Connect to the Lobster runtime to start chatting.</p>
        </div>

        <LoginErrorAlert error={error} onRetry={onRetry} busy={busy} />

        <HostedOptionsForm
          key={defaultNodeName}
          onSubmit={onSignIn}
          defaultNodeName={defaultNodeName}
          disabled={busy}
        />

        <TermsFooter />
      </AuthCardShell>

      {!__IS_RELEASE_BUILD__ && !__hideDevGate ? (
        <div className="fixed inset-x-0 bottom-6 flex justify-center">
          <InteractiveElementMonitor_SignIn callback={() => onSignIn({ mode: "no-auth" })}>
            {(cb) => (
              <Button
                variant="link"
                size="sm"
                onClick={cb}
                disabled={busy}
                data-testid="gateway-login-no-auth"
                className="text-xs text-muted-foreground"
              >
                Connect to a local Lobster runtime (dev only)
              </Button>
            )}
          </InteractiveElementMonitor_SignIn>
        </div>
      ) : null}
    </>
  );
}
