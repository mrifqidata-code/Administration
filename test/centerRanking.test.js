// Tests for the pure calculation in apps-script/CenterRanking.gs. Run: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'CenterRanking.gs'), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(src + '\n;this.CR = CR;', ctx);

const V = '✅ VALID', X = '❌ INCOMPLETE';

// n rows for one center/period/day with `ok` of them complete
const day = (center, period, d, n, ok) =>
  Array.from({ length: n }, (_, i) => [center, i < ok ? V : X, period, d]);

test('classifies audit results', () => {
  assert.equal(ctx.crClassify_(V), 1);
  assert.equal(ctx.crClassify_(X), 0);
  assert.equal(ctx.crClassify_('❌ BELUM LENGKAP'), 0);
  assert.equal(ctx.crClassify_('N/A - No Show Up'), null);
  assert.equal(ctx.crClassify_(''), null);
  assert.equal(ctx.crClassify_('#N/A'), null);
});

test('finds columns by header, right-most for duplicate "Day"', () => {
  const h = ['Center', 'Student ID', 'Day', 'Audit Result', 'Missing Field(s)', '', 'Period Key', 'Day'];
  assert.equal(ctx.crFindColumn_(h, ['day'], true), 7);
  assert.equal(ctx.crFindColumn_(h, ['audit result'], true), 3);
  assert.equal(ctx.crFindColumn_(['Center', 'Audit Result (New Rules)', 'Period Key'], ['audit result'], true), 1);
  assert.equal(ctx.crFindColumn_(['Center', 'Payment Day', 'Period Key'], ['day', 'payment day'], true), 1);
  assert.equal(ctx.crFindColumn_(['Center', 'Day of Birth'], ['day'], true), -1);
  assert.equal(ctx.crFindColumn_(['Center', 'Audit Flag'], ['audit result', 'audit flag'], true), 1);
});

test('normalizes period keys and days', () => {
  assert.equal(ctx.crNormPeriod_(202608), '202608');
  assert.equal(ctx.crNormPeriod_('202608'), '202608');
  assert.equal(ctx.crNormPeriod_('202613'), '');
  assert.equal(ctx.crNormPeriod_(''), '');
  assert.equal(ctx.crNormDay_(26), 26);
  assert.equal(ctx.crNormDay_('7'), 7);
  assert.equal(ctx.crNormDay_(''), 0);
  assert.equal(ctx.crPeriodLabel_('202608'), 'Aug 2026');
});

test('daily pass at 80%, category pass at 90% of active days', () => {
  const rows = [
    ...day('KLM', 202608, 1, 5, 4),   // 80% → pass
    ...day('KLM', 202608, 2, 5, 3),   // 60% → fail
    ...day('KLM', 202608, 3, 1, 1),   // 100% → pass
    ['KLM', 'N/A - No Show Up', 202608, 4], // not audited: day 4 is not active
  ];
  const { detail } = ctx.crAggregate_({ RT: rows }, 0.8, 0.9);
  assert.equal(detail.length, 1);
  const d = detail[0];
  assert.equal(d.activeDays, 3);
  assert.equal(d.passDays, 2);
  assert.ok(Math.abs(d.daysPassPct - 2 / 3) < 1e-12);
  assert.equal(d.records, 11);
  assert.equal(d.complete, 8);
  assert.equal(d.pass, false);
});

test('counts rows that cannot be placed', () => {
  const { skipped, detail } = ctx.crAggregate_({ PR: [['', V, 202608, 1], ['KLM', V, '', 1], ['KLM', V, 202608, '']] }, 0.8, 0.9);
  assert.equal(skipped.PR, 3);
  assert.equal(detail.length, 0);
});

