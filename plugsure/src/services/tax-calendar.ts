import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { LEGACY_CURRENCY } from '../domain/money.js';
import { periodTotals } from './withholding-tax.js';

/**
 * Tax filing calendar (v1.23.0). The monthly Indonesian obligations an operator has from what PlugSure records, each
 * due on a day of the month after the period (moved to the Monday when it falls on a weekend; public holidays are not
 * known, so check the calendar the tax office publishes):
 *
 *   pph23_pay      pay the PPh 23 withheld (Finance → Tax)                              default the 15th
 *   pph23_report   file the SPT Masa PPh Unifikasi                                       default the 20th
 *   ppn_pay        pay the PPN on fleet invoices less credit notes                       default the end of the month
 *   ppn_report     file the SPT Masa PPN                                                 default the end of the month
 *   efaktur        upload the period's fakturs to Coretax (fleet invoices with PPN)      default the 15th
 *   pph21_pay      (v1.32.0) pay the PPh 21 and 26 withheld from suppliers (the slips)   default the 15th
 *   pph21_report   (v1.32.0) file the SPT Masa PPh 21/26                                default the 20th
 *
 * The days are settings (Finance → Settings → Tax calendar): the rules change (PMK 81/2024) and an adviser may have
 * the operator file earlier. Each period's obligation is marked filed with the date, the reference (NTPN, BPE) and the
 * amount; with reminders on, the worker raises finance.tax_due (warning) from the reminder days before, critical once
 * overdue, and clears it when filed. What PlugSure knows of the amount is shown beside each (it is not the return: the accountant files).
 */

