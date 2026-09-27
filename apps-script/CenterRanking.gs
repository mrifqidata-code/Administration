/**
 * SPARKS SWIM — CENTER ADMINISTRATION RANKING
 *
 * Builds three tabs from the raw audit sheets:
 *   - "Center Ranking"          dashboard: pick a month, see every center ranked best → worst
 *   - "Center Ranking Data"     one row per center per month (feeds the dashboard)
 *   - "Center Category Detail"  one row per center × category × month (audit trail)
 *
 * Method (same as the existing Audit Dashboard):
 *   Daily %        = complete records / auditable records for that center, category and day
 *   Day PASSES     when Daily % >= DAILY_MIN
 *   Days Pass %    = passing days / active days in the month (days with zero records are ignored)
 *   Category PASS  when Days Pass % >= MONTH_PASS
 *   Center score   = average Days Pass % over the categories that have records that month
 *   ACCURATE       = every category with records that month is PASS
 *   Rank           = score (desc), then categories PASS (desc), then month accuracy (desc)
 *
 * Web app: Dashboard.html is served by doGet() — deploy as a web app for a lightweight dashboard link.
 *
 * Setup: run installCenterRanking() once. See README.md.
 */

const CR = {
  // Keep these in line with the Settings tab.
  DAILY_MIN: 0.80,
  MONTH_PASS: 0.90,

  // The web app is the main dashboard. The in-sheet "Center Ranking" tab is slow to draw on a
  // spreadsheet this size, so the hourly refresh skips it; build it from the menu when needed.
  BUILD_SHEET_TAB_ON_REFRESH: false,

  DASH: 'Center Ranking',
  DATA: 'Center Ranking Data',
  DETAIL: 'Center Category Detail',
  DAILY: 'Center Daily Detail',
  MISSING: 'Center Missing Fields',

  // Columns are found by header name in row 1. For each field the candidates are tried in order;
  // within a candidate the right-most matching column wins (SCHEDULE MANAGEMENT has two "Day" columns,
  // PAYMENT RECORD has an old "Missing Fields" column left of the current "Missing Field(s) (...)").
  // "missing" is optional: its codes are column letters (e.g. "BK; AV;") and are shown by header name.
  CATEGORIES: [
    { key: 'RT', name: 'Register Trial', sheet: 'REGISTER TRIAL',
      result: ['audit result'], period: ['period key'], day: ['day'], missing: ['missing field'] },
    { key: 'PR', name: 'Payment Record', sheet: 'PAYMENT RECORD',
      result: ['audit result'], period: ['period key'], day: ['day', 'payment day'], missing: ['missing field'] },
    { key: 'SD', name: 'Student Database', sheet: 'STUDENT DATABASE',
      result: ['audit result'], period: ['period key'], day: ['day', 'regist day'], missing: ['missing field'] },
    { key: 'SM', name: 'Schedule Mgmt', sheet: 'SCHEDULE MANAGEMENT',
      result: ['audit result'], period: ['period key'], day: ['day'], missing: ['missing field'] },
    { key: 'AL', name: 'Attendance Log', sheet: 'Attendance Log',
      result: ['audit result', 'audit flag'], period: ['period key'], day: ['day'], missing: ['missing field'] },
  ],

  ACCURATE: '✅ ACCURATE',
  NOT_ACCURATE: '❌ NOT ACCURATE',
};

const CR_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ─────────────────────────────────────────────────────────────────────────────
// Setup, menu and triggers
// ─────────────────────────────────────────────────────────────────────────────

/** Run once: adds the menu, an hourly refresh, and builds the tabs. */
function installCenterRanking() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.getProjectTriggers()
    .filter(t => ['crOnOpen', 'refreshCenterRanking'].includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('crOnOpen').forSpreadsheet(ss).onOpen().create();
  ScriptApp.newTrigger('refreshCenterRanking').timeBased().everyHours(1).create();
  PropertiesService.getScriptProperties().setProperty('CR_SPREADSHEET_ID', ss.getId());
  crAddMenu_();
  refreshCenterRanking();
}

/** Removes the triggers created by installCenterRanking(). The tabs are left in place. */
function uninstallCenterRanking() {
  ScriptApp.getProjectTriggers()
    .filter(t => ['crOnOpen', 'refreshCenterRanking'].includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));
}

/** Installable onOpen handler (not named onOpen so it cannot clash with an existing script). */
function crOnOpen() {
  crAddMenu_();
}

