import type {
  MainSessionWorkspaceBinding,
  RepositoryAgentIdentity,
  SessionRepositoryAgent,
  WorkspaceInstanceIdentity,
} from "./marshal-ipc-contract";

export function normalizeRepositoryAgentPath(value: string): string {
  return value.trim().replace(/[\\/]+/g, "/");
}

export function normalizeRepositoryAgentName(value: string): string {
  return value.trim().normalize("NFC");
}

export function workspaceInstanceIdentitiesEqual(
  left: WorkspaceInstanceIdentity | undefined,
  right: WorkspaceInstanceIdentity | undefined,
): boolean {
  return (
    !!left &&
    !!right &&
    left.version === right.version &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs
  );
}

export function workspaceBindingsEqual(
  left: MainSessionWorkspaceBinding | undefined,
  right: MainSessionWorkspaceBinding | undefined,
): boolean {
  return (
    !!left &&
    !!right &&
    left.name === right.name &&
    workspaceInstanceIdentitiesEqual(left.identity, right.identity)
  );
}

export function repositoryAgentIdentitiesEqual(
  left: RepositoryAgentIdentity | undefined,
  right: RepositoryAgentIdentity | undefined,
): boolean {
  return (
    !!left &&
    !!right &&
    left.version === right.version &&
    left.normalizedPath === right.normalizedPath &&
    left.declaredName === right.declaredName &&
    left.contentDigest === right.contentDigest
  );
}

export function repositoryAgentsEqual(
  left: SessionRepositoryAgent | undefined,
  right: SessionRepositoryAgent | undefined,
): boolean {
  return (
    !!left &&
    !!right &&
    normalizeRepositoryAgentPath(left.path) === normalizeRepositoryAgentPath(right.path) &&
    normalizeRepositoryAgentName(left.name) === normalizeRepositoryAgentName(right.name) &&
    repositoryAgentIdentitiesEqual(left.identity, right.identity)
  );
}

export function workspaceBindingKey(binding: MainSessionWorkspaceBinding): string {
  const { identity } = binding;
  return JSON.stringify([
    binding.name,
    identity.version,
    identity.device,
    identity.inode,
    identity.birthtimeNs,
  ]);
}

export function repositoryAgentBindingKey(agent: SessionRepositoryAgent): string | undefined {
  const identity = agent.identity;
  if (!identity) return undefined;
  return JSON.stringify([
    identity.version,
    identity.normalizedPath,
    identity.declaredName,
    identity.contentDigest,
  ]);
}
