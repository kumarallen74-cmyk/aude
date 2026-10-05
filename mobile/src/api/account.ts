import type { Http } from './http';
import { ApiError } from './http';
import type { DeletionBlocker, DeletionStart } from './types';

export type DeleteOutcome =
  | { kind: 'deleted'; deleted: string[]; retained: string[] }
  | { kind: 'blocked'; code: DeletionBlocker['code']; message: string; blockers: DeletionBlocker[] };

/**
 * §15.8 account deletion (App Store 5.1.1(v), Google Play): a code to the account's number, then immediate deletion.
 * Refused (409) while money is owed or a charge, hold, reservation or queue place is open — with the blockers.
 * Afterwards the app discards its device token and starts again as a guest.
 */
export const accountApi = (http: Http) => ({
  startDeletion: () => http.post<DeletionStart>('/v1/account/delete/start', {}),
  confirmDeletion: async (code: string): Promise<DeleteOutcome> => {
    try {
      const r = await http.post<{ ok: true; deleted: string[]; retained: string[] }>('/v1/account/delete', { code });
      return { kind: 'deleted', deleted: r.deleted, retained: r.retained };
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const body = (e.body ?? {}) as { code?: DeletionBlocker['code']; blockers?: DeletionBlocker[] };
        return { kind: 'blocked', code: body.code ?? 'unpaid', message: e.message, blockers: body.blockers ?? [] };
      }
      throw e;
    }
  },
});
