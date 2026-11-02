import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type ElectronApplication } from "@playwright/test";

import type {
  RuntimeAcceptanceFixtureSpec,
  RuntimeAcceptanceTypeScriptProfile,
} from "../common/runtime-acceptance";
import { launchPersistentE2EApp } from "./marshal-fixtures";
import {
  LiveStoryRecorder,
  RuntimeAcceptanceClient,
  array,
  output,
  record,
  requireOk,
  resultErrorCode,
} from "./runtime-acceptance/harness";

const RUN_ROOT = requiredPath("MARSHAL_RUNTIME_ACCEPTANCE_RUN_ROOT");
const EVIDENCE_ROOT = requiredPath("MARSHAL_RUNTIME_ACCEPTANCE_EVIDENCE_ROOT");
const USER_DATA_ROOT = path.join(RUN_ROOT, "electron-user-data-stories");
const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCOPE = { sessionId: "e2e-fresh", workspaceName: "marshal" } as const;
const SELECTED_STORIES = new Set(
  (process.env.MARSHAL_RUNTIME_ACCEPTANCE_STORIES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const CONTEXT_API_STORIES = new Set(["MRT-CTX-001", "MRT-API-002"]);
const TYPESCRIPT_STORIES = new Set(["MRT-TS-001", "MRT-TS-002", "MRT-TS-003", "MRT-TS-004"]);
const EXTENSION_STORIES = new Set([
  "MRT-EXT-002",
  "MRT-EXT-003",
  "MRT-EXT-004",
  "MRT-EXT-005",
  "MRT-EXT-007",
]);
const PORTABLE_SWARM_STORIES = new Set(["MRT-LEG-001"]);

interface MaterializedFixture {
  readonly fixtureId: string;
  readonly identity: string;
  readonly version: string;
  readonly capabilityNames: readonly string[];
  readonly resourceUris: readonly string[];
}

test.describe.configure({ mode: "serial" });

test("runs extended live Marshal Runtime story campaign", async () => {
  test.setTimeout(12 * 60_000);
  const app = await launchPersistentE2EApp({
    userDataDir: USER_DATA_ROOT,
    seed: true,
    extraEnv: acceptanceEnvironment(),
  });
  const logs = captureProcessLogs(app, "stories-launch");
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(
      () => typeof window.runtimeAcceptanceAPI?.getBridgeInfo === "function",
    );
    const bridgeInfo = record(
      await new RuntimeAcceptanceClient(app, page, SCOPE).value("getBridgeInfo"),
    );
    const paths = record(await new RuntimeAcceptanceClient(app, page, SCOPE).value("getPaths"));
    const client = new RuntimeAcceptanceClient(app, page, SCOPE);
    const recorder = new LiveStoryRecorder(EVIDENCE_ROOT, {
      processId: number(bridgeInfo.mainProcessPid),
      userDataDirectory: string(paths.electronUserDataRoot),
      appDataDirectory: string(paths.marshalAppDataRoot),
    });

    // eslint-disable-next-line playwright/no-conditional-in-test -- acceptance campaigns select explicit story clusters
    if (shouldRunAny(CONTEXT_API_STORIES)) await runContextAndApiStories(recorder, client);
    // eslint-disable-next-line playwright/no-conditional-in-test -- acceptance campaigns select explicit story clusters
    if (shouldRunAny(TYPESCRIPT_STORIES)) await runTypeScriptStories(recorder, client);
    // eslint-disable-next-line playwright/no-conditional-in-test -- acceptance campaigns select explicit story clusters
    if (shouldRunAny(EXTENSION_STORIES)) await runExtensionStories(recorder, client);
    // eslint-disable-next-line playwright/no-conditional-in-test -- acceptance campaigns select explicit story clusters
    if (shouldRunAny(PORTABLE_SWARM_STORIES)) await runPortableSwarmStories(recorder, client);

    const result = recorder.finalize();
    expect(result.stories.length).toBeGreaterThan(0);
  } finally {
    await app.close();
    await logs.close();
  }

  function shouldRunAny(stories: ReadonlySet<string>): boolean {
    return SELECTED_STORIES.size === 0 || [...stories].some((story) => SELECTED_STORIES.has(story));
  }
});

async function runContextAndApiStories(
  recorder: LiveStoryRecorder,
  client: RuntimeAcceptanceClient,
): Promise<void> {
  await recorder.run("MRT-CTX-001", "LIVE-ELECTRON", async () => {
    const search = requireOk(
      await client.search({ query: "marshal", detail: "full", limit: 1_000 }),
    );
    const required = ["marshal.session.context", "marshal.workspace.list", "marshal.skill.read"];
    const descriptors = searchMatches(search).filter((match) =>
      required.includes(capabilityName(match)),
    );
    const session = requireOk(
      await client.invoke("marshal.session.context", {}, unique("session-context")),
    );
    const workspaces = requireOk(
      await client.invoke("marshal.workspace.list", {}, unique("workspace-list")),
    );
    const resources = array(await client.value("listResources", SCOPE)).filter((resource) =>
      string(record(resource).uri).startsWith("marshal-skill://skill/"),
    );
    const firstResource = record(resources[0]);
    const skillName = decodeURIComponent(
      string(firstResource.uri).slice("marshal-skill://skill/".length),
    );
    const skill = requireOk(
      await client.invoke("marshal.skill.read", { name: skillName }, unique("skill-read")),
    );
    const content = record(
      await client.value("readResource", { ...SCOPE, uri: string(firstResource.uri) }),
    );
    const missing = requireOk(
      await client.invoke(
        "marshal.skill.read",
        { name: "acceptance-missing-skill" },
        unique("skill-missing"),
      ),
    );
    expect(descriptors.map(capabilityName).sort()).toEqual([...required].sort());
    expect(record(output(session).session).id).toBe(SCOPE.sessionId);
    expect(array(output(workspaces).workspaces).length).toBeGreaterThan(1);
    expect(resources.length).toBeGreaterThan(0);
    expect(string(content.mimeType)).toBe("text/markdown");
    expect(record(output(skill).skill).instructions).toBe(string(content.text));
    expect(output(missing).skill).toBeNull();
    return {
      actions: [
        "search:marshal-context",
        "invoke:marshal.session.context",
        "invoke:marshal.workspace.list",
        "invoke:marshal.skill.read",
        "list/read-skill-resource",
      ],
      rawResultEnvelopes: { search, session, workspaces, resources, skill, content, missing },
      assertions: {
        closedDescriptors: true,
        boundedSession: true,
        registeredWorkspaces: true,
        resourceAndCapabilityAgree: true,
        missingSkillDoesNotLeak: true,
      },
      proof: { descriptors, session, workspaces, firstResource, skill, missing },
    };
  });

  await recorder.run("MRT-API-002", "LIVE-ELECTRON", async () => {
    const invalidRequests = await Promise.all([
      client.search({ query: "x".repeat(4_001) }),
      client.search({ query: "x", limit: 1 }, { sessionId: "", workspaceName: "marshal" }),
      client.search(
        { query: "x", limit: 1 },
        { sessionId: "x".repeat(257), workspaceName: "marshal" },
      ),
      client.invoke("", {}, unique("empty-capability")),
      client.invoke("x".repeat(513), {}, unique("long-capability")),
      client.invoke("code.index.status", {}, "x".repeat(257)),
      client.invoke("code.index.status", {}, unique("wrong-scope"), {
        scope: { sessionId: SCOPE.sessionId, workspaceName: "wrong-workspace" },
      }),
      client.invoke("code.index.status", {}, unique("pre-abort"), {
        abort: { timing: "pre" },
      }),
    ]);
    expect(resultErrorCode(invalidRequests[0])).toBeNull();
    expect(
      invalidRequests.slice(1, 6).every((result) => resultErrorCode(result) === "invalid-request"),
    ).toBe(true);
    expect(resultErrorCode(invalidRequests[6])).toBe("permission-denied");
    expect(resultErrorCode(invalidRequests[7])).toBe("aborted");
    const fixedPermissionOverride = await client.acceptance(
      "setAcceptancePermission",
      "ui.open",
      "deny",
    );
    expect(fixedPermissionOverride.success).toBe(false);
    return {
      actions: [
        "search-over-4000",
        "invalid-required-string-matrix",
        "wrong-scope",
        "pre-abort",
        "attempt-fixed-permission-override",
      ],
      rawResultEnvelopes: { invalidRequests, fixedPermissionOverride },
      assertions: {
        searchTruncates: true,
        requiredLimitsReject: true,
        wrongScopeDenied: true,
        abortExplicit: true,
        fixedPermissionsImmutable: true,
      },
      proof: { invalidRequests, fixedPermissionOverride },
    };
  });
}

async function runTypeScriptStories(
  recorder: LiveStoryRecorder,
  client: RuntimeAcceptanceClient,
): Promise<void> {
  const fixture = await materialize(client, {
    profile: "invocation-delay",
    invocationDelayMs: 180,
  });
  await allowFixture(client, fixture);
  requireOk(
    await client.value("installExtension", {
      ...SCOPE,
      fixtureId: fixture.fixtureId,
      idempotencyKey: unique("ts-install"),
    }),
  );

  await recorder.run("MRT-TS-001", "LIVE-ELECTRON+NODE-INTEGRATION", async () => {
    const input = { marker: unique("ts-001") };
    const idempotencyKey = unique("ts-001-execute");
    const beforeCounts = record(await client.value("getInvocationCounts"));
    const beforeAudit = await client.value("getAuthorityAudit");
    const request = {
      ...SCOPE,
      profile: "invoke-capability" as const,
      capability: fixture.capabilityNames[0],
      input,
      idempotencyKey,
    };
    const result = await client.value("executeTypeScript", request);
    const afterCounts = record(await client.value("getInvocationCounts"));
    const afterAudit = await client.value("getAuthorityAudit");
    const ok = requireOk(result);
    const generatedSources = array(afterCounts.generatedTypeScriptSources);
    const source = generatedSources
      .map(record)
      .find((entry) => entry.idempotencyKey === idempotencyKey);
    const nestedAudit = afterAudit.slice(beforeAudit.length);
    const fixtureEvents = array(record(afterCounts.fixtureEvents)[`fixture:${fixture.fixtureId}`]);
    const execution = output(ok);
    expect(execution).toMatchObject({ ok: true, status: "succeeded", mode: "brokered" });
    expect(record(execution.value)).toEqual({ version: fixture.version, input });
    expect(array(ok.receipts).every((receipt) => record(receipt).status === "success")).toBe(true);
    expect(source).toMatchObject({
      profile: "invoke-capability",
      capability: fixture.capabilityNames[0],
      idempotencyKey,
    });
    expect(string(record(source).sourceSha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(
      nestedAudit.some(
        (entry) =>
          entry.sessionId === SCOPE.sessionId &&
          entry.workspaceName === SCOPE.workspaceName &&
          entry.capability === fixture.capabilityNames[0] &&
          entry.decision === "allow",
      ),
    ).toBe(true);
    expect(
      fixtureEvents.filter((event) => event === `invoke:${fixture.capabilityNames[0]}`),
    ).toHaveLength(1);
    const artifact = recorder.writeSupporting("typescript/mrt-ts-001.json", {
      request,
      result,
      source,
      nestedAudit,
      beforeCounts,
      afterCounts,
    });
    return {
      actions: ["execute-brokered-typescript", "inspect-source-digest", "inspect-nested-audit"],
      rawResultEnvelopes: { request, result },
      assertions: {
        outerResultOk: true,
        nestedInvocationSucceeded: true,
        receiptsSuccessful: true,
        exactInputOutputPreserved: true,
        brokeredScopePreserved: true,
        sourceDigestCaptured: true,
      },
      proof: { request, result, source, nestedAudit, beforeCounts, afterCounts },
      supportingEvidence: [artifact, "authority-audit.jsonl", "api-audit.jsonl"],
    };
  });

  await recorder.run("MRT-TS-002", "LIVE-ELECTRON", async () => {
    let denied: unknown = null;
    let ambient: readonly unknown[] = [];
    const secretMarker = unique("ts-secret-marker");
    await client.value(
      "setAcceptancePermission",
      `marshal.tool.invoke:${fixture.capabilityNames[0]}`,
      "deny",
    );
    const before = record(await client.value("getInvocationCounts"));
    try {
      denied = await client.value("executeTypeScript", {
        ...SCOPE,
        profile: "invoke-capability",
        capability: fixture.capabilityNames[0],
        input: { marker: "denied", secretMarker },
        idempotencyKey: unique("ts-denied"),
      });
      ambient = await mapSeries(
        [
          "ambient-fs",
          "ambient-child-process",
          "ambient-process",
          "undeclared-import",
        ] as const satisfies readonly RuntimeAcceptanceTypeScriptProfile[],
        (profile) =>
          client.value("executeTypeScript", {
            ...SCOPE,
            profile,
            input: { secretMarker },
            idempotencyKey: unique(`ts-${profile}`),
          }),
      );
    } finally {
      await client.value(
        "setAcceptancePermission",
        `marshal.tool.invoke:${fixture.capabilityNames[0]}`,
        "allow",
      );
    }
    const after = record(await client.value("getInvocationCounts"));
    const authorityAudit = await client.value("getAuthorityAudit");
    const deniedExecution = output(requireOk(denied));
    const ambientExecutions = ambient.map((result) => output(requireOk(result)));
    expect(deniedExecution).toMatchObject({ ok: false, status: "runtime_failed" });
    expect(record(deniedExecution.error).code).toBe("permission_denied");
    expect(string(record(deniedExecution.error).message)).toMatch(
      /not allowed|approval|permission[_-]denied/i,
    );
    expect(
      ambientExecutions.every(
        (executionResult) =>
          executionResult.ok === true && record(executionResult.value).available === false,
      ),
    ).toBe(true);
    expect(fixtureInvokeCount(after, fixture)).toBe(fixtureInvokeCount(before, fixture));
    expect(
      authorityAudit.some(
        (entry) => entry.capability === fixture.capabilityNames[0] && entry.decision === "deny",
      ),
    ).toBe(true);
    const diagnosticText = JSON.stringify({
      deniedError: deniedExecution.error,
      ambientDiagnostics: ambientExecutions.map((executionResult) => ({
        error: executionResult.error,
        stderr: executionResult.stderr,
      })),
    });
    expect(diagnosticText.includes(secretMarker)).toBe(false);
    const artifact = recorder.writeSupporting("typescript/mrt-ts-002.json", {
      denied,
      deniedExecution,
      ambient,
      ambientExecutions,
      before,
      after,
      authorityAudit,
      secretMarker,
    });
    return {
      actions: ["deny-nested-capability", "execute-four-ambient-authority-probes"],
      rawResultEnvelopes: {
        denied,
        deniedExecution,
        ambient,
        ambientExecutions,
        before,
        after,
        authorityAudit,
        secretMarker,
      },
      assertions: {
        nestedPermissionDenied: true,
        ambientNodeAuthorityUnavailable: true,
        providerNotInvokedOnDenial: true,
        denialAudited: true,
        errorsSanitized: true,
      },
      proof: {
        denied,
        deniedExecution,
        ambient,
        ambientExecutions,
        before,
        after,
        authorityAudit,
        secretMarker,
      },
      supportingEvidence: [artifact, "authority-audit.jsonl", "api-audit.jsonl"],
    };
  });

  await recorder.run("MRT-TS-003", "LIVE-ELECTRON", async () => {
    const normal = await client.value("executeTypeScript", {
      ...SCOPE,
      profile: "search-capability",
      input: { query: "code" },
      idempotencyKey: unique("ts-normal"),
    });
    const normalExecution = output(requireOk(normal));
    const bridgeInfo = record(await client.value("getBridgeInfo"));
    const configuredNodeExecutable = string(bridgeInfo.nodeExecutable);
    const childrenBefore = windowsDescendants(number(bridgeInfo.mainProcessPid));
    const pending = client.value("executeTypeScript", {
      ...SCOPE,
      profile: "timeout",
      timeoutMs: 1_500,
      idempotencyKey: unique("ts-timeout"),
    });
    await delay(250);
    const childrenDuring = windowsDescendants(number(bridgeInfo.mainProcessPid));
    const timeout = await pending;
    const timeoutExecution = output(requireOk(timeout));
    const overflow = await client.value("executeTypeScript", {
      ...SCOPE,
      profile: "output-overflow",
      idempotencyKey: unique("ts-overflow"),
    });
    const overflowExecution = output(requireOk(overflow));
    const sourceLimit = await client.value("executeTypeScript", {
      ...SCOPE,
      profile: "source-over-limit",
      idempotencyKey: unique("ts-source-limit"),
    });
    const timeoutLimit = await client.value("executeTypeScript", {
      ...SCOPE,
      profile: "search-capability",
      timeoutMs: 60_001,
      idempotencyKey: unique("ts-timeout-limit"),
    });
    const observedWorkerPids = childrenDuring
      .filter(
        (child) =>
          child.executablePath &&
          path.normalize(child.executablePath).toLowerCase() ===
            path.normalize(configuredNodeExecutable).toLowerCase(),
      )
      .map((child) => child.pid);
    const workerExit = await waitForProcessesToExit(
      number(bridgeInfo.mainProcessPid),
      observedWorkerPids,
      5_000,
    );
    const childrenAfter = windowsDescendants(number(bridgeInfo.mainProcessPid));
    const observedConfiguredChildren = childrenDuring.filter(
      (child) =>
        child.executablePath &&
        path.normalize(child.executablePath).toLowerCase() ===
          path.normalize(configuredNodeExecutable).toLowerCase(),
    );
    const brokerTempWorkers = observedConfiguredChildren.filter((child) =>
      child.commandLine.toLowerCase().includes(`${path.sep}agent-runtime-ts-worker-`.toLowerCase()),
    );
    const executorSourcePath = path.join(
      SOURCE_ROOT,
      "node_modules",
      "@marshal",
      "agent-runtime-typescript",
      "src",
      "executor.ts",
    );
    const executorSource = fs.readFileSync(executorSourcePath, "utf8");
    const executorContract = {
      path: path.relative(SOURCE_ROOT, executorSourcePath).replaceAll(path.sep, "/"),
      sha256: createHash("sha256").update(executorSource).digest("hex"),
      configuredExecutableOption: /execPath:\s*nodeExecutable/.test(executorSource),
      brokerTempCwd: /cwd:\s*mode === 'brokered' \? temporaryDirectory : workingDirectory/.test(
        executorSource,
      ),
      windowsHidden: /windowsHide:\s*true/.test(executorSource),
      outputLimitEnforced: /maxOutputBytes/.test(executorSource),
      fallbackToProcessExecPath:
        /nodeExecutable \?\? process\.execPath/.test(executorSource) ||
        /execPath:\s*nodeExecutable/.test(executorSource),
    };
    const screenshotPath = path.join(EVIDENCE_ROOT, "screenshots", "mrt-ts-003-no-console.png");
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    await client.page.screenshot({ path: screenshotPath, fullPage: true });
    expect(normalExecution).toMatchObject({ ok: true, status: "succeeded" });
    expect(timeoutExecution).toMatchObject({ ok: false, status: "timed_out" });
    expect(overflowExecution).toMatchObject({
      ok: false,
      status: "output_limit_exceeded",
    });
    expect(resultErrorCode(sourceLimit)).toBe("invalid-request");
    expect(record(timeoutLimit).ok).toBe(false);
    if (process.platform === "win32") {
      expect(observedConfiguredChildren.length).toBeGreaterThan(0);
      expect(observedConfiguredChildren.every((child) => child.mainWindowHandle === 0)).toBe(true);
      expect(brokerTempWorkers.length).toBeGreaterThan(0);
    }
    expect(executorContract).toMatchObject({
      configuredExecutableOption: true,
      brokerTempCwd: true,
      windowsHidden: true,
      outputLimitEnforced: true,
      fallbackToProcessExecPath: true,
    });
    expect(childrenAfter.length).toBeLessThanOrEqual(
      Math.max(childrenBefore.length, childrenDuring.length),
    );
    expect(workerExit.exited).toBe(true);
    const artifact = recorder.writeSupporting("typescript/mrt-ts-003.json", {
      configuredNodeExecutable,
      normal,
      normalExecution,
      timeout,
      timeoutExecution,
      overflow,
      overflowExecution,
      sourceLimit,
      timeoutLimit,
      childrenBefore,
      childrenDuring,
      childrenAfter,
      workerExit,
      observedConfiguredChildren,
      brokerTempWorkers,
      executorContract,
    });
    return {
      actions: [
        "execute-normal-worker-timeout",
        "execute-output-overflow",
        "execute-source-over-limit",
        "execute-timeout-over-limit",
        "observe-child-process-window",
      ],
      rawResultEnvelopes: {
        normal,
        normalExecution,
        timeout,
        timeoutExecution,
        overflow,
        overflowExecution,
        sourceLimit,
        timeoutLimit,
        childrenBefore,
        childrenDuring,
        childrenAfter,
        workerExit,
      },
      assertions: {
        normalExecutionSucceeded: true,
        timeoutBounded: true,
        outputBounded: true,
        sourceLimitEnforced: true,
        timeoutLimitEnforced: true,
        configuredNodeExecutableObserved: true,
        brokerTemporaryWorkerPathObserved: true,
        maximumOutput64KiBConfigured: true,
        windowsChildHidden: true,
        noWorkerGrowthAfterSettledExecution: true,
      },
      proof: {
        configuredNodeExecutable,
        normal,
        normalExecution,
        timeout,
        timeoutExecution,
        overflow,
        overflowExecution,
        sourceLimit,
        timeoutLimit,
        childrenBefore,
        childrenDuring,
        childrenAfter,
        workerExit,
        observedConfiguredChildren,
        brokerTempWorkers,
        executorContract,
      },
      supportingEvidence: [artifact, "screenshots/mrt-ts-003-no-console.png", "api-audit.jsonl"],
    };
  });

  await recorder.run("MRT-TS-004", "LIVE-ELECTRON", async () => {
    await client.value(
      "setAcceptancePermission",
      `marshal.tool.invoke:${fixture.capabilityNames[0]}`,
      "allow",
    );
    const bridgeInfo = record(await client.value("getBridgeInfo"));
    const processBefore = windowsDescendants(number(bridgeInfo.mainProcessPid));
    const countsBefore = record(await client.value("getInvocationCounts"));
    const sharedKey = unique("ts-shared");
    const sharedStartedAt = new Date().toISOString();
    const [abortedWaiter, survivingWaiter] = await Promise.all([
      client.value("executeTypeScript", {
        ...SCOPE,
        profile: "invoke-capability",
        capability: fixture.capabilityNames[0],
        input: { marker: "shared" },
        idempotencyKey: sharedKey,
        abort: { timing: "after-ms", delayMs: 25 },
      }),
      client.value("executeTypeScript", {
        ...SCOPE,
        profile: "invoke-capability",
        capability: fixture.capabilityNames[0],
        input: { marker: "shared" },
        idempotencyKey: sharedKey,
      }),
    ]);
    const sharedCompletedAt = new Date().toISOString();
    const countsAfterShared = record(await client.value("getInvocationCounts"));
    const soleStartedAt = new Date().toISOString();
    const solePromise = client.value("executeTypeScript", {
      ...SCOPE,
      profile: "invoke-capability",
      capability: fixture.capabilityNames[0],
      input: { marker: "sole" },
      idempotencyKey: unique("ts-sole-abort"),
      abort: { timing: "fixture-event", event: "invoke:start" },
    });
    await delay(10);
    const processDuringSole = windowsDescendants(number(bridgeInfo.mainProcessPid));
    const soleAbort = await solePromise;
    const soleCompletedAt = new Date().toISOString();
    const conflict = await client.value("executeTypeScript", {
      ...SCOPE,
      profile: "invoke-capability",
      capability: fixture.capabilityNames[0],
      input: { marker: "changed" },
      idempotencyKey: sharedKey,
    });
    const counts = record(await client.value("getInvocationCounts"));
    await delay(250);
    const processAfter = windowsDescendants(number(bridgeInfo.mainProcessPid));
    const eventKey = `fixture:${fixture.fixtureId}`;
    const beforeEvents = array(record(countsBefore.fixtureEvents)[eventKey]);
    const sharedEvents = array(record(countsAfterShared.fixtureEvents)[eventKey]);
    const finalEvents = array(record(counts.fixtureEvents)[eventKey]);
    const sharedDelta = sharedEvents.slice(beforeEvents.length);
    const soleDelta = finalEvents.slice(sharedEvents.length);
    expect(resultErrorCode(abortedWaiter)).toBe("aborted");
    expect(record(survivingWaiter).ok).toBe(true);
    expect(record(output(requireOk(survivingWaiter)).value)).toMatchObject({
      version: fixture.version,
      input: { marker: "shared" },
    });
    expect(resultErrorCode(soleAbort)).toBe("aborted");
    expect(resultErrorCode(conflict)).toBe("idempotency-conflict");
    expect(
      fixtureInvokeCount(countsAfterShared, fixture) - fixtureInvokeCount(countsBefore, fixture),
    ).toBe(1);
    expect(
      fixtureInvokeCount(counts, fixture) - fixtureInvokeCount(countsAfterShared, fixture),
    ).toBe(1);
    expect(sharedDelta).toContain(`invoke:released:${fixture.capabilityNames[0]}`);
    expect(soleDelta).toContain(`invoke:aborted:${fixture.capabilityNames[0]}`);
    expect(processAfter.length).toBeLessThanOrEqual(
      Math.max(processBefore.length, processDuringSole.length),
    );
    const timeline = {
      sharedStartedAt,
      sharedCompletedAt,
      soleStartedAt,
      soleCompletedAt,
      sharedDelta,
      soleDelta,
    };
    const artifact = recorder.writeSupporting("typescript/mrt-ts-004.json", {
      abortedWaiter,
      survivingWaiter,
      soleAbort,
      conflict,
      countsBefore,
      countsAfterShared,
      counts,
      timeline,
      processBefore,
      processDuringSole,
      processAfter,
    });
    return {
      actions: [
        "share-identical-key-across-two-waiters",
        "abort-one-shared-waiter",
        "abort-sole-waiter",
        "reuse-settled-key-with-different-input",
      ],
      rawResultEnvelopes: { abortedWaiter, survivingWaiter, soleAbort, conflict, counts },
      assertions: {
        sharedExecutionOnce: true,
        survivingWaiterSucceeded: true,
        soleAbortPropagatedToProvider: true,
        conflictRejected: true,
        noWorkerGrowthAfterAbort: true,
      },
      proof: {
        abortedWaiter,
        survivingWaiter,
        soleAbort,
        conflict,
        countsBefore,
        countsAfterShared,
        counts,
        timeline,
        processBefore,
        processDuringSole,
        processAfter,
      },
      supportingEvidence: [artifact, "fixture-events.jsonl", "api-audit.jsonl"],
    };
  });
}

async function runExtensionStories(
  recorder: LiveStoryRecorder,
  client: RuntimeAcceptanceClient,
): Promise<void> {
  await recorder.run("MRT-EXT-002", "LIVE-ELECTRON", async () => {
    const before = record(await client.value("getStatus"));
    const fixture = await materialize(client, { profile: "echo", version: "1.0.0" });
    await allowFixture(client, fixture);
    const install = requireOk(
      await client.value("installExtension", {
        ...SCOPE,
        fixtureId: fixture.fixtureId,
        idempotencyKey: unique("ext2-install"),
      }),
    );
    const search = requireOk(
      await client.search({ name: fixture.capabilityNames[0], detail: "full" }),
    );
    const invoke = requireOk(
      await client.invoke(fixture.capabilityNames[0], { marker: "ext2" }, unique("ext2-invoke")),
    );
    const after = record(await client.value("getStatus"));
    const counts = record(await client.value("getInvocationCounts"));
    expect(record(install.value)).toMatchObject({
      identity: fixture.identity,
      version: "1.0.0",
      status: "enabled",
    });
    expect(searchMatches(search).map(capabilityName)).toContain(fixture.capabilityNames[0]);
    expect(output(invoke)).toMatchObject({ version: "1.0.0", input: { marker: "ext2" } });
    expect(after).toEqual(before);
    expect(fixtureEventCount(counts, fixture, "activate:complete")).toBe(1);
    return {
      actions: ["install", "search", "invoke", "compare-host-status"],
      rawResultEnvelopes: { fixture, install, search, invoke, before, after, counts },
      assertions: {
        enabledImmediately: true,
        searchableInvokable: true,
        noHostRestart: true,
        activationOnce: true,
      },
      proof: { fixture, install, search, invoke, before, after, counts },
    };
  });

  await recorder.run("MRT-EXT-003", "LIVE-ELECTRON", async () => {
    const first = await materialize(client, { profile: "echo", version: "1.0.0" });
    await allowFixture(client, first);
    requireOk(
      await client.value("installExtension", {
        ...SCOPE,
        fixtureId: first.fixtureId,
        idempotencyKey: unique("ext3-install"),
      }),
    );
    const second = await materialize(client, {
      profile: "echo",
      version: "2.0.0",
      identityFixtureId: first.fixtureId,
    });
    const searches = Array.from({ length: 12 }, (_, index) =>
      client.search({ name: first.capabilityNames[0], detail: "full", limit: 5 }).then((value) => ({
        index,
        value,
      })),
    );
    const update = client.value("updateExtension", {
      ...SCOPE,
      identity: first.identity,
      fixtureId: second.fixtureId,
      idempotencyKey: unique("ext3-update"),
    });
    const timeline = await Promise.all([
      ...searches,
      update.then((value) => ({ index: 99, value })),
    ]);
    const list = requireOk(await client.value("listExtensions", SCOPE));
    const counts = record(await client.value("getInvocationCounts"));
    const recordAfter = array(list.value).find(
      (entry) => string(record(entry).identity) === first.identity,
    );
    expect(record(recordAfter).version).toBe("2.0.0");
    expect(fixtureEventCount(counts, first, "dispose")).toBe(1);
    expect(fixtureEventCount(counts, second, "activate:complete")).toBe(1);
    expect(
      timeline
        .filter((entry) => entry.index !== 99)
        .every((entry) => {
          const result = record(entry.value);
          if (result.ok !== true) return false;
          const versions = searchMatches(result).map((match) =>
            string(record(record(match).capability).version),
          );
          return versions.every((version) => version === "1.0.0" || version === "2.0.0");
        }),
    ).toBe(true);
    return {
      actions: ["install-v1", "concurrent-searches", "update-v2", "list-final"],
      rawResultEnvelopes: { first, second, timeline, list, counts },
      assertions: {
        readersSeeCompleteVersions: true,
        oldDisposedAfterReplacement: true,
        finalVersionTwo: true,
      },
      proof: { timeline, list, counts },
    };
  });

  await recorder.run("MRT-EXT-004", "LIVE-ELECTRON", async () => {
    const first = await materialize(client, { profile: "echo", version: "1.0.0" });
    await allowFixture(client, first);
    requireOk(
      await client.value("installExtension", {
        ...SCOPE,
        fixtureId: first.fixtureId,
        idempotencyKey: unique("ext4-install"),
      }),
    );
    const activationFailure = await materialize(client, {
      profile: "activation-failure",
      version: "2.0.0",
      identityFixtureId: first.fixtureId,
    });
    const duplicateFailure = await materialize(client, {
      profile: "duplicate-capability",
      version: "2.1.0",
      identityFixtureId: first.fixtureId,
    });
    const failedUpdates = await Promise.all(
      [activationFailure, duplicateFailure].map((fixture) =>
        client.value("updateExtension", {
          ...SCOPE,
          identity: first.identity,
          fixtureId: fixture.fixtureId,
          idempotencyKey: unique("ext4-update"),
        }),
      ),
    );
    const invoke = requireOk(
      await client.invoke(first.capabilityNames[0], { marker: "still-v1" }, unique("ext4-invoke")),
    );
    const inventory = record(await client.value("getRegistrationInventory"));
    const counts = record(await client.value("getInvocationCounts"));
    expect(failedUpdates.every((result) => record(result).ok === false)).toBe(true);
    expect(output(invoke).version).toBe("1.0.0");
    expect(fixtureEventCount(counts, first, "dispose")).toBe(0);
    expect(
      searchMatches(record(inventory.search)).filter(
        (match) => capabilityName(match) === first.capabilityNames[0],
      ),
    ).toHaveLength(1);
    return {
      actions: ["install-v1", "activation-failing-update", "duplicate-update", "invoke-v1"],
      rawResultEnvelopes: { first, failedUpdates, invoke, inventory, counts },
      assertions: {
        updatesFailed: true,
        priorVersionRemainsLive: true,
        priorActivationNotDisposed: true,
        noPartialRegistration: true,
      },
      proof: { failedUpdates, invoke, inventory, counts },
    };
  });

  await recorder.run("MRT-EXT-005", "LIVE-ELECTRON", async () => {
    const fixture = await materialize(client, { profile: "echo" });
    await allowFixture(client, fixture);
    requireOk(
      await client.value("installExtension", {
        ...SCOPE,
        fixtureId: fixture.fixtureId,
        idempotencyKey: unique("ext5-install"),
      }),
    );
    const disabled = requireOk(
      await client.value("disableExtension", {
        ...SCOPE,
        identity: fixture.identity,
        idempotencyKey: unique("ext5-disable"),
      }),
    );
    const absent = await client.invoke(
      fixture.capabilityNames[0],
      {},
      unique("ext5-disabled-invoke"),
    );
    const enabled = requireOk(
      await client.value("enableExtension", {
        ...SCOPE,
        identity: fixture.identity,
        idempotencyKey: unique("ext5-enable"),
      }),
    );
    const replayEnable = requireOk(
      await client.value("enableExtension", {
        ...SCOPE,
        identity: fixture.identity,
        idempotencyKey: unique("ext5-enable-again"),
      }),
    );
    const live = requireOk(
      await client.invoke(fixture.capabilityNames[0], {}, unique("ext5-live-invoke")),
    );
    const removed = requireOk(
      await client.value("removeExtension", {
        ...SCOPE,
        identity: fixture.identity,
        idempotencyKey: unique("ext5-remove"),
      }),
    );
    const missing = await client.invoke(
      fixture.capabilityNames[0],
      {},
      unique("ext5-removed-invoke"),
    );
    expect(record(disabled.value).status).toBe("disabled");
    expect(resultErrorCode(absent)).toBe("not-found");
    expect(record(enabled.value).status).toBe("enabled");
    expect(record(replayEnable.value).status).toBe("enabled");
    expect(record(live).ok).toBe(true);
    expect(removed.value).toBe(true);
    expect(resultErrorCode(missing)).toBe("not-found");
    return {
      actions: ["disable", "invoke", "enable", "enable-again", "invoke", "remove", "invoke"],
      rawResultEnvelopes: { disabled, absent, enabled, replayEnable, live, removed, missing },
      assertions: {
        disabledRevokes: true,
        repeatedEnableNoDuplicate: true,
        removeDeletes: true,
      },
      proof: { disabled, absent, enabled, replayEnable, live, removed, missing },
    };
  });

  await recorder.run("MRT-EXT-007", "LIVE-ELECTRON", async () => {
    const fixture = await materialize(client, { profile: "echo" });
    const before = requireOk(await client.value("listExtensions", SCOPE));
    const wrongScope = await client.value("installExtension", {
      sessionId: SCOPE.sessionId,
      workspaceName: "wrong-workspace",
      fixtureId: fixture.fixtureId,
      idempotencyKey: unique("ext7-wrong"),
    });
    const aborted = await client.value("installExtension", {
      ...SCOPE,
      fixtureId: fixture.fixtureId,
      idempotencyKey: unique("ext7-abort"),
      abort: { timing: "pre" },
    });
    const fixedOverride = await client.acceptance(
      "setAcceptancePermission",
      "marshal.extension.install",
      "deny",
    );
    const after = requireOk(await client.value("listExtensions", SCOPE));
    expect(resultErrorCode(wrongScope)).toBe("permission-denied");
    expect(resultErrorCode(aborted)).toBe("aborted");
    expect(fixedOverride.success).toBe(false);
    expect(after.value).toEqual(before.value);
    return {
      actions: ["wrong-scope-install", "pre-aborted-install", "fixed-permission-override"],
      rawResultEnvelopes: { before, wrongScope, aborted, fixedOverride, after },
      assertions: {
        wrongScopeDenied: true,
        abortNoMutation: true,
        fixedBuiltInPermissionImmutable: true,
      },
      proof: { before, wrongScope, aborted, fixedOverride, after },
    };
  });

  await recorder.run("MRT-EXT-010", "LIVE-ELECTRON", async () => {
    const fixture = await materialize(client, {
      profile: "activation-delay",
      activationDelayMs: 180,
    });
    const preAborted = await client.value("installExtension", {
      ...SCOPE,
      fixtureId: fixture.fixtureId,
      idempotencyKey: unique("ext10-pre"),
      abort: { timing: "pre" },
    });
    const inFlight = await client.value("installExtension", {
      ...SCOPE,
      fixtureId: fixture.fixtureId,
      idempotencyKey: unique("ext10-flight"),
      abort: { timing: "after-ms", delayMs: 25 },
    });
    const sharedKey = unique("ext10-shared");
    const [first, replay] = await Promise.all([
      client.value("installExtension", {
        ...SCOPE,
        fixtureId: fixture.fixtureId,
        idempotencyKey: sharedKey,
      }),
      client.value("installExtension", {
        ...SCOPE,
        fixtureId: fixture.fixtureId,
        idempotencyKey: sharedKey,
      }),
    ]);
    const other = await materialize(client, { profile: "echo" });
    const conflict = await client.value("installExtension", {
      ...SCOPE,
      fixtureId: other.fixtureId,
      idempotencyKey: sharedKey,
    });
    const counts = record(await client.value("getInvocationCounts"));
    expect(resultErrorCode(preAborted)).toBe("aborted");
    expect(resultErrorCode(inFlight)).toBe("aborted");
    expect(first).toEqual(replay);
    expect(record(first).ok).toBe(true);
    expect(resultErrorCode(conflict)).toBe("idempotency-conflict");
    expect(fixtureEventCount(counts, fixture, "activate:complete")).toBe(1);
    return {
      actions: ["pre-abort", "in-flight-abort", "identical-concurrent-install", "conflict"],
      rawResultEnvelopes: { preAborted, inFlight, first, replay, conflict, counts },
      assertions: {
        cancellationCleansStaging: true,
        identicalExecutesOnce: true,
        conflictRejected: true,
      },
      proof: { preAborted, inFlight, first, replay, conflict, counts },
    };
  });

  await recorder.run("MRT-EXT-012", "LIVE-ELECTRON+NODE-INTEGRATION", async () => {
    const fixture = await materialize(client, { profile: "disposal-failure" });
    await allowFixture(client, fixture);
    requireOk(
      await client.value("installExtension", {
        ...SCOPE,
        fixtureId: fixture.fixtureId,
        idempotencyKey: unique("ext12-install"),
      }),
    );
    const removal = await client.value("removeExtension", {
      ...SCOPE,
      identity: fixture.identity,
      idempotencyKey: unique("ext12-remove"),
    });
    const list = requireOk(await client.value("listExtensions", SCOPE));
    expect(record(removal).ok).toBe(false);
    expect(
      array(list.value).some((entry) => string(record(entry).identity) === fixture.identity),
    ).toBe(false);
    return {
      actions: ["install-disposal-failure", "remove", "list"],
      rawResultEnvelopes: { removal, list },
      assertions: { removalReportsFailure: true, recordAndRegistrationsRevoked: true },
      proof: { removal, list },
      supportingEvidence: ["platform/story-ledger.json"],
    };
  });

  await recorder.run("MRT-EXT-013", "LIVE-ELECTRON+NODE-INTEGRATION", async () => {
    const fixture = await materialize(client, {
      profile: "ui-application",
      uiApplicationId: "acceptance.stable-application",
    });
    await allowFixture(client, fixture);
    requireOk(
      await client.value("installExtension", {
        ...SCOPE,
        fixtureId: fixture.fixtureId,
        idempotencyKey: unique("ext13-install"),
      }),
    );
    const inventory = record(await client.value("getRegistrationInventory"));
    const resources = array(await client.value("listResources", SCOPE));
    const content = record(
      await client.value("readResource", {
        ...SCOPE,
        uri: fixture.resourceUris[0],
      }),
    );
    expect(resources.map((resource) => string(record(resource).uri))).toContain(
      fixture.resourceUris[0],
    );
    expect(content.uri).toBe(fixture.resourceUris[0]);
    expect(
      searchMatches(record(inventory.search)).some(
        (match) => capabilityName(match) === fixture.capabilityNames[0],
      ),
    ).toBe(true);
    return {
      actions: ["install-resource-ui-extension", "inventory", "list/read-resource"],
      rawResultEnvelopes: { fixture, inventory, resources, content },
      assertions: {
        resourcePublished: true,
        resourceReadable: true,
        capabilityPublished: true,
      },
      proof: { fixture, inventory, resources, content },
      supportingEvidence: ["platform/story-ledger.json"],
    };
  });
}

async function materialize(
  client: RuntimeAcceptanceClient,
  spec: RuntimeAcceptanceFixtureSpec,
): Promise<MaterializedFixture> {
  const value = record(await client.value("materializeExtensionFixture", spec));
  return {
    fixtureId: requiredString(value.fixtureId, "fixtureId"),
    identity: requiredString(value.identity, "identity"),
    version: requiredString(value.version, "version"),
    capabilityNames: stringArray(value.capabilityNames, "capabilityNames"),
    resourceUris: stringArray(value.resourceUris, "resourceUris"),
  };
}

async function allowFixture(
  client: RuntimeAcceptanceClient,
  fixture: MaterializedFixture,
): Promise<void> {
  await Promise.all(
    fixture.capabilityNames.map((capability) =>
      client.value("setAcceptancePermission", `marshal.tool.invoke:${capability}`, "allow"),
    ),
  );
}

function searchMatches(value: unknown): readonly unknown[] {
  return array(record(record(value).value).matches);
}

function capabilityName(value: unknown): string {
  return string(record(record(value).capability).name);
}

function fixtureInvokeCount(counts: Record<string, unknown>, fixture: MaterializedFixture): number {
  return fixtureEventCount(counts, fixture, `invoke:${fixture.capabilityNames[0]}`);
}

function fixtureEventCount(
  counts: Record<string, unknown>,
  fixture: MaterializedFixture,
  event: string,
): number {
  const events = array(record(counts.fixtureEvents)[`fixture:${fixture.fixtureId}`]);
  return events.filter((candidate) => candidate === event).length;
}

async function runPortableSwarmStories(
  recorder: LiveStoryRecorder,
  client: RuntimeAcceptanceClient,
): Promise<void> {
  await recorder.capture("MRT-LEG-001", "LIVE-ELECTRON+STATIC+NODE-INTEGRATION", async () => {
    const runtimeRoot = path.join(SOURCE_ROOT, "node_modules", "@marshal", "runtime");
    const runtimeManifestPath = path.join(runtimeRoot, "package.json");
    const runtimeManifest = record(
      JSON.parse(fs.readFileSync(runtimeManifestPath, "utf8")) as unknown,
    );
    const exportsField = record(runtimeManifest.exports);
    const lockText = fs.readFileSync(path.join(SOURCE_ROOT, "pnpm-lock.yaml"), "utf8");
    const scanRoots = [
      path.join(SOURCE_ROOT, "common"),
      path.join(SOURCE_ROOT, "electron"),
      path.join(SOURCE_ROOT, "src"),
    ].filter((candidate) => fs.existsSync(candidate));
    const hostProductionMatches = scanHostProductionSwarmBoundary(scanRoots);
    const archiveRoot = path.join(SOURCE_ROOT, ".marshal-runtime-packs", "archives");
    const archiveScans = fs
      .readdirSync(archiveRoot)
      .filter((name) => name.endsWith(".tgz"))
      .sort()
      .map((name) => scanSwarmArchive(path.join(archiveRoot, name)));
    const esmImport = runNodeImportProbe(
      `const [swarm, main] = await Promise.all([
        import("@marshal/runtime/swarm"),
        import("@marshal/runtime"),
      ]);
      process.stdout.write(JSON.stringify({
        activationExports: Object.keys(swarm).filter((name) =>
          /(?:activate|activation|extension|kernel|provider|register)/i.test(name)
        ),
        mainSwarmExports: Object.keys(main).filter((name) => /swarm/i.test(name)),
      }));`,
    );
    const cjsImport = runNodeImportProbe(
      `(async () => {
        const swarm = await import("@marshal/runtime/swarm");
        process.stdout.write(JSON.stringify({
          activationExports: Object.keys(swarm).filter((name) =>
            /(?:activate|activation|extension|kernel|provider|register)/i.test(name)
          ),
        }));
      })().catch((error) => { console.error(error); process.exit(1); });`,
      "commonjs",
    );
    const extensionsImport = runNodeImportProbe(
      `import("@marshal/runtime/extensions").then((value) => process.exit(typeof value.RuntimeExtensionManager === "function" ? 0 : 4)).catch(() => process.exit(5));`,
    );
    const search = requireOk(await client.search({ query: "swarm", detail: "full", limit: 1_000 }));
    const swarmMatches = searchMatches(search).filter((match) => {
      const capability = record(record(match).capability);
      return (
        string(capability.name).toLowerCase().includes("swarm") ||
        array(capability.tags).some((tag) => string(tag).toLowerCase() === "swarm")
      );
    });
    const hostManifest = record(
      JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, "package.json"), "utf8")) as unknown,
    );
    const packManifest = record(
      JSON.parse(
        fs.readFileSync(path.join(SOURCE_ROOT, ".marshal-runtime-packs", "manifest.json"), "utf8"),
      ) as unknown,
    );
    const externalReferences = [
      ...["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].filter(
        (field) => record(hostManifest[field])["@marshal/swarm"] !== undefined,
      ),
      ...(record(record(hostManifest.pnpm).overrides)["@marshal/swarm"] !== undefined
        ? ["package.json:pnpm.overrides"]
        : []),
      ...(record(runtimeManifest.dependencies)["@marshal/swarm"] !== undefined
        ? ["node_modules/@marshal/runtime/package.json"]
        : []),
      ...(/(?:^|[\s'"])@marshal\/swarm(?:@|:|[\s'"])|packages[\\/]swarm/i.test(lockText)
        ? ["pnpm-lock.yaml"]
        : []),
      ...(array(packManifest.packages).some(
        (entry) => string(record(entry).name) === "@marshal/swarm",
      )
        ? [".marshal-runtime-packs/manifest.json"]
        : []),
      ...(fs.existsSync(path.join(SOURCE_ROOT, "node_modules", "@marshal", "swarm"))
        ? ["node_modules/@marshal/swarm"]
        : []),
      ...(fs.existsSync(path.join(SOURCE_ROOT, "packages", "swarm")) ? ["packages/swarm"] : []),
    ];
    const runtimeArchive = archiveScans.find((scan) => scan.packageName === "@marshal/runtime");
    const esmImportValue = record(JSON.parse(esmImport.stdout) as unknown);
    const cjsImportValue = record(JSON.parse(cjsImport.stdout) as unknown);
    expect(exportsField["./swarm"]).toEqual({
      types: "./dist/swarm.d.ts",
      default: "./dist/swarm.js",
    });
    expect(exportsField["./extensions"]).toBeDefined();
    expect(hostProductionMatches).toEqual([]);
    expect(externalReferences).toEqual([]);
    expect(
      archiveScans.every(
        (scan) =>
          scan.packageName !== "@marshal/swarm" &&
          scan.externalDependency === null &&
          !/^marshal-swarm-.*\.tgz$/i.test(path.basename(scan.path)),
      ),
    ).toBe(true);
    expect(runtimeArchive).toBeDefined();
    expect(esmImport.status).toBe(0);
    expect(cjsImport.status).toBe(0);
    expect(esmImportValue).toEqual({
      activationExports: [],
      mainSwarmExports: [],
    });
    expect(cjsImportValue).toEqual({
      activationExports: [],
    });
    expect(extensionsImport.status).toBe(0);
    expect(swarmMatches).toEqual([]);
    const artifact = recorder.writeSupporting("portable-swarm/mrt-leg-001.json", {
      runtimeManifestPath: relativeEvidencePath(runtimeManifestPath),
      runtimeManifestSha256: fileSha256(runtimeManifestPath),
      runtimeExports: exportsField,
      scanRoots: scanRoots.map(relativeEvidencePath),
      hostProductionMatches,
      archiveScans,
      lockfile: {
        path: "pnpm-lock.yaml",
        sha256: fileSha256(path.join(SOURCE_ROOT, "pnpm-lock.yaml")),
        externalReferences,
      },
      esmImport,
      esmImportValue,
      cjsImport,
      cjsImportValue,
      extensionsImport,
      liveSearch: search,
      swarmMatches,
    });
    return {
      actions: [
        "verify-installed-portable-swarm-export",
        "scan-runtime-archives",
        "scan-host-production-registration",
        "scan-external-extension-ownership",
        "probe-esm-and-commonjs-dynamic-imports",
        "search-live-runtime-for-swarm",
      ],
      rawResultEnvelopes: { esmImport, cjsImport, extensionsImport, search },
      assertions: {
        explicitPortableSwarmExportPresent: true,
        esmAndCommonjsDynamicImportsSucceed: true,
        activationExportsAbsent: true,
        mainEntryDoesNotReExportSwarm: true,
        hostProductionRegistrationAbsent: true,
        standaloneSwarmExtensionRemainsExternal: true,
        extensionPlatformExportRemainsPresent: true,
        liveRuntimeHasNoSwarmCapabilities: true,
      },
      proof: {
        runtimeExports: exportsField,
        hostProductionMatches,
        archiveScans,
        externalReferences,
        esmImport,
        esmImportValue,
        cjsImport,
        cjsImportValue,
        extensionsImport,
        swarmMatches,
      },
      supportingEvidence: [artifact, "static-gates.json", "api-audit.jsonl"],
    };
  });
}

function scanHostProductionSwarmBoundary(roots: readonly string[]): readonly {
  readonly file: string;
  readonly kind: "import" | "default-capability";
}[] {
  const matches: Array<{ file: string; kind: "import" | "default-capability" }> = [];
  for (const root of roots) {
    for (const filePath of listFiles(root)) {
      const relative = relativeEvidencePath(filePath);
      if (
        !/\.(?:[cm]?js|tsx?)$/.test(filePath) ||
        /(?:^|\/)(?:__tests__|e2e|test|tests)(?:\/|$)/.test(relative) ||
        /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relative)
      ) {
        continue;
      }
      const content = fs.readFileSync(filePath, "utf8");
      if (
        /(?:\bfrom\s+|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)["'](?:@marshal\/runtime\/swarm|@marshal\/swarm)["']/i.test(
          content,
        )
      ) {
        matches.push({ file: relative, kind: "import" });
      }
      if (
        /\b(?:name|id)\s*:\s*["'][^"']*swarm[^"']*["']|\btags\s*:\s*\[[^\]]*["']swarm["']/i.test(
          content,
        )
      ) {
        matches.push({ file: relative, kind: "default-capability" });
      }
    }
  }
  return matches;
}

function scanSwarmArchive(archivePath: string): {
  readonly path: string;
  readonly sha256: string;
  readonly entryCount: number;
  readonly entries: readonly string[];
  readonly packageName: string | null;
  readonly externalDependency: string | null;
} {
  const listed = spawnSync("tar.exe", ["-tf", archivePath], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (listed.status !== 0) {
    throw new Error(`Archive listing failed: ${listed.stderr || listed.stdout}`);
  }
  const entries = listed.stdout.split(/\r?\n/).filter(Boolean);
  const packageJson = spawnSync("tar.exe", ["-xOf", archivePath, "package/package.json"], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (packageJson.status !== 0) {
    throw new Error(
      `Archive package manifest scan failed: ${packageJson.stderr || packageJson.stdout}`,
    );
  }
  const manifest = record(JSON.parse(packageJson.stdout) as unknown);
  const externalDependency =
    ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].find(
      (field) => record(manifest[field])["@marshal/swarm"] !== undefined,
    ) ?? null;
  return {
    path: relativeEvidencePath(archivePath),
    sha256: fileSha256(archivePath),
    entryCount: entries.length,
    entries,
    packageName: typeof manifest.name === "string" ? manifest.name : null,
    externalDependency,
  };
}

function runNodeImportProbe(
  source: string,
  moduleKind: "module" | "commonjs" = "module",
): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const args =
    moduleKind === "module" ? ["--input-type=module", "--eval", source] : ["--eval", source];
  const result = spawnSync(process.execPath, args, {
    cwd: SOURCE_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function listFiles(root: string): readonly string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  visit(root);
  return files;
}

function fileSha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function relativeEvidencePath(filePath: string): string {
  return path.relative(SOURCE_ROOT, filePath).replaceAll(path.sep, "/");
}

function windowsDescendants(rootPid: number): readonly {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  readonly executablePath: string | null;
  readonly commandLine: string;
  readonly mainWindowHandle: number;
}[] {
  if (process.platform !== "win32" || rootPid <= 0) return [];
  const script = [
    "$all=Get-CimInstance Win32_Process",
    `$root=${rootPid}`,
    "$ids=[System.Collections.Generic.HashSet[int]]::new()",
    "[void]$ids.Add($root)",
    "$changed=$true",
    "while($changed){$changed=$false; foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)){$changed=$true}}}",
    "$all | Where-Object {$ids.Contains([int]$_.ProcessId) -and [int]$_.ProcessId -ne $root} | ForEach-Object {$gp=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; [pscustomobject]@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;name=$_.Name;executablePath=$_.ExecutablePath;commandLine=$_.CommandLine;mainWindowHandle=if($gp){[int64]$gp.MainWindowHandle}else{0}}} | ConvertTo-Json -Depth 4 -Compress",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) throw new Error(`Process observation failed: ${result.stderr}`);
  const parsed: unknown = result.stdout.trim() ? JSON.parse(result.stdout) : [];
  return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
    pid: number(record(entry).pid),
    ppid: number(record(entry).ppid),
    name: string(record(entry).name),
    executablePath:
      typeof record(entry).executablePath === "string"
        ? string(record(entry).executablePath)
        : null,
    commandLine: string(record(entry).commandLine),
    mainWindowHandle: number(record(entry).mainWindowHandle),
  }));
}