function crAddMenu_() {
  SpreadsheetApp.getUi()
    .createMenu('📊 Center Ranking')
    .addItem('Refresh now', 'refreshCenterRanking')
    .addItem('Build / update the Center Ranking tab', 'buildCenterRankingSheet')
    .addItem('Install / repair auto-refresh', 'installCenterRanking')
    .addToUi();
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

/** Reads the raw sheets, recalculates everything and writes the "Center Category Detail" tab. */
function refreshCenterRanking() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) { console.log('Another refresh is already running — skipped.'); return; }
  try {
    const t = crTimer_();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const raw = crReadAllCategories_(ss);
    t('read raw sheets (' + CR.CATEGORIES.map(c => c.key + ' ' + raw.rowsByCat[c.key].length).join(', ') + ' rows)');

    const agg = crAggregate_(raw.rowsByCat, CR.DAILY_MIN, CR.MONTH_PASS, raw.headersByCat);
    t('calculate (' + agg.detail.length + ' center × category × month rows)');

    crWriteDetail_(ss, agg.detail);
    crWriteDaily_(ss, agg.daily);
    crWriteMissing_(ss, agg.missing);
    const props = PropertiesService.getScriptProperties();
    props.setProperty('CR_SKIPPED', JSON.stringify(agg.skipped));
    props.setProperty('CR_REFRESHED_AT', new Date().toISOString());
    t('write "' + CR.DETAIL + '", "' + CR.DAILY + '", "' + CR.MISSING + '"');

    if (CR.BUILD_SHEET_TAB_ON_REFRESH) crBuildSheetTabs_(ss, agg.detail, agg.skipped, t);
    t('done', true);
  } finally {
    lock.releaseLock();
  }
}

/** Builds the in-sheet "Center Ranking" and "Center Ranking Data" tabs from the detail tab (no raw re-read). */
function buildCenterRankingSheet() {
  const t = crTimer_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let detail = crReadDetailTab_(ss);
  let skipped = JSON.parse(PropertiesService.getScriptProperties().getProperty('CR_SKIPPED') || '{}');
  if (!detail) {
    refreshCenterRanking();
    detail = crReadDetailTab_(ss) || [];
    skipped = JSON.parse(PropertiesService.getScriptProperties().getProperty('CR_SKIPPED') || '{}');
  }
  t('read "' + CR.DETAIL + '"');
  crBuildSheetTabs_(ss, detail, skipped, t);
  t('done', true);
}

function crBuildSheetTabs_(ss, detail, skipped, t) {
  const ranking = crRank_(detail);
  const periods = [...new Set(ranking.map(r => r.period))].sort();
  crWriteData_(ss, ranking);
  t('write "' + CR.DATA + '"');
  crWriteDashboard_(ss, ranking, periods, skipped);
  t('write "' + CR.DASH + '"');
}

/** Logs the seconds spent on each step to the Apps Script execution log. */
function crTimer_() {
  const start = Date.now();
  let last = start;
  return (step, total) => {
    const now = Date.now();
    console.log((total ? 'TOTAL ' + ((now - start) / 1000).toFixed(1) : ((now - last) / 1000).toFixed(1)) + 's  ' + step);
    last = now;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Web app
// ─────────────────────────────────────────────────────────────────────────────

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Dashboard')
    .setTitle('Center Ranking — Sparks Swim')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Called from Dashboard.html. Returns the dashboard payload as a JSON string. */
function crGetDashboardData() {
  const ss = crOpenSpreadsheet_();
  let detail = crReadDetailTab_(ss);
  if (!detail) detail = crAggregate_(crReadAllCategories_(ss).rowsByCat, CR.DAILY_MIN, CR.MONTH_PASS).detail;
  const refreshedAt = PropertiesService.getScriptProperties().getProperty('CR_REFRESHED_AT') || '';
  return JSON.stringify(crDashboardPayload_(detail, refreshedAt, new Date()));
}

function crOpenSpreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet() ||
    SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('CR_SPREADSHEET_ID'));
}

/**
 * Called from Dashboard.html when a month is opened in the center detail panel.
 * Returns JSON { available, daily: [[center, cat, day, records, complete]], missing: [[center, cat, field, code, records]] }.
 */
function crGetPeriodDetail(period) {
  const ss = crOpenSpreadsheet_();
  const daily = crReadTabForPeriod_(ss, CR.DAILY, period, 9);
  const missing = crReadTabForPeriod_(ss, CR.MISSING, period, 7);
  if (!daily) return JSON.stringify({ available: false });
  return JSON.stringify(crPeriodDetailPayload_(daily, missing || []));
}

/** Rows of a detail tab whose Period Key (column A) equals `period`; null when the tab is missing. */
function crReadTabForPeriod_(ss, name, period, width) {
  const sh = ss.getSheetByName(name);
  if (!sh) return null;
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, width).getValues().filter(r => crNormPeriod_(r[0]) === String(period));
}

function crPeriodDetailPayload_(dailyRows, missingRows) {
  const keyByName = {};
  CR.CATEGORIES.forEach(c => { keyByName[c.name] = c.key; });
  return {
    available: true,
    // Daily tab: Period Key, Month, Center, Category, Day, Records, Complete, Daily %, Verdict
    daily: dailyRows.filter(r => keyByName[r[3]]).map(r => [String(r[2]), keyByName[r[3]], Number(r[4]), Number(r[5]), Number(r[6])]),
    // Missing tab: Period Key, Month, Center, Category, Missing Field, Column, Records
    missing: missingRows.filter(r => keyByName[r[3]]).map(r => [String(r[2]), keyByName[r[3]], String(r[4]), String(r[5]), Number(r[6])]),
  };
}

