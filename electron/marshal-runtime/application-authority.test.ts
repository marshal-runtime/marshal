import type { InvocationContext } from "@marshal/runtime";
import type { PermissionCheck } from "@marshal/runtime/core";
import { describe, expect, it } from "vitest";

import { testDouble } from "../testing/harness";
import { RuntimeApplicationAuthority, stripApplicationAuthority } from "./application-authority";

const owner = {
  extensionId: "example",
  applicationId: "review",
  applicationScope: "user" as const,
  workspaceName: "marshal",
};
function check(context: InvocationContext, name: string, permission = name): PermissionCheck {
  return testDouble<PermissionCheck>({
    context,
    capability: { name },
    requirements: [{ permission }],
    request: { input: {} },
  });
}

describe("native application authority", () => {
  it("allows only declared owner-scoped UI operations with their exact permission", async () => {
    const authority = new RuntimeApplicationAuthority();
    await authority.run(
      {
        owner,
        capabilities: new Set([
          "ui.application.update",
          "ui.notifications.show",
          "marshal.ui.image.import",
        ]),
        workspacePath: "/tmp",
        isActive: async () => true,
      },
      async (context) => {
        const invocation: InvocationContext = {
          principal: { id: "application", kind: "user" },
          metadata: context.metadata,
        };
        expect(
          (await authority.decide(check(invocation, "marshal.ui.image.import")))?.decision,
        ).toBe("allow");
        expect(
          (
            await authority.decide(
              check(invocation, "marshal.ui.image.import", "marshal.session.read"),
            )
          )?.decision,
        ).toBe("deny");
        expect(
          (
            await authority.decide(
              check(invocation, "ui.application.update", "marshal.ui.application.update"),
            )
          )?.decision,
        ).toBe("allow");
        expect(
          (
            await authority.decide(
              check(invocation, "ui.application.update", "marshal.session.read"),
            )
          )?.decision,
        ).toBe("deny");
        expect(
          (
            await authority.decide(
              check(invocation, "ui.application.close", "marshal.ui.application.close"),
            )
          )?.decision,
        ).toBe("deny");
        expect(
          (
            await authority.decide(
              check(invocation, "ui.notifications.show", "marshal.ui.notifications.show"),
            )
          )?.decision,
        ).toBe("deny");
      },
    );
  });
  it("mints an invocation-limited owner without manufacturing a session", async () => {
    const authority = new RuntimeApplicationAuthority();
    let saved: InvocationContext | undefined;
    await authority.run(
      {
        owner,
        capabilities: new Set(["review.list"]),
        workspacePath: "/tmp",
        isActive: async () => true,
      },
      async (context) => {
        expect(context.sessionId).toBeUndefined();
        saved = { principal: { id: "application", kind: "user" }, metadata: context.metadata };
        expect(authority.resolve(saved)?.owner).toEqual(owner);
        expect((await authority.decide(check(saved, "review.list")))?.decision).toBe("allow");
        expect((await authority.decide(check(saved, "review.delete")))?.decision).toBe("deny");
      },
    );
    expect(authority.resolve(saved!)).toBeUndefined();
  });

  it("never accepts forged metadata or host privileges from an extension manifest", async () => {
    const authority = new RuntimeApplicationAuthority();
    expect(
      await authority.decide(
        check(
          {
            principal: { id: "forged", kind: "agent" },
            metadata: { runtimeExtensionIdentity: "example", marshalApplicationInvocation: "fake" },
          },
          "review.list",
        ),
      ),
    ).toBeUndefined();
    await authority.run(
      {
        owner,
        capabilities: new Set(["marshal.tool.searchSessions", "review.list"]),
        workspacePath: "/tmp",
        isActive: async () => true,
      },
      async (context) => {
        const invocation: InvocationContext = {
          principal: { id: "application", kind: "user" },
          metadata: context.metadata,
        };
        expect(
          (
            await authority.decide(
              check(
                invocation,
                "marshal.tool.searchSessions",
                "marshal.tool.invoke:searchSessions",
              ),
            )
          )?.decision,
        ).toBe("deny");
        expect(
          (await authority.decide(check(invocation, "review.list", "marshal.session.read")))
            ?.decision,
        ).toBe("deny");
        const metadata = { ...context.metadata };
        stripApplicationAuthority(metadata);
        expect(authority.resolve({ metadata })).toBeUndefined();
      },
    );
  });

  it("revalidates publication during execution and preserves host policy for a selected session", async () => {
    const authority = new RuntimeApplicationAuthority();
    let active = true;
    await authority.run(
      {
        owner,
        capabilities: new Set(["marshal.tool.searchSessions", "marshal.session.delivery.send"]),
        workspacePath: "/tmp",
        executionScope: { sessionId: "chosen", workspaceName: "project" },
        isActive: async () => active,
      },
      async (context) => {
        expect(context.sessionId).toBe("chosen");
        const invocation: InvocationContext = {
          principal: { id: "application", kind: "user" },
          metadata: context.metadata,
        };
        expect(
          await authority.decide(
            check(invocation, "marshal.tool.searchSessions", "marshal.tool.invoke:searchSessions"),
          ),
        ).toBeUndefined();
        expect(
          (await authority.decide(check(invocation, "marshal.session.delivery.send")))?.decision,
        ).toBe("allow");
        expect(
          (
            await authority.decide(
              check(invocation, "marshal.session.delivery.send", "marshal.session.read"),
            )
          )?.decision,
        ).toBe("deny");
        active = false;
        expect(
          (await authority.decide(check(invocation, "marshal.session.delivery.send")))?.decision,
        ).toBe("deny");
      },
    );
  });
  it("W2-F3 guard: background job invocations never claim foreground and carry no grant, while UI invocations affirmatively do", async () => {
    const authority = new RuntimeApplicationAuthority();
    await authority.run(
      {
        owner,
        capabilities: new Set<string>(),
        workspacePath: "/tmp",
        backgroundJobInvocationId: "job-1",
        isActive: async () => true,
      },
      async (context) => {
        expect(context.metadata?.foreground).toBeUndefined();
        expect(context.metadata?.grantId).toBeUndefined();
      },
    );
    await authority.run(
      {
        owner,
        capabilities: new Set<string>(),
        workspacePath: "/tmp",
        grantId: "grant-7",
        isActive: async () => true,
      },
      async (context) => {
        expect(context.metadata?.foreground).toBe(true);
        expect(context.metadata?.grantId).toBe("grant-7");
      },
    );
  });
  it("W3-F1: an extension's own internal session-delivery check is allowed even though a publication's declared capability set can never contain the host delivery name", async () => {
    const authority = new RuntimeApplicationAuthority();
    await authority.run(
      {
        // A REAL publication set: extension capability names only.
        owner,
        capabilities: new Set(["codereview.ai.ask"]),
        workspacePath: "/tmp",
        grantId: "grant-9",
        isActive: async () => true,
      },
      async (context) => {
        const invocation: InvocationContext = {
          principal: { id: "application", kind: "user" },
          metadata: context.metadata,
        };
        // the delivery send fired internally by codereview.ai.ask: allowed
        expect(
          (await authority.decide(check(invocation, "marshal.session.delivery.send")))?.decision,
        ).toBe("allow");
        expect(
          (await authority.decide(check(invocation, "marshal.session.delivery.cancel")))?.decision,
        ).toBe("allow");
        // exact-requirement validation still enforced on that branch
        expect(
          (
            await authority.decide(
              check(invocation, "marshal.session.delivery.send", "marshal.session.read"),
            )
          )?.decision,
        ).toBe("deny");
        // the publication membership gate still applies to extension-space
        // capabilities that were NOT declared
        expect(
          (await authority.decide(check(invocation, "codereview.ai.followup")))?.decision,
        ).toBe("deny");
        // a host job-lifecycle name reached via an extension capability
        // (babysit.arm -> marshal.application.job.arm) is allowed by the
        // same host-owned-class branch, never blocked by the membership gate
        expect(
          (await authority.decide(check(invocation, "marshal.application.job.arm")))?.decision,
        ).toBe("allow");
        // the one declared extension capability is not denied by the gate
        expect((await authority.decide(check(invocation, "codereview.ai.ask")))?.decision).not.toBe(
          "deny",
        );
      },
    );
  });
  it("allows an application to start and resume its own sessions without a selected session", async () => {
    const authority = new RuntimeApplicationAuthority();
    await authority.run(
      {
        owner,
        capabilities: new Set(["loops.item.dispatch"]),
        workspacePath: "/tmp",
        isActive: async () => true,
      },
      async (context) => {
        const invocation: InvocationContext = {
          principal: { id: "application", kind: "user" },
          metadata: context.metadata,
        };
        expect((await authority.decide(check(invocation, "marshal.session.start")))?.decision).toBe(
          "allow",
        );
        expect(
          (await authority.decide(check(invocation, "marshal.session.resume")))?.decision,
        ).toBe("allow");
        expect((await authority.decide(check(invocation, "marshal.session.reply")))?.decision).toBe(
          "allow",
        );
        expect(
          (
            await authority.decide(
              check(invocation, "marshal.session.reply", "marshal.tool.invoke:spawnSubagent"),
            )
          )?.decision,
        ).toBe("deny");
        expect(
          (
            await authority.decide(
              check(invocation, "marshal.session.start", "marshal.tool.invoke:spawnSubagent"),
            )
          )?.decision,
        ).toBe("deny");
        expect(
          (
            await authority.decide(
              check(invocation, "marshal.tool.spawnSubagent", "marshal.tool.invoke:spawnSubagent"),
            )
          )?.decision,
        ).toBe("deny");
      },
    );
  });
});
