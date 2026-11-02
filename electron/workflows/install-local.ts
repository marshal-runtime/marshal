// electron/workflows/install-local.ts
//
// Shared implementation for local/user-library workflow imports, including
// the explicit-binding authoring path:
// validate a candidate workflow folder, esbuild-compile `workflow.ts`
// to `dist/workflow.js`, write the `.installed.json` sidecar marking
// the install as `user-local`, and register the workflow under
// `~/.marshal/marshal-workflows/<id>/`.
//
// install_local stays for internal backwards-compat: it does the same work, but
// auto-derives bindings (shipped-agent when defaultAgent is present,
// default-with-role otherwise). The explicit `install()` lets the
// installing agent author a custom binding map per slot.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createLogger } from "../../common/marshal-logger";
import {
  type Binding,
  BindingsFileSchema,
  type BindingsFile,
  WorkflowManifestSchema,
  type WorkflowManifest,
} from "../../common/workflows-contract";
import { WorkflowInstallError } from "./errors";
import { writeInstalledSource } from "./installed-source-store";
import { compileRendererWithEsbuild, compileWithEsbuild } from "./workflow-compiler";
import { loadDefinitionFromCompiled } from "./workflow-introspect";
import type { WorkflowLoader } from "./workflow-loader";

const log = createLogger("WorkflowInstall");

export interface InstallLocalArgs {
  readonly sourceDir: string;
  readonly overwrite?: boolean;
}

export interface InstallLocalResult {
  readonly workflowId: string;
  readonly installedAt: number;
  readonly compiledBytes: number;
  readonly warnings: ReadonlyArray<string>;
}

export interface InstallArgs extends InstallLocalArgs {
  /**
   * Optional absolute path to a target repo. Persisted as
   * `bindings.targetRepoPath` so `repo-agent` / `create-agent` bindings
   * can resolve `.github/agents/` at run time. Null/undefined = standalone.
   */
  readonly targetRepoPath?: string | null;
  /**
   * Slot → binding map produced by the installing agent. MUST cover
   * every slot in the workflow's `agentRequirements`. When omitted,
   * `install` falls back to the same auto-derivation `installLocal`
   * uses (shipped-agent when defaultAgent is present, otherwise
   * default-with-role).
   */
  readonly bindings?: Record<string, Binding>;
  /** Optional absolute path to an authoritative `.github` folder. */
  readonly externalContextPath?: string | null;
}

export interface InstallResult extends InstallLocalResult {
  readonly bindings: BindingsFile;
  /** Bindings the install tool synthesized (e.g. auto-derived defaults). */
  readonly autoDerivedSlots: ReadonlyArray<string>;
  /** Slots authored by `create-agent` bindings whose .agent.md was written this run. */
  readonly createdAgentPaths: ReadonlyArray<string>;
}

export interface InstallLocalDeps {
  readonly loader: WorkflowLoader;
  /** Override esbuild for tests — receives a config object and returns the compiled JS. */
  readonly compile?: (sourceFile: string) => Promise<string>;
}

/**
 * Backwards-compat wrapper: install with no explicit binding map. The
 * helper auto-derives bindings from the workflow's declared
 * `agentRequirements`.
 */
export async function installLocal(
  args: InstallLocalArgs,
  deps: InstallLocalDeps,
): Promise<InstallLocalResult> {
  const result = await install({ ...args, targetRepoPath: null }, deps);
  return {
    workflowId: result.workflowId,
    installedAt: result.installedAt,
    compiledBytes: result.compiledBytes,
    warnings: result.warnings,
  };
}

/**
 * FEAT-SLOTS install entry point. Accepts an explicit binding map and
 * a target repo path. The installing agent (typically a chat agent
 * that called `workflowDescribe` + `listRepositoryAgents`
 * upstream) chooses, per slot:
 *
 *   - `repo-agent`: an existing `<repo>/.github/agents/<name>.agent.md`.
 *     Validated to exist before install completes.
 *   - `shipped-agent`: the workflow's `defaultAgent.agentMdPath`.
 *     Validated that the source dir contains the file.
 *   - `create-agent`: a NEW `.agent.md` the installer authored. The
 *     install tool writes it into the target repo at
 *     `<targetRepoPath>/<agentMdPath>` (creating directories as
 *     needed). The binding MUST include a `body` field on the input
 *     side — see `InstallArgs.createAgentBodies`.
 *   - `default-with-role`: no FS action; engine prepends role +
 *     personality at spawn time.
 *
 * For `create-agent` bindings, the body content is provided
 * out-of-band via `createAgentBodies` so the binding schema stays
 * symmetric with what gets persisted to disk (the body lives in the
 * .agent.md file, not in bindings.json).
 */
