import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { seal, unseal } from './secrets.js';
import { assertOpen } from './finance-periods.js';
import { gate, type Approver } from './finance-approvals.js';
import { reportingCurrency, currencies } from './fx.js';
import { pasal17 } from './withholding-tax.js';
import { PdfDoc, Flow } from './pdf.js';
import { xlsx } from './xlsx.js';

/**
 * Payroll and staff costs (v1.33.0). The operator's own employees, paid monthly:
 *
 *   employee      salary and fixed allowances, PTKP status, NIK and NPWP, BPJS Kesehatan and Ketenagakerjaan, the JKK
 *                 rate (by the work's risk, 0.24% to 1.74%), the bank account (sealed), start and end
 *   run           a month's payroll in a currency, drafted from the employees in service that month; each line takes
 *                 overtime, a bonus and other deductions; submitted, approved under the approvals matrix (kind
 *                 payroll_run), paid from a cash account on a day; voided while not paid
 *   BPJS          Kesehatan 5% (employer 4%, employee 1%) of the salary and fixed allowances, capped (default 12 million);
 *                 JHT 5.7% (employer 3.7%, employee 2%); JP 3% (employer 2%, employee 1%) capped (default 10 547 400);
 *                 JKK at the employee's rate and JKM 0.3%, both the employer's. The caps are settings.
 *   PPh 21        (PP 58/2023, PMK 168/2023) January to November: the monthly TER rate of the employee's category (A:
 *                 TK/0, TK/1, K/0; B: TK/2, TK/3, K/1, K/2; C: K/3) on the month's gross (salary, allowances, overtime,
 *                 bonus, and the employer's JKK, JKM and BPJS Kesehatan); December, or the last month of a leaver: the
 *                 year's tax — the year's gross less the occupational cost (5%, at most 6 million a year), the
 *                 employee's JHT and JP, and the PTKP, rounded down to the thousand, at the Pasal 17 rates — less what was
 *                 withheld in the year's earlier months. 20% more without an NPWP or NIK. The TER tables can be
 *                 replaced in the settings.
 *   outputs       payslips (PDF), the bank transfer list (CSV), the run (Excel); the ledger's payroll entry (salaries,
 *                 the employer's BPJS, net pay, PPh 21 and BPJS payable; paid against the bank); the cash position
 *                 counts the payment
 */

