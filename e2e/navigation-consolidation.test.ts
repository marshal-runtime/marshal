import { chatInput } from "./helpers/marshal-chat-input";
import { test, expect } from "./marshal-fixtures";

test("consolidates primary navigation and renders workflows beneath automations", async ({
  page,
}) => {
  await chatInput(page).waitFor();

  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(nav.getByRole("button", { name: "Automations", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Workspaces", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Command Center", exact: true })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "Workflows", exact: true })).toHaveCount(0);

  await nav.getByRole("button", { name: "Automations", exact: true }).click();

  const panel = page.locator("section[aria-label='Automations']");
  const newAutomation = panel.getByRole("button", { name: /new automation/i });
  const workflowsHeading = panel.getByRole("heading", { name: "Workflows" });
  await expect(newAutomation).toBeVisible();
  await expect(panel.locator('[data-slot="separator"]')).toBeVisible();
  await expect(workflowsHeading).toBeVisible();
  await expect(panel.getByText(/automatically collected from workspaces inside/i)).toBeVisible();
  await expect(panel.getByText(".marshal/marshal-worktrees")).toBeVisible();

  const [automationBox, workflowsBox] = await Promise.all([
    newAutomation.boundingBox(),
    workflowsHeading.boundingBox(),
  ]);
  expect(automationBox).not.toBeNull();
  expect(workflowsBox).not.toBeNull();
  expect(workflowsBox!.y).toBeGreaterThan(automationBox!.y);

  await nav.getByRole("button", { name: "Workspaces", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
});
