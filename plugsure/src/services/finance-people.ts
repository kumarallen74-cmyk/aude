import { many, outsideRequestScope } from '../db/pool.js';

/**
 * (v1.41.1) The people a finance user can name as a close step's owner or a card's holder: the
 * organisation's active console users, by id and name only. A finance manager may not read the
 * user list (user:read: roles, sign-ins, lock state), but must still be able to pick someone.
 */
export async function assignablePeople(orgId: string): Promise<{ id: string; name: string }[]> {
  return outsideRequestScope(() =>
    many<{ id: string; name: string }>(
      `SELECT id, name FROM app_user WHERE org_id = $1 AND status = 'active' AND email IS NOT NULL ORDER BY lower(name), id`,
      [orgId],
    ),
  );
}
