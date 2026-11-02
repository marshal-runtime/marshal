import { z } from "zod";

export const AgentRuntimeSchema = z.enum(["claude", "copilot"]);
export type AgentRuntime = z.infer<typeof AgentRuntimeSchema>;

export const PermissionProfileSchema = z.enum(["review", "default"]);
export type PermissionProfileName = z.infer<typeof PermissionProfileSchema>;

export const TurnSchema = z.object({
  at: z.string(),
  promptText: z.string(),
  responseText: z.string(),
  stopReason: z.string().optional(),
  usageOutputTokens: z.number().int().nonnegative().optional(),
});
export type Turn = z.infer<typeof TurnSchema>;

export const SessionRecordSchema = z.object({
  title: z.string(),
  sessionId: z.string(),
  runtime: AgentRuntimeSchema,
  cwd: z.string(),
  permissionProfile: PermissionProfileSchema,
  startedAt: z.string(),
  completedAt: z.string().optional(),
  turns: z.array(TurnSchema).min(1),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const MarshalAcpConfigSchema = z.object({
  defaultRuntime: AgentRuntimeSchema.default("claude"),
  defaultPermissionProfile: PermissionProfileSchema.default("default"),
  maxLifetimeMs: z
    .number()
    .int()
    .positive()
    .default(30 * 60_000),
});
export type MarshalAcpConfig = z.infer<typeof MarshalAcpConfigSchema>;
