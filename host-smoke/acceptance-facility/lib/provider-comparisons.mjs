// D4, point (e): provider acceptance receipt helpers
// (AUDIT-VERDICT-AND-ACCEPTANCE.md "Testing capability gaps", point 5).
// Pure comparison functions only — no network, no provider SDK. Scripts in
// ../scripts/provider-acceptance-receipts.mjs feed these real receipt JSON
// (fetched by the parent/live authorization) or this repo's example
// fixtures; either way the comparison logic itself is exercised the same
// way and is independently unit-tested (evidence class "unit").

/**
 * Verifies a connected-account list actually contains the expected work
 * login/organization instead of merely a personal login with the same name
 * (AUDIT-ACCOUNTS.md's exact finding: "acme" was a hardcoded label, not
 * credential-provenance evidence).
 */
export function verifyAccountScope(accountsList, expected) {
  const accounts = Array.isArray(accountsList?.accounts) ? accountsList.accounts : [];
  const match = accounts.find(
    (account) =>
      account.login === expected.login &&
      (!expected.organization || account.organization === expected.organization),
  );
  return {
    verified: Boolean(match),
    expected,
    matchedAccount: match ? { login: match.login, organization: match.organization ?? null } : null,
    candidateLogins: accounts.map((account) => account.login),
  };
}

// F-005b (Defect 2): comparing only array.length per field let wrong file paths/patches, unrelated thread
// ids/bodies, and opposite check conclusions all pass whenever the counts happened to agree. Each field now
// has an identity key and a normalized content value; a field "matches" only when both documents name the
// exact same set of keys AND every key's normalized content is equal. Any item missing a required field
// forces that field to REJECT, regardless of count agreement — count agreement alone can never pass.
const REQUIRED_ITEM_FIELDS = {
  files: ["path", "patch"],
  threads: ["id", "body"],
  checks: ["name", "conclusion"],
  iterations: ["id"],
};

const FIELD_KEY = {
  files: (item) => item?.path,
  threads: (item) => item?.id,
  checks: (item) => item?.name,
  iterations: (item) => item?.id,
};

const FIELD_VALUE = {
  files: (item) => ({ patch: normalizeText(item?.patch) }),
  threads: (item) => ({
    anchor: normalizeText(item?.anchor ?? null),
    body: normalizeText(item?.body),
  }),
  checks: (item) => ({ conclusion: normalizeText(item?.conclusion) }),
  iterations: (item) => ({ id: item?.id }),
};

function normalizeText(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : value;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => deepEqual(value, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length || aKeys.some((key, index) => key !== bKeys[index]))
      return false;
    return aKeys.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

function hasRequiredFields(field, item) {
  return REQUIRED_ITEM_FIELDS[field].every((requiredField) => {
    const value = item?.[requiredField];
    return typeof value === "string"
      ? value.trim().length > 0
      : value !== undefined && value !== null;
  });
}

function compareField(field, localItems, providerItems) {
  const localCount = localItems.length;
  const providerCount = providerItems.length;
  const missingRequiredFields = [...localItems, ...providerItems].some(
    (item) => !hasRequiredFields(field, item),
  );
  if (missingRequiredFields) {
    return { localCount, providerCount, missingRequiredFields: true, matches: false };
  }
  const keyOf = FIELD_KEY[field];
  const valueOf = FIELD_VALUE[field];
  const localByKey = new Map(localItems.map((item) => [keyOf(item), valueOf(item)]));
  const providerByKey = new Map(providerItems.map((item) => [keyOf(item), valueOf(item)]));
  const sameKeys =
    localByKey.size === localItems.length &&
    providerByKey.size === providerItems.length &&
    localByKey.size === providerByKey.size &&
    [...localByKey.keys()].every((key) => providerByKey.has(key));
  const mismatchedKeys = sameKeys
    ? [...localByKey.entries()]
        .filter(([key, value]) => !deepEqual(value, providerByKey.get(key)))
        .map(([key]) => key)
    : [];
  return {
    localCount,
    providerCount,
    missingRequiredFields: false,
    matches: sameKeys && mismatchedKeys.length === 0,
    ...(sameKeys ? {} : { keysMismatch: true }),
    ...(mismatchedKeys.length > 0 ? { mismatchedKeys } : {}),
  };
}

/**
 * Compares a locally-loaded PR detail (what the product rendered) against an
 * independently-fetched provider PR detail for the same owner/repo/number,
 * field by field. Neither document is fetched here — callers supply both.
 */
export function compareKnownPr(localPrDetail, providerPrDetail, expected) {
  const identityMatches =
    localPrDetail?.owner === expected.owner &&
    localPrDetail?.repo === expected.repo &&
    localPrDetail?.number === expected.number &&
    providerPrDetail?.owner === expected.owner &&
    providerPrDetail?.repo === expected.repo &&
    providerPrDetail?.number === expected.number;
  const headShaMatches =
    typeof localPrDetail?.headSha === "string" &&
    localPrDetail.headSha.trim().length > 0 &&
    localPrDetail.headSha === providerPrDetail?.headSha;
  const fields = ["files", "threads", "checks", "iterations"];
  const fieldComparisons = Object.fromEntries(
    fields.map((field) => [
      field,
      compareField(
        field,
        Array.isArray(localPrDetail?.[field]) ? localPrDetail[field] : [],
        Array.isArray(providerPrDetail?.[field]) ? providerPrDetail[field] : [],
      ),
    ]),
  );
  return {
    identityMatches,
    headShaMatches,
    fieldComparisons,
    allFieldsMatch:
      identityMatches &&
      headShaMatches &&
      Object.values(fieldComparisons).every((entry) => entry.matches),
  };
}

/**
 * Verifies an authorized write actually changed remote bytes — never trust a
 * mock commit SHA (AUDIT-VERDICT-AND-ACCEPTANCE.md: "A mock returns a commit
 * SHA, so the test passes without proving changed file bytes").
 */
export function verifyAuthorizedWrite(beforeContent, afterContent, expected) {
  const changedFiles = Object.keys(expected.expectedChangedFiles ?? {}).map((path) => {
    const before = beforeContent?.[path];
    const after = afterContent?.[path];
    const expectedAfter = expected.expectedChangedFiles[path];
    return {
      path,
      changed: before !== after,
      matchesExpectedContent: after === expectedAfter,
    };
  });
  return {
    commitShaChanged: beforeContent?.commitSha !== afterContent?.commitSha,
    changedFiles,
    verified:
      beforeContent?.commitSha !== afterContent?.commitSha &&
      changedFiles.length > 0 &&
      changedFiles.every((entry) => entry.changed && entry.matchesExpectedContent),
  };
}
