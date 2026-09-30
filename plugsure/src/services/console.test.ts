import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { budgetProblem, forStrategy, type Demand } from './smartcharging.js';
import { validateSite, siteComputations, siteInputFrom } from './sites.js';
import { validateTopology, type EvseSpec } from './chargepoints.js';
import { validateToken, normaliseUid } from './tokens.js';
import { inWindow, stageIndex, validateCampaign, normaliseSha256 } from './firmware.js';
import { normaliseDiagStatus, extractMultipartFile } from './diagnostics.js';
import { hashPassword, verifyPassword, passwordProblem, generateTemporaryPassword } from './users.js';
import { breakdown } from './session-query.js';
import { teraStatusFor, connectorMaySellEnergy } from './compliance.js';
import { computeTax } from './tax.js';
import { SYSTEM_ROLES, CONSOLE_ROLES } from './authz.js';
import { safeFileName } from './storage.js';

/** Pure logic behind the v1.3 enterprise console (SPEC-UI-CSMS-2026-FINAL). */

describe('DLM guardrail (acceptance criterion 2)', () => {
  test('250 kVA × 0.95: 237.5 kW is allowed, 240 kW is refused with the prescribed message', () => {
    assert.equal(budgetProblem({ ceilingW: 237_500, reserveW: 7_500 }, 250, 0.95), null);
    const p = budgetProblem({ ceilingW: 240_000, reserveW: 0 }, 250, 0.95);
    assert.equal(p?.field, 'ceilingW');
    assert.equal(p?.maxW, 237_500);
    assert.match(p!.message, /Exceeds 250 kVA PLN contract limit\. Clamped to prevent breaker trip\./);
  });
  test('reserve must leave power for charging', () => {
    assert.equal(budgetProblem({ ceilingW: 100_000, reserveW: 100_000 }, 250, 0.95)?.field, 'reserveW');
  });
  test('unknown subscription does not cap', () => {
    assert.equal(budgetProblem({ ceilingW: 10_000_000, reserveW: 0 }, null, 0.95), null);
  });
  test('priorities apply only under the priority strategy', () => {
    const d = [{ priority: 5 } as Demand];
    assert.equal(forStrategy(d, 'priority')[0]!.priority, 5);
    assert.equal(forStrategy(d, 'fair_share')[0]!.priority, 0);
  });
});

describe('site validation', () => {
  test('computations: kVA × PF, 200 kVA cliff, 40 × kVA rekening minimum', () => {
    const c = siteComputations(250, 0.95);
    assert.equal(c.activePowerCeilingKw, 237.5);
    assert.equal(c.crossesTrTmCliff, true);
    assert.equal(c.rekeningMinimumKwhPerMonth, 10_000);
  });
  test('a valid site passes; the TR/TM cliff is a warning, not an error', () => {
    const v = validateSite(
      siteInputFrom({ name: 'Hub', kabupatenKotaCode: '3171', connectedKva: '250', powerFactor: '0.95', spkluId: '01.POSO.20.3171.011', spkluScheme: 'POSO', pbjtRateBps: '1000' }),
      true,
    );
    assert.deepEqual(v.errors, {});
    assert.equal(v.warnings.length, 1);
  });
  test('malformed SPKLU ID, bad PF, PBJT above 10% and scheme mismatch are errors', () => {
    const v = validateSite({ name: 'x', spkluId: '01.XXXX.20.3171.011', powerFactor: 1.4, pbjtRateBps: 1500 }, true);
    assert.ok(v.errors.spkluId && v.errors.powerFactor && v.errors.pbjtRateBps);
    const m = validateSite({ name: 'x', spkluId: '01.POSO.20.3171.011', spkluScheme: 'ROSO' }, true);
    assert.ok(m.errors.spkluScheme);
  });
  test('municipality mismatch with the SPKLU ID is flagged', () => {
    const v = validateSite({ name: 'x', spkluId: '01.POSO.20.3171.011', kabupatenKotaCode: '3275' }, true);
    assert.ok(v.warnings.some((w) => /3171/.test(w)));
  });
  test('name is required on create', () => {
    assert.ok(validateSite({}, true).errors.name);
    assert.equal(validateSite({}, false).errors.name, undefined);
  });
});