/** Reads the "Center Category Detail" tab written by refreshCenterRanking(); null when it is missing. */
function crReadDetailTab_(ss) {
  const sh = ss.getSheetByName(CR.DETAIL);
  if (!sh || sh.getLastRow() < 2) return null;
  const keyByName = {};
  CR.CATEGORIES.forEach(c => { keyByName[c.name] = c.key; });
  return sh.getRange(2, 1, sh.getLastRow() - 1, 11).getValues()
    .filter(r => keyByName[r[3]] && crNormPeriod_(r[0]))
    .map(r => ({
      period: crNormPeriod_(r[0]), center: String(r[2]), cat: keyByName[r[3]],
      activeDays: Number(r[4]), passDays: Number(r[5]), daysPassPct: Number(r[6]),
      records: Number(r[7]), complete: Number(r[8]), accuracy: Number(r[9]), pass: r[10] === 'PASS',
    }));
}

/** The latest month before `now`, or the latest month when every month is current/future. */
function crDefaultPeriod_(periods, now) {
  const current = String(now.getFullYear() * 100 + now.getMonth() + 1);
  const finished = periods.filter(p => p < current);
  return finished.length ? finished[finished.length - 1] : (periods[periods.length - 1] || '');
}

function crDashboardPayload_(detail, refreshedAt, now) {
  const ranking = crRank_(detail);
  const periods = [...new Set(ranking.map(r => r.period))].sort();
  const current = String(now.getFullYear() * 100 + now.getMonth() + 1);
  return {
    dailyMin: CR.DAILY_MIN,
    monthPass: CR.MONTH_PASS,
    refreshedAt,
    categories: CR.CATEGORIES.map(c => ({ key: c.key, name: c.name })),
    periods: periods.map(p => ({ key: p, label: crPeriodLabel_(p), running: p === current })),
    defaultPeriod: crDefaultPeriod_(periods, now),
    centers: [...new Set(ranking.map(r => r.center))].sort(),
    ranking: ranking.map(r => ({
      period: r.period, center: r.center, rank: r.rank, score: r.score, accuracy: r.accuracy,
      catsPass: r.catsPass, catsActive: r.catsActive, accurate: r.accurate,
    })),
    detail: detail.map(d => ({
      period: d.period, center: d.center, cat: d.cat, activeDays: d.activeDays, passDays: d.passDays,
      daysPassPct: d.daysPassPct, records: d.records, complete: d.complete, accuracy: d.accuracy, pass: d.pass,
    })),
  };
}

/**
 * Reads every category. Uses one Sheets API batchGet call for all 20 columns when the
 * "Google Sheets API" advanced service is enabled (much faster), otherwise SpreadsheetApp.
 */
