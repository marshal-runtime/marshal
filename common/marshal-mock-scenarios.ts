// Mock conversation scenarios for dev testing.
// Shared between renderer (copilotService mock mode) and main process (mock-session.ts).
// Events use the runtime-neutral adapter shape consumed by TurnAccumulator.

import type { PermissionKind } from "./marshal-ipc-contract";
import { buildSlotReplyScenario } from "./marshal-mock-slot-reply";
import type {
  RuntimeSessionEvent,
  RuntimeSessionEventDataMap,
  RuntimeSessionEventType,
} from "./runtime-events";

// ---------------------------------------------------------------------------
// MockStep — discriminated union for scenario steps
// ---------------------------------------------------------------------------
// Existing scenarios use `{ delay, event }` which maps to MockEventStep.
// New step types trigger SDK hooks (permission requests, pre/post tool use)
// so the mock session can exercise the real permission pipeline.

/** Regular SDK event to emit through session event handlers. */
interface MockEventStep {
  type: "event";
  delay: number;
  event: RuntimeSessionEvent;
}

/** Trigger the session's onPermissionRequest hook. */
interface MockPermissionStep {
  type: "permission-request";
  delay: number;
  permissionRequest: {
    kind: PermissionKind;
    toolCallId?: string;
    toolName?: string;
    command?: string;
    fullCommandText?: string;
    [key: string]: unknown;
  };
}

/** Trigger the session's onPreToolUse hook. */
interface MockPreToolUseStep {
  type: "pre-tool-use";
  delay: number;
  toolCall: {
    toolCallId: string;
    toolName: string;
    toolArgs?: unknown;
    serverName?: string;
  };
}

/** Trigger the session's onPostToolUse hook. */
interface MockPostToolUseStep {
  type: "post-tool-use";
  delay: number;
  toolCall: {
    toolCallId: string;
    toolName: string;
    toolResult?: unknown;
    serverName?: string;
  };
}

export type MockStep =
  | MockEventStep
  | MockPermissionStep
  | MockPreToolUseStep
  | MockPostToolUseStep;

/** Create a mock runtime event with required base fields filled in. */
export function mockEvent<T extends RuntimeSessionEventType>(
  type: T,
  data: RuntimeSessionEventDataMap[T],
): RuntimeSessionEvent {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- generic event-map construction preserves the type/data correlation
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    parentId: null,
    type,
    data,
  } as RuntimeSessionEvent;
}

// Helper: build a complete response cycle (tool call + streaming deltas + final message + idle)
function buildResponseFixture(
  deltas: string[],
  opts?: {
    toolCallId?: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    initialDelay?: number;
    /** Reasoning chunks emitted as assistant.reasoning_delta before tool/message events */
    reasoningDeltas?: string[];
  },
): MockEventStep[] {
  const steps: MockEventStep[] = [];
  if (opts?.reasoningDeltas) {
    for (const text of opts.reasoningDeltas) {
      steps.push({
        type: "event",
        delay: 80 + Math.floor(Math.random() * 60),
        event: mockEvent("assistant.reasoning_delta", {
          reasoningId: "r-mock",
          deltaContent: text,
        }),
      });
    }
  }
  if (opts?.toolCallId) {
    steps.push({
      type: "event",
      delay: opts.initialDelay ?? 300,
      event: mockEvent("tool.execution_start", {
        toolCallId: opts.toolCallId,
        toolName: opts.toolName || "grep",
        mcpToolName: opts.toolName || "grep",
        arguments: opts.toolArgs || {},
      }),
    });
    steps.push({
      type: "event",
      delay: 800,
      event: mockEvent("tool.execution_complete", { toolCallId: opts.toolCallId, success: true }),
    });
  }
  for (const text of deltas) {
    steps.push({
      type: "event",
      delay: 120 + Math.floor(Math.random() * 100),
      event: mockEvent("assistant.message_delta", { messageId: "m-mock", deltaContent: text }),
    });
  }
  steps.push({
    type: "event",
    delay: 200,
    event: mockEvent("assistant.message", { messageId: "m-mock", content: deltas.join("") }),
  });
  steps.push({ type: "event", delay: 100, event: mockEvent("session.idle", {}) });
  return steps;
}

// --- Response text chunks ---

// Response 1: short intro with a tool call
const RESPONSE_1_DELTAS = [
  "Sure, let me look into the authentication system for you.\n\n",
  "I'll start by searching the codebase for relevant files and patterns.\n\n",
  "Give me a moment while I scan through the project structure.",
];