describe('EVSE topology', () => {
  const dc = (over = {}) => ({ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC' as const, maxPowerW: 120_000, teraCertStatus: 'verified' as const, teraDueAt: '2027-01-01', ...over });
  test('a dual-gun 1.6 charger is two EVSEs', () => {
    const ok: EvseSpec[] = [{ evseId: 1, connectors: [dc()] }, { evseId: 2, connectors: [dc()] }];
    assert.deepEqual(validateTopology(ok, 'ocpp1.6'), []);
    const bad: EvseSpec[] = [{ evseId: 1, connectors: [dc(), dc({ connectorId: 2 })] }];
    assert.equal(validateTopology(bad, 'ocpp1.6').length, 1);
    assert.deepEqual(validateTopology(bad, 'ocpp2.0.1'), []);
  });
  test('plug / current mismatch and a verified meter without expiry are refused', () => {
    assert.ok(validateTopology([{ evseId: 1, connectors: [dc({ connectorType: 'sType2' })] }], 'ocpp1.6').length);
    assert.ok(validateTopology([{ evseId: 1, connectors: [dc({ teraDueAt: null })] }], 'ocpp1.6').length);
    assert.ok(validateTopology([{ evseId: 1, connectors: [dc({ currentKind: 'AC1', connectorType: 'sType2', maxPowerW: 22_000 })] }], 'ocpp1.6').length);
  });
});

describe('metrology gate', () => {
  test('pending calibration blocks sale; exempt does not', () => {
    assert.equal(teraStatusFor(new Date('2030-01-01'), new Date(), 'pending'), 'pending');
    assert.equal(connectorMaySellEnergy('pending').allowed, false);
    assert.equal(connectorMaySellEnergy(teraStatusFor(null, new Date(), 'exempt')).allowed, true);
    assert.equal(teraStatusFor(new Date('2000-01-01')), 'lapsed', 'default cert status is unchanged behaviour');
  });
});

describe('RFID', () => {
  test('idTag rules (OCPP CiString20)', () => {
    assert.deepEqual(validateToken({ uid: '04A1B2C3D4E5', accountType: 'fleet', status: 'Accepted' }, true), {});
    assert.ok(validateToken({ uid: 'has space' }, true).uid);
    assert.ok(validateToken({ uid: 'X'.repeat(21) }, true).uid);
    assert.ok(validateToken({ uid: 'A', pin: '12' }, true).pin);
  });
  test('hex UIDs are upper-cased, others kept', () => {
    assert.equal(normaliseUid(' 04a1b2 '), '04A1B2');
    assert.equal(normaliseUid('ID-rfid-1'), 'ID-rfid-1');
  });
});

describe('FOTA', () => {
  test('maintenance window across midnight in site time', () => {
    const at = (iso: string) => new Date(iso);
    // 02:30 WIB = 19:30 UTC previous day
    assert.equal(inWindow(at('2026-09-25T19:30:00Z'), 'Asia/Jakarta', '02:00', '04:00'), true);
    assert.equal(inWindow(at('2026-09-25T23:30:00Z'), 'Asia/Jakarta', '02:00', '04:00'), false);
    assert.equal(inWindow(at('2026-09-25T16:30:00Z'), 'Asia/Jakarta', '22:00', '04:00'), true);
    assert.equal(inWindow(at('2026-09-25T16:30:00Z'), 'Asia/Jakarta', null, null), true);
  });
  test('stages and validation', () => {
    assert.equal(stageIndex('dispatched'), 0);
    assert.equal(stageIndex('Verified'), 5);
    assert.equal(stageIndex('failed'), -1);
    assert.ok(validateCampaign({ imageId: 'x', name: '', targetType: 'fleet', targetIds: [], windowStart: '02:00' }).length >= 2);
    assert.equal(normaliseSha256('AB:'.repeat(31) + 'AB'), 'ab'.repeat(32));
    assert.equal(normaliseSha256('xyz'), null);
  });
});

describe('diagnostics', () => {
  test('status vocabularies of both OCPP versions converge', () => {
    assert.equal(normaliseDiagStatus('UploadFailure'), 'UploadFailed');
    assert.equal(normaliseDiagStatus('UploadFailed'), 'UploadFailed');
    assert.equal(normaliseDiagStatus('Uploaded'), 'Uploaded');
    assert.equal(normaliseDiagStatus('AcceptedCanceled'), 'Idle');
  });
  test('multipart upload: first file part is extracted byte-exact', () => {
    const b = 'XyZ';
    const body = Buffer.from(
      `--${b}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhi\r\n` +
        `--${b}\r\nContent-Disposition: form-data; name="file"; filename="cp.log"\r\nContent-Type: text/plain\r\n\r\nLINE1\r\nLINE2\r\n--${b}--\r\n`,
    );
    const f = extractMultipartFile(body, `multipart/form-data; boundary=${b}`);
    assert.equal(f?.name, 'cp.log');
    assert.equal(f?.data.toString(), 'LINE1\r\nLINE2');
  });
  test('uploaded file names cannot traverse', () => {
    assert.equal(safeFileName('../../etc/passwd', 'x'), 'passwd');
    assert.equal(safeFileName('..', 'fallback'), 'fallback');
  });
});

describe('operator accounts', () => {
  test('scrypt hash verifies, rejects a wrong password, and is salted', async () => {
    const h = await hashPassword('Correct-Horse-9');
    assert.ok(await verifyPassword('Correct-Horse-9', h));
    assert.equal(await verifyPassword('correct-horse-9', h), false);
    assert.notEqual(h, await hashPassword('Correct-Horse-9'));
    assert.equal(await verifyPassword('x', null), false);
  });
  test('password policy and generated passwords satisfy it', () => {
    assert.ok(passwordProblem('short'));
    assert.ok(passwordProblem('alllowercaseletters'));
    assert.equal(passwordProblem(generateTemporaryPassword()), null);
  });
  test('the five console roles exist and are least-privilege', () => {
    for (const r of CONSOLE_ROLES) assert.ok(SYSTEM_ROLES[r.name], r.name);
    assert.ok(!SYSTEM_ROLES.cpo_operations_manager!.includes('user:write'), 'ops manager: users read-only');
    assert.ok(!SYSTEM_ROLES.site_host_landlord!.includes('charge_point:command'), 'site host: no commands');
    assert.ok(!SYSTEM_ROLES.field_technician!.includes('tariff:read'), 'technician: no tariffs');
    assert.ok(!SYSTEM_ROLES.field_technician!.includes('session:write'), 'technician: test-only starts');
    assert.ok(SYSTEM_ROLES.financial_auditor!.includes('session:export'));
    assert.ok(!SYSTEM_ROLES.financial_auditor!.includes('charge_point:command'));
  });
});

describe('invoice breakdown (acceptance criterion 4)', () => {
  test('explorer columns come from the frozen CDR; MDR only for QRIS', () => {
    const b = breakdown({
      cdr_id: 'x',
      lines: [
        { kind: 'energy', amountIdr: 49_350 },
        { kind: 'session', amountIdr: 21_000 },
        { kind: 'admin', amountIdr: 4_000 },
        { kind: 'idle', amountIdr: 5_000 },
      ],
      pbjt_idr: 2468, ppn_dpp_idr: 70_000, ppn_idr: 8_400, total_idr: 150_000, payment_method: 'qris',
    });
    assert.equal(b.energySubtotalIdr, 49_350);
    assert.equal(b.serviceFeeIdr, 25_000);
    assert.equal(b.idleFeeIdr, 5_000);
    assert.equal(b.mdrIdr, 1_050, 'QRIS above Rp 100,000 at the standard 0.7% MDR');
    assert.equal(breakdown({ cdr_id: 'x', lines: [], total_idr: 150_000, payment_method: 'fleet' }).mdrIdr, 0);
  });
  test('PPN can be disabled for a non-PKP tariff without touching PBJT', () => {
    const on = computeTax({ subtotalIdr: 100_000, energyIdr: 80_000, pbjtRateBps: 500 });
    const off = computeTax({ subtotalIdr: 100_000, energyIdr: 80_000, pbjtRateBps: 500, ppnApplies: false });
    assert.equal(on.pbjtIdr, off.pbjtIdr);
    assert.ok(on.ppnIdr > 0);
    assert.equal(off.ppnIdr, 0);
    assert.equal(off.ppnDppIdr, 0);
    assert.equal(off.totalIdr, 100_000 + off.pbjtIdr);
  });
});
