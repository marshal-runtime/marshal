// Throwing unwrap for zod safeParse — avoids `if (result.success) { expect(...) }`
// patterns that trip vitest/no-conditional-expect.
// Marshal ownership: relocated module identity.
export function expectZodSuccess<T>(
  result: { success: true; data: T } | { success: false; error: { message: string } },
): T {
  if (!result.success) {
    throw new Error(`expected zod parse to succeed, got error: ${result.error.message}`);
  }
  return result.data;
}
