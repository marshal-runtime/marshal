import type { GoalRuntimeSnapshot } from "@common/goal-contract";
import { parseRelayAccountId, parseRelayProviderId } from "@common/relay-contract";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  findRelayProviderSetupEvent,
  RELAY_PROVIDER_SETUP_QUERY_KEY,
  type RelayProviderSetupEvents,
} from "../../features/integrations/relayProviderQueryKeys";
import {
  createMockAutomationsAPI,
  createMockGoalAPI,
  createMockModelsAPI,
  createMockRelayProviderSettingsAPI,
  createMockSessionsAPI,
  createMockSettingsAPI,
  createMockSkillsAPI,
} from "../../test-utils";
import type { GoalAPI } from "../../types/electron";
import { wireQueryInvalidations } from "./wireQueryInvalidations";

interface ListenerHandle {
  fire: () => void;
  unsubscribe: () => void;
}

function makeOnChangedStub(): {
  onChanged: ReturnType<typeof vi.fn<(cb: () => void) => () => void>>;
  handles: ListenerHandle[];
} {
  const handles: ListenerHandle[] = [];
  const onChanged = vi.fn<(cb: () => void) => () => void>((cb: () => void) => {
    const handle: ListenerHandle = {
      fire: cb,
      unsubscribe: vi.fn<() => void>(() => {}),
    };
    handles.push(handle);
    return handle.unsubscribe;
  });
  return { onChanged, handles };
}

function makeGoalOnChangedStub(): {
  onChanged: ReturnType<typeof vi.fn<GoalAPI["onChanged"]>>;
  handles: Pick<ListenerHandle, "unsubscribe">[];
} {
  const handles: Pick<ListenerHandle, "unsubscribe">[] = [];
  const onChanged = vi.fn<GoalAPI["onChanged"]>(() => {
    const unsubscribe = vi.fn<() => void>();
    handles.push({ unsubscribe });
    return unsubscribe;
  });
  return { onChanged, handles };
}

