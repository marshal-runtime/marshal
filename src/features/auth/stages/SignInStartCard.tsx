import {
  COPILOT_GITHUB_SIGN_IN_LABEL,
  COPILOT_RUNTIME_ID,
  FIRST_RUN_BROWSER_RUNTIME_CHOICES,
  USE_ANOTHER_RUNTIME_LABEL,
} from "@common/runtime-config";
import { useState } from "react";

import { Button } from "@/components/marshal-ui/marshal-button";
import { RuntimeSwitchDialog } from "@/features/auth/runtime/RuntimeSwitchDialog";
import { useRuntimeStartupSelection } from "@/features/settings/useSettings";
import { InteractiveElementMonitor_SignIn } from "@/services/telemetry/schema";

import { AuthCardShell } from "../AuthCardShell";
import { TermsFooter } from "../TermsFooter";
import { MarshalSecureAccessIcon } from "../visuals/components/MarshalSecureAccessIcon";

interface Props {
  onSignInGitHub: () => void;
  error?: string;
}

export function SignInStartCard({ onSignInGitHub, error }: Props) {
  const { switchRuntime, isSwitching, switchError } = useRuntimeStartupSelection();
  const [runtimeSwitchOpen, setRuntimeSwitchOpen] = useState(false);
  const switchFailure = switchError?.message;
  const busy = isSwitching;

  return (
    <AuthCardShell ariaLiveLabel="Sign in" width="420">
      <MarshalSecureAccessIcon size={48} />
      <div className="flex w-full flex-col items-center gap-3 text-center text-foreground">
        <h1 className="text-2xl/[1.2] font-semibold">Sign in</h1>
        <p className="text-sm leading-[1.4]">Choose Copilot, Codex, or Cursor.</p>
      </div>

      {(error || switchFailure) && (
        <p role="alert" data-testid="auth-error" className="text-center text-sm text-destructive">
          {error || switchFailure}
        </p>
      )}

      <div className="flex w-full flex-col gap-3">
        <InteractiveElementMonitor_SignIn callback={onSignInGitHub}>
          {(cb) => (
            <Button
              variant="brand"
              className="h-auto w-full rounded-card py-2 text-base"
              disabled={busy}
              onClick={cb}
            >
              {COPILOT_GITHUB_SIGN_IN_LABEL}
            </Button>
          )}
        </InteractiveElementMonitor_SignIn>
        {FIRST_RUN_BROWSER_RUNTIME_CHOICES.map((choice) => (
          <Button
            key={choice.runtimeId}
            variant="default"
            className="h-auto w-full rounded-card py-2 text-base"
            disabled={busy}
            onClick={() => {
              void switchRuntime(choice.runtimeId).catch(() => undefined);
            }}
          >
            {choice.label}
          </Button>
        ))}
        <Button
          variant="outline"
          className="h-auto w-full rounded-card py-2 text-base"
          disabled={busy}
          onClick={() => setRuntimeSwitchOpen(true)}
        >
          {USE_ANOTHER_RUNTIME_LABEL}
        </Button>
      </div>

      {runtimeSwitchOpen && (
        <RuntimeSwitchDialog
          currentRuntimeId={COPILOT_RUNTIME_ID}
          open
          onOpenChange={setRuntimeSwitchOpen}
        />
      )}

      <TermsFooter />
    </AuthCardShell>
  );
}
