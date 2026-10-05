/** One Idempotency-Key per user attempt ([§14 G12]): kept while the outcome is unknown, rotated after an answer. */
import { api } from '@/api/client';
import { ApiError } from '@/api/http';
import { AttemptKey, withIdempotency } from '@/api/idempotency';
import { freshDevice } from '@/test/render';

const CONNECTOR = '00000000-0000-4000-8000-000000001001';

describe('AttemptKey', () => {
  it('keeps the key across retries after offline / timeout / 5xx / 429 / still processing', () => {
    const k = new AttemptKey();
    const body = { c: 'x', amount: 1 };
    const first = k.for(body);
    for (const e of [new ApiError('offline', '', 0), new ApiError('timeout', '', 0), new ApiError('server', '', 502), new ApiError('rate_limited', '', 429), new ApiError('business', '', 409, 'idempotency_in_progress')]) {
      k.settle(e);
      expect(k.for(body)).toBe(first);
    }
  });

  it('rotates after success or a business refusal', () => {
    const k = new AttemptKey();
    const a = k.for({ a: 1 });
    k.settle();
    const b = k.for({ a: 1 });
    expect(b).not.toBe(a);
    k.settle(new ApiError('business', 'Konektor ini sedang dipakai.', 422));
    expect(k.for({ a: 1 })).not.toBe(b);
  });

  it('a different request (amount, method changed) is a new attempt', () => {
    const k = new AttemptKey();
    const a = k.for({ amount: 1 });
    k.settle(new ApiError('timeout', '', 0));
    expect(k.for({ amount: 2 })).not.toBe(a);
  });
});

describe('withIdempotency', () => {
  it('asks again with the same key while the first request is still processing, then returns its answer', async () => {
    const run = jest
      .fn()
      .mockRejectedValueOnce(new ApiError('business', '', 409, 'idempotency_in_progress'))
      .mockResolvedValueOnce({ ok: true });
    await expect(withIdempotency('k1', run, { waitMs: 0 })).resolves.toEqual({ ok: true });
    expect(run.mock.calls).toEqual([['k1'], ['k1']]);
  });

  it('gives up after `tries` with the 409 (shown as "still processing") and never retries other errors', async () => {
    const busy = jest.fn().mockRejectedValue(new ApiError('business', '', 409, 'idempotency_in_progress'));
    await expect(withIdempotency('k', busy, { tries: 3, waitMs: 0 })).rejects.toMatchObject({ code: 'idempotency_in_progress' });
    expect(busy).toHaveBeenCalledTimes(3);
    const down = jest.fn().mockRejectedValue(new ApiError('offline', '', 0));
    await expect(withIdempotency('k', down, { waitMs: 0 })).rejects.toMatchObject({ kind: 'offline' });
    expect(down).toHaveBeenCalledTimes(1);
  });
});

describe('demo backend honours Idempotency-Key like the server', () => {
  beforeEach(() => freshDevice());

  it('a repeat returns the first answer (one charge); the same key with another body is 422 idempotency_key_reused', async () => {
    const a = await api.charge.prepaid(CONNECTOR, 100000, { method: 'QRIS' }, undefined, 'same-key');
    const b = await api.charge.prepaid(CONNECTOR, 100000, { method: 'QRIS' }, undefined, 'same-key');
    expect(b.chargeId).toBe(a.chargeId);
    await expect(api.charge.prepaid(CONNECTOR, 50000, { method: 'QRIS' }, undefined, 'same-key')).rejects.toMatchObject({ status: 422, code: 'idempotency_key_reused' });
    const c = await api.charge.prepaid(CONNECTOR, 100000, { method: 'QRIS' }, undefined, 'other-key');
    expect(c.chargeId).not.toBe(a.chargeId);
  });
});
