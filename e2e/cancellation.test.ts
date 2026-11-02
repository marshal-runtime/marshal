import fs from "fs";
import path from "path";

import { E2E_DATA_DIR } from "../electron/mock-mode";
import type {} from "../src/types/electron";
import { chatInput } from "./helpers/marshal-chat-input";
import { test, expect } from "./marshal-fixtures";

process.env.MARSHAL_E2E_WORKSPACE_CANCELLATION = "1";

const HIDDEN_WORKTREE = path.join(E2E_DATA_DIR, "marshal-worktrees", "runtime-hidden-worktree");
const HIDDEN_WORKSPACE_NAMES = [
  "1eacb6d6-8975-4093-beda-9ad72deac778",
  "evidence",
  "isolated",
  "out",
  "TestResults",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readMigratedWorkspaceStore(): {
  version: number;
  activeWorkspace: string;
  workspaces: Record<string, unknown>;
} {
  const value: unknown = JSON.parse(
    fs.readFileSync(path.join(E2E_DATA_DIR, "marshal-sessions", "workspaces.json"), "utf8"),
  );
  if (
    !isRecord(value) ||
    typeof value.version !== "number" ||
    typeof value.activeWorkspace !== "string" ||
    !isRecord(value.workspaces)
  ) {
    throw new Error("Expected a migrated workspace store");
  }
  return {
    version: value.version,
    activeWorkspace: value.activeWorkspace,
    workspaces: value.workspaces,
  };
}

async function selectSessionFilter(
  page: import("@playwright/test").Page,
  label: "Chats" | "Agents",
) {
  const filter = page
    .getByRole("combobox")
    .filter({ hasText: /Chats|Agents/ })
    .first();
  await filter.click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

test("workspace migration, explicit add, and parent-only cancellation stay isolated", async ({
  app,
  page,
}, testInfo) => {
  const evidenceDir =
    process.env.CANCELLATION_EVIDENCE_DIR ?? testInfo.outputPath("cancellation-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  const capture = async (name: string) => {
    await page.screenshot({ path: path.join(evidenceDir, name) });
  };

  await chatInput(page).waitFor();
  const workspaceStorePath = path.join(E2E_DATA_DIR, "marshal-sessions", "workspaces.json");
  expect(fs.existsSync(HIDDEN_WORKTREE)).toBe(true);
  expect(fs.existsSync(workspaceStorePath)).toBe(true);
  fs.copyFileSync(workspaceStorePath, path.join(evidenceDir, "workspace-store-before-list.json"));

  const initialWorkspaces = await page.evaluate(() => {
    const workspaceAPI = window.workspaceAPI;
    if (!workspaceAPI) throw new Error("Workspace API is unavailable");
    return workspaceAPI.listWorkspaces();
  });
  const initialRootChecks = await page.evaluate(
    async (workspaceNames) => {
      const workspaceAPI = window.workspaceAPI;
      if (!workspaceAPI) throw new Error("Workspace API is unavailable");
      return Promise.all(
        workspaceNames.map(async (workspaceName) => ({
          workspaceName,
          result: await workspaceAPI.getRoot(workspaceName),
        })),
      );
    },
    ["Scratchpad", "marshal", "PBI", "PowerQuery"],
  );
  fs.writeFileSync(
    path.join(evidenceDir, "workspace-root-checks.json"),
    JSON.stringify(initialRootChecks, null, 2),
  );
  expect(initialWorkspaces).toMatchObject({
    success: true,
    workspaces: ["Scratchpad", "marshal", "PBI", "PowerQuery"],
  });
  for (const hiddenName of [...HIDDEN_WORKSPACE_NAMES, "runtime-hidden-worktree"]) {
    expect(initialWorkspaces.workspaces).not.toContain(hiddenName);
  }

  await page.getByTestId("workspace-role-trigger").click();
  const workspaceDialog = page.getByTestId("workspace-role-dialog");
  await expect(workspaceDialog).toBeVisible();
  const workspaceSelect = workspaceDialog.locator("#main-session-workspace");
  await workspaceSelect.click();
  await Promise.all(
    ["No workspace", "Scratchpad", "marshal", "PBI", "PowerQuery"].map((workspaceName) =>
      expect(page.getByRole("option", { name: workspaceName, exact: true })).toBeVisible(),
    ),
  );
  await Promise.all(
    [...HIDDEN_WORKSPACE_NAMES, "runtime-hidden-worktree"].map((hiddenName) =>
      expect(page.getByRole("option", { name: hiddenName, exact: true })).toHaveCount(0),
    ),
  );
  await capture("01-selector-before-explicit-add.png");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await selectSessionFilter(page, "Agents");
  const childSession = page.locator(
    '[data-testid="session-item"][data-session-id="e2e-cancel-child"]',
  );
  await expect(childSession).toContainText("Cancellation child");
  await childSession.click();
  await chatInput(page).fill("child-long");
  await chatInput(page).press("Enter");
  await expect(page.getByText("Child is still working...")).toBeVisible();

  await selectSessionFilter(page, "Chats");
  await page.locator('[data-testid="session-item"][data-session-id="e2e-fresh"]').click();

  await app.evaluate(({ dialog }, selectedPath) => {
    Object.defineProperty(dialog, "showOpenDialog", {
      configurable: true,
      value: async () => ({ canceled: false, filePaths: [selectedPath] }),
    });
  }, HIDDEN_WORKTREE);
  await page.getByTestId("workspace-role-trigger").click();
  await expect(workspaceDialog).toBeVisible();
  await workspaceDialog.getByRole("button", { name: "Add workspace" }).click();
  await expect(workspaceSelect).toContainText("runtime-hidden-worktree");
  await workspaceSelect.click();
  await expect(
    page.getByRole("option", { name: "runtime-hidden-worktree", exact: true }),
  ).toBeVisible();
  await Promise.all(
    HIDDEN_WORKSPACE_NAMES.map((hiddenName) =>
      expect(page.getByRole("option", { name: hiddenName, exact: true })).toHaveCount(0),
    ),
  );
  await capture("02-explicit-worktree-added.png");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  const registeredWorkspaces = await page.evaluate(() => {
    const workspaceAPI = window.workspaceAPI;
    if (!workspaceAPI) throw new Error("Workspace API is unavailable");
    return workspaceAPI.listWorkspaces();
  });
  expect(registeredWorkspaces).toMatchObject({
    success: true,
    workspaces: ["Scratchpad", "marshal", "PBI", "PowerQuery", "runtime-hidden-worktree"],
  });

  await chatInput(page).fill("cancel-long");
  await chatInput(page).press("Enter");

  await expect(page.getByText("Working on cancellation test...")).toBeVisible();
  await capture("03-parent-working.png");

  const stopButton = page.getByTestId("stop-btn");
  const cancelStartedAt = Date.now();
  await stopButton.dispatchEvent("click");
  await expect(stopButton).toHaveAttribute("aria-label", "Cancelling");
  await expect(stopButton).toHaveAttribute("aria-busy", "true");
  const cancellingVisibleAt = Date.now();
  await selectSessionFilter(page, "Agents");
  await expect(childSession.getByTestId("session-running-spinner")).toBeVisible();
  await capture("04-parent-cancelling-child-running.png");

  await expect(page.getByTestId("send-btn")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("chat-input-editor")).toHaveAttribute("aria-label", "Message");
  const sendRestoredAt = Date.now();
  await expect(page.getByText("Working on cancellation test...")).toBeVisible();
  await capture("05-parent-cancelled-send-restored.png");

  await expect(childSession.getByTestId("session-running-spinner")).toHaveCount(0, {
    timeout: 10_000,
  });
  await childSession.click();
  await expect(page.getByText("Child completed after parent cancellation.")).toBeVisible();
  await expect(
    page.getByTestId("message-assistant").filter({
      hasText: "Child completed after parent cancellation.",
    }),
  ).toHaveCount(1);
  await capture("06-child-delivered-once.png");

  await selectSessionFilter(page, "Chats");
  await page.locator('[data-testid="session-item"][data-session-id="e2e-fresh"]').click();
  await expect(page.getByText("Late cancelled output")).toHaveCount(0);
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
  await expect(page.getByTestId("message-assistant")).toHaveCount(1);
  await expect(page.getByText("Working on cancellation test...")).toBeVisible();

  await chatInput(page).fill("cancel-followup");
  await chatInput(page).press("Enter");
  await expect(page.getByText("Follow-up completed.")).toBeVisible();
  await expect(page.getByText("Working on cancellation test...")).toBeVisible();
  await capture("07-fresh-parent-send.png");

  const migratedStore = readMigratedWorkspaceStore();
  const explicitWorktree = migratedStore.workspaces["runtime-hidden-worktree"];
  const proof = {
    buildProfile: "internal",
    initialWorkspaces: initialWorkspaces.workspaces,
    registeredWorkspaces: registeredWorkspaces.workspaces,
    migratedStoreVersion: migratedStore.version,
    migratedActiveWorkspace: migratedStore.activeWorkspace,
    registryKeys: Object.keys(migratedStore.workspaces).sort(),
    explicitWorktree,
    hiddenPathsPreserved: Object.fromEntries(
      HIDDEN_WORKSPACE_NAMES.map((name) => [
        name,
        fs.existsSync(path.join(E2E_DATA_DIR, "workspace", name)),
      ]),
    ),
    hiddenWorktreePreserved: fs.existsSync(HIDDEN_WORKTREE),
    cancellingVisibleMs: cancellingVisibleAt - cancelStartedAt,
    sendRestoredMs: sendRestoredAt - cancelStartedAt,
    pageErrors,
  };
  fs.writeFileSync(path.join(evidenceDir, "runtime-proof.json"), JSON.stringify(proof, null, 2));
  expect(migratedStore.version).toBe(3);
  expect(migratedStore.activeWorkspace).toBe("Scratchpad");
  expect(explicitWorktree).toMatchObject({
    origin: "user-added",
    externalPath: fs.realpathSync(HIDDEN_WORKTREE),
    identity: expect.any(Object),
  });
  expect(Object.values(proof.hiddenPathsPreserved).every(Boolean)).toBe(true);
  expect(proof.hiddenWorktreePreserved).toBe(true);
  expect(proof.sendRestoredMs).toBeLessThanOrEqual(5_000);
  expect(pageErrors).toEqual([]);
});