// Response 2: long detailed analysis (auto-fired after response 1)
const RESPONSE_2_DELTAS = [
  "# Authentication Analysis\n\n",
  "After scanning the codebase, here's a comprehensive summary of the authentication system.\n\n",
  "## Overview\n\n",
  "The app uses a token-based authentication flow with automatic refresh. ",
  "When a user signs in, the server issues both an access token (short-lived) and a refresh token (long-lived). ",
  "The access token is stored in memory while the refresh token is persisted to secure storage.\n\n",
  "## Token Lifecycle\n\n",
  "1. **Initial Login** — User authenticates via OAuth device flow\n",
  "2. **Token Storage** — Access token kept in memory, refresh token in keychain\n",
  "3. **Auto-Refresh** — When access token expires, refresh token is used to get a new one\n",
  "4. **Expiry Handling** — If refresh token expires, user is prompted to re-authenticate\n\n",
  "## Security Considerations\n\n",
  "The current implementation follows security best practices:\n\n",
  "- Access tokens expire after 1 hour\n",
  "- Refresh tokens expire after 30 days\n",
  "- Tokens are never stored in localStorage or cookies\n",
  "- All API calls use HTTPS with certificate pinning\n",
  "- Failed auth attempts are rate-limited server-side\n\n",
  "## Code Locations\n\n",
  "- `src/auth/provider.ts` — Main auth provider with login/logout methods\n",
  "- `src/auth/token-store.ts` — Secure token persistence layer\n",
  "- `src/auth/refresh.ts` — Background token refresh logic\n",
  "- `src/middleware/auth.ts` — Express middleware for route protection\n",
  "- `src/hooks/useAuth.ts` — React hook exposing auth state\n\n",
  "## Implementation Details\n\n",
  "### Token Storage Layer\n\n",
  "The `TokenStore` class uses the OS keychain via `keytar` for secure persistence. ",
  "On macOS this maps to Keychain Access, on Windows to Credential Manager, and on Linux to libsecret. ",
  "The store implements a simple get/set/delete interface with namespace isolation per environment.\n\n",
  "### Refresh Flow\n\n",
  "The refresh mechanism runs on a background interval (every 5 minutes) and also triggers reactively ",
  "when an API call receives a 401 response. The flow is:\n\n",
  "1. Check if access token expires within the next 10 minutes\n",
  "2. If yes, call the `/oauth/token` endpoint with the refresh token\n",
  "3. Store the new access token in memory and new refresh token in keychain\n",
  "4. If refresh fails with 401, emit an `auth:expired` event to trigger re-login\n\n",
  "### Middleware Stack\n\n",
  "The Express middleware chain processes requests in this order:\n\n",
  "1. `extractToken` — pulls Bearer token from Authorization header\n",
  "2. `validateToken` — verifies JWT signature and expiration\n",
  "3. `loadUser` — fetches user profile from the token claims\n",
  "4. `checkPermissions` — validates role-based access for the endpoint\n\n",
  "## Recommendations\n\n",
  "Based on the analysis, I'd suggest a few improvements:\n\n",
  "1. **Add PKCE flow** for the OAuth authorization step\n",
  "2. **Implement token rotation** so each refresh issues a new refresh token\n",
  "3. **Add session binding** to tie tokens to the originating device\n",
  "4. **Audit logging** for all authentication events\n\n",
  "Would you like me to implement any of these changes?",
];

// Response 3: follow-up on user's next message
const RESPONSE_3_DELTAS = [
  "Great question! Let me dig deeper into that specific area.\n\n",
  "Looking at the token rotation implementation, ",
  "the current approach stores a single long-lived refresh token. ",
  "With rotation, each time the refresh token is used, a new one is issued and the old one is invalidated.\n\n",
  "Here's what the implementation would look like:\n\n",
  "```typescript\n",
  "async function rotateRefreshToken(currentToken: string): Promise<TokenPair> {\n",
  "  const response = await fetch('/oauth/token', {\n",
  "    method: 'POST',\n",
  "    body: JSON.stringify({\n",
  "      grant_type: 'refresh_token',\n",
  "      refresh_token: currentToken,\n",
  "      rotate: true,\n",
  "    }),\n",
  "  });\n",
  "  const { access_token, refresh_token } = await response.json();\n",
  "  await tokenStore.set('refresh', refresh_token);\n",
  "  return { accessToken: access_token, refreshToken: refresh_token };\n",
  "}\n",
  "```\n\n",
  "The key benefit is that if a refresh token is ever stolen, ",
  "it becomes useless after the legitimate client uses it once. ",
  "This significantly reduces the window of vulnerability.\n\n",
  "I can create a PR with this change if you'd like. ",
  "It would touch `src/auth/refresh.ts` and `src/auth/token-store.ts`.",
];

// --- Reasoning chunks ---

const REASONING_1 = [
  "The user is asking about the **authentication system**. ",
  "I should start by searching for relevant files — ",
  "likely under `src/auth/` or similar directories.\n\n",
  "Let me use grep to find authentication-related patterns ",
  "before giving a comprehensive overview.",
];

const REASONING_2 = [
  "Now I have the search results. Let me analyze the key files:\n\n",
  "1. `src/auth/provider.ts` — this looks like the main entry point\n",
  "2. `src/auth/token-store.ts` — handles persistence\n",
  "3. `src/auth/refresh.ts` — background refresh logic\n\n",
  "I should provide a structured overview covering the token lifecycle, ",
  "security considerations, and potential improvements.",
];

// --- Assembled scenarios ---

// Scenario 1 (first user send): short response → pause → long auto-follow-up
const MOCK_SCENARIO_1: MockEventStep[] = [
  ...buildResponseFixture(RESPONSE_1_DELTAS, {
    toolCallId: "mock-t1",
    toolName: "grep",
    toolArgs: { pattern: "authentication" },
    reasoningDeltas: REASONING_1,
  }),
  // After a pause, auto-fire the longer second response
  ...buildResponseFixture(RESPONSE_2_DELTAS, {
    toolCallId: "mock-t2",
    toolName: "view",
    toolArgs: { path: "src/auth/provider.ts" },
    initialDelay: 1500,
    reasoningDeltas: REASONING_2,
  }),
];

// Scenario 2+ (subsequent user sends): medium follow-up
const MOCK_SCENARIO_2: MockEventStep[] = buildResponseFixture(RESPONSE_3_DELTAS, {
  toolCallId: "mock-t3",
  toolName: "view",
  toolArgs: { path: "src/auth/refresh.ts" },
});