export class TaxCalendarError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const OBLIGATIONS = {
  pph23_pay: { label: 'Pay PPh 23 withheld', day: 15 },
  pph23_report: { label: 'File SPT Masa PPh Unifikasi (PPh 23)', day: 20 },
  ppn_pay: { label: 'Pay PPN', day: 31 },
  ppn_report: { label: 'File SPT Masa PPN', day: 31 },
  efaktur: { label: 'Upload e-Faktur to Coretax', day: 15 },
  pph21_pay: { label: 'Pay PPh 21/26 withheld', day: 15 },
  pph21_report: { label: 'File SPT Masa PPh 21/26', day: 20 },
} as const;
export type Obligation = keyof typeof OBLIGATIONS;
const KEYS = Object.keys(OBLIGATIONS) as Obligation[];
const KIND = 'finance.tax_due';
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const zone = () => config.billing.timeZone;
const localDay = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const addMonths = (m: string, n: number) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const t = y * 12 + (mo - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** The due date of a period's obligation: the day of the following month (clamped to its last day), a weekend moved to Monday. */
export function dueDate(period: string, day: number): string {
  const next = addMonths(period, 1);
  const [y, m] = next.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const d = new Date(Date.UTC(y, m - 1, Math.min(day, last)));
  const wd = d.getUTCDay();
  if (wd === 6) d.setUTCDate(d.getUTCDate() + 2);
  else if (wd === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export interface CalendarSettings { obligations: Record<Obligation, { enabled: boolean; day: number }>; reminderDays: number; reminders: boolean }

export async function settings(orgId: string): Promise<CalendarSettings> {
  const r = await outsideRequestScope(() => one<{ tax_calendar: any }>(`SELECT tax_calendar FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  const v = r?.tax_calendar ?? {};
  const obligations = Object.fromEntries(KEYS.map((k) => {
    const o = v.obligations?.[k] ?? {};
    return [k, { enabled: o.enabled !== false, day: Number(o.day ?? OBLIGATIONS[k].day) }];
  })) as CalendarSettings['obligations'];
  return { obligations, reminderDays: Number(v.reminderDays ?? 5), reminders: v.reminders === true };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>, userId: string | null): Promise<CalendarSettings> {
  const cur = await settings(orgId);
  const raw = (b.obligations ?? {}) as Record<string, any>;
  for (const k of Object.keys(raw)) if (!KEYS.includes(k as Obligation)) throw new TaxCalendarError(422, `Unknown obligation ${k}.`);
  const obligations = { ...cur.obligations };
  for (const k of KEYS) {
    if (!raw[k]) continue;
    const day = raw[k].day == null ? obligations[k].day : Number(raw[k].day);
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new TaxCalendarError(422, `${OBLIGATIONS[k].label}: the day is 1 to 31 of the following month (31 = its last day).`);
    obligations[k] = { enabled: raw[k].enabled === undefined ? obligations[k].enabled : raw[k].enabled === true, day };
  }
  const reminderDays = b.reminderDays == null || b.reminderDays === '' ? cur.reminderDays : Number(b.reminderDays);
  if (!Number.isInteger(reminderDays) || reminderDays < 0 || reminderDays > 30) throw new TaxCalendarError(422, 'Remind 0 to 30 days before.');
  const v = { obligations, reminderDays, reminders: b.reminders === undefined ? cur.reminders : b.reminders === true };
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, tax_calendar, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET tax_calendar = EXCLUDED.tax_calendar, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify(v), userId]));
  return v;
}

/** What PlugSure knows of each obligation's amount for the periods: PPh 23 withheld, PPN out (fleet invoices − credit notes), fakturs to upload. */
async function figures(orgId: string, periods: string[]) {
  const z = zone();
  const [wht, ppnInv, ppnCn, ef, sl] = await Promise.all([
    outsideRequestScope(() => many<{ period: string; amount: string; n: number }>(
      `SELECT period, COALESCE(sum(amount_minor), 0)::bigint AS amount, count(*)::int AS n FROM tax_withholding WHERE org_id = $1 AND voided_at IS NULL AND period = ANY($2::text[]) GROUP BY 1`, [orgId, periods])),
    outsideRequestScope(() => many<{ period: string; amount: string }>(
      `SELECT to_char(issued_at AT TIME ZONE $3, 'YYYY-MM') AS period, COALESCE(sum(tax_minor), 0)::bigint AS amount FROM fleet_invoice
        WHERE org_id = $1 AND status IN ('issued', 'paid') AND currency = $4 AND to_char(issued_at AT TIME ZONE $3, 'YYYY-MM') = ANY($2::text[]) GROUP BY 1`, [orgId, periods, z, LEGACY_CURRENCY])),
    outsideRequestScope(() => many<{ period: string; amount: string }>(
      `SELECT to_char(issued_at AT TIME ZONE $3, 'YYYY-MM') AS period, COALESCE(sum(tax_minor), 0)::bigint AS amount FROM fleet_credit_note
        WHERE org_id = $1 AND status = 'issued' AND currency = $4 AND to_char(issued_at AT TIME ZONE $3, 'YYYY-MM') = ANY($2::text[]) GROUP BY 1`, [orgId, periods, z, LEGACY_CURRENCY])),
    outsideRequestScope(() => many<{ period: string; total: number; open: number }>(
      `SELECT to_char(issued_at AT TIME ZONE $3, 'YYYY-MM') AS period, count(*)::int AS total, count(*) FILTER (WHERE efaktur_exported_at IS NULL)::int AS open FROM fleet_invoice
        WHERE org_id = $1 AND status IN ('issued', 'paid') AND tax_minor > 0 AND to_char(issued_at AT TIME ZONE $3, 'YYYY-MM') = ANY($2::text[]) GROUP BY 1`, [orgId, periods, z])),
    periodTotals(orgId, periods),
  ]);
  const out = new Map<string, { amount: number | null; detail: string }>();
  for (const p of periods) {
    const w = wht.find((x) => x.period === p);
    const ppn = Number(ppnInv.find((x) => x.period === p)?.amount ?? 0) - Number(ppnCn.find((x) => x.period === p)?.amount ?? 0);
    const e = ef.find((x) => x.period === p);
    const whtAmt = Number(w?.amount ?? 0);
    out.set(`pph23_pay:${p}`, { amount: whtAmt, detail: `${w?.n ?? 0} PPh 23 record(s) (Finance → Tax)` });
    out.set(`pph23_report:${p}`, { amount: whtAmt, detail: `${w?.n ?? 0} PPh 23 record(s)` });
    out.set(`ppn_pay:${p}`, { amount: ppn, detail: 'PPN on fleet invoices less credit notes (input VAT not known here)' });
    out.set(`ppn_report:${p}`, { amount: ppn, detail: 'PPN on fleet invoices less credit notes' });
    out.set(`efaktur:${p}`, { amount: null, detail: e ? `${e.total} faktur(s), ${e.open} not exported yet` : 'no fleet invoice with PPN' });
    // (v1.32.0) Supplier withholding slips: PPh 21 and 26 go on the SPT Masa PPh 21/26; PPh 23 slips add to the PPh 23 figures.
    const s21 = sl.filter((x) => x.month === p && x.kind !== 'pph23');
    const s23 = sl.find((x) => x.month === p && x.kind === 'pph23');
    const a21 = s21.reduce((a, x) => a + x.amount, 0), n21 = s21.reduce((a, x) => a + x.count, 0), d21 = s21.reduce((a, x) => a + x.drafts, 0);
    const d = `${n21} slip(s)${d21 ? `, ${d21} not issued` : ''} (Finance → Tax → Withholding slips)`;
    out.set(`pph21_pay:${p}`, { amount: a21, detail: d });
    out.set(`pph21_report:${p}`, { amount: a21, detail: d });
    if (s23) {
      for (const k of ['pph23_pay', 'pph23_report']) {
        const g = out.get(`${k}:${p}`)!;
        out.set(`${k}:${p}`, { amount: (g.amount ?? 0) + s23.amount, detail: `${g.detail}; ${s23.count} supplier slip(s)` });
      }
    }
  }
  return out;
}

/** The calendar from 6 periods back to the current one: each obligation's due date, status, amount and filing. */
export async function calendar(orgId: string, now = new Date()) {
  const st = await settings(orgId);
  const today = localDay(now), cur = today.slice(0, 7);
  const periods = Array.from({ length: 7 }, (_, i) => addMonths(cur, -i)).reverse();
  const [fig, filings] = await Promise.all([
    figures(orgId, periods),
    outsideRequestScope(() => many<any>(
      `SELECT f.*, to_char(f.filed_on, 'YYYY-MM-DD') AS d, u.name AS by_name FROM tax_filing f LEFT JOIN app_user u ON u.id = f.filed_by
        WHERE f.org_id = $1 AND f.period = ANY($2::text[]) AND f.voided_at IS NULL`, [orgId, periods])),
  ]);
  const items: any[] = [];
  for (const p of periods) {
    for (const k of KEYS) {
      if (!st.obligations[k].enabled) continue;
      const due = dueDate(p, st.obligations[k].day);
      const f = filings.find((x) => x.obligation === k && x.period === p);
      const days = daysBetween(today, due);
      const status = f ? 'filed' : days < 0 ? 'overdue' : days <= st.reminderDays ? 'due_soon' : 'upcoming';
      const g = fig.get(`${k}:${p}`)!;
      items.push({
        obligation: k, label: OBLIGATIONS[k].label, period: p, dueDate: due, daysLeft: days, status, amount: g.amount, detail: g.detail,
        filing: f ? { id: String(f.id), filedOn: f.d, reference: f.reference, amount: f.amount_minor == null ? null : Number(f.amount_minor), note: f.note ?? null, by: f.by_name ?? null } : null,
      });
    }
  }
  items.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.obligation.localeCompare(b.obligation));
  return { today, settings: st, labels: Object.fromEntries(KEYS.map((k) => [k, OBLIGATIONS[k].label])), items };
}

export async function markFiled(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const k = String(b.obligation ?? '') as Obligation;
  if (!KEYS.includes(k)) throw new TaxCalendarError(422, `obligation is one of ${KEYS.join(', ')}.`);
  const period = String(b.period ?? '');
  if (!MONTH_RE.test(period)) throw new TaxCalendarError(422, 'period is YYYY-MM.');
  const filedOn = String(b.filedOn ?? '');
  if (!DATE_RE.test(filedOn) || Number.isNaN(Date.parse(`${filedOn}T00:00:00Z`))) throw new TaxCalendarError(422, 'filedOn is the date it was filed or paid (YYYY-MM-DD).');
  if (filedOn > localDay()) throw new TaxCalendarError(422, 'filedOn cannot be in the future.');
  const reference = String(b.reference ?? '').trim();
  if (reference.length < 3 || reference.length > 80) throw new TaxCalendarError(422, 'Give the reference (NTPN, BPE or receipt number; 3 to 80 characters).');
  const amount = b.amount == null || b.amount === '' ? null : Number(b.amount);
  if (amount != null && (!Number.isInteger(amount) || amount < 0)) throw new TaxCalendarError(422, 'The amount is a whole number of rupiah, 0 or more.');
  try {
    const r = await outsideRequestScope(() => one<{ id: string }>(
      `INSERT INTO tax_filing (org_id, obligation, period, filed_on, reference, amount_minor, note, filed_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [orgId, k, period, filedOn, reference, amount, b.note == null || b.note === '' ? null : String(b.note).slice(0, 300), userId]));
    await outsideRequestScope(() => resolveAlertsFor(orgId, KIND, 'tax_obligation', `${k}:${period}`)).catch(() => 0);
    return { id: String(r!.id), obligation: k, period, filedOn, reference, amount };
  } catch (e) {
    if ((e as any).code === '23505') throw new TaxCalendarError(409, `${OBLIGATIONS[k].label} for ${period} is already marked filed: void it first to correct it.`);
    throw e;
  }
}

export async function voidFiling(orgId: string, id: string, reasonRaw: unknown, userId: string | null) {
  if (!/^\d{1,18}$/.test(id)) throw new TaxCalendarError(404, 'No such filing.');
  const reason = String(reasonRaw ?? '').trim();
  if (reason.length < 3 || reason.length > 300) throw new TaxCalendarError(422, 'Say why it is voided (3 to 300 characters).');
  const r = await outsideRequestScope(() => one(`UPDATE tax_filing SET voided_at = now(), voided_by = $3, void_reason = $4 WHERE id = $1 AND org_id = $2 AND voided_at IS NULL RETURNING id`, [id, orgId, userId, reason]));
  if (!r) throw new TaxCalendarError(404, 'No such filing, or already voided.');
  return { ok: true };
}

/** The worker: for every organisation with reminders on, raise finance.tax_due for what is due soon or overdue. */
export async function remind(now = new Date()): Promise<number> {
  const orgs = await outsideRequestScope(() => many<{ id: string }>(
    `SELECT org_id AS id FROM finance_org_settings WHERE (tax_calendar->>'reminders')::boolean IS TRUE`));
  let n = 0;
  for (const o of orgs) {
    try {
      const c = await calendar(o.id, now);
      for (const it of c.items) {
        const target = `${it.obligation}:${it.period}`;
        if (it.status === 'overdue' || it.status === 'due_soon') {
          await outsideRequestScope(() => persistAlert({ orgId: o.id, kind: KIND, severity: it.status === 'overdue' ? 'critical' : 'warning', targetType: 'tax_obligation', targetId: target,
            message: `${it.label} for ${it.period} ${it.status === 'overdue' ? `was due on ${it.dueDate} (${-it.daysLeft} day(s) ago)` : `is due on ${it.dueDate}`}. Mark it filed in Finance → Tax → Calendar.` }));
          n++;
        } else if (it.status === 'filed') {
          await outsideRequestScope(() => resolveAlertsFor(o.id, KIND, 'tax_obligation', target)).catch(() => 0);
        }
      }
    } catch (e) { logger.warn({ org: o.id, err: (e as Error).message }, 'tax calendar reminders failed'); }
  }
  return n;
}
