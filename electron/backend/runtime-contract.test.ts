import { describe, expect, it, vi } from "vitest";

import type {
  RuntimeAttachment,
  RuntimeAuthLoginRequest,
  RuntimeAuthLoginResult,
  RuntimeClient,
  RuntimeSendOptions,
} from "./runtime-contract";

describe("RuntimeClient auth contract", () => {
  it("accepts the typed login request and result unions", async () => {
    const request: RuntimeAuthLoginRequest = {
      type: "external-token",
      accessToken: "token",
      accountId: "account",
      planType: "enterprise",
    };
    const result: RuntimeAuthLoginResult = {
      status: "pending",
      method: "device-code",
      loginId: "login-1",
      verificationUri: "https://example.test/device",
      userCode: "ABCD-EFGH",
      expiresAt: Date.now() + 60_000,
      intervalSeconds: 5,
    };
    const login = vi.fn<(input: RuntimeAuthLoginRequest) => Promise<RuntimeAuthLoginResult>>();
    login.mockResolvedValue(result);
    const client = {
      login,
    } satisfies Pick<RuntimeClient, "login">;

    await expect(client.login?.(request)).resolves.toEqual(result);
    expect(login).toHaveBeenCalledWith(request);
  });
});

describe("RuntimeClientSession send contract", () => {
  it("carries file and directory attachments", () => {
    const attachments: RuntimeAttachment[] = [
      { type: "file", path: "C:\\repo\\image.png", displayName: "image.png" },
      { type: "directory", path: "C:\\repo\\fixtures" },
    ];
    const options: RuntimeSendOptions = {
      prompt: "Inspect these inputs",
      attachments,
    };

    expect(options.attachments).toEqual(attachments);
  });
});