// Scenario 3: rich markdown showcase exercising all rendering features
const RESPONSE_MARKDOWN_DELTAS = [
  "# Markdown Rendering Showcase\n\n",
  "Here's a comprehensive overview of what I can render.\n\n",
  "## Text Formatting\n\n",
  "You can use **bold**, *italic*, ~~strikethrough~~, and `inline code`. ",
  "You can also combine them: ***bold italic***, **`bold code`**.\n\n",
  "## Lists\n\n",
  "### Ordered\n",
  "1. First item\n",
  "2. Second item with **emphasis**\n",
  "3. Third item\n\n",
  "### Unordered\n",
  "- Bullet one\n",
  "- Bullet two\n",
  "  - Nested bullet\n",
  "  - Another nested\n",
  "- Bullet three\n\n",
  "### Task List\n",
  "- [x] Completed task\n",
  "- [x] Another done\n",
  "- [ ] Still pending\n\n",
  "## Code Blocks\n\n",
  "Here's a TypeScript example:\n\n",
  "```typescript\n",
  "interface User {\n",
  "  id: string;\n",
  "  name: string;\n",
  "  email: string;\n",
  "  roles: ('admin' | 'user' | 'viewer')[];\n",
  "}\n",
  "\n",
  "async function getUser(id: string): Promise<User> {\n",
  "  const res = await fetch(`/api/users/${id}`);\n",
  "  if (!res.ok) throw new Error(`User ${id} not found`);\n",
  "  return res.json();\n",
  "}\n",
  "```\n\n",
  "And a shell command:\n\n",
  "```bash\n",
  "curl -s https://api.example.com/health | jq '.status'\n",
  "```\n\n",
  "## Table\n\n",
  "| Feature | Status | Priority |\n",
  "|---------|--------|----------|\n",
  "| Auth flow | ✅ Done | High |\n",
  "| Token rotation | 🔄 In progress | High |\n",
  "| Audit logging | ❌ Not started | Medium |\n",
  "| Rate limiting | ✅ Done | Low |\n\n",
  "## Blockquote\n\n",
  "> **Note:** This is an important callout.\n",
  "> It can span multiple lines and contain *formatted* text.\n\n",
  "## Links\n\n",
  "Check the [documentation](https://example.com/docs) for more details. ",
  "You can also reference `src/auth/provider.ts` directly.\n\n",
  "## Image\n\n",
  "Here's the Marshal logo:\n\n",
  "![Marshal icon](./marshal-icon.svg)\n\n",
  "## Horizontal Rule\n\n",
  "---\n\n",
  "## Mermaid Diagram\n\n",
  "```mermaid\nsequenceDiagram\n    participant A as Alice\n    participant B as Bob\n    A->>B: Hello Bob!\n    B-->>A: Hi Alice!\n    A->>B: How are you?\n    B-->>A: Great, thanks!\n```\n\n",
  "That covers all the major markdown features! Let me know if you'd like to see anything else.",
];

const MOCK_SCENARIO_3: MockEventStep[] = buildResponseFixture(RESPONSE_MARKDOWN_DELTAS);

// Scenario 4: code blocks for every supported language (syntax highlighting showcase)
const RESPONSE_LANG_SHOWCASE_DELTAS = [
  "# Syntax Highlighting Showcase\n\n",
  "Here's a code block for each of the 22 supported languages.\n\n",
  "## TypeScript\n```typescript\ninterface Config { port: number; host: string; }\nconst config: Config = { port: 3000, host: 'localhost' };\n```\n\n",
  "## JavaScript\n```javascript\nconst greet = (name) => `Hello, ${name}!`;\nconsole.log(greet('world'));\n```\n\n",
  '## TSX\n```tsx\nexport function Badge({ label }: { label: string }) {\n  return <span className="badge">{label}</span>;\n}\n```\n\n',
  "## JSX\n```jsx\nfunction App() {\n  const [count, setCount] = useState(0);\n  return <button onClick={() => setCount(c => c + 1)}>{count}</button>;\n}\n```\n\n",
  '## Bash\n```bash\n#!/bin/bash\nfor file in *.ts; do\n  echo "Processing $file"\n  wc -l "$file"\ndone\n```\n\n',
  '## JSON\n```json\n{\n  "name": "my-app",\n  "version": "1.0.0",\n  "dependencies": { "react": "^19.0.0" }\n}\n```\n\n',
  "## Python\n```python\ndef fibonacci(n: int) -> list[int]:\n    a, b = 0, 1\n    result = []\n    for _ in range(n):\n        result.append(a)\n        a, b = b, a + b\n    return result\n```\n\n",
  "## CSS\n```css\n.container {\n  display: grid;\n  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));\n  gap: 1rem;\n}\n```\n\n",
  '## HTML\n```html\n<nav aria-label="Main navigation">\n  <ul>\n    <li><a href="/">Home</a></li>\n    <li><a href="/about">About</a></li>\n  </ul>\n</nav>\n```\n\n',
  "## Markdown\n```markdown\n# Heading\n\n- Item with **bold** and *italic*\n- [Link](https://example.com)\n\n> A blockquote\n```\n\n",
  '## YAML\n```yaml\nservices:\n  api:\n    image: node:22-alpine\n    ports:\n      - "3000:3000"\n    environment:\n      NODE_ENV: production\n```\n\n',
  "## SQL\n```sql\nSELECT u.name, COUNT(o.id) AS order_count\nFROM users u\nLEFT JOIN orders o ON o.user_id = u.id\nGROUP BY u.name\nHAVING COUNT(o.id) > 5;\n```\n\n",
  "## PowerShell\n```powershell\nGet-ChildItem -Path .\\src -Recurse -Filter *.ts |\n  Where-Object { $_.Length -gt 1KB } |\n  Sort-Object Length -Descending |\n  Select-Object Name, Length -First 10\n```\n\n",
  "## C#\n```csharp\npublic record User(string Name, string Email);\n\nvar users = await dbContext.Users\n    .Where(u => u.IsActive)\n    .OrderBy(u => u.Name)\n    .ToListAsync();\n```\n\n",
  '## XML\n```xml\n<configuration>\n  <appSettings>\n    <add key="ApiUrl" value="https://api.example.com" />\n    <add key="Timeout" value="30" />\n  </appSettings>\n</configuration>\n```\n\n',
  "## Dockerfile\n```dockerfile\nFROM node:22-alpine AS builder\nWORKDIR /app\nCOPY package.json pnpm-lock.yaml ./\nRUN corepack enable && pnpm install --frozen-lockfile\nCOPY . .\nRUN pnpm run build\n```\n\n",
  '## Go\n```go\nfunc handler(w http.ResponseWriter, r *http.Request) {\n    name := r.URL.Query().Get("name")\n    if name == "" {\n        name = "World"\n    }\n    fmt.Fprintf(w, "Hello, %s!", name)\n}\n```\n\n',
  "## Rust\n```rust\nfn fibonacci(n: u32) -> Vec<u64> {\n    let mut seq = vec![0, 1];\n    for i in 2..n as usize {\n        seq.push(seq[i - 1] + seq[i - 2]);\n    }\n    seq\n}\n```\n\n",
  "## Java\n```java\npublic record Point(double x, double y) {\n    public double distanceTo(Point other) {\n        return Math.sqrt(Math.pow(x - other.x, 2) + Math.pow(y - other.y, 2));\n    }\n}\n```\n\n",
  '## Ruby\n```ruby\nclass Greeting\n  def initialize(name)\n    @name = name\n  end\n\n  def say\n    puts "Hello, #{@name}!"\n  end\nend\n```\n\n',
  "## GraphQL\n```graphql\ntype Query {\n  user(id: ID!): User\n  posts(limit: Int = 10): [Post!]!\n}\n\ntype User {\n  id: ID!\n  name: String!\n  posts: [Post!]!\n}\n```\n\n",
  '## TOML\n```toml\n[package]\nname = "my-app"\nversion = "0.1.0"\nedition = "2024"\n\n[dependencies]\ntokio = { version = "1", features = ["full"] }\n```\n\n',
  "## Unsupported Language (Haskell — falls back to plain text)\n```haskell\nfibonacci :: Int -> [Int]\nfibonacci n = take n fibs\n  where fibs = 0 : 1 : zipWith (+) fibs (tail fibs)\n```\n\n",
  "That covers all 22 supported languages plus an unsupported one (Haskell) showing plain-text fallback.",
];

