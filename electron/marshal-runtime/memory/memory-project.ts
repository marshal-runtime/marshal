import { createLogger } from "../../../common/marshal-logger";
import { captureWorkspaceBinding } from "../../workspace-role-identity";
import { resolveRuntimeWorkspaceIds } from "../runtime-workspace-identity";

const log = createLogger("MemoryProject");

export interface MemoryProject {
  readonly workspacePath: string;
  readonly projectId: string;
  /** The runtime workspace scope id, with `projectId` the session's runtime scope. */
  readonly workspaceId: string;
}

/**
 * Resolves a workspace path to the same git project id the Marshal Runtime
 * gives that workspace, so host-scoped memories line up with runtime scopes.
 * Failures resolve to `undefined` (global memory only) and are not cached.
 */
export class MemoryProjectResolver {
  private readonly resolved = new Map<string, MemoryProject>();
  private readonly pending = new Map<string, Promise<MemoryProject | undefined>>();

  peek(workspacePath: string | undefined): MemoryProject | undefined {
    return workspacePath ? this.resolved.get(workspacePath) : undefined;
  }

  resolve(workspacePath: string | undefined): Promise<MemoryProject | undefined> {
    if (!workspacePath) return Promise.resolve(undefined);
    const known = this.resolved.get(workspacePath);
    if (known) return Promise.resolve(known);
    const inFlight = this.pending.get(workspacePath);
    if (inFlight) return inFlight;
    const next = this.lookup(workspacePath).finally(() => this.pending.delete(workspacePath));
    this.pending.set(workspacePath, next);
    return next;
  }

  private async lookup(workspacePath: string): Promise<MemoryProject | undefined> {
    try {
      const workspace = captureWorkspaceBinding("Memory workspace", workspacePath);
      const { projectId, workspaceId } = await resolveRuntimeWorkspaceIds(
        workspace.canonicalPath,
        workspace.binding.identity,
      );
      const project = { workspacePath: workspace.canonicalPath, projectId, workspaceId };
      this.resolved.set(workspacePath, project);
      return project;
    } catch (error) {
      log.warn("Memory project unavailable; using global memory only", {
        error: error instanceof Error ? error.name : typeof error,
      });
      return undefined;
    }
  }
}