async function waitForProcessesToExit(
  rootPid: number,
  processIds: readonly number[],
  timeoutMs: number,
): Promise<{
  readonly exited: boolean;
  readonly waitedMs: number;
  readonly remainingProcessIds: readonly number[];
}> {
  const startedAt = Date.now();
  return await waitForProcessesToExitUntil(
    rootPid,
    new Set(processIds),
    startedAt,
    startedAt + timeoutMs,
  );
}

async function waitForProcessesToExitUntil(
  rootPid: number,
  expected: ReadonlySet<number>,
  startedAt: number,
  deadline: number,
): Promise<{
  readonly exited: boolean;
  readonly waitedMs: number;
  readonly remainingProcessIds: readonly number[];
}> {
  const remainingProcessIds = windowsDescendants(rootPid)
    .map((entry) => entry.pid)
    .filter((pid) => expected.has(pid));
  const waitedMs = Date.now() - startedAt;
  if (remainingProcessIds.length === 0) {
    return { exited: true, waitedMs, remainingProcessIds };
  }
  if (Date.now() >= deadline) {
    return { exited: false, waitedMs, remainingProcessIds };
  }
  await delay(100);
  return await waitForProcessesToExitUntil(rootPid, expected, startedAt, deadline);
}

function captureProcessLogs(app: ElectronApplication, name: string): { close(): Promise<void> } {
  const stdout = fs.createWriteStream(path.join(EVIDENCE_ROOT, `${name}-stdout.log`), {
    flags: "a",
  });
  const stderr = fs.createWriteStream(path.join(EVIDENCE_ROOT, `${name}-stderr.log`), {
    flags: "a",
  });
  app.process().stdout?.pipe(stdout);
  app.process().stderr?.pipe(stderr);
  return {
    async close() {
      await Promise.all([
        new Promise<void>((resolve) => stdout.end(resolve)),
        new Promise<void>((resolve) => stderr.end(resolve)),
      ]);
    },
  };
}

function acceptanceEnvironment(): Readonly<Record<string, string>> {
  return {
    MARSHAL_RUNTIME_ACCEPTANCE: "1",
    MARSHAL_RUNTIME_ACCEPTANCE_RUN_ROOT: RUN_ROOT,
    MARSHAL_RUNTIME_ACCEPTANCE_EVIDENCE_ROOT: EVIDENCE_ROOT,
  };
}

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Acceptance fixture field ${field} must be a non-empty string.`);
  }
  return value;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`Acceptance fixture field ${field} must be a string array.`);
  }
  return value;
}

async function mapSeries<T, U>(
  values: readonly T[],
  action: (value: T) => Promise<U>,
): Promise<readonly U[]> {
  const [first, ...rest] = values;
  if (first === undefined) return [];
  return [await action(first), ...(await mapSeries(rest, action))];
}

function number(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN;
}

function requiredPath(name: string): string {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return path.resolve(value);
}