const MOCK_SCENARIO_4: MockEventStep[] = buildResponseFixture(RESPONSE_LANG_SHOWCASE_DELTAS);

// Scenario 5: stress test — ~120 events at 20ms intervals to simulate real-world streaming rates.
// Used by perf profiler to expose event processing overhead under load.
function buildStressScenario(): MockEventStep[] {
  const steps: MockEventStep[] = [];
  const FAST = 20;

  // 5 reasoning deltas
  for (let i = 0; i < 5; i++) {
    steps.push({
      type: "event",
      delay: FAST,
      event: mockEvent("assistant.reasoning_delta", {
        reasoningId: "r-stress",
        deltaContent: `Analyzing step ${i + 1} of the problem. `,
      }),
    });
  }

  // Tool start + end
  steps.push({
    type: "event",
    delay: FAST,
    event: mockEvent("tool.execution_start", {
      toolCallId: "stress-t1",
      toolName: "grep",
      mcpToolName: "grep",
      arguments: { pattern: "auth" },
    }),
  });
  steps.push({
    type: "event",
    delay: 100, // brief tool execution
    event: mockEvent("tool.execution_complete", { toolCallId: "stress-t1", success: true }),
  });

  // ~100 text deltas at 20ms each — the core streaming stress test
  const words = RESPONSE_2_DELTAS.join("").split(" ");
  const allText: string[] = [];
  for (let i = 0; i < words.length; i += 2) {
    const chunk = words.slice(i, i + 2).join(" ") + " ";
    allText.push(chunk);
    steps.push({
      type: "event",
      delay: FAST,
      event: mockEvent("assistant.message_delta", { messageId: "m-stress", deltaContent: chunk }),
    });
  }

  steps.push({
    type: "event",
    delay: FAST,
    event: mockEvent("assistant.message", { messageId: "m-stress", content: allText.join("") }),
  });
  steps.push({ type: "event", delay: FAST, event: mockEvent("session.idle", {}) });
  return steps;
}

const MOCK_SCENARIO_STRESS = buildStressScenario();