export class PayrollError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const PTKP_STATUSES = ['TK/0', 'TK/1', 'TK/2', 'TK/3', 'K/0', 'K/1', 'K/2', 'K/3'] as const;
export type Ptkp = typeof PTKP_STATUSES[number];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const lastDay = (m: string) => { const [y, mo] = m.split('-').map(Number) as [number, number]; return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`; };
const ERR = (st: number, msg: string) => new PayrollError(st, msg);
const aad = (orgId: string) => `employee_account:${orgId}`;
const int = (v: unknown, what: string, min = 0) => {
  const n = v == null || v === '' ? 0 : Number(v);
  if (!Number.isInteger(n) || n < min) throw new PayrollError(422, `${what} is a whole amount, ${min} or more.`);
  return n;
};

// ─────────────────────────────────────────── the rules

/** PTKP per year (PMK 101/2016): 54 million, 4.5 million more when married and per dependant (up to 3). */
export function ptkpAmount(s: Ptkp): number {
  const [k, d] = s.split('/') as [string, string];
  return 54_000_000 + (k === 'K' ? 4_500_000 : 0) + Number(d) * 4_500_000;
}

export function terCategory(s: Ptkp): 'A' | 'B' | 'C' {
  if (s === 'TK/0' || s === 'TK/1' || s === 'K/0') return 'A';
  if (s === 'K/3') return 'C';
  return 'B';
}

/** The TER monthly tables (PP 58/2023, annex): up to the monthly gross, the rate %. To be confirmed by a tax adviser. */
export const TER: Record<'A' | 'B' | 'C', Array<[number, number]>> = {
  A: [[5_400_000, 0], [5_650_000, 0.25], [5_950_000, 0.5], [6_300_000, 0.75], [6_750_000, 1], [7_500_000, 1.25], [8_550_000, 1.5], [9_650_000, 1.75], [10_050_000, 2], [10_350_000, 2.25],
    [10_700_000, 2.5], [11_050_000, 3], [11_600_000, 3.5], [12_500_000, 4], [13_750_000, 5], [15_100_000, 6], [16_950_000, 7], [19_750_000, 8], [24_150_000, 9], [26_450_000, 10],
    [28_000_000, 11], [30_050_000, 12], [32_400_000, 13], [35_400_000, 14], [39_100_000, 15], [43_850_000, 16], [47_800_000, 17], [51_400_000, 18], [56_300_000, 19], [62_200_000, 20],
    [68_600_000, 21], [77_500_000, 22], [89_000_000, 23], [103_000_000, 24], [125_000_000, 25], [157_000_000, 26], [206_000_000, 27], [337_000_000, 28], [454_000_000, 29], [550_000_000, 30],
    [695_000_000, 31], [910_000_000, 32], [1_400_000_000, 33], [Infinity, 34]],
  B: [[6_200_000, 0], [6_500_000, 0.25], [6_850_000, 0.5], [7_300_000, 0.75], [9_200_000, 1], [10_750_000, 1.5], [11_250_000, 2], [11_600_000, 2.5], [12_600_000, 3], [13_600_000, 4],
    [14_950_000, 5], [16_400_000, 6], [18_450_000, 7], [21_850_000, 8], [26_000_000, 9], [27_700_000, 10], [29_350_000, 11], [31_450_000, 12], [33_950_000, 13], [37_100_000, 14],
    [41_100_000, 15], [45_800_000, 16], [49_500_000, 17], [53_800_000, 18], [58_500_000, 19], [64_000_000, 20], [71_000_000, 21], [80_000_000, 22], [93_000_000, 23], [109_000_000, 24],
    [129_000_000, 25], [163_000_000, 26], [211_000_000, 27], [374_000_000, 28], [459_000_000, 29], [555_000_000, 30], [704_000_000, 31], [957_000_000, 32], [1_405_000_000, 33], [Infinity, 34]],
  C: [[6_600_000, 0], [6_950_000, 0.25], [7_350_000, 0.5], [7_800_000, 0.75], [8_850_000, 1], [9_800_000, 1.25], [10_950_000, 1.5], [11_200_000, 1.75], [12_050_000, 2], [12_950_000, 3],
    [14_150_000, 4], [15_550_000, 5], [17_050_000, 6], [19_500_000, 7], [22_700_000, 8], [26_600_000, 9], [28_100_000, 10], [30_100_000, 11], [32_600_000, 12], [35_400_000, 13],
    [38_900_000, 14], [43_000_000, 15], [47_400_000, 16], [51_200_000, 17], [55_800_000, 18], [60_400_000, 19], [66_700_000, 20], [74_500_000, 21], [83_200_000, 22], [95_600_000, 23],
    [110_000_000, 24], [134_000_000, 25], [169_000_000, 26], [221_000_000, 27], [390_000_000, 28], [463_000_000, 29], [561_000_000, 30], [709_000_000, 31], [965_000_000, 32], [1_419_000_000, 33], [Infinity, 34]],
};

export function terRate(table: Array<[number, number]>, gross: number): number {
  for (const [upTo, rate] of table) if (gross <= upTo) return rate;
  return table[table.length - 1]![1];
}

export interface Rules { kesCap: number; jpCap: number; ter: typeof TER }
export async function rules(orgId: string): Promise<Rules> {
  const r = await outsideRequestScope(() => one<{ payroll: any }>(`SELECT payroll FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  const s = r?.payroll ?? {};
  const ter = { ...TER };
  for (const k of ['A', 'B', 'C'] as const) if (Array.isArray(s.ter?.[k]) && s.ter[k].length) ter[k] = (s.ter[k] as Array<[number | null, number]>).map(([u, rt]) => [u == null ? Infinity : Number(u), Number(rt)]);
  return { kesCap: Number(s.kesCap ?? 12_000_000), jpCap: Number(s.jpCap ?? 10_547_400), ter };
}