function crReadAllCategories_(ss) {
  const rowsByCat = {}, headersByCat = {};
  const plans = CR.CATEGORIES.map(cat => {
    const sh = ss.getSheetByName(cat.sheet);
    if (!sh) throw new Error('Sheet not found: "' + cat.sheet + '"');
    const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
    headersByCat[cat.key] = headers;
    return { cat, sh, n: Math.max(0, sh.getLastRow() - 1), col: crColumnsFor_(cat, headers) };
  });

  if (typeof Sheets === 'undefined') {
    console.log('Tip: enable Services → Google Sheets API for a faster read.');
    plans.forEach(p => {
      const read = c => (c < 0 || !p.n ? null : p.sh.getRange(2, c + 1, p.n, 1).getValues());
      const cols = CR_FIELDS.map(f => read(p.col[f]));
      rowsByCat[p.cat.key] = crZipColumns_(cols.map(c => (c ? c.map(r => r[0]) : [])), p.n);
    });
    return { rowsByCat, headersByCat };
  }

  const ranges = [];
  plans.forEach(p => {
    if (!p.n) return;
    const q = "'" + p.cat.sheet.replace(/'/g, "''") + "'!";
    CR_FIELDS.forEach(f => {
      if (p.col[f] < 0) return;
      const L = crColLetter_(p.col[f] + 1);
      ranges.push(q + L + '2:' + L + (p.n + 1));
    });
  });
  const res = ranges.length ? Sheets.Spreadsheets.Values.batchGet(ss.getId(),
    { ranges, majorDimension: 'COLUMNS', valueRenderOption: 'UNFORMATTED_VALUE' }).valueRanges : [];
  let k = 0;
  plans.forEach(p => {
    if (!p.n) { rowsByCat[p.cat.key] = []; return; }
    const cols = CR_FIELDS.map(f => (p.col[f] < 0 ? [] : ((res[k++] || {}).values || [[]])[0] || []));
    rowsByCat[p.cat.key] = crZipColumns_(cols, p.n);
  });
  return { rowsByCat, headersByCat };
}

/** The fields read from every category sheet, in row order. */
const CR_FIELDS = ['center', 'result', 'period', 'day', 'missing'];

/** Turns parallel column arrays into n rows; absent cells become ''. */
function crZipColumns_(cols, n) {
  const rows = new Array(n);
  for (let i = 0; i < n; i++) rows[i] = cols.map(c => (c[i] === undefined ? '' : c[i]));
  return rows;
}

/** Column indexes (0-based) of center / result / period / day / missing (-1 = absent) in a header row. */
function crColumnsFor_(cat, headers) {
  const col = {
    center: crFindColumn_(headers, ['center'], false),
    result: crFindColumn_(headers, cat.result, true),
    period: crFindColumn_(headers, cat.period, true),
    day: crFindColumn_(headers, cat.day, true),
    missing: crFindColumn_(headers, cat.missing || [], true),
  };
  ['center', 'result', 'period', 'day'].forEach(k => {
    if (col[k] < 0) throw new Error('"' + cat.sheet + '": cannot find the ' + k + ' column in row 1.');
  });
  return col;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure calculation (no Spreadsheet calls — covered by test/centerRanking.test.js)
// ─────────────────────────────────────────────────────────────────────────────

function crNormHeader_(h) {
  return String(h == null ? '' : h).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Index of the column whose header matches a candidate: exact match, or prefix for "audit ..." / "missing ..." headers. */
function crFindColumn_(headers, candidates, rightMost) {
  const norm = headers.map(crNormHeader_);
  for (const cand of candidates) {
    const hit = [];
    const prefix = cand.startsWith('audit') || cand.startsWith('missing');
    norm.forEach((h, i) => {
      if (h === cand || (prefix && h.startsWith(cand))) hit.push(i);
    });
    if (hit.length) return rightMost ? hit[hit.length - 1] : hit[0];
  }
  return -1;
}

/** 1 = complete, 0 = incomplete, null = not auditable (blank, N/A, no-show, errors). */
function crClassify_(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  if (!s || s.startsWith('N/A') || s.startsWith('#')) return null;
  if (s.includes('❌') || s.includes('INCOMPLETE') || s.includes('INVALID')) return 0;
  if (s.includes('VALID')) return 1;
  return null;
}

function crNormCenter_(v) {
  return String(v == null ? '' : v).trim().toUpperCase();
}

/** Returns "YYYYMM" or '' when the value is not a period key. */
function crNormPeriod_(v) {
  if (v instanceof Date) return String(v.getFullYear() * 100 + v.getMonth() + 1);
  const s = String(v == null ? '' : v).trim().replace(/\.0+$/, '');
  if (!/^\d{6}$/.test(s)) return '';
  const m = Number(s.slice(4));
  return m >= 1 && m <= 12 ? s : '';
}

function crNormDay_(v) {
  if (v instanceof Date) return v.getDate();
  const d = Number(String(v == null ? '' : v).trim());
  return Number.isInteger(d) && d >= 1 && d <= 31 ? d : 0;
}

function crPeriodLabel_(p) {
  return CR_MONTHS[Number(p.slice(4)) - 1] + ' ' + p.slice(0, 4);
}

/**
 * rowsByCat:    { RT: [[center, result, period, day, missing], ...], ... }
 * headersByCat: { RT: [row-1 headers], ... } (optional) — turns missing-field column letters into names.
 * Returns {
 *   detail:  one entry per period × center × category,
 *   daily:   one entry per period × center × category × day,
 *   missing: one entry per period × center × category × missing field (incomplete records only),
 *   skipped: { RT: n, ... } auditable rows without a center, period key or day,
 * }
 */
function crAggregate_(rowsByCat, dailyMin, monthPass, headersByCat) {
  const buckets = {};
  const skipped = {};
  const missingCount = {};
  CR.CATEGORIES.forEach(cat => {
    skipped[cat.key] = 0;
    const headers = (headersByCat || {})[cat.key] || [];
    (rowsByCat[cat.key] || []).forEach(r => {
      const res = crClassify_(r[1]);
      if (res === null) return;
      const center = crNormCenter_(r[0]);
      const period = crNormPeriod_(r[2]);
      const day = crNormDay_(r[3]);
      if (!center || !period || !day) { skipped[cat.key]++; return; }
      const k = period + '|' + center + '|' + cat.key;
      const b = buckets[k] || (buckets[k] = { period, center, cat: cat.key, days: {} });
      const d = b.days[day] || (b.days[day] = { total: 0, complete: 0 });
      d.total++;
      d.complete += res;
      if (res === 0) {
        crSplitMissing_(r[4]).forEach(code => {
          const mk = k + '|' + code;
          const m = missingCount[mk] || (missingCount[mk] = {
            period, center, cat: cat.key, code, field: crFieldLabel_(code, headers), records: 0 });
          m.records++;
        });
      }
    });
  });

  const daily = [];
  Object.keys(buckets).forEach(k => {
    const b = buckets[k];
    Object.keys(b.days).forEach(day => {
      const d = b.days[day];
      const pct = d.complete / d.total;
      daily.push({ period: b.period, center: b.center, cat: b.cat, day: Number(day),
        records: d.total, complete: d.complete, pct, pass: pct >= dailyMin - 1e-9 });
    });
  });
  daily.sort((a, b) => a.period.localeCompare(b.period) || a.center.localeCompare(b.center) ||
    crCatIndex_(a.cat) - crCatIndex_(b.cat) || a.day - b.day);

  const missing = Object.keys(missingCount).map(k => missingCount[k]);
  missing.sort((a, b) => a.period.localeCompare(b.period) || a.center.localeCompare(b.center) ||
    crCatIndex_(a.cat) - crCatIndex_(b.cat) || b.records - a.records || a.field.localeCompare(b.field));

  const detail = Object.keys(buckets).map(k => {
    const b = buckets[k];
    let active = 0, pass = 0, records = 0, complete = 0;
    Object.keys(b.days).forEach(day => {
      const d = b.days[day];
      active++;
      if (d.complete / d.total >= dailyMin - 1e-9) pass++;
      records += d.total;
      complete += d.complete;
    });
    const daysPassPct = pass / active;
    return {
      period: b.period, center: b.center, cat: b.cat,
      activeDays: active, passDays: pass, daysPassPct,
      records, complete, accuracy: complete / records,
      pass: daysPassPct >= monthPass - 1e-9,
    };
  });
  detail.sort((a, b) => a.period.localeCompare(b.period) || a.center.localeCompare(b.center) ||
    crCatIndex_(a.cat) - crCatIndex_(b.cat));
  return { detail, daily, missing, skipped };
}

/** "BK; AV; " → ["BK", "AV"]. Status text such as "❌ BELUM LENGKAP" is ignored. */
function crSplitMissing_(v) {
  return String(v == null ? '' : v).split(/[;,\n]/).map(x => x.trim()).filter(x => x && !/[❌✅]/.test(x));
}

/** Column letter → its row-1 header ("AV" → "Source Lead"); anything else is returned as is. */
function crFieldLabel_(code, headers) {
  if (!/^[A-Z]{1,3}$/.test(code)) return code;
  let n = 0;
  for (const ch of code) n = n * 26 + ch.charCodeAt(0) - 64;
  const h = String(headers[n - 1] == null ? '' : headers[n - 1]).replace(/\s+/g, ' ').replace(/^[*#\s]+/, '').trim();
  return h || code;
}

function crCatIndex_(key) {
  return CR.CATEGORIES.findIndex(c => c.key === key);
}

/** One row per center per month, ranked within the month. */
function crRank_(detail) {
  const byPC = {};
  detail.forEach(d => {
    const k = d.period + '|' + d.center;
    (byPC[k] || (byPC[k] = { period: d.period, center: d.center, cats: {} })).cats[d.cat] = d;
  });

  const rows = Object.keys(byPC).map(k => {
    const g = byPC[k];
    const cats = Object.keys(g.cats).map(c => g.cats[c]);
    const n = cats.length;
    const catsPass = cats.filter(c => c.pass).length;
    return {
      period: g.period, center: g.center,
      score: cats.reduce((s, c) => s + c.daysPassPct, 0) / n,
      accuracy: cats.reduce((s, c) => s + c.accuracy, 0) / n,
      catsPass, catsActive: n,
      accurate: catsPass === n,
      pct: CR.CATEGORIES.reduce((o, c) => { o[c.key] = g.cats[c.key] ? g.cats[c.key].daysPassPct : null; return o; }, {}),
      rank: 0,
    };
  });

  const byPeriod = {};
  rows.forEach(r => (byPeriod[r.period] || (byPeriod[r.period] = [])).push(r));
  Object.keys(byPeriod).forEach(p => {
    byPeriod[p]
      .sort((a, b) => (b.score - a.score) || (b.catsPass - a.catsPass) ||
        (b.accuracy - a.accuracy) || a.center.localeCompare(b.center))
      .forEach((r, i) => { r.rank = i + 1; });
  });

  rows.sort((a, b) => a.period.localeCompare(b.period) || a.rank - b.rank);
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Output tabs
// ─────────────────────────────────────────────────────────────────────────────

function crSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function crWriteDetail_(ss, detail) {
  const sh = crSheet_(ss, CR.DETAIL);
  sh.clear();
  const header = ['Period Key', 'Month', 'Center', 'Category', 'Active Days', 'Pass Days',
    'Days Pass %', 'Records', 'Complete', 'Month Accuracy', 'Verdict'];
  const name = key => CR.CATEGORIES[crCatIndex_(key)].name;
  const rows = detail.map(d => [d.period, crPeriodLabel_(d.period), d.center, name(d.cat), d.activeDays,
    d.passDays, d.daysPassPct, d.records, d.complete, d.accuracy, d.pass ? 'PASS' : 'FAIL']);
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#1f3a5f').setFontColor('#ffffff');
  if (rows.length) {
    sh.getRange(2, 1, rows.length, header.length).setValues(rows);
    sh.getRange(2, 7, rows.length, 1).setNumberFormat('0.0%');
    sh.getRange(2, 10, rows.length, 1).setNumberFormat('0.0%');
  }
  sh.setFrozenRows(1);
}

function crWriteDaily_(ss, daily) {
  const name = key => CR.CATEGORIES[crCatIndex_(key)].name;
  crWriteTable_(ss, CR.DAILY,
    ['Period Key', 'Month', 'Center', 'Category', 'Day', 'Records', 'Complete', 'Daily %', 'Verdict'],
    daily.map(d => [d.period, crPeriodLabel_(d.period), d.center, name(d.cat), d.day, d.records, d.complete, d.pct,
      d.pass ? 'PASS' : 'FAIL']),
    { 8: '0.0%' });
}

function crWriteMissing_(ss, missing) {
  const name = key => CR.CATEGORIES[crCatIndex_(key)].name;
  crWriteTable_(ss, CR.MISSING,
    ['Period Key', 'Month', 'Center', 'Category', 'Missing Field', 'Column', 'Records'],
    missing.map(m => [m.period, crPeriodLabel_(m.period), m.center, name(m.cat), m.field, m.code, m.records]),
    { 6: '@' });
}

/** Replaces a tab's contents with a header row and data rows in as few calls as possible. */
function crWriteTable_(ss, tab, header, rows, formats) {
  const sh = crSheet_(ss, tab);
  sh.clear();
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#1f3a5f').setFontColor('#ffffff');
  if (rows.length) {
    Object.keys(formats || {}).forEach(c => sh.getRange(2, Number(c), rows.length, 1).setNumberFormat(formats[c]));
    sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  }
  sh.setFrozenRows(1);
}

function crWriteData_(ss, ranking) {
  const sh = crSheet_(ss, CR.DATA);
  sh.clear();
  const header = ['Period Key', 'Month', 'Rank', 'Center', 'Score', 'Status', 'Categories PASS']
    .concat(CR.CATEGORIES.map(c => c.name), ['Month Accuracy']);
  const rows = ranking.map(r => [r.period, crPeriodLabel_(r.period), r.rank, r.center, r.score,
    r.accurate ? CR.ACCURATE : CR.NOT_ACCURATE, r.catsPass + ' / ' + r.catsActive]
    .concat(CR.CATEGORIES.map(c => (r.pct[c.key] == null ? '' : r.pct[c.key])), [r.accuracy]));
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#1f3a5f').setFontColor('#ffffff');
  if (rows.length) {
    sh.getRange(2, 7, rows.length, 1).setNumberFormat('@');   // "3 / 5" must not become a date
    sh.getRange(2, 1, rows.length, header.length).setValues(rows);
    sh.getRange(2, 5, rows.length, 1).setNumberFormat('0.0%');
    sh.getRange(2, 8, rows.length, CR.CATEGORIES.length + 1).setNumberFormat('0%');
  }
  sh.setFrozenRows(1);
}

function crWriteDashboard_(ss, ranking, periods, skipped) {
  const sh = crSheet_(ss, CR.DASH);
  const labels = periods.map(crPeriodLabel_);

  // Keep the viewer's month if it still exists; otherwise the latest finished month.
  let selected = '';
  if (sh.getLastRow() >= 4) selected = String(sh.getRange('C4').getDisplayValue()).trim();
  if (!labels.includes(selected)) selected = periods.length ? crPeriodLabel_(crDefaultPeriod_(periods, new Date())) : '';

  sh.getCharts().forEach(c => sh.removeChart(c));
  sh.clear();
  sh.clearConditionalFormatRules();
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart().clearDataValidations();
  sh.setHiddenGridlines(true);
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setFontFamily('Poppins');

  const D = "'" + CR.DATA + "'!";
  const nCat = CR.CATEGORIES.length;
  const lastCol = 2 + 5 + nCat;                       // B .. Month Accuracy
  const centers = [...new Set(ranking.map(r => r.center))].sort();
  const tableRows = Math.max(centers.length, 1) + 1;  // + spare row for a new center

  // Title
  sh.getRange('B1').setValue('SPARKS SWIM — CENTER ADMINISTRATION RANKING').setFontSize(16).setFontWeight('bold').setFontColor('#1f3a5f');
  sh.getRange('B2').setValue('Daily minimum ' + Math.round(CR.DAILY_MIN * 100) + '% per category  |  Category passes at ' +
    Math.round(CR.MONTH_PASS * 100) + '% of active days  |  ACCURATE = every category with records passes').setFontColor('#666666');

  // Period picker
  sh.getRange('B4').setValue('Period').setFontWeight('bold');
  const pick = sh.getRange('C4:D4').merge().setValue(selected)
    .setBackground('#fff2cc').setFontWeight('bold').setBorder(true, true, true, true, false, false);
  if (labels.length) {
    pick.setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(labels.slice().reverse(), true).setAllowInvalid(false).build());
  }
  sh.getRange('F4').setValue('Last refreshed').setFontColor('#666666');
  sh.getRange('G4').setValue(new Date()).setNumberFormat('dd mmm yyyy hh:mm').setFontColor('#666666');

  // KPI tiles
  const P = '$C$4';
  const kpis = [
    ['B', 'CENTERS ACCURATE', '=COUNTIFS(' + D + '$B:$B,' + P + ',' + D + '$F:$F,"' + CR.ACCURATE + '")&" of "&COUNTIF(' + D + '$B:$B,' + P + ')'],
    ['E', 'BEST CENTER', '=IFERROR(INDEX(FILTER(' + D + '$D:$D,' + D + '$B:$B=' + P + ',' + D + '$C:$C=1),1),"—")'],
    ['H', 'WORST CENTER', '=IFERROR(INDEX(FILTER(' + D + '$D:$D,' + D + '$B:$B=' + P + ',' + D + '$C:$C=COUNTIF(' + D + '$B:$B,' + P + ')),1),"—")'],
    ['K', 'AVERAGE SCORE', '=IFERROR(AVERAGEIF(' + D + '$B:$B,' + P + ',' + D + '$E:$E),"—")'],
  ];
  kpis.forEach(([c, label, f]) => {
    const colIdx = sh.getRange(c + '1').getColumn();
    sh.getRange(6, colIdx, 1, 3).merge().setValue(label).setFontSize(9).setFontColor('#666666').setBackground('#eef3f8');
    sh.getRange(7, colIdx, 1, 3).merge().setFormula(f).setFontSize(18).setFontWeight('bold').setBackground('#eef3f8');
  });
  sh.getRange('K7').setNumberFormat('0.0%');

  // Ranking table
  const hdrRow = 10, firstRow = 11;
  sh.getRange('B9').setValue('RANKING — BEST TO WORST').setFontWeight('bold').setFontColor('#1f3a5f');
  const hdr = ['Rank', 'Center', 'Score', 'Status', 'Categories PASS'].concat(CR.CATEGORIES.map(c => c.name), ['Month Accuracy']);
  sh.getRange(hdrRow, 2, 1, hdr.length).setValues([hdr]).setFontWeight('bold')
    .setBackground('#1f3a5f').setFontColor('#ffffff').setWrap(true).setVerticalAlignment('middle');
  const dataCols = 'C2:' + crColLetter_(7 + nCat + 1);   // Rank .. Month Accuracy in the data tab
  sh.getRange(firstRow, 2).setFormula('=IFERROR(SORT(FILTER(' + D + dataCols + ',' + D + 'B2:B=' + P +
    '),1,TRUE),"No data for this period")');
  const body = sh.getRange(firstRow, 2, tableRows, hdr.length);
  body.setBorder(true, true, true, true, false, true, '#d9d9d9', SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange(firstRow, 4, tableRows, 1).setNumberFormat('0.0%').setFontWeight('bold');
  sh.getRange(firstRow, 7, tableRows, nCat + 1).setNumberFormat('0%');
  sh.getRange(firstRow, 2, tableRows, hdr.length).setHorizontalAlignment('center');

  const pctRanges = [sh.getRange(firstRow, 4, tableRows, 1), sh.getRange(firstRow, 7, tableRows, nCat)];
  const rules = [];
  const red = '#f4cccc', amber = '#fff2cc', green = '#d9ead3';
  const top = 'D' + firstRow;
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND(ISNUMBER(' + top + '),' + top + '>=' + CR.MONTH_PASS + ')')
    .setBackground(green).setRanges(pctRanges).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND(ISNUMBER(' + top + '),' + top + '>=' + CR.DAILY_MIN + ')')
    .setBackground(amber).setRanges(pctRanges).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=ISNUMBER(' + top + ')')
    .setBackground(red).setRanges(pctRanges).build());
  const statusRange = sh.getRange(firstRow, 5, tableRows, 1);
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextContains('NOT').setBackground(red).setFontColor('#990000').setRanges([statusRange]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextContains('ACCURATE').setBackground(green).setFontColor('#274e13').setRanges([statusRange]).build());

  // Score chart for the selected month
  const chart = sh.newChart().setChartType(Charts.ChartType.BAR)
    .addRange(sh.getRange(firstRow, 3, tableRows, 2))
    .setPosition(hdrRow - 1, lastCol + 2, 0, 0)
    .setOption('title', 'Score by center (selected month)')
    .setOption('fontName', 'Poppins')
    .setOption('legend', { position: 'none' })
    .setOption('hAxis', { format: 'percent', viewWindow: { min: 0, max: 1 } })
    .setOption('colors', ['#1f3a5f'])
    .setOption('width', 520).setOption('height', 60 + 36 * tableRows)
    .build();
  sh.insertChart(chart);

  // Trend matrices (all months, oldest → newest)
  let row = firstRow + tableRows + 2;
  const byKey = {};
  ranking.forEach(r => { byKey[r.period + '|' + r.center] = r; });
  row = crWriteMatrix_(sh, row, 'SCORE TREND — ALL MONTHS', centers, periods, byKey, r => r.score, '0%',
    ['Months ACCURATE'], c => {
      const rs = periods.map(p => byKey[p + '|' + c]).filter(Boolean);
      return [rs.filter(r => r.accurate).length + ' / ' + rs.length];
    });
  const trendScore = sh.getRange(row - centers.length - 1, 3, centers.length, periods.length);
  if (centers.length && periods.length) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .setGradientMinpointWithValue('#e67c73', SpreadsheetApp.InterpolationType.NUMBER, '0')
      .setGradientMidpointWithValue('#ffd666', SpreadsheetApp.InterpolationType.NUMBER, String(CR.DAILY_MIN))
      .setGradientMaxpointWithValue('#57bb8a', SpreadsheetApp.InterpolationType.NUMBER, '1')
      .setRanges([trendScore]).build());
  }
  row = crWriteMatrix_(sh, row + 1, 'RANK TREND — ALL MONTHS (1 = best)', centers, periods, byKey, r => r.rank, '0',
    ['Average Rank'], c => {
      const rs = periods.map(p => byKey[p + '|' + c]).filter(Boolean);
      return [rs.length ? rs.reduce((s, r) => s + r.rank, 0) / rs.length : ''];
    });
  sh.getRange(row - centers.length - 1, 3 + periods.length, centers.length, 1).setNumberFormat('0.0');

  sh.setConditionalFormatRules(rules);

  // Notes
  row += 1;
  const skippedText = CR.CATEGORIES.map(c => c.name + ' ' + (skipped[c.key] || 0)).join('  |  ');
  const notes = [
    'HOW TO READ THIS',
    '● Score = average Days Pass % across the categories that had records for that center in that month. Blank category = no records, not a failure.',
    '● Days Pass % = share of active days where complete records / auditable records ≥ daily minimum. Register Trial no-show rows (N/A) are not audited.',
    '● ACCURATE = every category with records passed (Days Pass % ≥ ' + Math.round(CR.MONTH_PASS * 100) + '%). Ties are broken by categories PASS, then Month Accuracy.',
    '● The current month is still running, so its numbers move until the month closes.',
    '● Rows skipped (audited but missing center / period key / day): ' + skippedText,
    '● Numbers refresh every hour; this tab is redrawn by 📊 Center Ranking → Build / update the Center Ranking tab. Per-category numbers: tab "' + CR.DETAIL + '".',
  ];
  sh.getRange(row, 2, notes.length, 1).setValues(notes.map(n => [n])).setFontColor('#444444');
  sh.getRange(row, 2).setFontWeight('bold').setFontColor('#1f3a5f');

  // Layout
  sh.setColumnWidth(1, 16);
  sh.setColumnWidth(2, 70);
  sh.setColumnWidths(3, Math.max(lastCol, 2 + periods.length + 1) - 2, 104);
  sh.setRowHeight(hdrRow, 36);
  sh.setFrozenRows(0);
}

/** Writes a center × month matrix with extra summary columns; returns the next free row. */
function crWriteMatrix_(sh, row, title, centers, periods, byKey, pick, fmt, extraHdr, extra) {
  sh.getRange(row, 2).setValue(title).setFontWeight('bold').setFontColor('#1f3a5f');
  row++;
  const hdr = ['Center'].concat(periods.map(crPeriodLabel_), extraHdr);
  sh.getRange(row, 2, 1, hdr.length).setValues([hdr]).setFontWeight('bold')
    .setBackground('#1f3a5f').setFontColor('#ffffff').setHorizontalAlignment('center');
  row++;
  if (centers.length) {
    const vals = centers.map(c => [c].concat(periods.map(p => {
      const r = byKey[p + '|' + c];
      return r ? pick(r) : '';
    }), extra(c)));
    extraHdr.forEach((_, j) => {   // text such as "2 / 12" must not become a date
      if (typeof vals[0][1 + periods.length + j] === 'string') sh.getRange(row, 3 + periods.length + j, vals.length, 1).setNumberFormat('@');
    });
    const rng = sh.getRange(row, 2, vals.length, hdr.length).setValues(vals).setHorizontalAlignment('center');
    rng.setBorder(true, true, true, true, false, true, '#d9d9d9', SpreadsheetApp.BorderStyle.SOLID);
    if (periods.length) sh.getRange(row, 3, vals.length, periods.length).setNumberFormat(fmt);
    sh.getRange(row, 2, vals.length, 1).setFontWeight('bold');
    row += vals.length;
  }
  return row + 1;
}

function crColLetter_(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