// Scenario 6: permission pipeline — triggers real onPermissionRequest + onPreToolUse hooks.
// Used by E2E tests to exercise the full PermissionPolicy → PermissionCardManager flow.
// Two tool calls: shell (rm) then write (create_file), with a message_delta between them
// to reset skipUntilNextNonTool so each tool's permission is independently evaluated.
const MOCK_SCENARIO_PERMISSION: MockStep[] = [
  {
    type: "event",
    delay: 200,
    event: mockEvent("assistant.reasoning_delta", {
      reasoningId: "r-perm",
      deltaContent:
        "The user wants me to clean up temp files and save a report. I'll need shell and write permissions.",
    }),
  },
  {
    type: "event",
    delay: 300,
    event: mockEvent("assistant.message_delta", {
      messageId: "marshal-perm",
      deltaContent: "I'll clean up your temp files and save a report.\n\n",
    }),
  },
  // --- Tool 1: shell command ---
  {
    type: "permission-request",
    delay: 100,
    permissionRequest: {
      kind: "shell",
      toolCallId: "tc-perm-1",
      toolName: "shell",
      command: "rm -rf /tmp/old-files/*",
      fullCommandText: "rm -rf /tmp/old-files/*",
    },
  },
  {
    type: "pre-tool-use",
    delay: 100,
    toolCall: {
      toolCallId: "tc-perm-1",
      toolName: "shell",
      toolArgs: { command: "rm -rf /tmp/old-files/*" },
    },
  },
  {
    type: "event",
    delay: 200,
    event: mockEvent("tool.execution_start", {
      toolCallId: "tc-perm-1",
      toolName: "shell",
      mcpToolName: "shell",
      arguments: { command: "rm -rf /tmp/old-files/*" },
    }),
  },
  {
    type: "event",
    delay: 800,
    event: mockEvent("tool.execution_complete", {
      toolCallId: "tc-perm-1",
      success: true,
    }),
  },
  {
    type: "post-tool-use",
    delay: 50,
    toolCall: {
      toolCallId: "tc-perm-1",
      toolName: "shell",
      toolResult: "Removed 42 files",
    },
  },
  // Transition text — resets skipUntilNextNonTool between tool sequences
  {
    type: "event",
    delay: 200,
    event: mockEvent("assistant.message_delta", {
      messageId: "marshal-perm",
      deltaContent: "Files cleaned up. Now I'll save a report.\n\n",
    }),
  },
  // --- Tool 2: write (create_file) ---
  {
    type: "permission-request",
    delay: 100,
    permissionRequest: {
      kind: "write",
      toolCallId: "tc-perm-2",
      toolName: "create_file",
      command: "create_file /tmp/cleanup-report.txt",
      fullCommandText: "create_file /tmp/cleanup-report.txt",
    },
  },
  {
    type: "pre-tool-use",
    delay: 100,
    toolCall: {
      toolCallId: "tc-perm-2",
      toolName: "create_file",
      toolArgs: { path: "/tmp/cleanup-report.txt", content: "Removed 42 files" },
    },
  },
  {
    type: "event",
    delay: 200,
    event: mockEvent("tool.execution_start", {
      toolCallId: "tc-perm-2",
      toolName: "create_file",
      mcpToolName: "create_file",
      arguments: { path: "/tmp/cleanup-report.txt", content: "Removed 42 files" },
    }),
  },
  {
    type: "event",
    delay: 500,
    event: mockEvent("tool.execution_complete", {
      toolCallId: "tc-perm-2",
      success: true,
    }),
  },
  {
    type: "post-tool-use",
    delay: 50,
    toolCall: {
      toolCallId: "tc-perm-2",
      toolName: "create_file",
      toolResult: "File written (16 bytes)",
    },
  },
  // Final response
  {
    type: "event",
    delay: 200,
    event: mockEvent("assistant.message_delta", {
      messageId: "marshal-perm",
      deltaContent: "Done! Cleaned up 42 files and saved the report.",
    }),
  },
  {
    type: "event",
    delay: 100,
    event: mockEvent("assistant.message", {
      messageId: "marshal-perm",
      content:
        "I'll clean up your temp files and save a report.\n\nFiles cleaned up. Now I'll save a report.\n\nDone! Cleaned up 42 files and saved the report.",
    }),
  },
  { type: "event", delay: 100, event: mockEvent("session.idle", {}) },
];

// Scenario 5: Memory storage through the selected provider
// Demonstrates the remember self-tool being used to save a fact
const RESPONSE_MEMORY_STORE_DELTAS = [
  "Got it! I've saved that to my memory. ",
  "This preference will be available across future sessions.",
];

const MOCK_SCENARIO_MEMORY: MockEventStep[] = [
  {
    type: "event",
    delay: 300,
    event: mockEvent("tool.execution_start", {
      toolCallId: "mock-memory-1",
      toolName: "remember",
      mcpToolName: "remember",
      arguments: {
        fact: "User prefers TypeScript over other languages for backend development",
        category: "preference",
      },
    }),
  },
  {
    type: "event",
    delay: 600,
    event: mockEvent("tool.execution_complete", {
      toolCallId: "mock-memory-1",
      success: true,
    }),
  },
  ...buildResponseFixture(RESPONSE_MEMORY_STORE_DELTAS),
];

// Scenario 7: read-only shell command — exercises the auto-approve-readonly
// code path. When the user toggles "Auto-approve read-only operations" ON,
// the policy auto-approves at evaluate()-time and no card is created.
const MOCK_SCENARIO_READONLY_SHELL: MockStep[] = [
  {
    type: "event",
    delay: 200,
    event: mockEvent("assistant.message_delta", {
      messageId: "m-ro",
      deltaContent: "I'll list your home directory.\n",
    }),
  },
  {
    type: "permission-request",
    delay: 100,
    permissionRequest: {
      kind: "shell",
      toolCallId: "tc-ro-1",
      toolName: "shell",
      command: "ls ~",
      fullCommandText: "ls ~",
    },
  },
  {
    type: "pre-tool-use",
    delay: 50,
    toolCall: { toolCallId: "tc-ro-1", toolName: "shell", toolArgs: { command: "ls ~" } },
  },
  {
    type: "event",
    delay: 100,
    event: mockEvent("tool.execution_complete", { toolCallId: "tc-ro-1", success: true }),
  },
  {
    type: "event",
    delay: 100,
    event: mockEvent("assistant.message", {
      messageId: "m-ro",
      content: "I'll list your home directory.\nDone.",
    }),
  },
  { type: "event", delay: 50, event: mockEvent("session.idle", {}) },
];

// Scenario 8: writes-category shell command the classifier can safely
// broaden. Used by the pattern-persistence E2E test. Command choice matters:
// `npm install --save-dev foo` is a writes-category command where
// `npm install *` survives every guardrail (not in DENY_BINARIES, not a
// DENY_PAIR, 3-token pattern so G_BARE_STAR allows it, matches the command).
const MOCK_SCENARIO_CLASSIFIED_WRITE: MockStep[] = [
  {
    type: "event",
    delay: 200,
    event: mockEvent("assistant.message_delta", {
      messageId: "m-cw",
      deltaContent: "Installing lodash.\n",
    }),
  },
  {
    type: "permission-request",
    delay: 100,
    permissionRequest: {
      kind: "shell",
      toolCallId: "tc-cw-1",
      toolName: "shell",
      command: "npm install --save-dev lodash",
      fullCommandText: "npm install --save-dev lodash",
    },
  },
  // Scenario pauses here — the test responds via the card button and asserts
  // the resulting rule in Settings. No post-approval steps needed.
];

