import { TriangleAlert } from "@/components/icons";

import { Button } from "@/components/marshal-ui/marshal-button";
import { InteractiveElementMonitor_SignOut } from "@/services/telemetry/schema";

import { AuthCardShell } from "../AuthCardShell";

interface Props {
  login: string | undefined;
  onSignOut: () => void;
}

export function CopilotAccessRequiredCard({ login, onSignOut }: Props) {
  return (
    <AuthCardShell ariaLiveLabel="GitHub Copilot Business or Enterprise required" width="380">
      <TriangleAlert size={48} className="text-foreground" aria-hidden="true" />
      <div className="flex w-full flex-col items-center gap-3 text-center text-foreground">
        <h1 className="text-2xl/[1.2] font-semibold">
          GitHub Copilot Business or Enterprise required
        </h1>
        <div
          role="alert"
          data-testid="auth-error"
          className="flex flex-col gap-3 text-sm leading-[1.4] text-muted-foreground"
        >
          <p>
            {login ? (
              <>
                The GitHub account{" "}
                <strong className="font-semibold text-foreground">{login}</strong> does not have a
                GitHub Copilot Business or Enterprise license.
              </>
            ) : (
              "Your GitHub account does not have a GitHub Copilot Business or Enterprise license."
            )}
          </p>
          <p>
            To use Marshal, switch to your organizational GitHub account or request GitHub
            Copilot access from your admin.
          </p>
        </div>
      </div>
      <InteractiveElementMonitor_SignOut callback={onSignOut}>
        {(cb) => (
          <Button
            variant="default"
            className="h-auto w-full rounded-card py-2 text-base"
            onClick={cb}
          >
            Sign out
          </Button>
        )}
      </InteractiveElementMonitor_SignOut>
    </AuthCardShell>
  );
}
