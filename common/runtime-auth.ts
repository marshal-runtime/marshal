export type RuntimeAuthLoginRequest =
  | { type: "api-key"; apiKey: string }
  | { type: "browser" }
  | { type: "device-code" }
  | {
      type: "external-token";
      accessToken: string;
      accountId?: string;
      planType?: string;
    }
  | { type: "amazon-bedrock"; apiKey: string; region: string };

export type RuntimeInteractiveAuthMethod = Extract<
  RuntimeAuthLoginRequest["type"],
  "api-key" | "browser" | "device-code"
>;

export interface RuntimeAuthStatus {
  isAuthenticated: boolean;
  login?: string;
  statusMessage?: string;
}

export type RuntimeAuthLoginState =
  | { status: "authenticated" }
  | {
      status: "pending";
      method: "browser" | "device-code";
      verificationUri?: string;
      userCode?: string;
    };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isRuntimeAuthLoginRequest(value: unknown): value is RuntimeAuthLoginRequest {
  if (!value || typeof value !== "object") return false;
  const type = Reflect.get(value, "type");
  switch (type) {
    case "browser":
    case "device-code":
      return true;
    case "api-key":
      return isNonEmptyString(Reflect.get(value, "apiKey"));
    case "external-token":
      return (
        isNonEmptyString(Reflect.get(value, "accessToken")) &&
        (Reflect.get(value, "accountId") === undefined ||
          typeof Reflect.get(value, "accountId") === "string") &&
        (Reflect.get(value, "planType") === undefined ||
          typeof Reflect.get(value, "planType") === "string")
      );
    case "amazon-bedrock":
      return (
        isNonEmptyString(Reflect.get(value, "apiKey")) &&
        isNonEmptyString(Reflect.get(value, "region"))
      );
    default:
      return false;
  }
}