// Scenario 9: slow-classifier — exercises card decoupling. The permission
// card must render immediately with the synchronous heuristic primary; the
// LLM's broader suggestion arrives later and appears as a secondary option.
// The marker package name `slow-classify-pkg` tells the mock classifier to
// delay its response without altering the heuristic's first-token parsing
// (the command still starts with `npm`, so guardrails accept both the
// heuristic primary `npm install --save-dev *` and the LLM's broader
// `npm install *` — they differ, so the secondary should surface).
const MOCK_SCENARIO_SLOW_CLASSIFIER: MockStep[] = [
  {
    type: "event",
    delay: 200,
    event: mockEvent("assistant.message_delta", {
      messageId: "m-slow",
      deltaContent: "Installing something slowly.\n",
    }),
  },
  {
    type: "permission-request",
    delay: 100,
    permissionRequest: {
      kind: "shell",
      toolCallId: "tc-slow-1",
      toolName: "shell",
      command: "npm install --save-dev slow-classify-pkg",
      fullCommandText: "npm install --save-dev slow-classify-pkg",
    },
  },
];

/** Scenario that emits MCP server status + OAuth events so the renderer's
 *  toast surfacing for plugin remote MCP servers can be exercised end-to-end.
 *  Triggered by the keyword "mcp-oauth" in the user prompt. */
const MOCK_SCENARIO_MCP_OAUTH: MockStep[] = [
  {
    type: "event",
    delay: 100,
    event: mockEvent("session.mcp_server_status_changed", {
      serverName: "powerbi-remote",
      status: "needs-auth",
    }),
  },
  {
    type: "event",
    delay: 100,
    event: mockEvent("mcp.oauth_required", {
      requestId: "mock-oauth-req-1",
      serverName: "powerbi-mock",
      serverUrl: "https://mock.powerbi.test/mcp",
    }),
  },
  {
    type: "event",
    delay: 200,
    event: mockEvent("mcp.oauth_completed", {
      requestId: "mock-oauth-req-1",
    }),
  },
  {
    type: "event",
    delay: 100,
    event: mockEvent("session.mcp_server_status_changed", {
      serverName: "broken-mock",
      status: "failed",
    }),
  },
  {
    type: "event",
    delay: 100,
    event: mockEvent("assistant.message", {
      messageId: "marshal-mcp-oauth",
      content: "Done.",
    }),
  },
  {
    type: "event",
    delay: 50,
    event: mockEvent("session.idle", {}),
  },
];

// Scenario 10: browser_take_screenshot with an explicit filename — exercises
// the pendingBrowserWritePaths → write-kind upgrade path. The pre-tool-use
// step MUST precede the permission-request so extractBrowserWritePath runs
// first and stores the path before permissionHandler reads it.
const MOCK_SCENARIO_BROWSER_SCREENSHOT_WRITE: MockStep[] = [
  {
    type: "event",
    delay: 200,
    event: mockEvent("assistant.reasoning_delta", {
      reasoningId: "r-bss",
      deltaContent: "I'll take a screenshot and save it to disk.",
    }),
  },
  {
    type: "event",
    delay: 300,
    event: mockEvent("assistant.message_delta", {
      messageId: "m-bss",
      deltaContent: "Taking a screenshot of the page.\n\n",
    }),
  },
  // pre-tool-use first so pendingBrowserWritePaths is populated before the permission request
  {
    type: "pre-tool-use",
    delay: 50,
    toolCall: {
      toolCallId: "tc-bss-1",
      toolName: "browser_take_screenshot",
      toolArgs: { filename: "/tmp/report.png" },
      serverName: "playwright",
    },
  },
  {
    type: "permission-request",
    delay: 100,
    permissionRequest: {
      kind: "mcp",
      toolCallId: "tc-bss-1",
      toolName: "playwright-browser_take_screenshot",
    },
  },
  {
    type: "event",
    delay: 200,
    event: mockEvent("tool.execution_start", {
      toolCallId: "tc-bss-1",
      toolName: "playwright-browser_take_screenshot",
      mcpToolName: "playwright-browser_take_screenshot",
      arguments: { filename: "/tmp/report.png" },
    }),
  },
  {
    type: "event",
    delay: 500,
    event: mockEvent("tool.execution_complete", { toolCallId: "tc-bss-1", success: true }),
  },
  {
    type: "post-tool-use",
    delay: 50,
    toolCall: {
      toolCallId: "tc-bss-1",
      toolName: "browser_take_screenshot",
      toolResult: "Screenshot saved to /tmp/report.png",
      serverName: "playwright",
    },
  },
  {
    type: "event",
    delay: 200,
    event: mockEvent("assistant.message_delta", {
      messageId: "m-bss",
      deltaContent: "Screenshot saved.",
    }),
  },
  {
    type: "event",
    delay: 100,
    event: mockEvent("assistant.message", {
      messageId: "m-bss",
      content: "Taking a screenshot of the page.\n\nScreenshot saved.",
    }),
  },
  { type: "event", delay: 100, event: mockEvent("session.idle", {}) },
];

