import { one, many, query } from '../db/pool.js';

/**
 * On-call rotas: who is on duty this week (or day).
 *
 * A rota is an ordered list of alert contacts. Shifts are a day or a week long and hand over at
 * a local time (ALERT_TIMEZONE); the first shift begins at that time on the start date and goes
 * to the first member, the next to the second, and so on, wrapping round. An override puts
 * someone else on duty for a period (leave, a swap) and wins over the rotation.
 *
 * Rules (and their escalations) can notify "whoever is on duty" on a rota, alongside or instead
 * of named contacts; the person is looked up when the alert is routed.
 */

export interface Rota { id: string; name: string; member_ids: string[]; shift: 'daily' | 'weekly'; handover_time: string; starts_on: string | Date }
export interface Override { id?: string; rota_id: string; contact_id: string; starts_at: string | Date; ends_at: string | Date; note?: string | null; created_at?: string | Date }

/** Minutes east of UTC in a time zone at an instant (Asia/Jakarta: 420). */
function offsetMinutes(tz: string, at: Date): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(name);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
}

/** The instant a local date and time (in tz) happens. */
export function zonedInstant(date: string, time: string, tz: string): Date {
  const [y, mo, d] = date.slice(0, 10).split('-').map(Number) as [number, number, number];
  const [h, mi] = time.slice(0, 5).split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  return new Date(guess - offsetMinutes(tz, new Date(guess)) * 60_000);
}

const dateStr = (d: string | Date) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/**
 * Who is on duty at `at`: an override covering that moment (the most recently created one), else the
 * rotation's member for that shift. Null before the first shift, or with no members. Also the shift's
 * end (the next handover) and who takes over then.
 */
export function onDuty(rota: Rota, overrides: Override[], at: Date, tz: string): { contactId: string | null; override: boolean; shiftEnds: Date | null; nextContactId: string | null } {
  const ov = overrides
    .filter((o) => o.rota_id === rota.id && new Date(o.starts_at) <= at && at < new Date(o.ends_at))
    .sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())[0];
  const n = rota.member_ids.length;
  const first = zonedInstant(dateStr(rota.starts_on), String(rota.handover_time), tz);
  const period = (rota.shift === 'daily' ? 1 : 7) * 24 * 60 * 60_000;
  let shiftEnds: Date | null = null, member: string | null = null, next: string | null = null;
  if (n && at >= first) {
    const k = Math.floor((at.getTime() - first.getTime()) / period);
    member = rota.member_ids[k % n]!;
    next = rota.member_ids[(k + 1) % n]!;
    shiftEnds = new Date(first.getTime() + (k + 1) * period);
  } else if (n) {
    next = rota.member_ids[0]!;
    shiftEnds = first;
  }
  if (ov) return { contactId: ov.contact_id, override: true, shiftEnds: new Date(ov.ends_at) < (shiftEnds ?? new Date(8.64e15)) ? new Date(ov.ends_at) : shiftEnds, nextContactId: member ?? next };
  return { contactId: member, override: false, shiftEnds, nextContactId: next };
}

// ─────────────────────────────────────────── storage (API)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function listRotas(orgId: string, tz: string) {
  const [rotas, overrides] = await Promise.all([
    many<Rota & { created_at: Date }>(`SELECT id, name, member_ids, shift, handover_time, starts_on::text AS starts_on, created_at FROM on_call_rota WHERE org_id = $1 ORDER BY name`, [orgId]),
    many<Override>(`SELECT id, rota_id, contact_id, starts_at, ends_at, note, created_at FROM on_call_override WHERE org_id = $1 AND ends_at > now() - interval '7 days' ORDER BY starts_at`, [orgId]),
  ]);
  const now = new Date();
  return rotas.map((r) => ({ ...r, handover_time: String(r.handover_time).slice(0, 5), duty: onDuty(r, overrides, now, tz), overrides: overrides.filter((o) => o.rota_id === r.id) }));
}

