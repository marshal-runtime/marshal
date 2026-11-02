import { z } from "zod";

import { deleteSkill, loadLocalSkills } from "../skills";
import type { TenantPolicyProvider } from "../tenant-policy";
import { checkStringSize, IPC_LIMITS } from "./ipc-limits";
import { askHowToResolveInstallConflicts } from "./shared/install-conflict-prompt";
import type { IpcDeps } from "./types";

const TENANT_BLOCKED = "Automations are disabled by your organization's policy";

/** Lightweight schema for conflict detection — only validates the `name` field. */
const AutomationNameSchema = z.object({ name: z.string() }).strip();

export function registerAutomationsHandlers({
  sessionManager,
  getWindow,
  ipcHandle,
  tenantPolicyProvider,
}: Pick<IpcDeps, "sessionManager" | "getWindow" | "ipcHandle"> & {
  // Optional: open-by-default so dev/test works without tenant wiring.
  // If omitted in production (wiring bug), enforcement is silently skipped.
  tenantPolicyProvider?: Pick<TenantPolicyProvider, "get">;
}) {
  const backend = () => sessionManager.getBackendProvider();

  ipcHandle("automations:list", async () => {
    try {
      const automations = await backend().automation.listAutomations();
      return { success: true, automations };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("automations:create", async (_e, data) => {
    try {
      if (tenantPolicyProvider?.get()?.disableAutomations) {
        return { success: false, error: TENANT_BLOCKED };
      }
      // Backend returns the canonical AutomationData (id, createdAt, updatedAt,
      // resolved schedule, etc.). Input is the narrower `AutomationCreateInput`
      // shape the IPC contract already matches — no cast needed.
      const automation = await backend().automation.createAutomation(data);
      return { success: true, automation };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("automations:update", async (_e, id: string, updates) => {
    try {
      await backend().automation.updateAutomation(id, updates);
      const all = await backend().automation.listAutomations();
      const automation = all.find((a) => a.id === id);
      if (!automation) return { success: false, error: "Automation not found" };
      return { success: true, automation };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("automations:delete", async (_e, id: string, opts?: { deleteSkills?: boolean }) => {
    try {
      // If deleteSkills is requested, remove the associated skills first
      if (opts?.deleteSkills) {
        const automations = await backend().automation.listAutomations();
        const automation = automations.find((w) => w.id === id);
        if (automation?.skillNames?.length) {
          const localSkills = loadLocalSkills();
          for (const skillName of automation.skillNames) {
            const skill = localSkills.find((s) => s.name === skillName);
            if (skill) {
              deleteSkill(skill.id);
            }
          }
          const win = getWindow();
          win?.webContents.send("skills:changed");
        }
      }
      await backend().automation.deleteAutomation(id);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("automations:toggle", async (_e, id: string, enabled: boolean) => {
    try {
      if (enabled && tenantPolicyProvider?.get()?.disableAutomations) {
        return { success: false, error: TENANT_BLOCKED };
      }
      await backend().automation.toggleAutomation(id, enabled);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("automations:runNow", async (_e, id: string) => {
    try {
      if (tenantPolicyProvider?.get()?.disableAutomations) {
        return { success: false, error: TENANT_BLOCKED };
      }
      // Backend owns timeout/heartbeat semantics. Copilot returns the run
      // record for the activities-panel jump; gateway returns null (cron
      // fires async).
      const run = await backend().automation.triggerAutomationNow(id);
      return { success: true, run: run ?? undefined };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("automations:getHistory", async (_e, id: string) => {
    try {
      const runs = await backend().automation.getAutomationRuns(id);
      return { success: true, runs };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("automations:getAllHistory", async () => {
    try {
      const runs = await backend().automation.getAllAutomationRuns();
      return { success: true, runs };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("automations:getCurrentRun", async () => {
    return { success: true, run: await backend().automation.getCurrentRun() };
  });

  ipcHandle("automations:export", async (_e, id: string) => {
    try {
      const json = await backend().automation.exportAutomation(id);
      if (!json) return { success: false, error: "Automation not found" };
      return { success: true, json };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("automations:import", async (_e, json: string) => {
    try {
      const sizeCheck = checkStringSize(json, IPC_LIMITS.JSON_IMPORT_BYTES, "Automation import");
      if (sizeCheck) return sizeCheck;
      if (tenantPolicyProvider?.get()?.disableAutomations) {
        return { success: false, error: TENANT_BLOCKED };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(json); // SF-4: full schema validation lives in the backend's importAutomations()
      } catch {
        return { success: false, error: "Invalid automation JSON" };
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- parsed JSON, .name accessed via zod schema below
      const incoming = (Array.isArray(parsed) ? parsed : [parsed]) as unknown[];
      const existingNames = new Set(
        (await backend().automation.listAutomations()).map((w) => w.name),
      );
      const automationConflicts = incoming
        .map((w) => AutomationNameSchema.safeParse(w))
        .filter((r): r is { success: true; data: { name: string } } => r.success)
        .map((r) => r.data.name)
        .filter((n) => existingNames.has(n));

      let overwrite = false;
      if (automationConflicts.length > 0) {
        const choice = await askHowToResolveInstallConflicts(getWindow, [], automationConflicts);
        if (choice === "cancel") return { success: false, error: "Import cancelled" };
        overwrite = choice === "replace";
      }

      const automations = await backend().automation.importAutomations(json, { overwrite });
      if (automations.length === 0 && automationConflicts.length === 0)
        return { success: false, error: "Invalid automation JSON" };
      return { success: true, automations };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("automations:getConditionStatus", async (_e, id: string) => {
    try {
      const status = await backend().automation.getConditionStatus(id);
      return {
        success: true,
        lastCheck: status.lastCheck ?? undefined,
        nextCheck: status.nextCheck ?? undefined,
        lastError: status.lastError ?? undefined,
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}