// Scenario 11: browser_take_screenshot targeting a sensitive path (~/.ssh/config).
// Verifies that the sensitivePathWarning banner appears on the write-kind card even
// when playwright autoApprove is on — checkSensitivePath forces a prompt regardless.
const MOCK_SCENARIO_BROWSER_SCREENSHOT_SENSITIVE: MockStep[] = [
  {
    type: "event",
    delay: 200,
    event: mockEvent("assistant.reasoning_delta", {
      reasoningId: "r-bsc",
      deltaContent: "Saving screenshot to a sensitive location.",
    }),
  },
  {
    type: "event",
    delay: 300,
    event: mockEvent("assistant.message_delta", {
      messageId: "m-bsc",
      deltaContent: "Taking a screenshot.\n\n",
    }),
  },
  // pre-tool-use first so pendingBrowserWritePaths is populated before the permission request
  {
    type: "pre-tool-use",
    delay: 50,
    toolCall: {
      toolCallId: "tc-bsc-1",
      toolName: "browser_take_screenshot",
      // expandHome("~/.ssh/config") runs in the main process where os is available
      toolArgs: { filename: "~/.ssh/config" },
      serverName: "playwright",
    },
  },
  {
    type: "permission-request",
    delay: 100,
    permissionRequest: {
      kind: "mcp",
      toolCallId: "tc-bsc-1",
      toolName: "playwright-browser_take_screenshot",
    },
  },
  {
    type: "event",
    delay: 200,
    event: mockEvent("tool.execution_start", {
      toolCallId: "tc-bsc-1",
      toolName: "playwright-browser_take_screenshot",
      mcpToolName: "playwright-browser_take_screenshot",
      arguments: { filename: "~/.ssh/config" },
    }),
  },
  {
    type: "event",
    delay: 500,
    event: mockEvent("tool.execution_complete", { toolCallId: "tc-bsc-1", success: true }),
  },
  {
    type: "post-tool-use",
    delay: 50,
    toolCall: {
      toolCallId: "tc-bsc-1",
      toolName: "browser_take_screenshot",
      toolResult: "Screenshot saved",
      serverName: "playwright",
    },
  },
  {
    type: "event",
    delay: 200,
    event: mockEvent("assistant.message_delta", {
      messageId: "m-bsc",
      deltaContent: "Screenshot saved.",
    }),
  },
  {
    type: "event",
    delay: 100,
    event: mockEvent("assistant.message", {
      messageId: "m-bsc",
      content: "Taking a screenshot.\n\nScreenshot saved.",
    }),
  },
  { type: "event", delay: 100, event: mockEvent("session.idle", {}) },
];

// Scenario 12: browser_run_code write gate — no pre-tool-use needed because
// the code-execution upgrade is unconditional when FS is enabled.
// isBrowserCodeExecutionTool() matches bare "browser_run_code" after
// getBarePlaywrightToolName strips the "playwright-" prefix.
const MOCK_SCENARIO_BROWSER_RUN_CODE_WRITE: MockStep[] = [
  {
    type: "event",
    delay: 200,
    event: mockEvent("assistant.reasoning_delta", {
      reasoningId: "r-brc",
      deltaContent: "I need to run some browser code.",
    }),
  },
  {
    type: "event",
    delay: 300,
    event: mockEvent("assistant.message_delta", {
      messageId: "m-brc",
      deltaContent: "Running browser code.\n\n",
    }),
  },
  {
    type: "permission-request",
    delay: 100,
    permissionRequest: {
      kind: "mcp",
      toolCallId: "tc-brc-1",
      toolName: "playwright-browser_run_code",
    },
  },
  {
    type: "event",
    delay: 200,
    event: mockEvent("tool.execution_start", {
      toolCallId: "tc-brc-1",
      toolName: "playwright-browser_run_code",
      mcpToolName: "playwright-browser_run_code",
      arguments: { code: "console.log('hello')" },
    }),
  },
  {
    type: "event",
    delay: 500,
    event: mockEvent("tool.execution_complete", { toolCallId: "tc-brc-1", success: true }),
  },
  {
    type: "post-tool-use",
    delay: 50,
    toolCall: {
      toolCallId: "tc-brc-1",
      toolName: "browser_run_code",
      toolResult: "hello",
      serverName: "playwright",
    },
  },
  {
    type: "event",
    delay: 200,
    event: mockEvent("assistant.message_delta", {
      messageId: "m-brc",
      deltaContent: "Done.",
    }),
  },
  {
    type: "event",
    delay: 100,
    event: mockEvent("assistant.message", {
      messageId: "m-brc",
      content: "Running browser code.\n\nDone.",
    }),
  },
  { type: "event", delay: 100, event: mockEvent("session.idle", {}) },
];

const MOCK_SCENARIO_CANCEL_LONG: MockStep[] = [
  {
    type: "event",
    delay: 100,
    event: mockEvent("assistant.message_delta", {
      messageId: "m-cancel-long",
      deltaContent: "Working on cancellation test...",
    }),
  },
  {
    type: "event",
    delay: 50,
    event: mockEvent("tool.execution_start", {
      toolCallId: "tc-cancel-late",
      toolName: "late_cancelled_tool",
      arguments: {},
    }),
  },
  {
    type: "event",
    delay: 2_000,
    event: mockEvent("assistant.message_delta", {
      messageId: "m-cancel-long",
      deltaContent: "Late cancelled output",
    }),
  },
  {
    type: "event",
    delay: 100,
    event: mockEvent("tool.execution_complete", {
      toolCallId: "tc-cancel-late",
      success: true,
    }),
  },
  {
    type: "event",
    delay: 100,
    event: mockEvent("assistant.message", {
      messageId: "m-cancel-long",
      content: "Working on cancellation test...Late cancelled output",
    }),
  },
  { type: "event", delay: 100, event: mockEvent("session.idle", {}) },
];

