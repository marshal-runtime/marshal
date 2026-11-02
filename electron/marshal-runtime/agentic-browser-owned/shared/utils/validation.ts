import type { ZodSchema, ZodIssue } from 'zod';
import type { Result } from '../types/tools.js';

/** Validation failure details. */
export interface ValidationError {
  readonly field: string;
  readonly message: string;
}

/**
 * Validate unknown input against a Zod schema.
 *
 * Returns a Result with the parsed value on success, or an array
 * of validation errors on failure.
 *
 * @param schema - The Zod schema to validate against
 * @param input - The unknown input to validate
 * @returns Parsed value or validation errors
 */
export function validateInput<T>(
  schema: ZodSchema<T>,
  input: unknown,
): Result<T, readonly ValidationError[]> {
  const result = schema.safeParse(input);

  if (result.success) {
    return { ok: true, value: result.data };
  }

  const errors: ValidationError[] = result.error.issues.map((issue: ZodIssue) => ({
    field: issue.path.join('.'),
    message: issue.message,
  }));

  return { ok: false, error: errors };
}
