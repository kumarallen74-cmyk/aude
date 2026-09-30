/**
 * `limit` and `offset` query parameters, parsed once for every list route.
 *
 * Routes used to pass `Number(q.limit)` straight to SQL, capping only the top: a negative limit
 * reached PostgreSQL ("LIMIT must not be negative") and came back as a 500, and a fraction or
 * text was only rejected because the database choked on it. Now a bad value is the caller's
 * mistake, said plainly (400); a large one is still capped, as before.
 */
export class PagingError extends Error {
  statusCode = 400;
}

const present = (raw: unknown) => raw !== undefined && raw !== null && raw !== '';

/** A page size: a whole number of at least 1. Absent → `def`; above `max` → `max`. */
export function limitParam(raw: unknown, def: number, max: number): number {
  if (!present(raw)) return Math.min(def, max);
  const s = String(raw).trim();
  if (!/^\d+$/.test(s) || Number(s) < 1) throw new PagingError('limit must be a whole number of at least 1');
  return Math.min(Number(s), max);
}

/** An offset: a whole number, 0 or more. Absent → 0. */
export function offsetParam(raw: unknown, max = 1_000_000): number {
  if (!present(raw)) return 0;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) throw new PagingError('offset must be a whole number, 0 or more');
  return Math.min(Number(s), max);
}