describe("wireQueryInvalidations", () => {
  let originalAutomations: typeof window.automationsAPI;
  let originalSkills: typeof window.skillsAPI;
  let originalSettings: typeof window.settingsAPI;
  let originalRelayProviderSettings: typeof window.relayProviderSettingsAPI;
  let originalSessions: typeof window.sessionsAPI;
  let originalGoal: typeof window.goalAPI;
  let originalWorkspace: typeof window.workspaceAPI;

  beforeEach(() => {
    originalAutomations = window.automationsAPI;
    originalSkills = window.skillsAPI;
    originalSettings = window.settingsAPI;
    originalRelayProviderSettings = window.relayProviderSettingsAPI;
    originalSessions = window.sessionsAPI;
    originalGoal = window.goalAPI;
    originalWorkspace = window.workspaceAPI;
  });

  afterEach(() => {
    window.automationsAPI = originalAutomations;
    window.skillsAPI = originalSkills;
    window.settingsAPI = originalSettings;
    window.relayProviderSettingsAPI = originalRelayProviderSettings;
    window.sessionsAPI = originalSessions;
    window.goalAPI = originalGoal;
    window.workspaceAPI = originalWorkspace;
  });

  it("invalidates ['automations'] when automations:changed fires", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { onChanged, handles } = makeOnChangedStub();
    window.automationsAPI = createMockAutomationsAPI({ onChanged });
    window.skillsAPI = createMockSkillsAPI();
    window.settingsAPI = createMockSettingsAPI();

    wireQueryInvalidations(qc);
    handles[0].fire();

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["automations"] });
  });

  it("invalidates the ['models'] list when models:changed fires", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const originalModels = window.modelsAPI;
    const { onChanged, handles } = makeOnChangedStub();
    window.modelsAPI = createMockModelsAPI({ onChanged });

    wireQueryInvalidations(qc);
    handles[0].fire();
    window.modelsAPI = originalModels;

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["models"], exact: true });
  });

  it("invalidates both ['skills'] and ['automations'] when skills:changed fires", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { onChanged, handles } = makeOnChangedStub();
    window.automationsAPI = createMockAutomationsAPI();
    window.skillsAPI = createMockSkillsAPI({ onChanged });
    window.settingsAPI = createMockSettingsAPI();

    wireQueryInvalidations(qc);
    handles[0].fire();

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["skills"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["automations"] });
  });

  it("invalidates workspace selectors and roots when the registry changes", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { onChanged, handles } = makeOnChangedStub();
    window.workspaceAPI = {
      ...window.workspaceAPI,
      onWorkspaceRegistryChange: onChanged,
    };

    wireQueryInvalidations(qc);
    handles[0].fire();

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["workspaces"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["workspace", "root"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["workspace", "uiState"] });
  });

  it("invalidates ['permissions', 'config'] when settings:changed fires", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { onChanged, handles } = makeOnChangedStub();
    window.automationsAPI = createMockAutomationsAPI();
    window.skillsAPI = createMockSkillsAPI();
    window.settingsAPI = createMockSettingsAPI({ onChanged });
    window.sessionsAPI = createMockSessionsAPI();

    wireQueryInvalidations(qc);
    handles[0].fire();

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["permissions", "config"] });
  });

  it("invalidates relay provider snapshots when provider status changes", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    let relayChanged:
      | Parameters<NonNullable<typeof window.relayProviderSettingsAPI>["onChanged"]>[0]
      | undefined;
    const onChanged = vi.fn<NonNullable<typeof window.relayProviderSettingsAPI>["onChanged"]>(
      (callback) => {
        relayChanged = callback;
        return () => undefined;
      },
    );
    window.relayProviderSettingsAPI = createMockRelayProviderSettingsAPI({ onChanged });

    wireQueryInvalidations(qc);
    relayChanged?.({
      providerKey: "whatsapp",
      runtimeProviderId: "whatsapp-baileys",
      available: true,
      connection: { state: "connected" },
      capabilities: {
        inbound: true,
        quotedReplies: true,
        attachments: true,
        voice: true,
        managedGroups: true,
        communities: true,
        renameConversation: true,
        retireConversation: true,
        remotePermissionApproval: false,
      },
    });

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["relay-provider-settings"],
      exact: true,
    });
  });

  it("stores setup events globally and clears them when the provider reaches a terminal state", () => {
    const qc = new QueryClient();
    let relayChanged:
      | Parameters<NonNullable<typeof window.relayProviderSettingsAPI>["onChanged"]>[0]
      | undefined;
    let setupChanged:
      | Parameters<NonNullable<typeof window.relayProviderSettingsAPI>["onSetupChanged"]>[0]
      | undefined;
    window.relayProviderSettingsAPI = createMockRelayProviderSettingsAPI({
      onChanged: vi.fn<NonNullable<typeof window.relayProviderSettingsAPI>["onChanged"]>(
        (callback) => {
          relayChanged = callback;
          return () => undefined;
        },
      ),
      onSetupChanged: vi.fn<NonNullable<typeof window.relayProviderSettingsAPI>["onSetupChanged"]>(
        (callback) => {
          setupChanged = callback;
          return () => undefined;
        },
      ),
    });
    wireQueryInvalidations(qc);
    const event = {
      providerKey: "whatsapp" as const,
      runtimeProviderId: "whatsapp-baileys" as const,
      snapshot: {
        account: {
          providerId: parseRelayProviderId("whatsapp-baileys"),
          accountId: parseRelayAccountId("marshal-primary"),
        },
        state: "qr" as const,
        updatedAt: "2026-08-07T00:00:00.000Z",
        qr: { payload: "ephemeral-qr" },
      },
    };

    setupChanged?.(event);
    expect(
      findRelayProviderSetupEvent(
        qc.getQueryData<RelayProviderSetupEvents>(RELAY_PROVIDER_SETUP_QUERY_KEY) ?? {},
        "whatsapp",
        "marshal-primary",
      ),
    ).toBe(event);

    const secondAccountEvent = {
      ...event,
      snapshot: {
        ...event.snapshot,
        account: {
          ...event.snapshot.account,
          accountId: parseRelayAccountId("marshal-secondary"),
        },
        updatedAt: "2026-08-07T00:01:00.000Z",
        pairingAttemptId: "pairing:2",
      },
    };
    setupChanged?.(secondAccountEvent);
    setupChanged?.({
      ...event,
      snapshot: {
        ...event.snapshot,
        updatedAt: "2026-08-06T23:59:00.000Z",
        pairingAttemptId: "stale-pairing",
      },
    });
    expect(
      findRelayProviderSetupEvent(
        qc.getQueryData<RelayProviderSetupEvents>(RELAY_PROVIDER_SETUP_QUERY_KEY) ?? {},
        "whatsapp",
        "marshal-primary",
      ),
    ).toBe(event);

    relayChanged?.({
      providerKey: "whatsapp",
      runtimeProviderId: "whatsapp-baileys",
      available: true,
      accountId: "marshal-primary",
      connection: { state: "connected" },
      capabilities: {
        inbound: true,
        quotedReplies: true,
        attachments: true,
        voice: true,
        managedGroups: true,
        communities: true,
        renameConversation: true,
        retireConversation: true,
        remotePermissionApproval: false,
      },
    });
    expect(
      findRelayProviderSetupEvent(
        qc.getQueryData<RelayProviderSetupEvents>(RELAY_PROVIDER_SETUP_QUERY_KEY) ?? {},
        "whatsapp",
        "marshal-primary",
      ),
    ).toBeUndefined();
    expect(
      findRelayProviderSetupEvent(
        qc.getQueryData<RelayProviderSetupEvents>(RELAY_PROVIDER_SETUP_QUERY_KEY) ?? {},
        "whatsapp",
        "marshal-secondary",
      ),
    ).toBe(secondAccountEvent);
  });

  it("invalidates hydrated session data when session hydration finishes", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    let hydrationChangedCb:
      | Parameters<NonNullable<typeof window.sessionsAPI>["onHydrationChanged"]>[0]
      | undefined;
    window.automationsAPI = createMockAutomationsAPI();
    window.skillsAPI = createMockSkillsAPI();
    window.settingsAPI = createMockSettingsAPI();
    window.sessionsAPI = createMockSessionsAPI({
      onHydrationChanged: vi.fn<NonNullable<typeof window.sessionsAPI>["onHydrationChanged"]>(
        (cb) => {
          hydrationChangedCb = cb;
          return () => {};
        },
      ),
    });

    wireQueryInvalidations(qc);
    hydrationChangedCb?.({ sessionId: "cold-session", state: "loaded" });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["session", "cold-session"] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["sessions"] });
  });

  it("does not invalidate session data when session hydration starts", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    let hydrationChangedCb:
      | Parameters<NonNullable<typeof window.sessionsAPI>["onHydrationChanged"]>[0]
      | undefined;
    window.automationsAPI = createMockAutomationsAPI();
    window.skillsAPI = createMockSkillsAPI();
    window.settingsAPI = createMockSettingsAPI();
    window.sessionsAPI = createMockSessionsAPI({
      onHydrationChanged: vi.fn<NonNullable<typeof window.sessionsAPI>["onHydrationChanged"]>(
        (cb) => {
          hydrationChangedCb = cb;
          return () => {};
        },
      ),
    });

    wireQueryInvalidations(qc);
    hydrationChangedCb?.({ sessionId: "cold-session", state: "started" });

    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["session", "cold-session"] });
  });

  it("updates the goal runtime cache from the singleton goal subscription", () => {
    const qc = new QueryClient();
    let goalChanged: Parameters<NonNullable<typeof window.goalAPI>["onChanged"]>[0] | undefined;
    const snapshot = {
      sessionId: "goal-session",
      fence: { goalId: "g1", epoch: 1 },
      goal: {
        schemaVersion: 3,
        id: "g1",
        epoch: 1,
        objective: "Ship it",
        criteria: [],
        status: "pursuing",
        createdAt: "2026-08-20T12:00:00.000Z",
        updatedAt: "2026-08-20T12:01:00.000Z",
        progress: [],
        openQuestions: [],
        assumptions: [],
        decisions: [],
        state: {},
        tokensUsed: 0,
        activeMs: 0,
        continuationCount: 0,
      },
    } as GoalRuntimeSnapshot;
    window.goalAPI = createMockGoalAPI({
      onChanged: vi.fn<GoalAPI["onChanged"]>((callback) => {
        goalChanged = callback;
        return () => {};
      }),
    });

    const cleanup = wireQueryInvalidations(qc);
    goalChanged?.({ sessionId: "goal-session", snapshot });

    expect(window.goalAPI?.onChanged).toHaveBeenCalledOnce();
    expect(qc.getQueryData(["goal-state", "goal-session"])).toEqual(snapshot);
    cleanup();
  });

  it("caches a changed event that clears the active goal", () => {
    const qc = new QueryClient();
    let goalChanged: Parameters<NonNullable<typeof window.goalAPI>["onChanged"]>[0] | undefined;
    window.goalAPI = createMockGoalAPI({
      onChanged: vi.fn<GoalAPI["onChanged"]>((callback) => {
        goalChanged = callback;
        return () => {};
      }),
    });
    const cleanup = wireQueryInvalidations(qc);
    const snapshot: GoalRuntimeSnapshot = {
      sessionId: "goal-session",
      goal: null,
      fence: null,
    };

    goalChanged?.({ sessionId: "goal-session", snapshot });

    expect(qc.getQueryData(["goal-state", "goal-session"])).toEqual(snapshot);
    cleanup();
  });

  it("replaces the prior goal subscription on renderer re-entry", () => {
    const qc = new QueryClient();
    const first = makeGoalOnChangedStub();
    const second = makeGoalOnChangedStub();
    window.goalAPI = createMockGoalAPI({ onChanged: first.onChanged });
    const firstCleanup = wireQueryInvalidations(qc);

    window.goalAPI = createMockGoalAPI({ onChanged: second.onChanged });
    const secondCleanup = wireQueryInvalidations(qc);

    expect(first.handles[0].unsubscribe).toHaveBeenCalledOnce();
    firstCleanup();
    expect(second.handles[0].unsubscribe).not.toHaveBeenCalled();
    secondCleanup();
    expect(second.handles[0].unsubscribe).toHaveBeenCalledOnce();
  });

  it("returns a function that releases every subscription", () => {
    const qc = new QueryClient();
    const a = makeOnChangedStub();
    const s = makeOnChangedStub();
    const settings = makeOnChangedStub();
    const sessions = vi.fn<() => void>();
    const goal = makeGoalOnChangedStub();
    window.automationsAPI = createMockAutomationsAPI({ onChanged: a.onChanged });
    window.skillsAPI = createMockSkillsAPI({ onChanged: s.onChanged });
    window.settingsAPI = createMockSettingsAPI({ onChanged: settings.onChanged });
    window.sessionsAPI = createMockSessionsAPI({
      onHydrationChanged: vi.fn<NonNullable<typeof window.sessionsAPI>["onHydrationChanged"]>(
        () => sessions,
      ),
    });
    window.goalAPI = createMockGoalAPI({ onChanged: goal.onChanged });

    const cleanup = wireQueryInvalidations(qc);
    cleanup();

    expect(a.handles[0].unsubscribe).toHaveBeenCalledTimes(1);
    expect(s.handles[0].unsubscribe).toHaveBeenCalledTimes(1);
    expect(settings.handles[0].unsubscribe).toHaveBeenCalledTimes(1);
    expect(sessions).toHaveBeenCalledTimes(1);
    expect(goal.handles[0].unsubscribe).toHaveBeenCalledTimes(1);
  });
});