export async function install(
  args: InstallArgs & { readonly createAgentBodies?: Record<string, string> },
  deps: InstallLocalDeps,
): Promise<InstallResult> {
  const warnings: string[] = [];
  const srcDir = path.resolve(args.sourceDir);
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    throw new WorkflowInstallError(
      "MISSING_MANIFEST",
      `sourceDir does not exist or is not a directory: ${srcDir}`,
    );
  }

  // 1. Read manifest
  const manifestPath = path.join(srcDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new WorkflowInstallError("MISSING_MANIFEST", `manifest.json missing from ${srcDir}`);
  }
  let manifest: WorkflowManifest;
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as unknown;
    if (typeof raw !== "object" || raw === null) {
      throw new WorkflowInstallError("INVALID_MANIFEST", "manifest.json is not an object");
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed via typeof above; Zod validates immediately
    const rawObj = raw as Record<string, unknown>;
    delete rawObj.source; // Untrusted from disk per r1-fixes A12.
    const parsed = WorkflowManifestSchema.safeParse(rawObj);
    if (!parsed.success) {
      throw new WorkflowInstallError(
        "INVALID_MANIFEST",
        `manifest.json validation failed: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    manifest = parsed.data;
  } catch (err) {
    if (err instanceof WorkflowInstallError) throw err;
    throw new WorkflowInstallError(
      "INVALID_MANIFEST",
      `Could not parse manifest.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 2. Renderer source check
  const rendererSrc = path.join(srcDir, "renderer.tsx");
  const hasRendererSource = fs.existsSync(rendererSrc);

  // 3. Compile
  const workflowSrc = path.join(srcDir, "workflow.ts");
  const prebuiltDist = path.join(srcDir, "dist", "workflow.js");
  let compiled: string;
  if (deps.compile) {
    compiled = await deps.compile(workflowSrc);
  } else if (fs.existsSync(prebuiltDist)) {
    // Honour a prebuilt dist (tests + bundled-style installs).
    compiled = fs.readFileSync(prebuiltDist, "utf-8");
  } else if (fs.existsSync(workflowSrc)) {
    compiled = await compileWithEsbuild(workflowSrc);
  } else {
    throw new WorkflowInstallError(
      "MISSING_WORKFLOW_TS",
      `Neither workflow.ts nor dist/workflow.js found in ${srcDir}`,
    );
  }

  const rendererCompiled = hasRendererSource
    ? await compileRendererWithEsbuild(rendererSrc, manifest.id)
    : null;

  // 4. Load compiled workflow to introspect agentRequirements (FEAT-SLOTS).
  // The compiled JS bundles the SDK, so loading it from a tmpdir works.
  const definition = await loadDefinitionFromCompiled(compiled, manifest.id, srcDir);
  const requirements = definition.agentRequirements ?? [];
  const externalContextPath = resolveExternalContextPath(
    args.externalContextPath ?? definition.externalContext?.githubFolderPath,
  );

  // 5. Resolve / validate bindings.
  const targetRepoPath =
    typeof args.targetRepoPath === "string" && args.targetRepoPath.length > 0
      ? path.resolve(args.targetRepoPath)
      : null;
  const { bindingsFile, autoDerivedSlots, createdAgentPaths } = resolveBindings({
    requirements,
    explicitBindings: args.bindings,
    targetRepoPath,
    externalContextPath,
    workflowSrcDir: srcDir,
    createAgentBodies: args.createAgentBodies ?? {},
  });

  // 6. Install — write files into the install dir.
  const userRoot = deps.loader.userRoot();
  const destDir = path.join(userRoot, manifest.id);
  if (fs.existsSync(destDir) && !args.overwrite) {
    throw new WorkflowInstallError(
      "ID_CONFLICT",
      `Workflow ${manifest.id} already installed at ${destDir}. Pass overwrite=true to replace.`,
    );
  }
  fs.mkdirSync(path.join(destDir, "dist"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destDir, "manifest.json"), JSON.stringify(manifest, null, 2), {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(destDir, "dist", "workflow.js"), compiled, { mode: 0o600 });
  if (rendererCompiled) {
    fs.writeFileSync(path.join(destDir, "dist", "renderer.js"), rendererCompiled, {
      mode: 0o600,
    });
  }
  // Sibling dist/package.json so Node treats workflow.js as CJS even
  // when an ancestor package.json declares `"type": "module"`.
  fs.writeFileSync(
    path.join(destDir, "dist", "package.json"),
    JSON.stringify({ type: "commonjs" }, null, 2),
    { mode: 0o600 },
  );
  // Copy shipped agent files into the install dir so shipped-agent
  // bindings can locate them at run time (the engine reads the file
  // from <installDir>/<agentMdPath>). For user installs this is rare
  // (typically only bundled workflows ship agents), but we honour it
  // generically.
  copyShippedAgentFiles({ requirements, srcDir, destDir });
  // Also copy assets/ if present, so workflows that load static files
  // from `<__dirname>/assets/` resolve from the per-run pinned tmpdir.
  copyAssetsDir({ srcDir, destDir });
  // Write bindings.json next to manifest.json. Empty bindings are still
  // written so the loader's source-of-truth lives on disk.
  fs.writeFileSync(path.join(destDir, "bindings.json"), JSON.stringify(bindingsFile, null, 2), {
    mode: 0o600,
  });

  const compiledBytes = Buffer.byteLength(compiled, "utf-8");
  const distHash = createHash("sha256").update(compiled).digest("hex");

  // 7. Sidecar
  const installedAt = Date.now();
  writeInstalledSource(destDir, {
    source: "user-local",
    installedAt,
    distHash,
    version: manifest.version,
  });
  log.info(
    `Installed user workflow ${manifest.id} v${manifest.version} (${compiledBytes} bytes, ${
      Object.keys(bindingsFile.bindings).length
    } bindings)`,
  );

  return {
    workflowId: manifest.id,
    installedAt,
    compiledBytes,
    warnings,
    bindings: bindingsFile,
    autoDerivedSlots,
    createdAgentPaths,
  };
}

interface ResolveBindingsArgs {
  readonly requirements: ReadonlyArray<{
    slot: string;
    role: string;
    defaultPersonality?: string;
    defaultAgent?: { agentMdPath: string };
  }>;
  readonly explicitBindings: Record<string, Binding> | undefined;
  readonly targetRepoPath: string | null;
  readonly externalContextPath: string | null;
  readonly workflowSrcDir: string;
  readonly createAgentBodies: Record<string, string>;
}

interface ResolveBindingsResult {
  readonly bindingsFile: BindingsFile;
  readonly autoDerivedSlots: ReadonlyArray<string>;
  readonly createdAgentPaths: ReadonlyArray<string>;
}

export function resolveBindings(args: ResolveBindingsArgs): ResolveBindingsResult {
  const out: Record<string, Binding> = {};
  const autoDerivedSlots: string[] = [];
  const createdAgentPaths: string[] = [];

  // 1. Validate that no extra bindings reference unknown slots — catch
  //    typos at install time rather than at run time.
  if (args.explicitBindings) {
    const requiredSlots = new Set(args.requirements.map((r) => r.slot));
    for (const slot of Object.keys(args.explicitBindings)) {
      if (!requiredSlots.has(slot)) {
        throw new WorkflowInstallError(
          "INVALID_MANIFEST",
          `Binding refers to slot '${slot}' which the workflow does not declare in agentRequirements.`,
        );
      }
    }
  }

  // 2. For each required slot, take the explicit binding or auto-derive.
  for (const req of args.requirements) {
    const provided = args.explicitBindings?.[req.slot];
    if (provided) {
      validateBinding({
        slot: req.slot,
        binding: provided,
        requirement: req,
        targetRepoPath: args.targetRepoPath,
        workflowSrcDir: args.workflowSrcDir,
        createAgentBodies: args.createAgentBodies,
        createdAgentPaths,
      });
      out[req.slot] = provided;
    } else {
      // Auto-derive: shipped if defaultAgent present, else default-with-role.
      if (req.defaultAgent?.agentMdPath) {
        out[req.slot] = { kind: "shipped-agent" };
      } else {
        out[req.slot] = { kind: "default-with-role" };
      }
      autoDerivedSlots.push(req.slot);
    }
  }

  const bindingsFile: BindingsFile = {
    version: 1,
    bindings: out,
    targetRepoPath: args.targetRepoPath,
    externalContextPath: args.externalContextPath,
  };
  // Round-trip through the schema so we throw early on anything malformed.
  const validated = BindingsFileSchema.safeParse(bindingsFile);
  if (!validated.success) {
    throw new WorkflowInstallError(
      "INVALID_MANIFEST",
      `Generated bindings.json failed validation: ${validated.error.message}`,
    );
  }
  return { bindingsFile: validated.data, autoDerivedSlots, createdAgentPaths };
}

function resolveExternalContextPath(input: string | null | undefined): string | null {
  if (!input) return null;
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new WorkflowInstallError(
      "INVALID_MANIFEST",
      `externalContext.githubFolderPath does not exist or is not a directory: ${resolved}`,
    );
  }
  if (path.basename(resolved).toLowerCase() !== ".github") {
    throw new WorkflowInstallError(
      "INVALID_MANIFEST",
      `externalContext.githubFolderPath must point at a .github folder: ${resolved}`,
    );
  }
  return resolved;
}

interface ValidateBindingArgs {
  readonly slot: string;
  readonly binding: Binding;
  readonly requirement: ResolveBindingsArgs["requirements"][number];
  readonly targetRepoPath: string | null;
  readonly workflowSrcDir: string;
  readonly createAgentBodies: Record<string, string>;
  readonly createdAgentPaths: string[];
}

function validateBinding(args: ValidateBindingArgs): void {
  switch (args.binding.kind) {
    case "shipped-agent": {
      const agentMdPath = args.requirement.defaultAgent?.agentMdPath;
      if (!agentMdPath) {
        throw new WorkflowInstallError(
          "INVALID_MANIFEST",
          `Slot '${args.slot}' bound to 'shipped-agent' but the workflow's agentRequirement has no defaultAgent.agentMdPath.`,
        );
      }
      const abs = path.resolve(args.workflowSrcDir, agentMdPath);
      if (!fs.existsSync(abs)) {
        throw new WorkflowInstallError(
          "INVALID_MANIFEST",
          `Slot '${args.slot}' bound to 'shipped-agent' but ${agentMdPath} does not exist in the workflow source dir.`,
        );
      }
      return;
    }
    case "repo-agent": {
      if (!args.targetRepoPath && !args.binding.workspaceName) {
        throw new WorkflowInstallError(
          "INVALID_MANIFEST",
          `Slot '${args.slot}' bound to 'repo-agent' requires a targetRepoPath (or per-binding workspaceName).`,
        );
      }
      if (args.targetRepoPath) {
        const candidate = path.join(
          args.targetRepoPath,
          ".github",
          "agents",
          `${args.binding.agentName}.agent.md`,
        );
        const candidateAlt = path.join(
          args.targetRepoPath,
          ".github",
          "agents",
          `${args.binding.agentName}.md`,
        );
        if (!fs.existsSync(candidate) && !fs.existsSync(candidateAlt)) {
          throw new WorkflowInstallError(
            "INVALID_MANIFEST",
            `Slot '${args.slot}' bound to 'repo-agent' but ${candidate} (or ${candidateAlt}) does not exist.`,
          );
        }
      }
      return;
    }
    case "create-agent": {
      if (!args.targetRepoPath) {
        throw new WorkflowInstallError(
          "INVALID_MANIFEST",
          `Slot '${args.slot}' bound to 'create-agent' requires a targetRepoPath.`,
        );
      }
      const body = args.createAgentBodies[args.slot];
      if (!body || body.trim().length === 0) {
        throw new WorkflowInstallError(
          "INVALID_MANIFEST",
          `Slot '${args.slot}' bound to 'create-agent' requires createAgentBodies['${args.slot}'] with the agent.md content.`,
        );
      }
      const absPath = path.resolve(args.targetRepoPath, args.binding.agentMdPath);
      // Safety: ensure the path stays inside the target repo's .github/agents/.
      const agentsDir = path.resolve(args.targetRepoPath, ".github", "agents");
      if (!absPath.startsWith(agentsDir + path.sep) && absPath !== agentsDir) {
        throw new WorkflowInstallError(
          "INVALID_MANIFEST",
          `Slot '${args.slot}' bound to 'create-agent' targets ${absPath} which is outside ${agentsDir}. Refusing to write.`,
        );
      }
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      // Refuse to overwrite an existing file silently.
      if (fs.existsSync(absPath)) {
        throw new WorkflowInstallError(
          "ID_CONFLICT",
          `Slot '${args.slot}' bound to 'create-agent' refuses to overwrite existing file ${absPath}.`,
        );
      }
      fs.writeFileSync(absPath, body, { mode: 0o644 });
      args.createdAgentPaths.push(absPath);
      return;
    }
    case "default-with-role":
      return;
  }
}

function copyShippedAgentFiles(args: {
  requirements: ResolveBindingsArgs["requirements"];
  srcDir: string;
  destDir: string;
}): void {
  for (const req of args.requirements) {
    const rel = req.defaultAgent?.agentMdPath;
    if (!rel) continue;
    const srcAbs = path.resolve(args.srcDir, rel);
    if (!fs.existsSync(srcAbs)) continue;
    const destAbs = path.resolve(args.destDir, rel);
    fs.mkdirSync(path.dirname(destAbs), { recursive: true, mode: 0o700 });
    fs.copyFileSync(srcAbs, destAbs);
  }
}

function copyAssetsDir(args: { srcDir: string; destDir: string }): void {
  const assetsSrc = path.join(args.srcDir, "assets");
  if (!fs.existsSync(assetsSrc) || !fs.statSync(assetsSrc).isDirectory()) return;
  const assetsDest = path.join(args.destDir, "assets");
  fs.cpSync(assetsSrc, assetsDest, { recursive: true });
}