export async function saveRules(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const cur = await outsideRequestScope(() => one<{ payroll: any }>(`SELECT payroll FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  const v = { ...(cur?.payroll ?? {}) };
  for (const k of ['kesCap', 'jpCap'] as const) if (b[k] !== undefined) {
    const n = Number(b[k]);
    if (!Number.isInteger(n) || n <= 0) throw new PayrollError(422, `${k} is a whole amount above 0.`);
    v[k] = n;
  }
  if (b.ter !== undefined) {
    if (b.ter === null) delete v.ter;
    else {
      const t = b.ter as Record<string, unknown>;
      for (const [k, rows] of Object.entries(t)) {
        if (!['A', 'B', 'C'].includes(k) || !Array.isArray(rows) || rows.length < 2) throw new PayrollError(422, 'ter is { A|B|C: [[upTo or null, ratePct], …] } in ascending order.');
        let last = -1;
        for (const r of rows as unknown[]) {
          if (!Array.isArray(r) || r.length !== 2 || !Number.isFinite(Number(r[1])) || Number(r[1]) < 0 || Number(r[1]) > 50) throw new PayrollError(422, `ter.${k}: each row is [upTo, ratePct].`);
          const u = r[0] == null ? Infinity : Number(r[0]);
          if (!(u > last)) throw new PayrollError(422, `ter.${k}: the bands go up.`);
          last = u;
        }
        if (last !== Infinity) throw new PayrollError(422, `ter.${k}: the last band has no upper limit (null).`);
      }
      v.ter = t;
    }
  }
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, payroll, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET payroll = EXCLUDED.payroll, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify(v), userId]));
  const r = await rules(orgId);
  return { kesCap: r.kesCap, jpCap: r.jpCap, terOverridden: !!v.ter };
}

export interface LineInput { base: number; allowance: number; overtime: number; bonus: number; deduction: number }
export interface EmpRules { ptkp: Ptkp; hasTaxId: boolean; kes: boolean; tk: boolean; jkkPct: number }

/** BPJS for a month: the employee's and the employer's parts. */
export function bpjs(e: EmpRules, wage: number, r: Pick<Rules, 'kesCap' | 'jpCap'>) {
  const kesBase = Math.min(wage, r.kesCap), jpBase = Math.min(wage, r.jpCap);
  const p = (base: number, pct: number) => Math.round((base * pct) / 100);
  const out = {
    kesEmployer: e.kes ? p(kesBase, 4) : 0, kesEmployee: e.kes ? p(kesBase, 1) : 0,
    jhtEmployer: e.tk ? p(wage, 3.7) : 0, jhtEmployee: e.tk ? p(wage, 2) : 0,
    jpEmployer: e.tk ? p(jpBase, 2) : 0, jpEmployee: e.tk ? p(jpBase, 1) : 0,
    jkk: e.tk ? p(wage, e.jkkPct) : 0, jkm: e.tk ? p(wage, 0.3) : 0,
  };
  return { ...out, employer: out.kesEmployer + out.jhtEmployer + out.jpEmployer + out.jkk + out.jkm, employee: out.kesEmployee + out.jhtEmployee + out.jpEmployee };
}

/**
 * One employee's month. `prior` is the year's earlier months (gross, PPh 21 withheld, the employee's JHT + JP) for the
 * annual calculation in December or the leaver's last month.
 */
export function computeLine(e: EmpRules, x: LineInput, r: Rules, annual: { final: boolean; prior: { gross: number; pph21: number; pension: number; months: number } }) {
  const wage = x.base + x.allowance;
  const b = bpjs(e, wage, r);
  const gross = x.base + x.allowance + x.overtime + x.bonus + b.jkk + b.jkm + b.kesEmployer;
  const cat = terCategory(e.ptkp);
  let pph21: number, method: string, rate: number | null = null, detail: Record<string, number> | null = null;
  if (!annual.final) {
    rate = terRate(r.ter[cat], gross);
    pph21 = Math.round((gross * rate) / 100);
    method = `TER ${cat}`;
  } else {
    const yGross = annual.prior.gross + gross;
    const months = annual.prior.months + 1;
    const jabatan = Math.min(Math.round(yGross * 0.05), 500_000 * months);
    const pension = annual.prior.pension + b.jhtEmployee + b.jpEmployee;
    const net = yGross - jabatan - pension;
    const pkp = Math.max(0, Math.floor((net - ptkpAmount(e.ptkp)) / 1000) * 1000);
    const yearTax = pasal17(pkp);
    pph21 = yearTax - annual.prior.pph21;
    method = 'annual (Pasal 17)';
    detail = { yearGross: yGross, occupationalCost: jabatan, pension, net, ptkp: ptkpAmount(e.ptkp), pkp, yearTax, withheldBefore: annual.prior.pph21 };
  }
  if (!e.hasTaxId) pph21 = Math.round(pph21 * 1.2);
  const net = x.base + x.allowance + x.overtime + x.bonus - b.employee - pph21 - x.deduction;
  return { gross, pph21, net, employer: b.employer, employeeBpjs: b.employee, bpjs: b, category: cat, rate, method, detail };
}

// ─────────────────────────────────────────── employees

const empView = (r: any) => {
  let acct: string | null = null;
  try { acct = r.account_sealed ? unseal(r.account_sealed, aad(r.org_id)) : null; } catch { acct = null; }
  return {
    id: String(r.id), number: r.number, name: r.name, email: r.email ?? null, nik: r.nik ?? null, npwp: r.npwp ?? null, ptkp: r.ptkp as Ptkp, category: terCategory(r.ptkp),
    position: r.position ?? null, siteId: r.site_id ?? null, currency: r.currency, baseSalary: Number(r.base_salary_minor), allowance: Number(r.allowance_minor),
    bpjsKesehatan: r.bpjs_kesehatan, bpjsKetenagakerjaan: r.bpjs_ketenagakerjaan, jkkRatePct: Number(r.jkk_rate_pct),
    bank: r.bank_name ? { name: r.bank_name, accountLast4: acct ? acct.slice(-4) : null, accountName: r.account_name ?? null } : null,
    startOn: r.start_s, endOn: r.end_s ?? null, active: !r.end_s || r.end_s >= today(),
  };
};
const EMP_SELECT = `SELECT e.*, to_char(e.start_on, 'YYYY-MM-DD') AS start_s, to_char(e.end_on, 'YYYY-MM-DD') AS end_s FROM employee e`;

export async function employees(orgId: string) {
  return (await outsideRequestScope(() => many<any>(`${EMP_SELECT} WHERE e.org_id = $1 ORDER BY (e.end_on IS NOT NULL AND e.end_on < CURRENT_DATE), lower(e.name)`, [orgId]))).map(empView);
}

async function empRow(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new PayrollError(404, 'No such employee.');
  const r = await outsideRequestScope(() => one<any>(`${EMP_SELECT} WHERE e.id = $1 AND e.org_id = $2`, [id, orgId]));
  if (!r) throw new PayrollError(404, 'No such employee.');
  return r;
}

export async function saveEmployee(orgId: string, id: string | null, b: Record<string, unknown>, userId: string | null) {
  const cur = id ? await empRow(orgId, id) : null;
  const v = (k: string, col: string) => (b[k] === undefined && cur ? cur[col] : b[k]);
  const name = String(v('name', 'name') ?? '').trim();
  if (name.length < 2 || name.length > 120) throw new PayrollError(422, 'name is 2 to 120 characters.');
  const txt = (k: string, col: string, max: number) => { const x = v(k, col); return x == null || String(x).trim() === '' ? null : String(x).trim().slice(0, max); };
  const nik = txt('nik', 'nik', 20);
  if (nik && !/^\d{16}$/.test(nik)) throw new PayrollError(422, 'nik is 16 digits.');
  const npwp = txt('npwp', 'npwp', 30);
  if (npwp && !/^[0-9.\-\s]{15,25}$/.test(npwp)) throw new PayrollError(422, 'npwp is 15 or 16 digits (dots and dashes allowed).');
  const ptkp = String(v('ptkp', 'ptkp') ?? 'TK/0') as Ptkp;
  if (!(PTKP_STATUSES as readonly string[]).includes(ptkp)) throw new PayrollError(422, `ptkp is one of ${PTKP_STATUSES.join(', ')}.`);
  const currency = String(v('currency', 'currency') ?? (await reportingCurrency(orgId)) ?? (await currencies(orgId))[0] ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new PayrollError(422, 'currency is an ISO code.');
  const base = int(v('baseSalary', 'base_salary_minor'), 'baseSalary');
  const allowance = int(v('allowance', 'allowance_minor'), 'allowance');
  const bool = (k: string, col: string, d: boolean) => { const x = v(k, col); return x == null || x === '' ? d : x === true || x === 'true'; };
  const jkk = v('jkkRatePct', 'jkk_rate_pct') == null || v('jkkRatePct', 'jkk_rate_pct') === '' ? 0.24 : Number(v('jkkRatePct', 'jkk_rate_pct'));
  if (!Number.isFinite(jkk) || jkk < 0 || jkk > 2) throw new PayrollError(422, 'jkkRatePct is 0.24 to 1.74 (the work\'s risk group).');
  const startOn = String(v('startOn', 'start_s') ?? '');
  if (!DATE_RE.test(startOn)) throw new PayrollError(422, 'startOn is YYYY-MM-DD.');
  const endOn = txt('endOn', 'end_s', 10);
  if (endOn && (!DATE_RE.test(endOn) || endOn < startOn)) throw new PayrollError(422, 'endOn is YYYY-MM-DD, not before startOn.');
  const siteId = txt('siteId', 'site_id', 40);
  const bank = (b.bank ?? undefined) as Record<string, unknown> | undefined;
  let sealed = cur?.account_sealed ?? null, bankName = cur?.bank_name ?? null, acctName = cur?.account_name ?? null;
  if (bank !== undefined) {
    bankName = bank?.name ? String(bank.name).trim().slice(0, 80) : null;
    acctName = bank?.accountName ? String(bank.accountName).trim().slice(0, 120) : null;
    const no = bank?.accountNumber ? String(bank.accountNumber).replace(/[\s-]/g, '') : '';
    if (no && !/^\d{4,30}$/.test(no)) throw new PayrollError(422, 'The bank account number is digits.');
    if (no) sealed = seal(no, aad(orgId)); else if (!bank) sealed = null;
  }
  const p = [orgId, name, txt('email', 'email', 200), nik, npwp, ptkp, txt('position', 'position', 80), siteId, currency, base, allowance,
    bool('bpjsKesehatan', 'bpjs_kesehatan', true), bool('bpjsKetenagakerjaan', 'bpjs_ketenagakerjaan', true), jkk, bankName, sealed, acctName, startOn, endOn];
  if (cur) {
    await outsideRequestScope(() => query(
      `UPDATE employee SET name = $2, email = $3, nik = $4, npwp = $5, ptkp = $6, position = $7, site_id = $8, currency = $9, base_salary_minor = $10, allowance_minor = $11,
              bpjs_kesehatan = $12, bpjs_ketenagakerjaan = $13, jkk_rate_pct = $14, bank_name = $15, account_sealed = $16, account_name = $17, start_on = $18, end_on = $19
        WHERE org_id = $1 AND id = $20`, [...p, cur.id]));
    return empView(await empRow(orgId, String(cur.id)));
  }
  for (let k = 0; k < 5; k++) {
    const n = await outsideRequestScope(() => one<{ n: string }>(`SELECT count(*) AS n FROM employee WHERE org_id = $1`, [orgId]));
    try {
      const r = await outsideRequestScope(() => one<{ id: string }>(
        `INSERT INTO employee (org_id, name, email, nik, npwp, ptkp, position, site_id, currency, base_salary_minor, allowance_minor, bpjs_kesehatan, bpjs_ketenagakerjaan, jkk_rate_pct,
           bank_name, account_sealed, account_name, start_on, end_on, number, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) RETURNING id`,
        [...p, `EMP-${String(Number(n?.n ?? 0) + 1 + k).padStart(4, '0')}`, userId]));
      return empView(await empRow(orgId, String(r!.id)));
    } catch (e) { if ((e as any).code !== '23505') throw e; }
  }
  throw new PayrollError(409, 'Could not number the employee. Try again.');
}

// ─────────────────────────────────────────── runs

const RUN_SELECT = `SELECT r.*, to_char(r.paid_on, 'YYYY-MM-DD') AS paid_s, s.name AS submitted_by_name, f.name AS first_approved_by_name, a.name AS approved_by_name, ca.name AS cash_account_name
  FROM payroll_run r LEFT JOIN app_user s ON s.id = r.submitted_by LEFT JOIN app_user f ON f.id = r.first_approved_by LEFT JOIN app_user a ON a.id = r.approved_by LEFT JOIN cash_account ca ON ca.id = r.cash_account_id`;

async function runRow(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new PayrollError(404, 'No such payroll run.');
  const r = await outsideRequestScope(() => one<any>(`${RUN_SELECT} WHERE r.id = $1 AND r.org_id = $2`, [id, orgId]));
  if (!r) throw new PayrollError(404, 'No such payroll run.');
  return r;
}

const lineView = (l: any) => ({
  id: String(l.id), employeeId: String(l.employee_id), number: l.number, name: l.name, ptkp: l.ptkp,
  base: Number(l.base_minor), allowance: Number(l.allowance_minor), overtime: Number(l.overtime_minor), bonus: Number(l.bonus_minor), deduction: Number(l.deduction_minor),
  gross: Number(l.gross_minor), employerBpjs: Number(l.employer_minor), employeeBpjs: Number(l.employee_bpjs_minor), pph21: Number(l.pph21_minor), net: Number(l.net_minor),
  method: l.data?.method ?? null, terRate: l.data?.rate ?? null, bpjs: l.data?.bpjs ?? null, annual: l.data?.detail ?? null, excluded: !!l.data?.excluded,
});

export async function get(orgId: string, id: string) {
  const r = await runRow(orgId, id);
  const ls = await outsideRequestScope(() => many<any>(`SELECT l.*, e.number, e.name, e.ptkp FROM payroll_line l JOIN employee e ON e.id = l.employee_id WHERE l.run_id = $1 ORDER BY e.number`, [r.id]));
  return {
    id: String(r.id), month: r.month, currency: r.currency, status: r.status, totals: r.totals,
    submittedBy: r.submitted_by_name ?? null, firstApprovedBy: r.first_approved_by_name ?? null, approvedBy: r.approved_by_name ?? null,
    paidOn: r.paid_s ?? null, cashAccount: r.cash_account_name ?? null, voidReason: r.void_reason ?? null,
    lines: ls.map(lineView).filter((l) => !l.excluded),
  };
}

export async function runs(orgId: string) {
  const rows = await outsideRequestScope(() => many<any>(`${RUN_SELECT} WHERE r.org_id = $1 ORDER BY r.month DESC, r.id DESC LIMIT 60`, [orgId]));
  return rows.map((r) => ({ id: String(r.id), month: r.month, currency: r.currency, status: r.status, totals: r.totals, approvedBy: r.approved_by_name ?? null, paidOn: r.paid_s ?? null }));
}

/** The year's earlier months for an employee: gross, PPh 21, the employee's JHT + JP, months (runs not void). */
async function priorYear(orgId: string, employeeId: string, month: string) {
  const r = await outsideRequestScope(() => one<any>(
    `SELECT COALESCE(sum(l.gross_minor), 0)::bigint AS gross, COALESCE(sum(l.pph21_minor), 0)::bigint AS pph21,
            COALESCE(sum(COALESCE((l.data->'bpjs'->>'jhtEmployee')::bigint, 0) + COALESCE((l.data->'bpjs'->>'jpEmployee')::bigint, 0)), 0)::bigint AS pension, count(*)::int AS months
       FROM payroll_line l JOIN payroll_run r ON r.id = l.run_id
      WHERE r.org_id = $1 AND l.employee_id = $2 AND r.status <> 'void' AND left(r.month, 4) = left($3, 4) AND r.month < $3 AND NOT COALESCE((l.data->>'excluded')::boolean, false)`, [orgId, employeeId, month]));
  return { gross: Number(r?.gross ?? 0), pph21: Number(r?.pph21 ?? 0), pension: Number(r?.pension ?? 0), months: Number(r?.months ?? 0) };
}

async function recompute(orgId: string, runId: string) {
  const run = await runRow(orgId, runId);
  const r = await rules(orgId);
  const end = lastDay(run.month);
  const ls = await outsideRequestScope(() => many<any>(`SELECT l.*, e.ptkp, e.nik, e.npwp, e.bpjs_kesehatan, e.bpjs_ketenagakerjaan, e.jkk_rate_pct, to_char(e.end_on, 'YYYY-MM-DD') AS end_s FROM payroll_line l JOIN employee e ON e.id = l.employee_id WHERE l.run_id = $1`, [run.id]));
  const t = { employees: 0, gross: 0, wages: 0, employerBpjs: 0, employeeBpjs: 0, pph21: 0, deductions: 0, net: 0, cost: 0 };
  for (const l of ls) {
    if (l.data?.excluded) continue;
    const e: EmpRules = { ptkp: l.ptkp, hasTaxId: !!(l.npwp || l.nik), kes: l.bpjs_kesehatan, tk: l.bpjs_ketenagakerjaan, jkkPct: Number(l.jkk_rate_pct) };
    const x: LineInput = { base: Number(l.base_minor), allowance: Number(l.allowance_minor), overtime: Number(l.overtime_minor), bonus: Number(l.bonus_minor), deduction: Number(l.deduction_minor) };
    const final = run.month.endsWith('-12') || (l.end_s != null && l.end_s <= end);
    const c = computeLine(e, x, r, { final, prior: final ? await priorYear(orgId, String(l.employee_id), run.month) : { gross: 0, pph21: 0, pension: 0, months: 0 } });
    await outsideRequestScope(() => query(`UPDATE payroll_line SET gross_minor = $2, pph21_minor = $3, net_minor = $4, employer_minor = $5, employee_bpjs_minor = $6, data = $7 WHERE id = $1`,
      [l.id, c.gross, c.pph21, c.net, c.employer, c.employeeBpjs, JSON.stringify({ method: c.method, rate: c.rate, category: c.category, bpjs: c.bpjs, detail: c.detail })]));
    const wages = x.base + x.allowance + x.overtime + x.bonus;
    t.employees++; t.gross += c.gross; t.wages += wages; t.employerBpjs += c.employer; t.employeeBpjs += c.employeeBpjs; t.pph21 += c.pph21; t.deductions += x.deduction; t.net += c.net; t.cost += wages + c.employer;
  }
  await outsideRequestScope(() => query(`UPDATE payroll_run SET totals = $2 WHERE id = $1`, [run.id, JSON.stringify(t)]));
}

/** Draft a month's run from the employees in service in it (or refresh a draft's employees; their entries are kept). */
export async function draft(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const month = String(b.month ?? '');
  if (!MONTH_RE.test(month)) throw new PayrollError(422, 'month is YYYY-MM.');
  await assertOpen(orgId, month, 'A payroll', ERR);
  const currency = b.currency ? String(b.currency).toUpperCase() : (await reportingCurrency(orgId)) ?? (await currencies(orgId))[0] ?? null;
  if (!currency) throw new PayrollError(422, 'currency is needed.');
  let run = await outsideRequestScope(() => one<any>(`SELECT * FROM payroll_run WHERE org_id = $1 AND month = $2 AND currency = $3 AND status <> 'void'`, [orgId, month, currency]));
  if (run && run.status !== 'draft') throw new PayrollError(409, `The ${month} payroll is ${run.status.replace('_', ' ')}.`);
  if (!run) run = await outsideRequestScope(() => one<any>(`INSERT INTO payroll_run (org_id, month, currency, created_by) VALUES ($1, $2, $3, $4) RETURNING *`, [orgId, month, currency, userId]));
  const emps = await outsideRequestScope(() => many<any>(
    `SELECT * FROM employee WHERE org_id = $1 AND currency = $2 AND start_on <= $3::date AND (end_on IS NULL OR end_on >= $4::date)`, [orgId, currency, lastDay(month), `${month}-01`]));
  if (!emps.length) throw new PayrollError(422, `No employee paid in ${currency} is in service in ${month}.`);
  const ids = new Set(emps.map((e) => String(e.id)));
  for (const e of emps) {
    await outsideRequestScope(() => query(
      `INSERT INTO payroll_line (org_id, run_id, employee_id, base_minor, allowance_minor) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (run_id, employee_id) DO UPDATE SET base_minor = EXCLUDED.base_minor, allowance_minor = EXCLUDED.allowance_minor, data = payroll_line.data - 'excluded'`,
      [orgId, run.id, e.id, e.base_salary_minor, e.allowance_minor]));
  }
  for (const l of await outsideRequestScope(() => many<any>(`SELECT id, employee_id FROM payroll_line WHERE run_id = $1`, [run.id]))) {
    if (!ids.has(String(l.employee_id))) await outsideRequestScope(() => query(`UPDATE payroll_line SET data = data || '{"excluded": true}'::jsonb WHERE id = $1`, [l.id]));
  }
  await recompute(orgId, String(run.id));
  return get(orgId, String(run.id));
}

/** A line's overtime, bonus and deductions (draft only). */
export async function adjust(orgId: string, runId: string, lineId: string, b: Record<string, unknown>) {
  const run = await runRow(orgId, runId);
  if (run.status !== 'draft') throw new PayrollError(409, 'Only a draft payroll is changed.');
  if (!/^\d{1,18}$/.test(lineId)) throw new PayrollError(404, 'No such line.');
  const l = await outsideRequestScope(() => one<any>(`SELECT * FROM payroll_line WHERE id = $1 AND run_id = $2`, [lineId, run.id]));
  if (!l) throw new PayrollError(404, 'No such line.');
  const pick = (k: string, col: string) => (b[k] === undefined ? Number(l[col]) : int(b[k], k));
  await outsideRequestScope(() => query(`UPDATE payroll_line SET overtime_minor = $2, bonus_minor = $3, deduction_minor = $4 WHERE id = $1`,
    [l.id, pick('overtime', 'overtime_minor'), pick('bonus', 'bonus_minor'), pick('deduction', 'deduction_minor')]));
  await recompute(orgId, String(run.id));
  return get(orgId, String(run.id));
}

export async function submit(orgId: string, id: string, userId: string | null) {
  const r = await runRow(orgId, id);
  if (r.status !== 'draft') throw new PayrollError(409, `The payroll is ${r.status.replace('_', ' ')}.`);
  if ((await get(orgId, id)).lines.some((l) => l.net < 0)) throw new PayrollError(422, 'A line has a negative net pay: lower its deductions.');
  await outsideRequestScope(() => query(`UPDATE payroll_run SET status = 'awaiting_approval', submitted_by = $2, submitted_at = now(), first_approved_by = NULL, first_approved_at = NULL WHERE id = $1`, [r.id, userId]));
  return get(orgId, id);
}

export async function approve(orgId: string, id: string, who: Approver) {
  const r = await runRow(orgId, id);
  if (r.status !== 'awaiting_approval') throw new PayrollError(409, `The payroll is ${r.status.replace('_', ' ')}.`);
  const step = await gate('payroll_run', orgId, { id: r.id, amount: Number(r.totals?.net ?? 0), requested_by: r.submitted_by, first_approved_by: r.first_approved_by }, who);
  if (step === 'first') return { ...(await get(orgId, id)), waitingForSecondApprover: true };
  await outsideRequestScope(() => query(`UPDATE payroll_run SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1 AND status = 'awaiting_approval'`, [r.id, who.userId]));
  return get(orgId, id);
}

export async function pay(orgId: string, id: string, b: Record<string, unknown>) {
  const r = await runRow(orgId, id);
  if (r.status !== 'approved') throw new PayrollError(409, 'Only an approved payroll is paid.');
  const paidOn = String(b.paidOn ?? '');
  if (!DATE_RE.test(paidOn)) throw new PayrollError(422, 'paidOn is YYYY-MM-DD.');
  await assertOpen(orgId, paidOn.slice(0, 7), 'A payroll payment', ERR);
  const acct = String(b.cashAccountId ?? '');
  const a = /^\d{1,18}$/.test(acct) ? await outsideRequestScope(() => one<any>(`SELECT id, currency FROM cash_account WHERE id = $1 AND org_id = $2`, [acct, orgId])) : null;
  if (!a) throw new PayrollError(422, 'cashAccountId is the account the salaries are paid from.');
  if (a.currency !== r.currency) throw new PayrollError(422, `The account is in ${a.currency}, the payroll in ${r.currency}.`);
  await outsideRequestScope(() => query(`UPDATE payroll_run SET status = 'paid', paid_on = $2, cash_account_id = $3 WHERE id = $1`, [r.id, paidOn, a.id]));
  return get(orgId, id);
}

export async function voidRun(orgId: string, id: string, reasonRaw: unknown) {
  const r = await runRow(orgId, id);
  if (r.status === 'paid' || r.status === 'void') throw new PayrollError(409, `A ${r.status} payroll is not voided.`);
  const reason = String(reasonRaw ?? '').trim();
  if (reason.length < 3) throw new PayrollError(422, 'Give a reason (at least 3 characters).');
  await outsideRequestScope(() => query(`UPDATE payroll_run SET status = 'void', void_reason = $2 WHERE id = $1`, [r.id, reason.slice(0, 300)]));
  return get(orgId, id);
}

// ─────────────────────────────────────────── files

const rp = (n: number, cur: string) => `${cur} ${Math.round(n).toLocaleString('en-US')}`;

export async function payslip(orgId: string, runId: string, lineId: string): Promise<{ name: string; pdf: Buffer }> {
  const run = await get(orgId, runId);
  const l = run.lines.find((x) => x.id === lineId);
  if (!l) throw new PayrollError(404, 'No such line.');
  const org = await outsideRequestScope(() => one<{ name: string }>(`SELECT name FROM organisation WHERE id = $1`, [orgId]));
  const doc = new PdfDoc({ title: `Payslip ${run.month} ${l.name}`, author: org?.name ?? 'PlugSure CSMS', subject: 'Payslip', created: new Date() });
  const f = new Flow(doc);
  const c = run.currency;
  f.para(`${org?.name ?? ''}: payslip, ${run.month}`, { size: 15, bold: true });
  f.para(`${l.name} · ${l.number} · PTKP ${l.ptkp}`, { size: 9.5, color: [0.36, 0.39, 0.44] });
  f.heading('Earnings');
  f.row('Base salary', rp(l.base, c)); f.row('Fixed allowances', rp(l.allowance, c));
  if (l.overtime) f.row('Overtime', rp(l.overtime, c));
  if (l.bonus) f.row('Bonus', rp(l.bonus, c));
  f.heading('Deductions');
  const bp = l.bpjs ?? {};
  if (bp.kesEmployee) f.row('BPJS Kesehatan (1%)', rp(bp.kesEmployee, c));
  if (bp.jhtEmployee) f.row('BPJS JHT (2%)', rp(bp.jhtEmployee, c));
  if (bp.jpEmployee) f.row('BPJS JP (1%)', rp(bp.jpEmployee, c));
  f.row(`PPh 21 (${l.method}${l.terRate != null ? ` ${l.terRate}%` : ''})`, rp(l.pph21, c));
  if (l.deduction) f.row('Other deductions', rp(l.deduction, c));
  f.rule();
  f.row('Net pay', rp(l.net, c), { bold: true });
  f.heading('Paid by the employer');
  f.row('BPJS (Kesehatan 4%, JHT 3.7%, JP 2%, JKK, JKM 0.3%)', rp(l.employerBpjs, c));
  f.row('Gross for PPh 21', rp(l.gross, c), { muted: true });
  return { name: `payslip-${run.month}-${l.number}.pdf`, pdf: doc.toBuffer() };
}

/** The bank transfer list (CSV): name, bank, account number (unsealed), amount, reference. */
export async function transferCsv(orgId: string, id: string): Promise<string> {
  const run = await get(orgId, id);
  if (run.status !== 'approved' && run.status !== 'paid') throw new PayrollError(409, 'The transfer list is for an approved payroll.');
  const emps = await outsideRequestScope(() => many<any>(`SELECT id, org_id, name, bank_name, account_sealed, account_name FROM employee WHERE org_id = $1`, [orgId]));
  const q = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const rows = [['name', 'bank', 'account_number', 'account_name', 'amount', 'reference'].join(',')];
  for (const l of run.lines) {
    const e = emps.find((x) => String(x.id) === l.employeeId);
    let acct = '';
    try { acct = e?.account_sealed ? unseal(e.account_sealed, aad(orgId)) : ''; } catch { acct = ''; }
    rows.push([q(l.name), q(e?.bank_name), q(acct), q(e?.account_name ?? l.name), l.net, q(`GAJI ${run.month} ${l.number}`)].join(','));
  }
  return rows.join('\r\n') + '\r\n';
}

export async function runXlsx(orgId: string, id: string): Promise<Buffer> {
  const run = await get(orgId, id);
  return xlsx([{ name: `Payroll ${run.month}`,
    rows: [['Number', 'Name', 'PTKP', 'Base', 'Allowances', 'Overtime', 'Bonus', 'Employer BPJS', 'Employee BPJS', 'Gross (PPh 21)', 'PPh 21', 'Method', 'Deductions', 'Net pay'],
      ...run.lines.map((l) => [l.number, l.name, l.ptkp, l.base, l.allowance, l.overtime, l.bonus, l.employerBpjs, l.employeeBpjs, l.gross, l.pph21, l.method, l.deduction, l.net]),
      ['', 'Total', '', null, null, null, null, run.totals.employerBpjs, run.totals.employeeBpjs, run.totals.gross, run.totals.pph21, '', run.totals.deductions, run.totals.net]],
    widths: [10, 28, 8, 14, 14, 12, 12, 14, 14, 16, 14, 18, 12, 16], formats: [null, null, null, 'money', 'money', 'money', 'money', 'money', 'money', 'money', 'money', null, 'money', 'money'] }]);
}

/** For the cash position: paid payrolls out of their account. */
export async function cashMoves(orgId: string, upTo: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT cash_account_id::text AS a, to_char(paid_on, 'YYYY-MM-DD') AS d, (totals->>'net')::bigint AS net FROM payroll_run WHERE org_id = $1 AND status = 'paid' AND cash_account_id IS NOT NULL AND paid_on <= $2::date`, [orgId, upTo]));
  return rows.map((r) => ({ account_id: r.a as string, d: r.d as string, amount: -Number(r.net ?? 0) }));
}

/** For the cash forecast: the last run's net pay per currency, to repeat monthly. */
export async function lastNet(orgId: string) {
  return outsideRequestScope(() => many<{ currency: string; net: string; month: string }>(
    `SELECT DISTINCT ON (currency) currency, (totals->>'net')::bigint AS net, month FROM payroll_run WHERE org_id = $1 AND status IN ('approved', 'paid') ORDER BY currency, month DESC`, [orgId]));
}
