import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron, expect, test } from "@playwright/test";

import { E2E_DATA_DIR } from "../electron/mock-mode";
import { cleanupTestData, seedTestData } from "./marshal-fixtures";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("restores maximized state on launch when persisted", async () => {
  // seedTestData() wipes + reseeds the data dir. Write the window-state file
  // AFTER it so the wipe doesn't clobber our seed.
  seedTestData();
  fs.writeFileSync(
    path.join(E2E_DATA_DIR, "marshal-window-state.json"),
    JSON.stringify({
      bounds: { x: 100, y: 100, width: 1200, height: 800 },
      isMaximized: true,
    }),
  );

  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, MARSHAL_E2E: "1" },
    cwd: path.resolve(__dirname, ".."),
  });
  try {
    // Wait for the renderer to be ready — by then ready-to-show has fired,
    // win.show() has been called, and the OS has applied win.maximize().
    await app.firstWindow();
    // Poll isMaximized() — on Windows/Linux CI the OS can take a moment to
    // apply the maximize after the window becomes visible.
    await expect
      .poll(
        () =>
          app.evaluate(({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows()[0];
            return win ? win.isMaximized() : false;
          }),
        { timeout: 10_000 },
      )
      .toBe(true);
  } finally {
    await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
    cleanupTestData();
  }
});