test('ranks centers per month; blank categories are not failures', () => {
  const rowsByCat = {
    // AAA: RT 100%, PR 100% → score 1, accurate
    RT: [...day('AAA', 202608, 1, 2, 2), ...day('BBB', 202608, 1, 2, 2), ...day('CCC', 202608, 1, 2, 0),
         ...day('AAA', 202609, 1, 2, 0), ...day('BBB', 202609, 1, 2, 2)],
    PR: [...day('AAA', 202608, 1, 2, 2), ...day('BBB', 202608, 1, 2, 0)],
    // CCC only has RT (0%) and SD (100%) → score 0.5
    SD: [...day('CCC', 202608, 1, 1, 1)],
  };
  const { detail } = ctx.crAggregate_(rowsByCat, 0.8, 0.9);
  const ranking = ctx.crRank_(detail);
  const aug = ranking.filter(r => r.period === '202608').map(r => [r.rank, r.center, r.score, r.accurate, r.catsPass, r.catsActive]);
  assert.deepEqual(JSON.parse(JSON.stringify(aug)), [
    [1, 'AAA', 1, true, 2, 2],
    // BBB and CCC: score 0.5, 1 PASS, month accuracy 0.5 each → full tie, ordered by name
    [2, 'BBB', 0.5, false, 1, 2],
    [3, 'CCC', 0.5, false, 1, 2],
  ]);
  const sep = ranking.filter(r => r.period === '202609').map(r => [r.rank, r.center]);
  assert.deepEqual(JSON.parse(JSON.stringify(sep)), [[1, 'BBB'], [2, 'AAA']]);
  assert.equal(ranking.find(r => r.period === '202608' && r.center === 'CCC').pct.PR, null);
});

test('tie on score is broken by categories PASS, then month accuracy', () => {
  const rowsByCat = {
    // ZZZ: RT 2/2 days pass (100%), PR 0/2 → score 0.5, 1 PASS
    RT: [...day('ZZZ', 202608, 1, 1, 1), ...day('ZZZ', 202608, 2, 1, 1),
         ...day('YYY', 202608, 1, 10, 7), ...day('YYY', 202608, 2, 10, 9)],
    PR: [...day('ZZZ', 202608, 1, 1, 0), ...day('ZZZ', 202608, 2, 1, 0),
         ...day('YYY', 202608, 1, 10, 7), ...day('YYY', 202608, 2, 10, 9)],
    // YYY: RT 1/2 days (50%), PR 1/2 days (50%) → score 0.5, 0 PASS
  };
  const ranking = ctx.crRank_(ctx.crAggregate_(rowsByCat, 0.8, 0.9).detail);
  assert.deepEqual(JSON.parse(JSON.stringify(ranking.map(r => r.center))), ['ZZZ', 'YYY']);
});

test('column letters', () => {
  assert.equal(ctx.crColLetter_(1), 'A');
  assert.equal(ctx.crColLetter_(13), 'M');
  assert.equal(ctx.crColLetter_(27), 'AA');
});

test('default period is the latest finished month', () => {
  const now = new Date(2026, 8, 27); // 27 Sep 2026
  assert.equal(ctx.crDefaultPeriod_(['202607', '202608', '202609'], now), '202608');
  assert.equal(ctx.crDefaultPeriod_(['202609'], now), '202609');
  assert.equal(ctx.crDefaultPeriod_([], now), '');
});

test('dashboard payload carries ranking, detail and month flags', () => {
  const rowsByCat = {
    RT: [...day('AAA', 202608, 1, 2, 2), ...day('BBB', 202608, 1, 2, 0), ...day('AAA', 202609, 1, 1, 1)],
    PR: [...day('BBB', 202608, 1, 1, 1)],
  };
  const { detail } = ctx.crAggregate_(rowsByCat, 0.8, 0.9);
  const p = JSON.parse(JSON.stringify(ctx.crDashboardPayload_(detail, '2026-09-27T01:00:00Z', new Date(2026, 8, 27))));
  assert.deepEqual(p.periods, [
    { key: '202608', label: 'Aug 2026', running: false },
    { key: '202609', label: 'Sep 2026', running: true },
  ]);
  assert.equal(p.defaultPeriod, '202608');
  assert.deepEqual(p.centers, ['AAA', 'BBB']);
  assert.deepEqual(p.categories.map(c => c.key), ['RT', 'PR', 'SD', 'SM', 'AL']);
  assert.deepEqual(p.ranking.filter(r => r.period === '202608').map(r => [r.rank, r.center, r.catsPass, r.catsActive]),
    [[1, 'AAA', 1, 1], [2, 'BBB', 1, 2]]);
  assert.equal(p.detail.length, 4);
  assert.equal(p.refreshedAt, '2026-09-27T01:00:00Z');
});

