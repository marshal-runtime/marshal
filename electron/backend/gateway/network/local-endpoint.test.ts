import { describe, it, expect } from "vitest";

import { isLoopbackGatewayEndpoint } from "./local-endpoint";

describe("isLoopbackGatewayEndpoint", () => {
  it("returns true for localhost", () => {
    expect(isLoopbackGatewayEndpoint("ws://localhost:18789/v1/marshal-gateway")).toBe(true);
    expect(isLoopbackGatewayEndpoint("ws://localhost:8001")).toBe(true);
    expect(isLoopbackGatewayEndpoint("http://localhost/")).toBe(true);
  });

  it("returns true for 127.0.0.1", () => {
    expect(isLoopbackGatewayEndpoint("ws://127.0.0.1:18789/v1/marshal-gateway")).toBe(true);
  });

  it("returns true for IPv6 loopback", () => {
    expect(isLoopbackGatewayEndpoint("ws://[::1]:18789/v1/marshal-gateway")).toBe(true);
    expect(isLoopbackGatewayEndpoint("ws://[::1]")).toBe(true);
  });

  it("returns false for non-local hosts", () => {
    // Hosted gateway URLs — exactly the case where the device-approval
    // panel must NOT render: m's token has no admin scope, the call would
    // 401 anyway, and surfacing it would mislead the user.
    expect(isLoopbackGatewayEndpoint("wss://gateway.example.com/v1/marshal-gateway")).toBe(false);
    expect(isLoopbackGatewayEndpoint("wss://10.0.0.5/v1/marshal-gateway")).toBe(false);
    expect(isLoopbackGatewayEndpoint("wss://localhost.example.com/v1/marshal-gateway")).toBe(false);
  });

  it("returns false for malformed URLs (safe default)", () => {
    // Pre-spec / partially-configured gateways shouldn't accidentally enable
    // the local-only panel — fail closed.
    expect(isLoopbackGatewayEndpoint("not a url")).toBe(false);
    expect(isLoopbackGatewayEndpoint("")).toBe(false);
  });
});
