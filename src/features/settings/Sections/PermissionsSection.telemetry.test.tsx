import { beforeEach, describe, expect, it, vi } from "vitest";

import { TelemetryProvider } from "@/services/telemetry";
import {
  interactiveElements,
  TelemetryPath_App,
  TelemetryPath_Permissions,
  TelemetryPath_Settings,
} from "@/services/telemetry/schema";
import { createCaptureSink, findUserAction, sinkSetup } from "@/services/telemetry/test-utils";
import { installMockAPIs, render, screen, userEvent } from "@/test-utils";
import type { PermissionsConfig } from "@/types/electron";

import { PermissionsEditor } from "../../permissions/PermissionsEditor";

const { sinkManager, events } = createCaptureSink();

vi.mock("@/services/telemetry/makeTelemetrySinkManagers", () => ({
  makeTelemetrySinkManagers: () => sinkSetup(sinkManager),
}));

const basePermissions = {
  autoApproveReadOnly: false,
  allow: [],
  allowModelPermissionsChange: false,
  tools: {},
  servers: {
    filesystem: { enabled: true, autoApprove: false },
    playwright: { enabled: true, autoApprove: false },
    shell: { enabled: true, autoApprove: false },
    "example-mcp": { enabled: true, autoApprove: false },
  },
};

function renderEditor() {
  installMockAPIs();
  const onUpdatePermissions = vi.fn<(p: PermissionsConfig) => void>();
  render(
    <TelemetryProvider>
      <TelemetryPath_App>
        <TelemetryPath_Settings>
          <TelemetryPath_Permissions>
            <PermissionsEditor
              permissions={basePermissions}
              onUpdatePermissions={onUpdatePermissions}
            />
          </TelemetryPath_Permissions>
        </TelemetryPath_Settings>
      </TelemetryPath_App>
    </TelemetryProvider>,
  );
  return { onUpdatePermissions };
}

describe("PermissionsSection telemetry", () => {
  beforeEach(() => {
    events.splice(0);
  });

  it("emits UserAction for AllowModelPermissionsChange at /App/Settings/Permissions", async () => {
    const user = userEvent.setup();
    renderEditor();

    const toggle = screen.getByRole("switch", {
      name: /allow ai to request permission changes/i,
    });
    await user.click(toggle);

    const event = findUserAction(
      events,
      "AllowModelPermissionsChange",
      "/App/Settings/Permissions",
    );
    expect(event).toBeDefined();
  });

  it("declares /App/Settings/Permissions in the AllowModelPermissionsChange contract", () => {
    // The emitted path comes from the rendered component nesting, not from
    // expectedPaths — so an emptied contract row would otherwise go unnoticed.
    expect(interactiveElements.AllowModelPermissionsChange.expectedPaths).toContain(
      "/App/Settings/Permissions",
    );
  });
});
