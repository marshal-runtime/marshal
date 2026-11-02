import { RUNTIME_UI_PLACEMENT } from "@common/runtime-ui";

import { RuntimeUiPlacementActionButton } from "./RuntimeUiPlacementAction";
import { useRuntimeUiPlacementApplications } from "./RuntimeUiPlacements";

export function RuntimeUiComposerActions({
  sessionId,
  workspaceName,
}: {
  sessionId?: string | null;
  workspaceName?: string;
}) {
  const applications = useRuntimeUiPlacementApplications(
    RUNTIME_UI_PLACEMENT.CHAT_COMPOSER_ACTIONS,
  );
  if (!workspaceName || !sessionId) return null;
  return applications.map((application) => (
    <RuntimeUiPlacementActionButton
      key={`${application.extensionId}:${application.applicationId}`}
      application={application}
      sessionId={sessionId}
      workspaceName={workspaceName}
      presentation="icon"
    />
  ));
}
