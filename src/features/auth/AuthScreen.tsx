import * as React from "react";

import {
  generateGuid,
  RenderMonitorContext,
  emptyRenderMonitor,
} from "@/services/telemetry/opensource";

import { AuthCheckingCard } from "./stages/AuthCheckingCard";
import { CopilotAccessRequiredCard } from "./stages/CopilotAccessRequiredCard";
import { GitHubDeviceCodeCard } from "./stages/GitHubDeviceCodeCard";
import { SignInStartCard } from "./stages/SignInStartCard";
import type { AuthStage, UseAuthFlowResult } from "./useAuthFlow";

interface Props {
  stage: AuthStage;
  actions: UseAuthFlowResult["actions"];
}

function AuthScreenContent({ stage, actions }: Props) {
  switch (stage.kind) {
    case "checking":
      return <AuthCheckingCard />;
    case "start":
      return <SignInStartCard onSignInGitHub={actions.signInGitHub} error={stage.error} />;
    case "github-device-code":
      return (
        <GitHubDeviceCodeCard
          code={stage.code}
          expired={stage.expired}
          onRetry={actions.signInGitHub}
        />
      );
    case "copilot-access-error":
      return <CopilotAccessRequiredCard login={stage.login} onSignOut={actions.signOutAll} />;
    case "ready":
      return null;
    default:
      stage satisfies never;
      return null;
  }
}

export function AuthScreen({ stage, actions }: Props) {
  // Provide a stable renderScenarioCorrelationId for auth-phase events without
  // using RenderScenarioProvider (which fires endSession() on unmount via its
  // useRenderMonitorInitializer cleanup). Auth completion unmounts AuthScreen,
  // so a full RenderScenarioProvider here would prematurely end the session and
  // corrupt the session duration. A plain RenderMonitorContext.Provider gives
  // InteractiveElementMonitor a non-empty correlationId with no lifecycle side effects.
  const correlationId = React.useMemo(generateGuid, []);
  const monitor = React.useMemo(
    () => ({ ...emptyRenderMonitor, getRenderScenarioCorrelationId: () => correlationId }),
    [correlationId],
  );

  return (
    <RenderMonitorContext.Provider value={monitor}>
      <AuthScreenContent stage={stage} actions={actions} />
    </RenderMonitorContext.Provider>
  );
}
