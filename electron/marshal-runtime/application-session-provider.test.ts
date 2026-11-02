import type { InvocationContext } from "@marshal/runtime";
import { describe, expect, it, vi } from "vitest";

import { testDouble } from "../testing/harness";
import {
  APPLICATION_SESSION_PERMISSION,
  createApplicationSessionProvider,
} from "./application-session-provider";
import type { ApplicationSessionService } from "./application-sessions";

type Start = ApplicationSessionService["start"];
type Resume = ApplicationSessionService["resume"];
type Reply = ApplicationSessionService["reply"];

const owner = {
  extensionId: "@example/inbox",
  applicationId: "inbox",
  applicationScope: "user" as const,
  workspaceName: "marshal",
};
const context = testDouble<InvocationContext>({ metadata: {} });

describe("createApplicationSessionProvider", () => {
  it("routes start, resume and reply to the service with the resolved UI owner", async () => {
    const start = vi.fn<Start>().mockResolvedValue(testDouble({ sessionId: "session-1" }));
    const resume = vi.fn<Resume>().mockResolvedValue(testDouble({ grantId: "grant-1" }));
    const reply = vi.fn<Reply>().mockResolvedValue(testDouble({ grantId: "grant-2" }));
    const provider = createApplicationSessionProvider(
      testDouble<ApplicationSessionService>({ start, resume, reply }),
      () => owner,
    );
    await provider.invoke(
      APPLICATION_SESSION_PERMISSION.start,
      { requestId: "r", task: "t" },
      context,
    );
    await provider.invoke(
      APPLICATION_SESSION_PERMISSION.resume,
      { sessionId: "session-1" },
      context,
    );
    expect(start).toHaveBeenCalledWith(owner, { requestId: "r", task: "t" });
    await provider.invoke(APPLICATION_SESSION_PERMISSION.reply, { sessionId: "chat-1" }, context);
    expect(resume).toHaveBeenCalledWith(owner, { sessionId: "session-1" });
    expect(reply).toHaveBeenCalledWith(owner, { sessionId: "chat-1" });
  });

  it("refuses callers that are not a live native application UI invocation", async () => {
    const start = vi.fn<Start>();
    const provider = createApplicationSessionProvider(
      testDouble<ApplicationSessionService>({ start }),
      () => {
        throw Object.assign(new Error("A native application UI invocation is required."), {
          code: "permission_denied",
        });
      },
    );
    await expect(
      provider.invoke(APPLICATION_SESSION_PERMISSION.start, { requestId: "r", task: "t" }, context),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(start).not.toHaveBeenCalled();
  });

  it("reports malformed input as an invalid request", async () => {
    const provider = createApplicationSessionProvider(
      testDouble<ApplicationSessionService>({
        start: vi
          .fn<Start>()
          .mockRejectedValue(
            Object.assign(new Error("task is required"), { code: "invalid_input" }),
          ),
      }),
      () => owner,
    );
    await expect(
      provider.invoke(APPLICATION_SESSION_PERMISSION.start, { requestId: "r" }, context),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});
