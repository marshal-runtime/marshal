import type { RuntimeClientFactory } from "../runtime-contract";
import { CodexRuntimeClient, type CodexRuntimeClientOptions } from "./client";
import { createCodexAppServerConnection, type CodexSpawnOptions } from "./process";

export interface CodexClientFactoryOptions
  extends Omit<CodexSpawnOptions, "workspaceDir">, CodexRuntimeClientOptions {}

export function createCodexClientFactory(
  options: CodexClientFactoryOptions = {},
): RuntimeClientFactory {
  return async (workspaceDir) => {
    const connection = await createCodexAppServerConnection({
      ...options,
      workspaceDir,
    });
    try {
      return await CodexRuntimeClient.initialize(connection, workspaceDir, {
        persistThreadTools: true,
        ...options,
      });
    } catch (error) {
      await connection.shutdown({ force: true });
      throw error;
    }
  };
}
