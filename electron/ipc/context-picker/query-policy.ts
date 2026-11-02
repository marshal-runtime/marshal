export const PER_TYPE_LIMIT = 8;

export function isZeroQuery(query: string): boolean {
  return query.trim().length === 0;
}
