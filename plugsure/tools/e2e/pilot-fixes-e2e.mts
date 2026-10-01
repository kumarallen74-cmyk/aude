/**
 * Regression checks for the pilot-blocker fixes that live at the HTTP edge:
 *
 *   - authentication is decided on the matched route, so a percent-encoded or
 *     absolute-form request target cannot skip it (/v1, /d/v1, /ocpi);
 *   - user management only grants, or takes over, authority the caller holds;
 *   - the generic charger command route needs what each dedicated route needs;
 *   - an operator can suspend a charger (no new sessions) and resume it.
 *
 * Prerequisites: the stack running (API at E2E_API), the seeded operator
 * (ops@plugsure.com) and the seeded charger AUTEL-AC22-SMB-001. Creates two
 * API keys (revoked afterwards) and a few invited users, and suspends and
 * resumes the charger.
 */
const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const PASSWORD = process.env.E2E_PASSWORD ?? 'Console-Test-2026!';
const CP = process.env.E2E_CHARGER ?? 'AUTEL-AC22-SMB-001';

let passed = 0; let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) { console.log('PASS ', label); passed++; }
  else { console.log('FAIL ', label, '--', JSON.stringify(detail)); failed++; }
};

let cookie = '';
const call = async (method: string, path: string, body?: unknown, bearer?: string) => {
  const r = await fetch(API + path, {
    method,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : { cookie, 'x-plugsure-csrf': '1' }),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get('set-cookie');
  if (sc && !bearer) cookie = sc.split(';')[0]!;
  return { s: r.status, d: (await r.json().catch(() => null)) as any };
};
const raw = async (path: string) => (await fetch(API + path)).status;

const keys: string[] = [];
try {
  // ── 1. Authentication cannot be walked around with an encoded path
  for (const [path, label] of [
    ['/%761/sites', '/v1 with an encoded "v"'],
    ['/%76%31/charge-points', '/v1 fully encoded'],
    ['/%761/sessions/00000000-0000-0000-0000-000000000000', '/v1 object lookup (no existence oracle)'],
    ['/%64/v1/me', '/d/v1 with an encoded "d"'],
    ['/%6fcpi/versions', '/ocpi with an encoded "o"'],
  ] as const) {
    check(`encoded path refused: ${label}`, (await raw(path)) === 401, await raw(path));
  }

  const login = await call('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: PASSWORD });
  check('operator signs in', login.s === 200, login.s);
  const tag = Date.now().toString(36);

  // ── 2. User management cannot escalate
  const uw = await call('POST', '/v1/api-keys', { name: `e2e user:write ${tag}`, permissions: ['user:write'] });
  keys.push(uw.d?.id);
  const esc = await call('POST', '/v1/users', { name: 'Escalation', email: `esc-${tag}@plugsure.test`, role: 'super_admin' }, uw.d?.key);
  check('a user:write-only key cannot create a Super Administrator', esc.s === 403, esc);
  const list = await call('GET', '/v1/users');
  const admin = (list.d?.items ?? list.d ?? []).find((u: any) => u.email === 'ops@plugsure.com');
  const rp = await call('POST', `/v1/users/${admin?.id}/reset-password`, {}, uw.d?.key);
  check("a user:write-only key cannot reset a Super Administrator's password", rp.s === 403 && !rp.d?.temporaryPassword, rp.s);
  const tech = await call('POST', '/v1/users', { name: 'Tech', email: `tech-${tag}@plugsure.test`, role: 'field_technician' });
  check('a Super Administrator still invites a Field Technician', tech.s === 200, tech);
  const promote = await call('PUT', `/v1/users/${tech.d?.id}`, { role: 'super_admin' }, uw.d?.key);
  check('a user:write-only key cannot promote a user to Super Administrator', promote.s === 403, promote.s);

  // ── 3. The generic command route needs what the dedicated routes need
  const cmd = await call('POST', '/v1/api-keys', { name: `e2e api_client ${tag}`, permissions: ['site:read', 'charge_point:read', 'session:read', 'charge_point:command'] });
  keys.push(cmd.d?.id);
  const k = cmd.d?.key;
  const fw = await call('POST', `/v1/charge-points/${CP}/commands/update-firmware`, { location: 'https://example.com/fw.bin' }, k);
  check('charge_point:command alone cannot push firmware (needs firmware:write)', fw.s === 403, fw);
  const sp = await call('POST', `/v1/charge-points/${CP}/commands/set-charging-profile`, { connectorId: 1, purpose: 'TxDefaultProfile', stackLevel: 1, ocppProfileId: 9, limit: 6, unit: 'A' }, k);
  check('charge_point:command alone cannot set a charging profile (needs smartcharging:write)', sp.s === 403, sp);
  const dt = await call('POST', `/v1/charge-points/${CP}/commands/data-transfer`, { vendorId: 'x' }, k);
  check('charge_point:command alone cannot send vendor DataTransfer (needs charge_point:config)', dt.s === 403, dt);

  const ak = await call('POST', `/v1/charge-points/${CP}/commands/change-configuration`, { key: 'AuthorizationKey', value: '0123456789abcdef0123' });
  check('AuthorizationKey cannot be changed through the raw command', ak.s === 400, ak);
  const insecureFw = await call('POST', `/v1/charge-points/${CP}/commands/update-firmware`, { location: 'http://169.254.169.254/latest' });
  check('firmware from a non-https / internal URL is refused', insecureFw.s === 400, insecureFw);
  const ceiling = await call('POST', `/v1/charge-points/${CP}/commands/clear-charging-profile`, { chargingProfilePurpose: 'ChargePointMaxProfile' });
  check('the station ceiling cannot be cleared through the raw command', ceiling.s === 400, ceiling);

  // ── 4. Suspending a charger takes it out of service and back
  const susNoPerm = await call('POST', `/v1/charge-points/${CP}/suspend`, {}, k);
  check('charge_point:command alone cannot suspend a charger (needs charge_point:write)', susNoPerm.s === 403, susNoPerm.s);
  const reason = `e2e suspension ${tag}`;
  const sus = await call('POST', `/v1/charge-points/${CP}/suspend`, { reason });
  try {
    check('an operator suspends a charger', sus.s === 200, sus);
    const after = await call('GET', `/v1/charge-points/${CP}`);
    check('the charger reads as suspended', after.d?.status === 'suspended', after.d?.status);
    const again = await call('POST', `/v1/charge-points/${CP}/suspend`, {});
    check('suspending it again answers 409', again.s === 409, again);
    const rs = await call('POST', `/v1/charge-points/${CP}/remote-start`, { connectorId: 1, idTag: 'E2E-ANY' });
    check('a suspended charger refuses a remote start with 409', rs.s === 409 && /suspended/.test(rs.d?.error ?? ''), rs);
    const qris = await call('POST', '/v1/checkout/qris', { ocppIdentity: CP, connectorId: 1, amountIdr: 50000 });
    check('a suspended charger sells no operator QRIS checkout (409)', qris.s === 409 && /suspended/.test(qris.d?.error ?? ''), qris);
    const audit = await call('GET', '/v1/audit');
    const entry = (audit.d?.entries ?? []).find((e: any) => e.action === 'charge_point.suspended' && e.target_id === CP);
    check('the suspension and its reason are audited', entry?.after_state?.reason === reason, entry);
  } finally {
    const res = await call('POST', `/v1/charge-points/${CP}/resume`);
    check('an operator resumes the charger', res.s === 200, res);
  }
  const resumed = await call('GET', `/v1/charge-points/${CP}`);
  check('the resumed charger is back in service', !['suspended', 'pending_adoption', 'decommissioned'].includes(resumed.d?.status), resumed.d?.status);
  const since = resumed.d?.offline_since ? Date.parse(resumed.d.offline_since) : NaN;
  // Disconnected (the usual case here): offline from now. Connected (a simulator attached): online, no offline_since.
  check('a resumed charger is offline from now (not from before the suspension), or online if connected',
    resumed.d?.status === 'offline' ? Number.isFinite(since) && Date.now() - since < 120_000 : resumed.d?.status === 'online' && !resumed.d?.offline_since,
    { status: resumed.d?.status, offline_since: resumed.d?.offline_since });
  const res2 = await call('POST', `/v1/charge-points/${CP}/resume`);
  check('resuming a charger that is not suspended answers 409', res2.s === 409, res2);
} finally {
  for (const id of keys) if (id) await call('DELETE', `/v1/api-keys/${id}`).catch(() => undefined);
}

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