test('reads the detail tab back into detail records', () => {
  const values = [
    [202608, 'Aug 2026', 'KLM', 'Register Trial', 27, 5, 5 / 27, 120, 80, 80 / 120, 'FAIL'],
    [202608, 'Aug 2026', 'KLM', 'Payment Record', 27, 27, 1, 60, 60, 1, 'PASS'],
    ['', '', '', '', '', '', '', '', '', '', ''],
  ];
  const ss = { getSheetByName: () => ({ getLastRow: () => values.length + 1, getRange: () => ({ getValues: () => values }) }) };
  const d = JSON.parse(JSON.stringify(ctx.crReadDetailTab_(ss)));
  assert.equal(d.length, 2);
  assert.deepEqual(d[1], { period: '202608', center: 'KLM', cat: 'PR', activeDays: 27, passDays: 27, daysPassPct: 1,
    records: 60, complete: 60, accuracy: 1, pass: true });
  assert.equal(ctx.crReadDetailTab_({ getSheetByName: () => null }), null);
});

test('finds the current missing-field column, not the old one', () => {
  const h = ['Center', 'Missing Fields', 'Unique Key', 'Audit Result (New Rules)', 'Missing Field(s) (New Rules)', 'Period Key'];
  assert.equal(ctx.crFindColumn_(h, ['missing field'], true), 4);
  assert.equal(ctx.crFindColumn_(['Center', 'Audit Flag', 'Missing Fields'], ['missing field'], true), 2);
});

test('turns missing-field codes into header names', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.crSplitMissing_('BK; AV; '))), ['BK', 'AV']);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.crSplitMissing_('❌ BELUM LENGKAP'))), []);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.crSplitMissing_(''))), []);
  const headers = ['Center', 'Date', 'Time', '* Reasons\nNot DP'];
  assert.equal(ctx.crFieldLabel_('D', headers), 'Reasons Not DP');
  assert.equal(ctx.crFieldLabel_('B', headers), 'Date');
  assert.equal(ctx.crFieldLabel_('Z', headers), 'Z');          // beyond the header row
  assert.equal(ctx.crFieldLabel_('Birth Date', headers), 'Birth Date');
});

test('daily rows and missing fields per center / category / month', () => {
  const headers = { SD: ['Center', 'Regist Day', 'Source Lead', 'Bag Taken Date'] };
  const rowsByCat = {
    SD: [
      ['KLM', V, 202608, 1, ''],
      ['KLM', X, 202608, 1, 'C; D; '],
      ['KLM', X, 202608, 2, 'D; '],
      ['KLM', V, 202608, 2, 'D; '],        // complete rows never count as missing
      ['HIB', X, 202608, 2, 'C; '],
    ],
  };
  const agg = ctx.crAggregate_(rowsByCat, 0.8, 0.9, headers);
  const daily = JSON.parse(JSON.stringify(agg.daily)).map(d => [d.center, d.day, d.records, d.complete, d.pass]);
  assert.deepEqual(daily, [['HIB', 2, 1, 0, false], ['KLM', 1, 2, 1, false], ['KLM', 2, 2, 1, false]]);
  const missing = JSON.parse(JSON.stringify(agg.missing)).map(m => [m.center, m.field, m.code, m.records]);
  assert.deepEqual(missing, [['HIB', 'Source Lead', 'C', 1], ['KLM', 'Bag Taken Date', 'D', 2], ['KLM', 'Source Lead', 'C', 1]]);
});

test('period detail payload maps tab rows to compact arrays', () => {
  const daily = [[202608, 'Aug 2026', 'KLM', 'Student Database', 3, 10, 7, 0.7, 'FAIL'], [202608, 'Aug 2026', 'KLM', 'Unknown', 3, 1, 1, 1, 'PASS']];
  const missing = [[202608, 'Aug 2026', 'KLM', 'Student Database', 'Bag Taken Date', 'BK', 12]];
  const p = JSON.parse(JSON.stringify(ctx.crPeriodDetailPayload_(daily, missing)));
  assert.deepEqual(p, { available: true, daily: [['KLM', 'SD', 3, 10, 7]], missing: [['KLM', 'SD', 'Bag Taken Date', 'BK', 12]] });
});
