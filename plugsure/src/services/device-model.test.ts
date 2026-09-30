import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseReportData, parseMonitoringData, valueProblem, protectedVariable, monitorProblem, refsOf, keyOf, label, type Characteristics } from './device-model.js';

const ch = (c: Partial<Characteristics>): Characteristics => ({ dataType: 'string', unit: null, minLimit: null, maxLimit: null, valuesList: null, supportsMonitoring: false, ...c });

describe('device model: parsing reports', () => {
  test('a NotifyReport item becomes one row with attributes and characteristics', () => {
    const rows = parseReportData([
      {
        component: { name: 'EVSE', evse: { id: 1 } },
        variable: { name: 'Power' },
        variableAttribute: [{ type: 'Actual', value: '7200', mutability: 'ReadOnly' }, { type: 'MaxSet', value: '22000', mutability: 'ReadWrite', persistent: true }],
        variableCharacteristics: { dataType: 'decimal', unit: 'W', maxLimit: 22000, supportsMonitoring: true },
      },
      { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'HeartbeatInterval' }, variableAttribute: [{ value: '300' }] },
    ]);
    assert.equal(rows.length, 2);
    assert.deepEqual({ c: rows[0]!.component, e: rows[0]!.evseId, k: rows[0]!.connectorId, v: rows[0]!.variable }, { c: 'EVSE', e: 1, k: 0, v: 'Power' });
    assert.equal(rows[0]!.attributes[1]!.persistent, true);
    assert.deepEqual(rows[0]!.characteristics, { dataType: 'decimal', unit: 'W', minLimit: null, maxLimit: 22000, valuesList: null, supportsMonitoring: true });
    // Attribute type and mutability default as the spec says (Actual, ReadWrite); no characteristics → null.
    assert.deepEqual(rows[1]!.attributes[0], { type: 'Actual', value: '300', mutability: 'ReadWrite', persistent: null, constant: null });
    assert.equal(rows[1]!.characteristics, null);
  });

  test('items without names, and non-arrays, are dropped; valuesList splits on commas', () => {
    assert.deepEqual(parseReportData(null), []);
    assert.deepEqual(parseReportData([{ component: {}, variable: { name: 'X' } }, { component: { name: 'A' } }]), []);
    const [r] = parseReportData([{ component: { name: 'Connector', evse: { id: 2, connectorId: 1 } }, variable: { name: 'ConnectorType' }, variableCharacteristics: { dataType: 'OptionList', valuesList: 'cType2, cCCS2 ,cCHAdeMO' } }]);
    assert.deepEqual(r!.characteristics!.valuesList, ['cType2', 'cCCS2', 'cCHAdeMO']);
    assert.equal(r!.connectorId, 1);
  });

  test('monitors: one per variableMonitoring, invalid ones skipped, severity clamped', () => {
    const m = parseMonitoringData([
      {
        component: { name: 'EVSE', evse: { id: 1 } }, variable: { name: 'Power' },
        variableMonitoring: [
          { id: 3, transaction: false, value: 22000, type: 'UpperThreshold', severity: 4, eventNotificationType: 'CustomMonitor' },
          { id: 4, value: 60, type: 'Periodic', severity: 12 },
          { id: 'x', value: 1, type: 'Delta', severity: 1 },
          { id: 5, value: 1, type: 'Sideways', severity: 1 },
        ],
      },
    ]);
    assert.deepEqual(m.map((x) => [x.monitorId, x.type, x.severity, x.kind]), [[3, 'UpperThreshold', 4, 'CustomMonitor'], [4, 'Periodic', 9, null]]);
  });
});

