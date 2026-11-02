import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findInvokeTargetResourceUri,
  verifyInvokeResult,
  verifyLiveInvokeRequest,
} from "./capability-invoke-verification.mjs";

const VALID_REQUEST = Object.freeze({
  workspaceName: "workspace-1",
  extensionId: "publisher/sample-extension",
  applicationId: "sample-app",
  instanceId: "instance-1",
  capability: "acceptance-sample.read",
  idempotencyKey: "idem-1",
  publicationRevisionId: "revision-1",
});

void test("verifyLiveInvokeRequest rejects a missing request", () => {
  assert.equal(verifyLiveInvokeRequest(undefined).ok, false);
  assert.equal(verifyLiveInvokeRequest(null).ok, false);
});

// F-005 (d): missing target/identity must fail.
void test("verifyLiveInvokeRequest fails and names every missing target identity field", () => {
  const result = verifyLiveInvokeRequest({ capability: "acceptance-sample.read" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /workspaceName/);
  assert.match(result.reason, /extensionId/);
  assert.match(result.reason, /applicationId/);
  assert.match(result.reason, /instanceId/);
  assert.match(result.reason, /idempotencyKey/);
});

void test("verifyLiveInvokeRequest passes a fully-specified request with no limits", () => {
  const result = verifyLiveInvokeRequest(VALID_REQUEST);
  assert.equal(result.ok, true);
  assert.deepEqual(result.limits, []);
});

// F-005 (b): publicationRevisionId is now part of the documented/validated shape.
void test("verifyLiveInvokeRequest passes but warns when publicationRevisionId is absent", () => {
  const { publicationRevisionId: _drop, ...withoutRevision } = VALID_REQUEST;
  const result = verifyLiveInvokeRequest(withoutRevision);
  assert.equal(result.ok, true);
  assert.equal(result.limits.length, 1);
  assert.match(result.limits[0], /publicationRevisionId/);
  assert.match(result.limits[0], /stale/);
});

void test("verifyInvokeResult fails on an unsuccessful envelope", () => {
  const result = verifyInvokeResult({ success: false, error: { message: "permission-denied" } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "permission-denied");
});

void test("verifyInvokeResult fails on a missing envelope without throwing", () => {
  assert.equal(verifyInvokeResult(undefined).ok, false);
});

void test("verifyInvokeResult passes on a successful envelope", () => {
  assert.equal(verifyInvokeResult({ success: true, value: {} }).ok, true);
});

void test("findInvokeTargetResourceUri finds the matching instance's resource uri", () => {
  const instances = [
    {
      instanceId: VALID_REQUEST.instanceId,
      owner: { extensionId: VALID_REQUEST.extensionId, applicationId: VALID_REQUEST.applicationId },
      content: { kind: "application", resource: { uri: "app://sample/index.html" } },
    },
  ];
  assert.equal(findInvokeTargetResourceUri(instances, VALID_REQUEST), "app://sample/index.html");
});

void test("findInvokeTargetResourceUri returns undefined when no instance matches", () => {
  assert.equal(findInvokeTargetResourceUri([], VALID_REQUEST), undefined);
  assert.equal(findInvokeTargetResourceUri(undefined, VALID_REQUEST), undefined);
});

void test("findInvokeTargetResourceUri ignores a non-application content instance", () => {
  const instances = [
    {
      instanceId: VALID_REQUEST.instanceId,
      owner: { extensionId: VALID_REQUEST.extensionId, applicationId: VALID_REQUEST.applicationId },
      content: { kind: "text", text: "not an application" },
    },
  ];
  assert.equal(findInvokeTargetResourceUri(instances, VALID_REQUEST), undefined);
});
