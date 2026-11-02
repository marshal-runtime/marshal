import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, it, expect, vi } from "vitest";

import { useNavigation, resetNavHistoryForTests } from "./useNavigation";
import type { NavigationApplyEvent } from "./useNavigation";

// withViewTransition calls the callback synchronously in test env (no document.startViewTransition)
vi.mock("@/shared/marshal-foundation/animation", () => ({
  withViewTransition: (fn: () => void) => fn(),
}));

describe("useNavigation", () => {
  beforeEach(() => {
    resetNavHistoryForTests();
  });

  it("starts on chat view", () => {
    const { result } = renderHook(() => useNavigation());
    expect(result.current.currentView).toBe("chat");
    expect(result.current.canGoBack).toBe(false);
    expect(result.current.canGoForward).toBe(false);
  });

  it("navigates to a new view", () => {
    const { result } = renderHook(() => useNavigation());

    act(() => result.current.navigate("settings"));

    expect(result.current.currentView).toBe("settings");
    expect(result.current.canGoBack).toBe(true);
    expect(result.current.canGoForward).toBe(false);
  });

  it("goes back to the previous view", () => {
    const { result } = renderHook(() => useNavigation());

    act(() => result.current.navigate("settings"));
    act(() => result.current.goBack());

    expect(result.current.currentView).toBe("chat");
    expect(result.current.canGoBack).toBe(false);
    expect(result.current.canGoForward).toBe(true);
  });

  it("goes forward after going back", () => {
    const { result } = renderHook(() => useNavigation());

    act(() => result.current.navigate("settings"));
    act(() => result.current.goBack());
    act(() => result.current.goForward());

    expect(result.current.currentView).toBe("settings");
    expect(result.current.canGoBack).toBe(true);
    expect(result.current.canGoForward).toBe(false);
  });

  it("truncates forward history on new navigation", () => {
    const { result } = renderHook(() => useNavigation());

    act(() => result.current.navigate("settings"));
    act(() => result.current.navigate("heartbeat"));
    act(() => result.current.goBack()); // back to settings
    act(() => result.current.navigate("integrations")); // should truncate heartbeat

    expect(result.current.currentView).toBe("integrations");
    expect(result.current.canGoForward).toBe(false);

    act(() => result.current.goBack());
    expect(result.current.currentView).toBe("settings");

    act(() => result.current.goBack());
    expect(result.current.currentView).toBe("chat");
  });

  it("preserves state through history", () => {
    const { result } = renderHook(() => useNavigation());

    act(() => result.current.navigate("automations", { editAutomationName: "daily-check" }));
    expect(result.current.editAutomationName).toBe("daily-check");

    act(() => result.current.navigate("chat"));
    expect(result.current.editAutomationName).toBeNull();

    act(() => result.current.goBack());
    expect(result.current.currentView).toBe("automations");
    expect(result.current.editAutomationName).toBe("daily-check");
  });

  it("goBack is a no-op at the beginning of history", () => {
    const { result } = renderHook(() => useNavigation());

    act(() => result.current.goBack());

    expect(result.current.currentView).toBe("chat");
    expect(result.current.canGoBack).toBe(false);
  });

  it("goForward is a no-op at the end of history", () => {
    const { result } = renderHook(() => useNavigation());

    act(() => result.current.navigate("settings"));
    act(() => result.current.goForward());

    expect(result.current.currentView).toBe("settings");
    expect(result.current.canGoForward).toBe(false);
  });

  it("supports multi-step back and forward", () => {
    const { result } = renderHook(() => useNavigation());

    act(() => result.current.navigate("settings"));
    act(() => result.current.navigate("heartbeat"));
    act(() => result.current.navigate("integrations"));

    // Go back 3 steps
    act(() => result.current.goBack());
    expect(result.current.currentView).toBe("heartbeat");
    act(() => result.current.goBack());
    expect(result.current.currentView).toBe("settings");
    act(() => result.current.goBack());
    expect(result.current.currentView).toBe("chat");
    expect(result.current.canGoBack).toBe(false);

    // Go forward 3 steps
    act(() => result.current.goForward());
    expect(result.current.currentView).toBe("settings");
    act(() => result.current.goForward());
    expect(result.current.currentView).toBe("heartbeat");
    act(() => result.current.goForward());
    expect(result.current.currentView).toBe("integrations");
    expect(result.current.canGoForward).toBe(false);
  });

  it("deduplicates same-view navigation", () => {
    const { result } = renderHook(() => useNavigation());

    act(() => result.current.navigate("settings"));
    act(() => result.current.navigate("settings")); // duplicate — should be no-op

    expect(result.current.canGoBack).toBe(true);

    // Going back should land on chat (only one settings entry)
    act(() => result.current.goBack());
    expect(result.current.currentView).toBe("chat");
    expect(result.current.canGoBack).toBe(false);
  });

  it("allows navigation to same view with different params", () => {
    const { result } = renderHook(() => useNavigation());

    act(() => result.current.navigate("automations", { editAutomationName: "task-a" }));
    act(() => result.current.navigate("automations", { editAutomationName: "task-b" }));

    expect(result.current.editAutomationName).toBe("task-b");
    act(() => result.current.goBack());
    expect(result.current.editAutomationName).toBe("task-a");
  });

  it("deduplicates when all params match including sessionId", () => {
    const { result } = renderHook(() => useNavigation());

    act(() => result.current.navigate("chat", { sessionId: "s1" }));
    act(() => result.current.navigate("chat", { sessionId: "s1" })); // duplicate

    act(() => result.current.goBack());
    expect(result.current.currentView).toBe("chat");
    expect(result.current.canGoBack).toBe(false); // only initial + one entry
  });

  it("creates separate history entries for different sessionIds", () => {
    const { result } = renderHook(() => useNavigation());

    act(() => result.current.navigate("chat", { sessionId: "s1" }));
    act(() => result.current.navigate("chat", { sessionId: "s2" }));

    act(() => result.current.goBack());
    expect(result.current.currentView).toBe("chat");
    expect(result.current.canGoBack).toBe(true); // can go back further to initial chat

    act(() => result.current.goForward());
    expect(result.current.currentView).toBe("chat");
    expect(result.current.canGoForward).toBe(false);
  });

  it("calls onApply with isHistoryNavigation=false for navigate", () => {
    const onApply = vi.fn<(event: NavigationApplyEvent) => void>();
    const { result } = renderHook(() => useNavigation({ onApply }));

    act(() => result.current.navigate("settings"));

    expect(onApply).toHaveBeenCalledWith({
      view: "settings",
      state: { returnToPage: "chat" },
      isHistoryNavigation: false,
    });
  });

  it("calls onApply with isHistoryNavigation=true for goBack/goForward", () => {
    const onApply = vi.fn<(event: NavigationApplyEvent) => void>();
    const { result } = renderHook(() => useNavigation({ onApply }));

    act(() => result.current.navigate("settings"));
    act(() => result.current.navigate("heartbeat"));
    onApply.mockClear();

    act(() => result.current.goBack());
    expect(onApply).toHaveBeenCalledWith({
      view: "settings",
      state: { returnToPage: "chat" },
      isHistoryNavigation: true,
    });

    onApply.mockClear();
    act(() => result.current.goForward());
    expect(onApply).toHaveBeenCalledWith({
      view: "heartbeat",
      state: { returnToPage: "chat" },
      isHistoryNavigation: true,
    });
  });

  it("restores sessionId through onApply on back navigation", () => {
    const onApply = vi.fn<(event: NavigationApplyEvent) => void>();
    const { result } = renderHook(() => useNavigation({ onApply }));

    act(() => result.current.navigate("chat", { sessionId: "s1" }));
    act(() => result.current.navigate("chat", { sessionId: "s2" }));
    onApply.mockClear();

    act(() => result.current.goBack());
    expect(onApply).toHaveBeenCalledWith({
      view: "chat",
      state: { sessionId: "s1" },
      isHistoryNavigation: true,
    });
  });

  it("tracks workspaceName state for create view", () => {
    const onApply = vi.fn<(event: NavigationApplyEvent) => void>();
    const { result } = renderHook(() => useNavigation({ onApply }));

    act(() => result.current.navigate("create", { workspaceName: "project-a" }));
    act(() => result.current.navigate("create", { workspaceName: "project-b" }));
    onApply.mockClear();

    act(() => result.current.goBack());
    expect(onApply).toHaveBeenCalledWith({
      view: "create",
      state: { workspaceName: "project-a" },
      isHistoryNavigation: true,
    });
  });

  it("preserves repoPath state for repo-local workflow navigation", () => {
    const repoPath = "Q:\\src\\example-repo";
    const { result } = renderHook(() => useNavigation());

    act(() => result.current.navigate("workflows", { workflowId: "repo-demo", repoPath }));

    expect(result.current.workflowsState).toEqual({ workflowId: "repo-demo", repoPath });
  });

  it("keeps legacy consolidated routes available for deep links", () => {
    {
      resetNavHistoryForTests("/command-center");
      const view = renderHook(() => useNavigation());
      expect(view.result.current.currentView).toBe("commandCenter");
      view.unmount();
    }

    {
      resetNavHistoryForTests("/workflows");
      const view = renderHook(() => useNavigation());
      expect(view.result.current.currentView).toBe("workflows");
      view.unmount();
    }

    {
      resetNavHistoryForTests("/extensions");
      const view = renderHook(() => useNavigation());
      expect(view.result.current.currentView).toBe("plugins");
    }
  });

  it("uses the canonical plugins route", () => {
    resetNavHistoryForTests("/plugins");
    const { result } = renderHook(() => useNavigation());

    expect(result.current.currentView).toBe("plugins");
  });

  it("supports extension views with ext: prefix", () => {
    const { result } = renderHook(() => useNavigation());

    act(() => result.current.navigate("ext:kanban", { boardId: "b1" }));
    expect(result.current.currentView).toBe("ext:kanban");
    expect(result.current.canGoBack).toBe(true);

    act(() => result.current.goBack());
    expect(result.current.currentView).toBe("chat");
  });

  it("preserves extension state through history", () => {
    const onApply = vi.fn<(event: NavigationApplyEvent) => void>();
    const { result } = renderHook(() => useNavigation({ onApply }));

    act(() => result.current.navigate("ext:kanban", { boardId: "b1", cardId: "c5" }));
    act(() => result.current.navigate("settings"));
    onApply.mockClear();

    act(() => result.current.goBack());
    expect(onApply).toHaveBeenCalledWith({
      view: "ext:kanban",
      state: { boardId: "b1", cardId: "c5" },
      isHistoryNavigation: true,
    });
  });

  it("deduplicates extension views with same state", () => {
    const { result } = renderHook(() => useNavigation());

    act(() => result.current.navigate("ext:kanban", { boardId: "b1" }));
    act(() => result.current.navigate("ext:kanban", { boardId: "b1" })); // duplicate

    act(() => result.current.goBack());
    expect(result.current.currentView).toBe("chat");
    expect(result.current.canGoBack).toBe(false);
  });

  describe("returnToPage and dismissPanel", () => {
    it("sets returnToPage when navigating from a page to a panel", () => {
      const { result } = renderHook(() => useNavigation());

      act(() => result.current.navigate("settings"));

      expect(result.current.returnToPage).toBe("chat");
    });

    it("preserves returnToPage when navigating from panel to panel", () => {
      const { result } = renderHook(() => useNavigation());

      act(() => result.current.navigate("settings"));
      act(() => result.current.navigate("heartbeat"));

      expect(result.current.returnToPage).toBe("chat");
    });

    it("clears returnToPage when navigating from panel to page", () => {
      const { result } = renderHook(() => useNavigation());

      act(() => result.current.navigate("settings"));
      expect(result.current.returnToPage).toBe("chat");

      act(() => result.current.navigate("automations"));
      expect(result.current.returnToPage).toBeNull();
    });

    it("returnToPage is null when navigating page to page", () => {
      const { result } = renderHook(() => useNavigation());

      act(() => result.current.navigate("automations"));

      expect(result.current.returnToPage).toBeNull();
    });

    it("dismissPanel navigates to returnToPage", () => {
      const { result } = renderHook(() => useNavigation());

      act(() => result.current.navigate("automations"));
      act(() => result.current.navigate("settings"));
      expect(result.current.returnToPage).toBe("automations");

      act(() => result.current.dismissPanel());
      expect(result.current.currentView).toBe("automations");
      expect(result.current.returnToPage).toBeNull();
    });

    it("dismissPanel falls back to chat when returnToPage is null", () => {
      // Simulate a cold start on a panel URL (e.g., deep link / page reload)
      resetNavHistoryForTests("/settings");
      const { result } = renderHook(() => useNavigation());

      expect(result.current.currentView).toBe("settings");
      expect(result.current.returnToPage).toBeNull();

      act(() => result.current.dismissPanel());

      expect(result.current.currentView).toBe("chat");
    });

    it("restores returnToPage on goBack", () => {
      const { result } = renderHook(() => useNavigation());

      act(() => result.current.navigate("automations"));
      act(() => result.current.navigate("settings"));
      act(() => result.current.navigate("heartbeat"));

      act(() => result.current.goBack());
      expect(result.current.currentView).toBe("settings");
      expect(result.current.returnToPage).toBe("automations");
    });

    it("restores returnToPage as null on goBack to a page", () => {
      const { result } = renderHook(() => useNavigation());

      act(() => result.current.navigate("automations"));
      act(() => result.current.navigate("settings"));

      act(() => result.current.goBack());
      expect(result.current.currentView).toBe("automations");
      expect(result.current.returnToPage).toBeNull();
    });

    it("works with extension views as returnToPage", () => {
      const { result } = renderHook(() => useNavigation());

      act(() => result.current.navigate("ext:kanban", { boardId: "b1" }));
      act(() => result.current.navigate("settings"));

      expect(result.current.returnToPage).toBe("ext:kanban");

      act(() => result.current.dismissPanel());
      expect(result.current.currentView).toBe("ext:kanban");
    });

    it("preserves returnToPage through multiple panel switches", () => {
      const { result } = renderHook(() => useNavigation());

      act(() => result.current.navigate("create"));
      act(() => result.current.navigate("heartbeat"));
      act(() => result.current.navigate("settings"));
      act(() => result.current.navigate("plugins"));
      act(() => result.current.navigate("activities"));

      expect(result.current.returnToPage).toBe("create");

      act(() => result.current.dismissPanel());
      expect(result.current.currentView).toBe("create");
    });
  });
});