const MOCK_SCENARIO_CANCEL_ACTIVITY_ONLY: MockStep[] = [
  {
    type: "event",
    delay: 100,
    event: mockEvent("assistant.reasoning_delta", {
      reasoningId: "r-cancel-activity",
      deltaContent: "Inspecting the cancellation path.",
    }),
  },
  {
    type: "event",
    delay: 50,
    event: mockEvent("tool.execution_start", {
      toolCallId: "tc-cancel-activity",
      toolName: "read_file",
      arguments: { path: "electron/sessions.ts" },
    }),
  },
  {
    type: "event",
    delay: 2_000,
    event: mockEvent("assistant.message_delta", {
      messageId: "m-cancel-activity",
      deltaContent: "Late cancelled output",
    }),
  },
  { type: "event", delay: 100, event: mockEvent("session.idle", {}) },
];

const MOCK_SCENARIO_CHILD_LONG: MockStep[] = [
  {
    type: "event",
    delay: 100,
    event: mockEvent("assistant.message_delta", {
      messageId: "m-child-long",
      deltaContent: "Child is still working...",
    }),
  },
  {
    type: "event",
    delay: 8_000,
    event: mockEvent("assistant.message_delta", {
      messageId: "m-child-long",
      deltaContent: "Child completed after parent cancellation.",
    }),
  },
  {
    type: "event",
    delay: 100,
    event: mockEvent("assistant.message", {
      messageId: "m-child-long",
      content: "Child is still working...Child completed after parent cancellation.",
    }),
  },
  { type: "event", delay: 100, event: mockEvent("session.idle", {}) },
];

const MOCK_SCENARIO_CANCEL_FOLLOWUP: MockStep[] = [
  {
    type: "event",
    delay: 100,
    event: mockEvent("assistant.message_delta", {
      messageId: "m-cancel-followup",
      deltaContent: "Follow-up completed.",
    }),
  },
  {
    type: "event",
    delay: 50,
    event: mockEvent("assistant.message", {
      messageId: "m-cancel-followup",
      content: "Follow-up completed.",
    }),
  },
  { type: "event", delay: 50, event: mockEvent("session.idle", {}) },
];

const MOCK_SCENARIO_ACTIVITY_SHOWCASE: MockStep[] = [
  {
    type: "event",
    delay: 100,
    event: mockEvent("tool.execution_start", {
      toolCallId: "activity-read-1",
      toolName: "listSubagents",
      mcpToolName: "listSubagents",
      arguments: { scope: "children" },
    }),
  },
  {
    type: "event",
    delay: 300,
    event: mockEvent("tool.execution_complete", {
      toolCallId: "activity-read-1",
      success: true,
    }),
  },
  {
    type: "event",
    delay: 100,
    event: mockEvent("tool.execution_start", {
      toolCallId: "activity-read-2",
      toolName: "view",
      mcpToolName: "view",
      arguments: { path: "src/features/chat/components/ToolActivityIsland.tsx" },
    }),
  },
  {
    type: "event",
    delay: 100,
    event: mockEvent("tool.execution_start", {
      toolCallId: "activity-read-3",
      toolName: "view",
      mcpToolName: "view",
      arguments: { path: "src/features/chat/components/PermissionDecisionTray.tsx" },
    }),
  },
  {
    type: "event",
    delay: 5_000,
    event: mockEvent("tool.execution_complete", {
      toolCallId: "activity-read-2",
      success: false,
      error: "Could not read ToolActivityIsland.tsx",
    }),
  },
  {
    type: "event",
    delay: 100,
    event: mockEvent("tool.execution_complete", {
      toolCallId: "activity-read-3",
      success: false,
      error: "Operation cancelled",
    }),
  },
  {
    type: "event",
    delay: 100,
    event: mockEvent("assistant.message_delta", {
      messageId: "m-activity-showcase",
      deltaContent: "Activity showcase finished with issues.",
    }),
  },
  {
    type: "event",
    delay: 50,
    event: mockEvent("assistant.message", {
      messageId: "m-activity-showcase",
      content: "Activity showcase finished with issues.",
    }),
  },
  { type: "event", delay: 50, event: mockEvent("session.idle", {}) },
];

/** Scenarios that cycle on each user send. */
export const MOCK_SCENARIOS: MockStep[][] = [MOCK_SCENARIO_1, MOCK_SCENARIO_2, MOCK_SCENARIO_3];

/** Triggered scenarios — keyed by trigger word matched against user input. */
export const MOCK_TRIGGERED_SCENARIOS: Record<string, MockStep[]> = {
  code: MOCK_SCENARIO_4,
  stress: MOCK_SCENARIO_STRESS,
  permission: MOCK_SCENARIO_PERMISSION,
  "readonly-shell": MOCK_SCENARIO_READONLY_SHELL,
  "classified-write": MOCK_SCENARIO_CLASSIFIED_WRITE,
  "slow-classifier": MOCK_SCENARIO_SLOW_CLASSIFIER,
  memory: MOCK_SCENARIO_MEMORY,
  "mcp-oauth": MOCK_SCENARIO_MCP_OAUTH,
  "browser-screenshot-write": MOCK_SCENARIO_BROWSER_SCREENSHOT_WRITE,
  "browser-screenshot-sensitive": MOCK_SCENARIO_BROWSER_SCREENSHOT_SENSITIVE,
  "browser-exec-write": MOCK_SCENARIO_BROWSER_RUN_CODE_WRITE,
  "cancel-activity-only": MOCK_SCENARIO_CANCEL_ACTIVITY_ONLY,
  "cancel-long": MOCK_SCENARIO_CANCEL_LONG,
  "child-long": MOCK_SCENARIO_CHILD_LONG,
  "cancel-followup": MOCK_SCENARIO_CANCEL_FOLLOWUP,
  "activity-showcase": MOCK_SCENARIO_ACTIVITY_SHOWCASE,
  "slot-reply": buildSlotReplyScenario(mockEvent),
};