describe('device model: checking values before SetVariables', () => {
  test('integers and decimals, with limits', () => {
    const i = ch({ dataType: 'integer', minLimit: 30, maxLimit: 3600 });
    assert.equal(valueProblem(i, '300'), null);
    assert.equal(valueProblem(i, '3.5'), 'A whole number.');
    assert.equal(valueProblem(i, '10'), 'At least 30.');
    assert.equal(valueProblem(i, '4000'), 'At most 3600.');
    assert.equal(valueProblem(ch({ dataType: 'decimal', maxLimit: 32 }), '16.5'), null);
    assert.equal(valueProblem(ch({ dataType: 'decimal' }), '16,5'), 'A number (use a dot for decimals).');
  });

  test('booleans, dates, option lists and member lists', () => {
    assert.equal(valueProblem(ch({ dataType: 'boolean' }), 'true'), null);
    assert.equal(valueProblem(ch({ dataType: 'boolean' }), 'yes'), 'true or false.');
    assert.equal(valueProblem(ch({ dataType: 'dateTime' }), '2026-10-01T00:00:00Z'), null);
    assert.match(valueProblem(ch({ dataType: 'dateTime' }), 'tomorrow')!, /date and time/);
    const opt = ch({ dataType: 'OptionList', valuesList: ['Always', 'Never'] });
    assert.equal(valueProblem(opt, 'Never'), null);
    assert.equal(valueProblem(opt, 'Sometimes'), 'One of: Always, Never.');
    const mem = ch({ dataType: 'MemberList', valuesList: ['Energy.Active.Import.Register', 'Power.Active.Import', 'SoC'] });
    assert.equal(valueProblem(mem, 'SoC,Power.Active.Import'), null);
    assert.match(valueProblem(mem, 'SoC,Voltage')!, /^Not allowed: Voltage/);
    assert.equal(valueProblem(mem, 'SoC,SoC'), 'Each value once.');
  });

  test('strings respect maxLimit as a length; no characteristics lets the station decide', () => {
    assert.equal(valueProblem(ch({ maxLimit: 5 }), 'abcdef'), 'At most 5 characters.');
    assert.equal(valueProblem(null, 'anything'), null);
    assert.equal(valueProblem(null, 'x'.repeat(1001)), 'At most 1000 characters.');
  });

  test('security and network variables are refused; ordinary ones are not', () => {
    assert.match(protectedVariable('SecurityCtrlr', 'SecurityProfile')!, /Security tab/);
    assert.match(protectedVariable('OCPPCommCtrlr', 'NetworkConfigurationPriority')!, /Onboarding/);
    assert.match(protectedVariable('NetworkConfiguration', 'OcppCsmsUrl')!, /connection profile/);
    assert.match(protectedVariable('OCPPCommCtrlr', 'BasicAuthPassword')!, /credential/);
    assert.equal(protectedVariable('ISO15118Ctrlr', 'ContractCertificateInstallationEnabled'), null);
    assert.equal(protectedVariable('OCPPCommCtrlr', 'HeartbeatInterval'), null);
    assert.equal(protectedVariable('SampledDataCtrlr', 'TxUpdatedInterval'), null);
  });

  test('monitors: type, value and severity', () => {
    assert.equal(monitorProblem({ type: 'UpperThreshold', value: 80, severity: 4 }), null);
    assert.match(monitorProblem({ type: 'Above', value: 80, severity: 4 })!, /type/);
    assert.match(monitorProblem({ type: 'Delta', value: 'x', severity: 4 })!, /number/);
    assert.match(monitorProblem({ type: 'Periodic', value: 0, severity: 4 })!, /above 0/);
    assert.match(monitorProblem({ type: 'Delta', value: 5, severity: 10 })!, /Severity/);
  });
});

describe('device model: wire references', () => {
  test('refsOf leaves out empty instances and EVSE 0, and round-trips through keyOf', () => {
    assert.deepEqual(refsOf({ component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval' }), { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'HeartbeatInterval' } });
    const k = { component: 'Connector', componentInstance: '', evseId: 1, connectorId: 2, variable: 'AvailabilityState', variableInstance: '' };
    const r = refsOf(k);
    assert.deepEqual(r.component, { name: 'Connector', evse: { id: 1, connectorId: 2 } });
    assert.deepEqual(keyOf(r.component, r.variable), k);
    assert.equal(label(k), 'Connector[EVSE 1/2].AvailabilityState');
  });
});
