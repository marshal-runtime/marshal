import { test, expect } from "./marshal-fixtures";
import { chatInput } from "./helpers/marshal-chat-input";
import { openMoreMenuItem } from "./helpers/marshal-nav";

test.describe("extensions panel — Marshal flow", () => {
  test.beforeEach(async ({ page }) => {
    await chatInput(page).waitFor();
  });

  test("opens the extensions panel and shows tabs", async ({ page }) => {
    await (await openMoreMenuItem(page, /Extensions/)).click();
    await expect(page.getByText("Your Skills")).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("tab", { name: "Skills" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "MCP Servers" })).toBeVisible();
  });

  test("switches to MCP Servers tab and shows empty state", async ({ page }) => {
    await (await openMoreMenuItem(page, /Extensions/)).click();
    await expect(page.getByText("Your Skills")).toBeVisible({ timeout: 5000 });
    await page.getByRole("tab", { name: "MCP Servers" }).click();
    await expect(page.getByText("No custom servers yet.")).toBeVisible();
  });

  test("creates a custom skill and verifies it appears in the list", async ({ page }) => {
    // Open extensions panel (defaults to Skills tab)
    await (await openMoreMenuItem(page, /Extensions/)).click();
    await expect(page.getByText("Your Skills")).toBeVisible({ timeout: 5000 });

    // Open "Add Skill" dialog
    await page.getByRole("button", { name: "Add Skill" }).click();
    await expect(page.getByText("Create Skill")).toBeVisible();

    // Fill the form
    await page.getByLabel(/^Name/).fill("e2e-test-skill");
    await page.getByLabel("Description").fill("A test skill created by E2E");
    await page.getByLabel("Instructions").fill("Test instructions for the skill.");

    // Save
    await page.getByRole("button", { name: "Create Skill" }).click();

    // Wait for dialog to close
    await expect(page.getByText("Create Skill")).not.toBeVisible({ timeout: 5000 });

    // Look for the skill card (will resolve as soon as it appears)
    const skillButtons = page.locator("role=button").filter({ hasText: /^e2e-test-skill/ });
    await expect(skillButtons.first()).toBeVisible({ timeout: 10000 });
  });

  test("adds a custom MCP server via command mode", async ({ page }) => {
    // Open extensions panel → MCP Servers tab
    await (await openMoreMenuItem(page, /Extensions/)).click();
    await expect(page.getByText("Your Skills")).toBeVisible({ timeout: 5000 });
    await page.getByRole("tab", { name: "MCP Servers" }).click();

    // Open "Add Server" dialog
    await page.getByRole("button", { name: "Add Server" }).click();
    await expect(page.getByPlaceholder("Server name")).toBeVisible();

    // Switch to Command mode and fill the form
    await page.getByRole("button", { name: "Command" }).click();
    await page.getByPlaceholder("Server name").fill("e2e-test-server");
    await page.getByPlaceholder("npx -y @my-org/mcp-server").fill("npx -y @test/mcp");

    // Save
    await page.getByRole("button", { name: "Add" }).click();

    // Wait for dialog to close
    await expect(page.getByPlaceholder("Server name")).not.toBeVisible({ timeout: 10000 });

    // Look for the server card (will resolve as soon as it appears)
    const serverButtons = page.locator("role=button").filter({ hasText: /^e2e-test-server/ });
    await expect(serverButtons.first()).toBeVisible({ timeout: 10000 });
  });
});
