import type { RuntimeUiInstance } from "@common/runtime-ui";
import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import { testDouble } from "../../../electron/testing/harness";
import { RuntimeUiDocumentCompanion } from "./RuntimeUiDocumentCompanion";
import { RuntimeUiSelectedSessionContext } from "./RuntimeUiSessionSelection";
import { useRuntimeUiScope, type RuntimeUiModel } from "./useRuntimeUi";

vi.mock("./useRuntimeUi", () => ({ useRuntimeUiScope: vi.fn<() => RuntimeUiModel>() }));
vi.mock("./RuntimeUiHost", () => ({
  RuntimeUiPanelSurface: () => <aside>Native documents</aside>,
}));

describe("application document companion", () => {
  it("uses the originating session when no picker selection exists", () => {
    vi.mocked(useRuntimeUiScope).mockReturnValue(
      testDouble<RuntimeUiModel>({ bySurface: { panel: [] } }),
    );
    const instance = testDouble<RuntimeUiInstance>({
      owner: {
        sessionId: "origin",
        workspaceName: "repository",
      },
      content: { kind: "application", descriptor: { hostFeatures: ["workspace"] } },
    });
    render(
      <RuntimeUiSelectedSessionContext value={null}>
        <RuntimeUiDocumentCompanion instance={instance}>
          <span>Application</span>
        </RuntimeUiDocumentCompanion>
      </RuntimeUiSelectedSessionContext>,
    );
    expect(useRuntimeUiScope).toHaveBeenLastCalledWith({
      sessionId: "origin",
      workspaceName: "repository",
    });
    expect(screen.getByText("Application")).toBeInTheDocument();
  });

  it("uses the selected workspace and preserves the app when native evidence opens", () => {
    let panels: RuntimeUiInstance[] = [];
    vi.mocked(useRuntimeUiScope).mockImplementation(() =>
      testDouble<RuntimeUiModel>({ bySurface: { panel: panels } }),
    );
    const instance = testDouble<RuntimeUiInstance>({
      owner: { applicationScope: "user", workspaceName: "marshal" },
      content: { kind: "application", descriptor: { hostFeatures: ["workspace"] } },
    });
    const mounted = vi.fn<() => void>();
    function App() {
      useEffect(mounted, []);
      return <input aria-label="Unsaved thought" defaultValue="Keep this" />;
    }
    const view = () => (
      <RuntimeUiSelectedSessionContext
        value={{
          grantId: "grant",
          sessionId: "selected",
          workspaceName: "repository",
        }}
      >
        <RuntimeUiDocumentCompanion instance={instance}>
          <App />
        </RuntimeUiDocumentCompanion>
      </RuntimeUiSelectedSessionContext>
    );
    const { rerender } = render(view());
    expect(useRuntimeUiScope).toHaveBeenLastCalledWith({
      sessionId: "selected",
      workspaceName: "repository",
    });
    const input = screen.getByLabelText("Unsaved thought");
    expect(screen.queryByText("Native documents")).not.toBeInTheDocument();
    panels = [
      testDouble<RuntimeUiInstance>({ content: { kind: "file", path: "/repository/source.ts" } }),
    ];
    rerender(view());
    expect(screen.getByText("Native documents")).toBeInTheDocument();
    expect(screen.getByLabelText("Unsaved thought")).toBe(input);
    expect(mounted).toHaveBeenCalledOnce();
    panels = [
      testDouble<RuntimeUiInstance>({ content: { kind: "text", text: "Unrelated panel" } }),
    ];
    rerender(view());
    expect(screen.queryByText("Native documents")).not.toBeInTheDocument();
    expect(mounted).toHaveBeenCalledOnce();
  });
});
