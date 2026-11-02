import { dialog } from "electron";

export type InstallConflictChoice = "skip" | "replace" | "cancel";

export function formatInstallConflictDetails(
  skillConflicts: string[],
  automationConflicts: string[],
): string {
  const sections: string[] = [];
  if (skillConflicts.length > 0)
    sections.push(
      `Skills (${skillConflicts.length}):\n${skillConflicts.map((name) => `  • ${name}`).join("\n")}`,
    );
  if (automationConflicts.length > 0)
    sections.push(
      `Automations (${automationConflicts.length}):\n${automationConflicts.map((name) => `  • ${name}`).join("\n")}`,
    );
  return `${sections.join("\n\n")}\n\nHow would you like to proceed?`;
}

export async function askHowToResolveInstallConflicts(
  getWindow: () => Electron.BrowserWindow | null,
  skillConflicts: string[],
  automationConflicts: string[],
): Promise<InstallConflictChoice> {
  const opts = {
    type: "question" as const,
    title: "Items already exist",
    message: "Some items are already installed",
    detail: formatInstallConflictDetails(skillConflicts, automationConflicts),
    buttons: ["Skip existing", "Replace all", "Cancel"],
    defaultId: 0,
    cancelId: 2,
  };
  const win = getWindow();
  const { response } = win
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts);
  if (response === 2) return "cancel";
  if (response === 1) return "replace";
  return "skip";
}