/** Everyone on duty now, per rota id (for routing). */
export async function dutyNow(orgId: string, tz: string, at = new Date()): Promise<Map<string, string | null>> {
  const [rotas, overrides] = await Promise.all([
    many<Rota>(`SELECT id, name, member_ids, shift, handover_time, starts_on::text AS starts_on FROM on_call_rota WHERE org_id = $1`, [orgId]),
    many<Override>(`SELECT rota_id, contact_id, starts_at, ends_at, created_at FROM on_call_override WHERE org_id = $1 AND starts_at <= $2 AND ends_at > $2`, [orgId, at]),
  ]);
  return new Map(rotas.map((r) => [r.id, onDuty(r, overrides, at, tz).contactId]));
}

export async function saveRota(orgId: string, id: string | null, input: any) {
  const name = String(input?.name ?? '').trim().slice(0, 120);
  if (!name) return { error: 'Give the rota a name.' };
  const members = [...new Set<string>((Array.isArray(input?.memberIds) ? input.memberIds : []).map((x: unknown) => String(x)))].filter((x) => UUID_RE.test(x));
  if (!members.length) return { error: 'Choose at least one person, in the order they take shifts.' };
  const shift = input?.shift === 'daily' ? 'daily' : input?.shift === 'weekly' || input?.shift == null ? 'weekly' : null;
  if (!shift) return { error: 'Shifts are daily or weekly.' };
  const handover = String(input?.handoverTime ?? '08:00').trim();
  if (!HHMM.test(handover)) return { error: 'Enter the handover time as HH:MM, e.g. 08:00.' };
  const startsOn = String(input?.startsOn ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startsOn) || Number.isNaN(Date.parse(startsOn))) return { error: 'Enter the date the first shift starts.' };
  const owned = await one<{ n: number }>(`SELECT count(*)::int AS n FROM alert_contact WHERE org_id = $1 AND id = ANY($2::uuid[])`, [orgId, members]);
  if (owned?.n !== members.length) return { error: 'A chosen person is not one of this organisation\'s contacts.' };
  const row = id
    ? await one(`UPDATE on_call_rota SET name = $3, member_ids = $4, shift = $5, handover_time = $6, starts_on = $7, updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING id`, [id, orgId, name, members, shift, handover, startsOn])
    : await one(`INSERT INTO on_call_rota (org_id, name, member_ids, shift, handover_time, starts_on) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [orgId, name, members, shift, handover, startsOn]);
  return row ? { rota: row as { id: string } } : { error: 'not found' };
}

export async function deleteRota(orgId: string, id: string) {
  // Take it out of every rule too, so no rule points at a rota that is gone.
  await query(`UPDATE alert_rule SET rota_ids = array_remove(rota_ids, $2::uuid), escalate_rota_ids = array_remove(escalate_rota_ids, $2::uuid) WHERE org_id = $1`, [orgId, id]);
  const r = await query(`DELETE FROM on_call_rota WHERE id = $1 AND org_id = $2`, [id, orgId]);
  return (r.rowCount ?? 0) > 0;
}

export async function addOverride(orgId: string, rotaId: string, input: any) {
  const contact = String(input?.contactId ?? '');
  const startsAt = new Date(String(input?.startsAt ?? '')), endsAt = new Date(String(input?.endsAt ?? ''));
  if (!UUID_RE.test(contact)) return { error: 'Choose who covers.' };
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) return { error: 'Enter a start and an end, the end after the start.' };
  if (endsAt.getTime() - startsAt.getTime() > 92 * 24 * 60 * 60_000) return { error: 'An override covers at most 92 days; change the rota for longer.' };
  const ok = await one<{ rota: boolean; contact: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM on_call_rota WHERE id = $2 AND org_id = $1) AS rota, EXISTS (SELECT 1 FROM alert_contact WHERE id = $3 AND org_id = $1) AS contact`,
    [orgId, rotaId, contact]);
  if (!ok?.rota) return { error: 'not found' };
  if (!ok.contact) return { error: 'That person is not one of this organisation\'s contacts.' };
  const row = await one<{ id: string }>(
    `INSERT INTO on_call_override (org_id, rota_id, contact_id, starts_at, ends_at, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [orgId, rotaId, contact, startsAt, endsAt, input?.note ? String(input.note).slice(0, 200) : null]);
  return { override: row! };
}

export async function deleteOverride(orgId: string, rotaId: string, id: string) {
  const r = await query(`DELETE FROM on_call_override WHERE id = $1 AND rota_id = $2 AND org_id = $3`, [id, rotaId, orgId]);
  return (r.rowCount ?? 0) > 0;
}
