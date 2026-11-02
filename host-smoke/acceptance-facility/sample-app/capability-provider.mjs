import {
  SAMPLE_APP_CAPABILITY_NAME,
  SAMPLE_APP_DECLARED_PERMISSION,
  SAMPLE_APP_IDENTITY,
  SAMPLE_APP_VERSION,
} from "./manifest.mjs";

const PAGE_SIZE = 3;
const TOTAL_ITEMS = 9;

function descriptor() {
  return {
    protocolVersion: "1.0",
    name: SAMPLE_APP_CAPABILITY_NAME,
    version: SAMPLE_APP_VERSION,
    title: "Read paginated sample items",
    description: "Returns one page of sample items; used to demonstrate a real read capability.",
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["items", "page", "hasMore"],
      properties: {
        items: { type: "array", items: { type: "string" } },
        page: { type: "number" },
        hasMore: { type: "boolean" },
      },
    },
    permissions: [
      { permission: SAMPLE_APP_DECLARED_PERMISSION, reason: "Read sample provider data." },
    ],
  };
}

/** @returns {import("@marshal/agent-runtime-core").CapabilityProvider} */
export function createSampleAppCapabilityProvider() {
  return {
    id: SAMPLE_APP_IDENTITY,
    version: SAMPLE_APP_VERSION,
    list() {
      return [descriptor()];
    },
    get(name) {
      return name === SAMPLE_APP_CAPABILITY_NAME ? descriptor() : undefined;
    },
    invoke(name, input) {
      if (name !== SAMPLE_APP_CAPABILITY_NAME) {
        throw Object.assign(new Error(`Unknown sample-app capability: ${name}`), {
          code: "not_found",
        });
      }
      const page = Math.max(1, Number(input && input.page) || 1);
      if (input && input.forceError) {
        throw Object.assign(new Error("Deliberate acceptance-facility provider failure."), {
          code: "sample_provider_failure",
        });
      }
      const start = (page - 1) * PAGE_SIZE;
      const items = [];
      for (let index = start; index < Math.min(start + PAGE_SIZE, TOTAL_ITEMS); index += 1) {
        items.push(`row ${index + 1} (page ${page})`);
      }
      return { output: { items, page, hasMore: start + PAGE_SIZE < TOTAL_ITEMS } };
    },
  };
}
