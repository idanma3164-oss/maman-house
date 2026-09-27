// ═══════════════════════════════════════════════════════════════
// payments.js — תשלומים לקבלן + משכנתא והלוואת קבלן (page: payments)
// Data: contract/…, mortgage/… (see test/AGENT_BRIEF.md)
// Public: window.PAY_API.summary(), .upcoming(days), .seed()
// ═══════════════════════════════════════════════════════════════
(function () {
  'use strict';
  const MH = window.MH;
  const esc = s => MH.esc(s);
  const money = n => MH.money(n);

  const STAGES = ['טרם התחיל', 'איסוף מסמכים', 'אישור עקרוני', 'השוואת הצעות', 'אישור סופי', 'חתימה ומשיכה'];
  const TRACK_TYPES = ['פריים', 'קל"צ', 'ק"צ', 'משתנה כל 5'];
  const CHECKLIST = [
    'תעודות זהות + ספחים', '3 תלושי שכר אחרונים לכל אחד', 'דפי עו"ש 3 חודשים', 'אישור יתרות/חסכונות',
    'חוזה מכר + נספחים', 'אישור זכויות/הערת אזהרה', 'אישור הקבלן על יתרת תשלום', 'נסח/אישור זכויות מהקבלן',
    'פוליסות ביטוח חיים ומבנה', 'שמאות',
  ];
  const LOAN_DEFAULT = { bank: 'בנק הפועלים', amount: 700000, startDate: '2025-06-11', maxMonths: 30 };

  let C = null, M = null;               // contract, mortgage (raw snapshots)
  let cLoaded = false, mLoaded = false;
  const ui = { details: false };

  // ── seeding (only when node is null; transaction aborts otherwise) ──
  function contractSeed() {
    const now = Date.now();
    return {
      price: 1790000, signDate: '2025-03-24', deliveryDate: '2027-12-31', graceDays: 30,
      baseIndexLabel: '02/2025', indexShare: 0.5, lateInterestPct: 11,
      seller: 'צרפתי שמעון בע"מ', project: 'צרפתי בנאות הדרים, באר שבע — מגרש 110, בניין 6, דירה 24, קומה 6',
      installments: {
        i1: { n: 1, label: 'תשלום 1 — בחתימה (7 ימים)', amount: 330000, dueDate: '2025-03-31', notes: '' },
        i2: { n: 2, label: 'תשלום 2 — הלוואת קבלן', amount: 700000, dueDate: '2025-06-30', notes: 'ממומן בהלוואה מסובסדת (בנק הפועלים)' },
        i3: { n: 3, label: 'תשלום 3 — יתרה', amount: 760000, dueDate: '2027-12-17', notes: '' },
      },
      payments: {
        p1: { date: '2025-04-02', amount: 330000, installmentKey: 'i1', invoiceNo: '18304', notes: 'רכישת נכס', docKey: '' },
        p2: { date: '2025-06-11', amount: 700000, installmentKey: 'i2', invoiceNo: '18673', notes: 'רכישת נכס — הלוואת קבלן', docKey: '' },
        p3: { date: '2025-12-25', amount: 65000, installmentKey: 'i3', invoiceNo: '19513', notes: 'רכישת נכס — תשלום מוקדם', docKey: '' },
        p4: { date: '2026-03-11', amount: 52500, installmentKey: 'i3', invoiceNo: '19915', notes: 'רכישת נכס — תשלום מוקדם', docKey: '' },
      },
      createdAt: now,
    };
  }
  function mortgageSeed() {
    const checklist = {};
    CHECKLIST.forEach((label, i) => { checklist['c' + String(i + 1).padStart(2, '0')] = { label, done: false, docKey: '', order: i + 1 }; });
    return { stage: STAGES[0], advisor: '', bank: '', notes: '', contractorLoan: Object.assign({}, LOAN_DEFAULT), checklist, createdAt: Date.now() };
  }
  // One-time: meta/seeded/<name> flag (never re-seed a node someone cleared) AND node must be null.
  const seeding = {};
  function seedNode(name, make) {
    if (seeding[name]) return seeding[name];
    const flag = MH.db.ref('meta/seeded/' + name);
    seeding[name] = flag.once('value').then(s => {
      if (s.val() === true) return false;
      return MH.db.ref(name).transaction(cur => (cur === null || cur === undefined) ? make() : undefined)
        .then(() => flag.transaction(cur => cur === true ? undefined : true))   // also marks pre-existing nodes
        .then(() => true);
    }).catch(e => { console.error('[payments] seed ' + name, e); return false; })
      .then(r => { delete seeding[name]; return r; });
    return seeding[name];
  }
  function seed() { return Promise.all([seedNode('contract', contractSeed), seedNode('mortgage', mortgageSeed)]).then(r => r); }
  // ═══ Index engine (v2.3) — the user's own method (see his sheet "חישוב תשלום מדד תשומות בניה") ═══
  // CBS "מדד מחירי תשומה בבנייה למגורים" id 200010. Base 2011 up to 07/2025, new base Jul-2025=100 from 08/2025.
  // chain value (2011-base equivalent) = v (2011) | v × 1.387 (new base). User's points scale = v × 2.709502 (2011) | v × 3.758128 (new).
  const IX = { LINK: 1.387, F_OLD: 2.709502, F_NEW: 3.758128, LS: 'py.cbs.lastFetch', THROTTLE: 6 * 3600e3, TIMEOUT: 6000,
    URL: 'https://api.cbs.gov.il/index/data/price?id=200010&format=json&download=false&startPeriod=01-2025&endPeriod=12-2030&lang=he' };
  const IX_FALLBACK = (() => {
    const p = {};
    [['2025-01', 137.1], ['2025-02', 137.7], ['2025-03', 138.2], ['2025-04', 138.4], ['2025-05', 138.6], ['2025-06', 138.6], ['2025-07', 138.7]].forEach(([k, v]) => { p[k] = { v, base: '2011' }; });
    [['2025-08', 100.4], ['2025-09', 100.4], ['2025-10', 100.5], ['2025-11', 101.1], ['2025-12', 101.2], ['2026-01', 101.3], ['2026-02', 101.5],
      ['2026-03', 101.7], ['2026-04', 102.8], ['2026-05', 103.4], ['2026-06', 103.6], ['2026-07', 103.5], ['2026-08', 103.9]].forEach(([k, v]) => { p[k] = { v, base: '2025' }; });
    return { source: 'seed', latestMonth: '2026-08', updatedAt: 0, points: p };
  })();
  function indexRowsSeed() {
    return {
      r1: { payDate: '2025-04-02', amount: 330000, paymentKey: 'p1', notes: 'חשבונית 18304' },
      r2: { payDate: '2025-06-11', amount: 700000, paymentKey: 'p2', indexMonth: '2025-05', indexValue: 375.537, exposedAfter: 380000, notes: 'חשבונית 18673' },
      r3: { payDate: '2025-12-25', amount: 65000, paymentKey: 'p3', indexMonth: '2025-11', indexValue: 379.942, exposedAfter: 315000, due: 4457, notes: 'חשבונית 19513' },
      r4: { payDate: '2026-03-11', amount: 52500, paymentKey: 'p4', indexMonth: '2026-02', indexValue: 381.45, exposedAfter: 262500, due: 1246, notes: 'חשבונית 19915' },
    };
  }
  function extrasSeed() {
    return { x1: { title: "חשבון שינויים מס' 1", amount: 8707, date: '2026-01-07', indexBaseMonth: '2025-11', linked: true, dueAt: 'delivery',
      financedByMortgage: true, paid: false, docTitle: "חשבון שינויים מס' 1- בניין 6 דירה 24", notes: '8,020 − 8% הנחה = 7,378.40 + מע"מ 18%. תשלומו תנאי לקבלת החזקה.' } };
  }
  const DELIVERY_EXT = { to: '2028-03-03', note: 'חשבון שינויים מס\' 1: החברה רשאית לדחות את המסירה ב-63 ימי עבודה בגלל שינויי הדיירים' };

  // sub-node seeds under contract — only when contract exists, node is null and flag not set
  function subSeed(flagName, path, make) {
    if (seeding[flagName]) return seeding[flagName];
    const flag = MH.db.ref('meta/seeded/' + flagName);
    seeding[flagName] = flag.once('value').then(s => {
      if (s.val() === true || !C) return false;
      return MH.db.ref(path).transaction(cur => (cur === null || cur === undefined) ? make() : undefined)
        .then(() => flag.transaction(cur => cur === true ? undefined : true)).then(() => true);
    }).catch(e => { console.error('[payments] seed ' + flagName, e); return false; })
      .then(r => { delete seeding[flagName]; return r; });
    return seeding[flagName];
  }
  function seedContractExtras() {
    return Promise.all([
      subSeed('indexRows', 'contract/indexRows', indexRowsSeed),
      subSeed('indexSeries', 'contract/indexSeries', () => JSON.parse(JSON.stringify(IX_FALLBACK))),
      subSeed('extras', 'contract/extras', extrasSeed),
      subSeed('deliveryExt', 'contract/deliveryExtendedTo', () => DELIVERY_EXT.to)
        .then(r => r && MH.db.ref('contract/deliveryExtensionNote').transaction(cur => cur == null ? DELIVERY_EXT.note : undefined)),
    ]);
  }

  // ── month helpers ──
  const mkey = iso => String(iso || '').slice(0, 7);
  function addMonthKey(k, n) { const [y, m] = k.split('-').map(Number); const t = new Date(y, m - 1 + n, 1); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0'); }
  const prevMonthKey = iso => addMonthKey(mkey(iso), -1);                 // index month for a payment = month before payment
  function monthDiff(a, b) { const [ya, ma] = a.split('-').map(Number), [yb, mb] = b.split('-').map(Number); return (yb - ya) * 12 + (mb - ma); }
  const monthLabel = k => k ? k.slice(5, 7) + '/' + k.slice(0, 4) : '';

  function seriesObj() { const s = C && C.indexSeries; return (s && s.points && typeof s.points === 'object') ? s : IX_FALLBACK; }
  function seriesPoints() { return Object.assign({}, IX_FALLBACK.points, seriesObj().points); }
  function indexModel(mm) {
    const c = mm.c, S = seriesPoints(), months = Object.keys(S).sort();
    const chain = k => (k && S[k] && num(S[k].v) != null) ? (S[k].base === '2011' ? S[k].v : S[k].v * IX.LINK) : null;
    const userOf = k => (k && S[k]) ? S[k].v * (S[k].base === '2011' ? IX.F_OLD : IX.F_NEW) : null;
    const rows = entries(c.indexRows).sort((a, b) => String(a.payDate).localeCompare(String(b.payDate)) || a._key.localeCompare(b._key));
    let prev = null, past = 0;
    rows.forEach(r => {
      r._month = r.indexMonth || null;
      r._cbs = r._month && S[r._month] ? S[r._month].v : null;
      r._user = num(r.indexValue) != null ? num(r.indexValue) : userOf(r._month);
      r._rise = null; r._due = null; r._exposedBefore = null;
      if (!r._month) { r._exposedAfter = null; return; }
      if (!prev) { r._exposedAfter = num(r.exposedAfter) != null ? num(r.exposedAfter) : mm.share * (num(r.amount) || 0); prev = r; return; }
      const a = chain(prev._month), b = chain(r._month);
      const ratio = (a && b) ? b / a : (prev._user && r._user ? r._user / prev._user : null);
      r._exposedBefore = prev._exposedAfter;
      r._rise = ratio != null ? ratio - 1 : null;
      r._due = ratio != null ? Math.max(0, r._exposedBefore * (ratio - 1)) : null;   // decreases don't reduce the price
      past += r._due || 0;
      r._exposedAfter = num(r.exposedAfter) != null ? num(r.exposedAfter) : Math.max(0, r._exposedBefore - (num(r.amount) || 0));
      prev = r;
    });
    const L = months[months.length - 1] || null;
    const B = prev ? prev._month : null, exposed = prev ? prev._exposedAfter : 0;
    const cL = chain(L), cB = chain(B);
    const accruedCurrent = (cL && cB) ? exposed * Math.max(0, cL / cB - 1) : 0;
    // average monthly rise: geometric mean of the last 12 monthly changes (fewer if the series is shorter)
    let n = 12; while (n > 0 && !chain(addMonthKey(L, -n))) n--;
    const m = (n > 0 && cL) ? Math.pow(cL / chain(addMonthKey(L, -n)), 1 / n) - 1 : 0;
    const finalInst = mm.inst.filter(i => i._rem > 0).sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate))).pop();
    const projMonth = prevMonthKey(finalInst ? finalInst.dueDate : (c.deliveryDate || '2027-12-31'));
    let lateMonth = prevMonthKey(c.deliveryExtendedTo || DELIVERY_EXT.to);
    if (lateMonth <= projMonth) lateMonth = addMonthKey(projMonth, 3);
    const projChain = k => cL ? cL * Math.pow(1 + m, Math.max(0, monthDiff(L, k))) : null;
    const pC = projChain(projMonth), pCL = projChain(lateMonth);
    const projDiffLast = (pC && cB) ? exposed * Math.max(0, pC / cB - 1) : 0;
    const projDiffLate = (pCL && cB) ? exposed * Math.max(0, pCL / cB - 1) : 0;
    const paidPast = !!c.indexDiffPaid;
    const sObj = seriesObj();
    const curMonth = mkey(MH.todayISO());
    return {
      rows, S, chain, userOf, latestMonth: L, latestValueCbs: L ? S[L].v : null, latestValueUser: userOf(L),
      baseMonth: B, exposed, accruedPast: past, accruedCurrent, accruedTotal: past + accruedCurrent, avgMonthly: m, avgAnnual: Math.pow(1 + m, 12) - 1,
      projMonth, lateMonth, projChain: pC, projIndexUser: pC ? pC * IX.F_NEW / IX.LINK : null, projIndexCbs: pC ? pC / IX.LINK : null,
      projDiffLast, projectedTotal: past + projDiffLast, projectedTotalLate: past + projDiffLate, paidPast,
      toPayNow: (paidPast ? 0 : past) + accruedCurrent, toPayProjected: (paidPast ? 0 : past) + projDiffLast,
      updatedAt: sObj.updatedAt || null, source: sObj.source || 'seed',
      stale: !!ui.fetchFailed || !L || monthDiff(L, curMonth) > 2,
    };
  }
  function extrasModel(im) {
    return entries(C && C.extras).sort((a, b) => String(a.date).localeCompare(String(b.date))).map(x => {
      const base = im.chain(x.indexBaseMonth);
      x._ixProj = (x.linked && base && im.projChain) ? Math.max(0, (num(x.amount) || 0) * (im.projChain / base - 1)) : 0;
      x._ixNow = (x.linked && base && im.chain(im.latestMonth)) ? Math.max(0, (num(x.amount) || 0) * (im.chain(im.latestMonth) / base - 1)) : 0;
      return x;
    });
  }

  // ── CBS auto-update (≤ once per 6h per device, 6s timeout, forward-only write) ──
  function parseCbs(j) {
    const arr = j && j.month && j.month[0] && j.month[0].date;
    if (!Array.isArray(arr) || !arr.length) throw new Error('CBS: unexpected format');
    const points = {};
    arr.forEach(d => {
      const y = Number(d.year), mo = Number(d.month), v = num(d.currBase && d.currBase.value);
      if (!y || !mo || v == null) return;
      points[y + '-' + String(mo).padStart(2, '0')] = { v, base: /2011/.test(String(d.currBase.baseDesc || '')) ? '2011' : '2025' };
    });
    const keys = Object.keys(points).sort();
    if (!keys.length) throw new Error('CBS: no data');
    return { points, latestMonth: keys[keys.length - 1] };
  }
  function writeSeries(s) {
    if (!C) return Promise.resolve(false);
    return MH.db.ref('contract/indexSeries').transaction(cur => {
      if (cur && cur.latestMonth && cur.latestMonth >= s.latestMonth) return;         // only move forward
      return { updatedAt: Date.now(), source: 'CBS', latestMonth: s.latestMonth, points: Object.assign({}, cur && cur.points, s.points) };
    }).then(r => !!(r && r.committed));
  }
  let ixInflight = null;
  function refreshIndex(opts) {
    opts = opts || {};
    if (!opts.force) { try { const t = Number(localStorage.getItem(IX.LS)) || 0; if (Date.now() - t < IX.THROTTLE) return Promise.resolve('throttled'); } catch (e) {} }
    if (ixInflight) return ixInflight;
    ui.fetching = true; MH.refreshIfShown('payments');
    let timer = null;
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => { try { ctl && ctl.abort(); } catch (e) {} rej(new Error('timeout')); }, IX.TIMEOUT); });
    ixInflight = Promise.race([fetch(IX.URL, ctl ? { signal: ctl.signal } : {}), timeout])
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(j => {
        const s = parseCbs(j);
        try { localStorage.setItem(IX.LS, String(Date.now())); } catch (e) {}
        ui.fetchFailed = false; ui.checkedAt = Date.now();
        return writeSeries(s).then(w => w ? 'updated' : 'current');
      })
      .catch(e => { console.warn('[payments] CBS fetch failed', e && e.message); ui.fetchFailed = true; return 'failed'; })
      .then(res => { clearTimeout(timer); ixInflight = null; ui.fetching = false; ui.lastResult = res; MH.emit('contract'); MH.refreshIfShown('payments'); return res; });
    return ixInflight;
  }

  // ── writes (granular) ──
  // update() on an existing parent only (contract / mortgage); never recreates a cleared node
  function upd(path, obj) {
    const exists = path === 'contract' ? !!C : path === 'mortgage' ? !!M : true;
    if (!exists) { MH._conflict ? MH._conflict() : MH.toast('⚠️ הנתונים נמחקו במכשיר אחר'); return Promise.resolve(false); }
    MH.syncing(); return MH.db.ref(path).update(obj).then(MH.saved, MH.saveError);
  }
  function setv(path, v) { MH.syncing(); return MH.db.ref(path).set(v).then(MH.saved, MH.saveError); }

  // ── date helpers ──
  function addMonthsISO(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    const t = new Date(y, m - 1 + n, 1);
    const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
    t.setDate(Math.min(d, last));
    return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
  }
  function monthsDaysUntil(iso) { // {m, d} from today until iso (non-negative)
    const today = MH.today(); const end = new Date(iso + 'T00:00:00');
    if (end <= today) return { m: 0, d: 0 };
    let m = (end.getFullYear() - today.getFullYear()) * 12 + (end.getMonth() - today.getMonth());
    let mark = new Date(today.getFullYear(), today.getMonth() + m, today.getDate());
    if (mark > end) { m--; mark = new Date(today.getFullYear(), today.getMonth() + m, today.getDate()); }
    return { m, d: Math.round((end - mark) / 864e5) };
  }
  const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);

  // ── derived model ──
  function entries(o) { return o && typeof o === 'object' ? Object.keys(o).map(k => Object.assign({ _key: k }, o[k])) : []; }
  function model() {
    const c = C || {};
    const price = num(c.price) || 0;
    const pays = entries(c.payments).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const inst = entries(c.installments).sort((a, b) => (a.n || 0) - (b.n || 0) || String(a.dueDate).localeCompare(String(b.dueDate)));
    const paid = pays.reduce((s, p) => s + (num(p.amount) || 0), 0);
    inst.forEach(i => {
      i._pays = pays.filter(p => p.installmentKey === i._key);
      i._paid = i._pays.reduce((s, p) => s + (num(p.amount) || 0), 0);
      i._rem = Math.max(0, (num(i.amount) || 0) - i._paid);
      i._days = MH.daysUntil(i.dueDate);
      i._status = i._rem <= 0 ? 'full' : (i._days !== null && i._days < 0) ? 'late' : i._paid > 0 ? 'partial' : 'future';
    });
    const orphan = pays.filter(p => !inst.some(i => i._key === p.installmentKey));
    const remaining = Math.max(0, price - paid);
    const remainingInst = inst.reduce((s, i) => s + i._rem, 0);
    const share = num(c.indexShare) != null ? num(c.indexShare) : 0.5;
    const next = inst.find(i => i._rem > 0) || null;
    const mm = { c, price, pays, inst, orphan, paid, remaining, remainingInst, share, next, pct: price ? paid / price * 100 : 0 };
    // single source of truth for indexation: indexModel (old baseIndex/currentIndex/INDEX_PREFILL fields are ignored)
    mm.ix = indexModel(mm);
    mm.extras = extrasModel(mm.ix);
    mm.indexEstimate = C ? mm.ix.toPayNow : null;
    mm.indexProjection = C ? mm.ix.toPayProjected : null;
    mm.deliveryLatest = c.deliveryExtendedTo && c.deliveryExtendedTo > (c.deliveryDate || '') ? c.deliveryExtendedTo : (c.deliveryDate || null);
    return mm;
  }
  function expenseIndexEstimate() {
    try {
      const it = (typeof DATA !== 'undefined' && Array.isArray(DATA)) ? DATA.find(x => x && String(x.desc || '').includes('מדד')) : null;
      return it ? { price: num(it.price) || 0, paid: num(it.paid) || 0, notes: it.notes || '' } : null;
    } catch (e) { return null; }
  }
  function available() { try { return (typeof SETTINGS !== 'undefined' && SETTINGS && num(SETTINGS.available)) || 0; } catch (e) { return 0; } }
  function loanInfo() {
    const l = Object.assign({}, LOAN_DEFAULT, (M && M.contractorLoan) || {});
    const end = addMonthsISO(l.startDate, Number(l.maxMonths) || 30);
    const days = MH.daysUntil(end);
    const md = monthsDaysUntil(end);
    const state = days < 0 ? 'red' : md.m < 6 ? 'red' : md.m < 12 ? 'yellow' : 'green';
    return Object.assign(l, { end, days, md, state });
  }
  function financing(mm) {
    const ix = mm.indexProjection || 0;
    const ixSrc = 'תחזית ל-' + monthLabel(mm.ix.projMonth) + (mm.ix.paidPast ? ', ללא הפרשים ששולמו' : '');
    const loan = loanInfo();
    const fx = mm.extras.filter(x => x.financedByMortgage && !x.paid);
    const extras = fx.reduce((s, x) => s + (num(x.amount) || 0) + x._ixProj, 0);
    const total = mm.remaining + ix + (Number(loan.amount) || 0) + extras;
    const cash = available();
    const est = Math.max(0, total - cash);
    const target = M && num(M.targetAmount);
    return { ix, ixSrc, extras, extrasList: fx, loanAmt: Number(loan.amount) || 0, total, cash, est, target, mortgage: target || est };
  }
  function tracksModel() {
    const t = entries(M && M.tracks);
    let total = 0, wsum = 0, monthly = 0;
    t.forEach(x => {
      const A = num(x.amount) || 0, r = (num(x.rate) || 0) / 100 / 12, n = Math.round((num(x.years) || 0) * 12);
      x._pmt = n > 0 ? (r > 0 ? A * r / (1 - Math.pow(1 + r, -n)) : A / n) : 0;
      total += A; wsum += A * (num(x.rate) || 0); monthly += x._pmt;
    });
    return { t, total, avg: total ? wsum / total : 0, monthly };
  }
  function checklistItems() { return entries(M && M.checklist).sort((a, b) => (a.order || 0) - (b.order || 0)); }

  // ── docs integration (optional; DOCS_API may not exist) ──
  function docsList() {
    const D = window.DOCS_API; if (!D) return [];
    try {
      let arr = typeof D.list === 'function' ? D.list() : typeof D.all === 'function' ? D.all() : (D.docs || []);
      if (arr && !Array.isArray(arr)) arr = Object.keys(arr).map(k => Object.assign({ key: k }, arr[k]));
      return (arr || []).map(d => Object.assign({ key: d.key || d._key || d.id }, d));
    } catch (e) { return []; }
  }
  function docByKey(k) {
    if (!k) return null;
    const D = window.DOCS_API;
    if (D && typeof D.get === 'function') { try { const d = D.get(k); if (d) return Object.assign({ key: k }, d); } catch (e) {} }
    return docsList().find(d => d.key === k) || null;
  }
  function docForPayment(p) {
    if (p.docKey) { const d = docByKey(p.docKey); if (d) return d; }
    const rel = docsList().find(d => d.relatedPayment && d.relatedPayment === p._key && d.status !== 'חסר');
    if (rel) return rel;
    if (!p.invoiceNo) return null;
    const inv = String(p.invoiceNo);
    return docsList().find(d => String(d.title || '').includes(inv) || String(d.path || '').includes(inv)) || null;
  }
  function docLinkHtml(d) {
    if (!d) return '';
    if (d.link && /^https?:\/\//i.test(String(d.link).trim())) return '<a class="py-doc" href="' + esc(String(d.link).trim()) + '" target="_blank" rel="noopener" title="' + esc(d.title) + '">🔗</a>';
    if (!d.key) return '';
    return '<button class="py-doc" data-act="open-doc" data-k="' + esc(d.key) + '" title="' + esc(d.title) + '">🔗</button>';
  }
  function docOptions(sel) {
    const D = window.DOCS_API;
    if (D && typeof D.optionsHtml === 'function') { try { const h = D.optionsHtml(sel || ''); return /value=""/.test(h) ? h : '<option value="">— ללא —</option>' + h; } catch (e) {} }
    const l = docsList(); if (!l.length) return null;
    return '<option value="">— ללא —</option>' + l.map(d => '<option value="' + esc(d.key) + '"' + (d.key === sel ? ' selected' : '') + '>' + esc(d.title) + '</option>').join('');
  }

  // ── CSS ──
  function injectCSS() {
    if (document.getElementById('payments-css')) return;
    const s = document.createElement('style'); s.id = 'payments-css';
    s.textContent = `
#pay-root{font-variant-numeric:tabular-nums}
.py-sec{font-size:1.02rem;font-weight:900;margin:6px 2px 10px;display:flex;align-items:center;justify-content:space-between;gap:8px}
.py-sec+.py-sub{margin-top:-6px}
.py-sub{font-size:.72rem;color:var(--muted);margin:0 2px 10px;line-height:1.5}
.py-num{font-variant-numeric:tabular-nums;white-space:nowrap}
.py-kpi-date{font-size:.66rem;color:var(--muted);margin-top:4px}
.py-tl{position:relative;padding-right:22px}
.py-tl:before{content:'';position:absolute;right:7px;top:6px;bottom:6px;width:2px;background:var(--border)}
.py-inst{position:relative;padding:2px 0 14px}
.py-inst:last-child{padding-bottom:2px}
.py-dot{position:absolute;right:-21px;top:3px;width:14px;height:14px;border-radius:50%;background:#fff;border:3px solid #9ca3af}
.py-inst.full .py-dot{border-color:var(--green);background:var(--green)}
.py-inst.partial .py-dot{border-color:var(--yellow)}
.py-inst.late .py-dot{border-color:var(--red);background:var(--red)}
.py-ih{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.py-ih .mh-title{font-size:.84rem}
.py-amt{font-size:.95rem;font-weight:900;white-space:nowrap}
.py-ibar{height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden;margin:6px 0 4px}
.py-ibar>i{display:block;height:100%;background:var(--green)}
.py-inst.partial .py-ibar>i{background:var(--yellow)}
.py-inst.late .py-ibar>i{background:var(--red)}
.py-pays{margin-top:6px;background:var(--bg);border-radius:10px;padding:2px 10px}
.py-pay{display:flex;align-items:center;gap:8px;padding:7px 0;border-top:1px solid var(--border);font-size:.74rem;cursor:pointer}
.py-pay:first-child{border-top:none}
.py-pay .py-pd{color:var(--muted);white-space:nowrap}
.py-pay .py-pa{font-weight:800;white-space:nowrap}
.py-pay .py-pi{flex:1;min-width:0;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.py-doc{background:none;border:none;text-decoration:none;font-size:.9rem;cursor:pointer;padding:0;min-width:32px;min-height:32px;display:inline-flex;align-items:center;justify-content:center;border-radius:8px;flex-shrink:0;margin:-4px 0}
.py-doc:active{background:var(--blue-50)}
#pay-root .mh-btn.sm{min-height:32px;padding:6px 11px}
.py-two{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0}
.py-box{background:var(--bg);border-radius:10px;padding:10px}
.py-box.hl{background:var(--blue-50)}
.py-box-l{font-size:.66rem;color:var(--muted);font-weight:700}
.py-box-v{font-size:1.02rem;font-weight:900;margin-top:3px}
.py-box-s{font-size:.64rem;color:var(--muted);margin-top:3px;line-height:1.4}
.py-list{margin:0;padding:0 16px 0 0;font-size:.74rem;line-height:1.7}
.py-list li{margin-bottom:2px}
.py-warn{font-size:.68rem;color:#92400e;background:var(--yellow-50);border-radius:8px;padding:6px 9px;margin-top:8px}
details.py-det>summary{list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;font-size:.88rem;font-weight:800}
details.py-det>summary::-webkit-details-marker{display:none}
details.py-det>summary:after{content:'▾';color:var(--muted);transition:transform .2s}
details.py-det[open]>summary:after{transform:rotate(180deg)}
details.py-det[open]>summary{margin-bottom:10px}
.py-loan{border-right:5px solid var(--green)}
.py-loan.yellow{border-right-color:var(--yellow)}.py-loan.red{border-right-color:var(--red)}
.py-cd{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.py-cd b{font-size:1.6rem;font-weight:900}
.py-loan.red .py-cd b{color:var(--red)}.py-loan.yellow .py-cd b{color:#b45309}.py-loan.green .py-cd b{color:#047857}
.py-fin{width:100%;border-collapse:collapse;font-size:.78rem}
.py-fin td{padding:6px 0;border-top:1px solid var(--border)}
.py-fin tr:first-child td{border-top:none}
.py-fin td:last-child{text-align:left;font-weight:700;white-space:nowrap;direction:ltr}
.py-fin tr.tot td{font-weight:900;border-top:2px solid var(--ink)}
.py-fin tr.res td{font-weight:900;font-size:.9rem;color:var(--accent)}
.py-steps{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.py-step{border:1.5px solid var(--border);background:#fff;border-radius:10px;padding:8px 4px;font-family:inherit;font-size:.68rem;font-weight:700;color:var(--muted);cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:4px;line-height:1.2;text-align:center;min-height:62px}
.py-step i{font-style:normal;width:22px;height:22px;border-radius:50%;background:#e5e7eb;color:var(--muted);display:flex;align-items:center;justify-content:center;font-size:.7rem;font-weight:900}
.py-step.done{color:var(--ink)}
.py-step.done i{background:var(--green);color:#fff}
.py-step.cur{border-color:var(--accent);background:var(--blue-50);color:var(--accent)}
.py-step.cur i{background:var(--accent);color:#fff}
.py-kv{display:flex;gap:14px;flex-wrap:wrap;font-size:.74rem;margin-top:10px}
.py-kv span{color:var(--muted)}
.py-ck{display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--border)}
.py-ck:first-child{border-top:none}
.py-cb{width:32px;height:32px;padding:4px;border:none;background:none;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;margin:-4px}
.py-cb>span{width:24px;height:24px;border-radius:7px;border:2px solid var(--border);background:#fff;display:flex;align-items:center;justify-content:center;font-size:.8rem;color:#fff}
.py-cb.on>span{background:var(--green);border-color:var(--green)}
.py-ck .mh-title{font-size:.8rem;font-weight:600;cursor:pointer}
.py-ck.done .mh-title{color:var(--muted);text-decoration:line-through}
.py-tr{display:grid;grid-template-columns:auto 1fr auto;gap:4px 10px;align-items:center;padding:9px 0;border-top:1px solid var(--border);cursor:pointer}
.py-tr:first-child{border-top:none}
.py-tr .py-tv{font-size:.72rem;color:var(--muted)}
.py-tr .py-tp{font-weight:800;font-size:.82rem;text-align:left}
.py-ttot{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:10px}
.py-ixsrc{font-size:.68rem;color:var(--muted);margin:-4px 0 8px}
.py-fail{color:#b45309;font-weight:700}
.py-muted{color:var(--muted);font-weight:500}
.py-ixrows{background:var(--bg);border-radius:10px;padding:2px 10px}
.py-ixr{display:grid;grid-template-columns:1fr auto;gap:2px 8px;padding:8px 0;border-top:1px solid var(--border);cursor:pointer;font-size:.74rem}
.py-ixr:first-child{border-top:none}
.py-ixr-a{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.py-ixn{color:var(--muted)}
.py-ixr-due{font-weight:900;text-align:left;white-space:nowrap}
.py-ixr-b{grid-column:1/-1;font-size:.68rem;color:var(--ink-2);line-height:1.5}
.py-ixtot{display:flex;justify-content:space-between;gap:8px;padding:8px 0;border-top:2px solid var(--ink);font-size:.78rem;font-weight:800}
.py-row-btns{display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap}
.py-chk{display:flex;align-items:center;gap:8px;font-size:.72rem;min-height:32px;cursor:pointer;flex:1;min-width:0}
.py-chk input{width:20px;height:20px;flex-shrink:0;accent-color:var(--green)}
`;
    document.head.appendChild(s);
  }

  // ── render ──
  function statusBadge(i) {
    if (i._status === 'full') return '<span class="mh-badge green">שולם במלואו</span>';
    if (i._status === 'late') return '<span class="mh-badge red">באיחור · ' + Math.abs(i._days) + ' ימים</span>';
    if (i._status === 'partial') return '<span class="mh-badge yellow">שולם חלקית · נותרו ' + money(i._rem) + '</span>';
    return '<span class="mh-badge">עתידי · בעוד ' + (i._days != null ? i._days : '?') + ' ימים</span>';
  }
  function payRow(p) {
    return '<div class="py-pay" data-act="edit-pay" data-k="' + esc(p._key) + '">'
      + '<span class="py-pd">' + esc(MH.date(p.date)) + '</span>'
      + '<span class="py-pa">' + money(p.amount) + '</span>'
      + '<span class="py-pi">' + (p.invoiceNo ? 'חשבונית ' + esc(p.invoiceNo) : '') + (p.notes ? ' · ' + esc(p.notes) : '') + '</span>'
      + docLinkHtml(docForPayment(p)) + '</div>';
  }

  function renderContract(mm) {
    const c = mm.c;
    const dDays = MH.daysUntil(c.deliveryDate);
    const ext = mm.deliveryLatest && mm.deliveryLatest !== c.deliveryDate;
    let h = '<div class="py-sec">🏗️ תשלומים לקבלן<button class="mh-btn sm" data-act="add-pay">＋ תשלום</button></div>';
    h += '<div class="mh-kpis">'
      + '<div class="mh-kpi"><div class="mh-kpi-val">' + money(mm.price) + '</div><div class="mh-kpi-lbl">מחיר הדירה (כולל מע"מ)</div></div>'
      + '<div class="mh-kpi"><div class="mh-kpi-val" style="color:#047857">' + money(mm.paid) + '</div><div class="mh-kpi-lbl">שולם · ' + mm.pct.toFixed(1) + '%</div>'
      + '<div class="mh-meter"><i style="width:' + Math.min(100, mm.pct).toFixed(1) + '%"></i></div></div>'
      + '<div class="mh-kpi"><div class="mh-kpi-val" style="color:#b91c1c">' + money(mm.remaining) + '</div><div class="mh-kpi-lbl">יתרה לתשלום</div>'
      + '<div class="mh-kpi-sub">+ הפרשי הצמדה</div></div>'
      + '<div class="mh-kpi"><div class="mh-kpi-val">' + (dDays != null ? dDays.toLocaleString('he-IL') : '—') + '</div><div class="mh-kpi-lbl">ימים עד המסירה</div>'
      + '<div class="py-kpi-date">📅 חוזי ' + esc(MH.date(c.deliveryDate)) + (ext ? ' · ייתכן עד ' + esc(MH.date(mm.deliveryLatest)) + ' (ארכת שינויי דיירים)' : ' (+ חודש גרייס)') + '</div></div>'
      + '</div>';

    // timeline
    h += '<div class="mh-card"><div class="mh-card-title">לוח תשלומים <small>נספח ג\'</small></div><div class="py-tl">';
    mm.inst.forEach(i => {
      const pct = i.amount ? Math.min(100, i._paid / i.amount * 100) : 0;
      h += '<div class="py-inst ' + i._status + '"><span class="py-dot"></span>'
        + '<div class="py-ih"><div class="mh-grow"><div class="mh-title">' + esc(i.label || ('תשלום ' + (i.n || ''))) + '</div>'
        + '<div class="mh-sub">עד ' + esc(MH.date(i.dueDate)) + (i.notes ? ' · ' + esc(i.notes) : '') + '</div></div>'
        + '<div class="py-amt">' + money(i.amount) + '</div></div>'
        + '<div class="py-ibar"><i style="width:' + pct.toFixed(1) + '%"></i></div>'
        + '<div class="mh-meta">' + statusBadge(i) + '<span class="mh-badge blue">שולם ' + money(i._paid) + '</span></div>'
        + (i._pays.length ? '<div class="py-pays">' + i._pays.map(payRow).join('') + '</div>' : '')
        + '</div>';
    });
    if (!mm.inst.length) h += '<div class="mh-empty">אין תשלומים מוגדרים</div>';
    h += '</div>';
    if (mm.orphan.length) h += '<div class="mh-sub" style="margin-top:8px">תשלומים ללא שיוך:</div><div class="py-pays">' + mm.orphan.map(payRow).join('') + '</div>';
    h += '<div class="mh-sub" style="margin-top:8px">הקש/י על תשלום כדי לערוך או למחוק.</div></div>';

    // indexation (user's method)
    const ix = mm.ix;
    const pct = (v, d) => v == null ? '—' : (v * 100).toFixed(d == null ? 3 : d) + '%';
    const pts = v => v == null ? '—' : Number(v).toFixed(3);
    h += '<div class="mh-card" id="py-index"><div class="mh-card-title">📈 הצמדה למדד תשומות הבנייה<button class="mh-btn sm ghost" data-act="refresh-index"' + (ui.fetching ? ' disabled' : '') + '>' + (ui.fetching ? '⏳ מעדכן…' : '🔄 עדכן מדד') + '</button></div>';
    h += '<div class="py-ixsrc">' + (ix.source === 'CBS' && ix.updatedAt ? 'עודכן מהלמ"ס: ' + esc(MH.date(new Date(ix.updatedAt).toISOString().slice(0, 10))) : 'נתוני מדד שמורים (עד ' + monthLabel(ix.latestMonth) + ')')
      + (ui.fetchFailed ? ' · <span class="py-fail">עדכון אוטומטי נכשל — מוצג מדד אחרון שנשמר</span>' : '') + '</div>';
    h += '<div class="py-ixrows">';
    ix.rows.forEach(r => {
      h += '<div class="py-ixr" data-act="edit-ixrow" data-k="' + esc(r._key) + '">'
        + '<div class="py-ixr-a"><b>' + esc(MH.date(r.payDate)) + '</b> · ' + money(r.amount) + (r.notes ? '<span class="py-ixn"> · ' + esc(r.notes) + '</span>' : '') + '</div>'
        + '<div class="py-ixr-due">' + (r._due != null ? money(r._due) : (r._month ? '<span class="py-muted">בסיס</span>' : '<span class="py-muted">—</span>')) + '</div>'
        + '<div class="py-ixr-b">' + (r._month
          ? 'מדד ' + monthLabel(r._month) + ': <b>' + pts(r._user) + '</b>' + (r._cbs != null ? ' <span class="py-muted">(למ"ס ' + r._cbs + ')</span>' : '')
            + ' · חשוף ' + money(r._exposedAfter) + (r._rise != null ? ' · עלייה ' + pct(r._rise) : '')
          : 'לפני תחילת ההצמדה') + '</div></div>';
    });
    if (!ix.rows.length) h += '<div class="mh-empty">אין שורות — הוסיפו את התשלומים</div>';
    h += '<div class="py-ixtot"><span>סה"כ הפרשים שנצברו בתשלומים</span><b>' + money(ix.accruedPast) + '</b></div></div>';
    h += '<div class="py-row-btns"><button class="mh-btn sm ghost" data-act="add-ixrow">＋ שורה</button>'
      + '<label class="py-chk"><input type="checkbox" data-act="ix-paid"' + (ix.paidPast ? ' checked' : '') + '> הפרשי ההצמדה שנצברו (' + money(ix.accruedPast) + ') כבר שולמו</label></div>';
    h += '<div class="py-two">'
      + '<div class="py-box hl"><div class="py-box-l">נכון לעכשיו · מדד ' + monthLabel(ix.latestMonth) + '</div><div class="py-box-v">' + money(ix.accruedTotal) + '</div>'
      + '<div class="py-box-s">' + pts(ix.latestValueUser) + ' נק\' (למ"ס ' + (ix.latestValueCbs != null ? ix.latestValueCbs : '—') + ')<br>מאז התשלום האחרון: ' + money(ix.accruedCurrent) + ' על חשוף ' + money(ix.exposed)
      + (ix.paidPast ? '<br>לתשלום (ללא ששולמו): ' + money(ix.toPayNow) : '') + '</div></div>'
      + '<div class="py-box"><div class="py-box-l">צפי בתשלום האחרון · מדד ' + monthLabel(ix.projMonth) + '</div><div class="py-box-v">' + money(ix.projectedTotal) + '</div>'
      + '<div class="py-box-s">מדד צפוי ' + pts(ix.projIndexUser) + ' (למ"ס ' + (ix.projIndexCbs != null ? ix.projIndexCbs.toFixed(1) : '—') + ')<br>אם המסירה תידחה (' + monthLabel(ix.lateMonth) + '): ' + money(ix.projectedTotalLate) + '</div></div>'
      + '</div>';
    h += '<div class="mh-sub">עלייה חודשית ממוצעת (12 חודשים אחרונים, גיאומטרי): <b>' + pct(ix.avgMonthly) + '</b> · שנתי ≈ <b>' + pct(ix.avgAnnual, 2) + '</b></div>';
    h += '<div class="mh-note" style="margin-top:8px">שיטת החישוב: מדד כל תשלום = המדד של החודש שלפניו. אחרי התשלום השני 50% מהיתרה (' + money(ix.rows.length ? (ix.rows.find(r => r._month) || {})._exposedAfter : 0) + ') "חשופים" למדד, וכל תשלום נוסף מקטין את החשוף בסכומו המלא. בכל תשלום משלמים: חשוף × (מדד נוכחי ÷ מדד קודם − 1). ירידת מדד לא מקטינה את המחיר.</div>';
    const ex = expenseIndexEstimate();
    if (ex) h += '<div class="mh-sub" style="margin-top:6px">ברשימת ההוצאות רשומה הערכה של ' + money(ex.price) + (Math.abs(ex.price - ix.toPayProjected) > 2000 ? ' — צפי לפי השיטה: ' + money(Math.round(ix.toPayProjected / 100) * 100) : ' — תואמת לצפי') + '.</div>';
    h += '<div class="py-warn">⚠️ הערכה בלבד — לאמת מול עו"ד/הקבלן.</div></div>';

    // extras
    h += '<div class="mh-card" id="py-extras"><div class="mh-card-title">🔧 תשלומים נוספים לקבלן<button class="mh-btn sm ghost" data-act="add-extra">＋ תשלום נוסף</button></div>';
    mm.extras.forEach(x => {
      h += '<div class="py-ck' + (x.paid ? ' done' : '') + '"><button class="py-cb' + (x.paid ? ' on' : '') + '" data-act="extra-paid" data-k="' + esc(x._key) + '" aria-label="שולם"><span>' + (x.paid ? '✓' : '') + '</span></button>'
        + '<div class="mh-grow" data-act="edit-extra" data-k="' + esc(x._key) + '" style="cursor:pointer"><div class="mh-title">' + esc(x.title) + '</div>'
        + '<div class="mh-sub">' + esc(MH.date(x.date)) + (x.dueAt === 'delivery' ? ' · לתשלום במסירה' : x.dueAt ? ' · עד ' + esc(MH.date(x.dueAt)) : '')
        + (x.linked ? ' · צמוד מ-' + monthLabel(x.indexBaseMonth) + ' · הצמדה צפויה ' + money(x._ixProj) : '') + '</div>'
        + '<div class="mh-meta">' + (x.financedByMortgage ? '<span class="mh-badge blue">ימומן במשכנתא</span>' : '') + (x.paid ? '<span class="mh-badge green">שולם</span>' : '') + '</div></div>'
        + '<div class="py-amt">' + money(x.amount) + '</div></div>';
    });
    if (!mm.extras.length) h += '<div class="mh-empty">אין תשלומים נוספים</div>';
    h += '</div>';

    // contract details
    h += '<div class="mh-card"><details class="py-det" data-det="details"' + (ui.details ? ' open' : '') + '><summary>📄 פרטי החוזה</summary><ul class="py-list">'
      + '<li>מוכר: ' + esc(c.seller || 'צרפתי שמעון בע"מ') + '</li>'
      + '<li>נכס: ' + esc(c.project || 'צרפתי בנאות הדרים, באר שבע — מגרש 110, בניין 6, דירה 24') + '</li>'
      + '<li>נחתם: ' + esc(MH.date(c.signDate)) + '</li>'
      + '<li>מסירה: חוזי ' + esc(MH.date(c.deliveryDate)) + ' (סעיף 3.4) + חודש גרייס (3.5) + עיכובים בכוח עליון (3.6). מעבר לכך — פיצוי לפי סעיף 5א לחוק המכר.</li>'
      + (ext ? '<li>ייתכן עד ' + esc(MH.date(mm.deliveryLatest)) + ' (ארכת שינויי דיירים)' + (c.deliveryExtensionNote ? ' — ' + esc(c.deliveryExtensionNote) : '') + '.</li>' : '')
      + '<li>ריבית פיגורים ' + esc(c.lateInterestPct != null ? c.lateInterestPct : 11) + '% לשנה — אין ריבית על איחור עד 7 ימים (תוספת משפטית).</li>'
      + '<li>ליקויים בפרוטוקול המסירה יתוקנו תוך 13 חודשים.</li>'
      + '<li>הקונה משלם פיקדונות למוני גז, חשמל ומים.</li>'
      + '<li>עמלת ערבות חוק מכר (0.65% לשנה) — על חשבון החברה.</li>'
      + '<li>משכנתא (סעיף 9.2) רק לאחר תשלום מעל 20% מהון עצמי — בוצע ✓</li>'
      + '</ul></details></div>';
    return h;
  }

  function renderMortgage(mm) {
    const loan = loanInfo();
    const fin = financing(mm);
    const m = M || {};
    const si = Math.max(0, STAGES.indexOf(m.stage));
    let h = '<div class="py-sec" style="margin-top:18px">🏦 משכנתא והלוואת קבלן</div>';

    // loan countdown
    h += '<div class="mh-card py-loan ' + loan.state + '"><div class="mh-card-title">⏳ הלוואת קבלן — ' + esc(loan.bank) + '<small>' + money(loan.amount) + '</small></div>'
      + '<div class="py-cd"><b>' + (loan.days < 0 ? 'עבר המועד' : loan.md.m) + '</b>' + (loan.days < 0 ? '' : '<span>חודשים ו-' + loan.md.d + ' ימים</span>') + '</div>'
      + '<div class="mh-sub">עד <b>' + esc(MH.date(loan.end)) + '</b> (' + loan.maxMonths + ' חודשים מ-' + esc(MH.date(loan.startDate)) + ') · ' + Math.max(0, loan.days).toLocaleString('he-IL') + ' ימים</div>'
      + '<div class="mh-note" style="margin-top:8px">החברה משלמת את הריבית וההצמדה עד תום 30 חודשים — המשכנתא צריכה להחליף את ההלוואה לפני המועד הזה.</div>'
      + (mm.deliveryLatest && mm.deliveryLatest > loan.end ? '<div class="py-warn">⚠️ ההלוואה מסתיימת ב-' + esc(MH.date(loan.end)) + ', והמסירה עשויה להידחות עד ' + esc(MH.date(mm.deliveryLatest))
        + ' — פער של כ-' + Math.max(1, Math.round((new Date(mm.deliveryLatest) - new Date(loan.end)) / 864e5 / 30.4)) + ' חודשים שבהם הסבסוד עלול להסתיים לפני המשכנתא. לברר מול בנק הפועלים/הקבלן.</div>' : '')
      + '</div>';

    // financing need
    h += '<div class="mh-card"><div class="mh-card-title">💰 צורך מימון במסירה<button class="mh-btn sm ghost" data-act="edit-target">יעד משכנתא</button></div>'
      + '<table class="py-fin"><tbody>'
      + '<tr><td>יתרה לקבלן</td><td>' + money(mm.remaining) + '</td></tr>'
      + '<tr><td>הפרשי הצמדה <span class="mh-sub">(' + fin.ixSrc + ')</span></td><td>' + money(fin.ix) + '</td></tr>'
      + '<tr><td>פירעון הלוואת קבלן</td><td>' + money(fin.loanAmt) + '</td></tr>'
      + (fin.extras ? '<tr><td>תשלומים נוספים <span class="mh-sub">(שינויי דיירים + הצמדה)</span></td><td>' + money(fin.extras) + '</td></tr>' : '')
      + '<tr class="tot"><td>סה"כ נדרש במסירה</td><td>' + money(fin.total) + '</td></tr>'
      + '<tr><td>הון עצמי זמין (הגדרות)</td><td>−' + money(fin.cash) + '</td></tr>'
      + '<tr class="res"><td>משכנתא משוערת</td><td>' + money(fin.est) + '</td></tr>'
      + (fin.target ? '<tr><td>🎯 יעד משכנתא (ידני)</td><td>' + money(fin.target) + '</td></tr>' : '')
      + '</tbody></table></div>';

    // stages
    h += '<div class="mh-card"><div class="mh-card-title">שלב המשכנתא<button class="mh-btn sm ghost" data-act="edit-mort">✏️ יועץ ובנק</button></div><div class="py-steps">';
    STAGES.forEach((s, i) => {
      h += '<button class="py-step ' + (i < si ? 'done' : i === si ? 'cur' : '') + '" data-act="stage" data-i="' + i + '"><i>' + (i < si ? '✓' : i + 1) + '</i>' + esc(s) + '</button>';
    });
    h += '</div><div class="py-kv"><div><span>יועץ: </span>' + (m.advisor ? esc(m.advisor) : '—') + '</div><div><span>בנק: </span>' + (m.bank ? esc(m.bank) : '—') + '</div></div>'
      + (m.notes ? '<div class="mh-sub" style="margin-top:6px;white-space:pre-wrap">' + esc(m.notes) + '</div>' : '') + '</div>';

    // checklist
    const ck = checklistItems();
    const done = ck.filter(x => x.done).length;
    h += '<div class="mh-card"><div class="mh-card-title">📋 מסמכים למשכנתא <small>' + done + '/' + ck.length + '</small><button class="mh-btn sm ghost" data-act="add-ck">＋ פריט</button></div>'
      + '<div class="mh-meter" style="margin:-4px 0 8px"><i style="width:' + (ck.length ? done / ck.length * 100 : 0).toFixed(1) + '%"></i></div>';
    ck.forEach(x => {
      const d = docByKey(x.docKey);
      h += '<div class="py-ck' + (x.done ? ' done' : '') + '"><button class="py-cb' + (x.done ? ' on' : '') + '" data-act="ck" data-k="' + esc(x._key) + '" aria-label="סמן"><span>' + (x.done ? '✓' : '') + '</span></button>'
        + '<div class="mh-grow mh-title" data-act="edit-ck" data-k="' + esc(x._key) + '">' + esc(x.label) + '</div>' + docLinkHtml(d) + '</div>';
    });
    if (!ck.length) h += '<div class="mh-empty">אין פריטים</div>';
    h += '</div>';

    // tracks
    const tm = tracksModel();
    h += '<div class="mh-card"><div class="mh-card-title">🛤️ מסלולים<button class="mh-btn sm" data-act="add-track">＋ מסלול</button></div>';
    tm.t.forEach(x => {
      h += '<div class="py-tr" data-act="edit-track" data-k="' + esc(x._key) + '"><span class="mh-badge purple">' + esc(x.type || '') + '</span>'
        + '<div><div class="mh-title py-num">' + money(x.amount) + '</div><div class="py-tv">' + (num(x.rate) || 0) + '% · ' + (num(x.years) || 0) + ' שנים</div></div>'
        + '<div class="py-tp">' + money(x._pmt) + '<div class="py-tv">לחודש</div></div></div>';
    });
    if (!tm.t.length) h += '<div class="mh-empty">עוד לא הוגדרו מסלולים — הוסיפו את ההצעות מהבנק/היועץ</div>';
    else h += '<div class="py-ttot"><div class="py-box"><div class="py-box-l">סה"כ</div><div class="py-box-v">' + MH.moneyK(tm.total) + '</div></div>'
      + '<div class="py-box"><div class="py-box-l">ריבית משוקללת</div><div class="py-box-v">' + tm.avg.toFixed(2) + '%</div></div>'
      + '<div class="py-box hl"><div class="py-box-l">החזר חודשי ≈</div><div class="py-box-v">' + money(tm.monthly) + '</div></div></div>'
      + '<div class="mh-sub" style="margin-top:6px">החזר לפי שפיצר בריבית הנוכחית, ללא הצמדה ושינויי ריבית.' + (fin.mortgage && Math.abs(tm.total - fin.mortgage) > 1000 ? (tm.total < fin.mortgage ? ' חסרים ' + money(fin.mortgage - tm.total) + ' מול סכום המשכנתא הנדרש.' : ' עודף של ' + money(tm.total - fin.mortgage) + ' מעל סכום המשכנתא הנדרש.') : '') + '</div>';
    h += '</div>';
    return h;
  }

  function render() {
    injectCSS();
    const root = document.getElementById('pay-root'); if (!root) return;
    bindRoot(root);
    if (!cLoaded || !mLoaded) { root.innerHTML = '<div class="loading"><div class="spinner"></div><div>טוען...</div></div>'; return; }
    const mm = model();
    root.innerHTML = (C ? renderContract(mm) : '<div class="py-sec">🏗️ תשלומים לקבלן</div><div class="mh-card mh-empty">נתוני החוזה חסרים במסד הנתונים (נמחקו?). אפשר לשחזר מגיבוי בהגדרות.</div>')
      + (M ? renderMortgage(mm) : '<div class="py-sec" style="margin-top:18px">🏦 משכנתא והלוואת קבלן</div><div class="mh-card mh-empty">נתוני המשכנתא חסרים במסד הנתונים.</div>');
  }

  // ── sheets ──
  function paySheet(key) {
    const mm = model();
    const p = key ? mm.pays.find(x => x._key === key) : null;
    const defInst = p ? p.installmentKey : (mm.next ? mm.next._key : '');
    const dOpts = docOptions(p && p.docKey);
    const html = '<div class="form-row-2"><div class="form-group"><label>תאריך *</label><input type="date" name="date" value="' + esc(p ? p.date : MH.todayISO()) + '"></div>'
      + '<div class="form-group"><label>סכום ₪ *</label><input type="number" name="amount" inputmode="decimal" value="' + esc(p ? p.amount : '') + '"></div></div>'
      + '<div class="form-group"><label>על חשבון</label><select name="installmentKey">' + mm.inst.map(i => '<option value="' + esc(i._key) + '"' + (i._key === defInst ? ' selected' : '') + '>' + esc(i.label) + ' (' + money(i.amount) + ')</option>').join('') + '</select></div>'
      + '<div class="form-group"><label>מס\' חשבונית</label><input type="text" name="invoiceNo" inputmode="numeric" value="' + esc(p ? p.invoiceNo : '') + '"></div>'
      + (dOpts ? '<div class="form-group"><label>מסמך מקושר</label><select name="docKey">' + dOpts + '</select></div>' : '')
      + '<div class="form-group"><label>הערות</label><textarea name="notes">' + esc(p ? p.notes : '') + '</textarea></div>';
    MH.sheet({
      title: p ? '✏️ עריכת תשלום' : '＋ תשלום לקבלן', html,
      onSave: el => {
        const v = MH.formValues(el);
        if (!v.date || !(v.amount > 0)) { MH.toast('יש להזין תאריך וסכום'); return false; }
        const obj = { date: v.date, amount: v.amount, installmentKey: v.installmentKey || '', invoiceNo: v.invoiceNo || '', notes: v.notes || '' };
        if ('docKey' in v) obj.docKey = v.docKey || '';
        return p ? MH.keyed.update('contract/payments/' + p._key, obj) : MH.keyed.add('contract/payments', Object.assign({ docKey: '' }, obj));
      },
      danger: p ? { label: '🗑️ מחק תשלום', onClick: async () => {
        if (!await MH.confirm('למחוק את התשלום של ' + money(p.amount) + ' מ-' + MH.date(p.date) + '?')) return false;
        return MH.keyed.remove('contract/payments/' + p._key);
      } } : null,
    });
  }
  function ixRowSheet(key) {
    if (!C) return;
    const mm = model(), ix = mm.ix;
    const r = key ? ix.rows.find(x => x._key === key) : null;
    // new row: default to the latest contractor payment that has no index row yet
    const used = new Set(ix.rows.map(x => x.paymentKey).filter(Boolean));
    const cand = r ? null : mm.pays.filter(p => !used.has(p._key)).pop();
    const d = r || (cand ? { payDate: cand.date, amount: cand.amount, paymentKey: cand._key, notes: cand.invoiceNo ? 'חשבונית ' + cand.invoiceNo : '' } : { payDate: MH.todayISO() });
    const im = d.indexMonth || (r ? '' : prevMonthKey(d.payDate));
    const iv = d.indexValue != null ? d.indexValue : (!r && ix.userOf(im) != null ? Math.round(ix.userOf(im) * 1000) / 1000 : '');
    MH.sheet({
      title: r ? '✏️ שורת הצמדה' : '＋ שורת הצמדה',
      html: '<div class="form-row-2"><div class="form-group"><label>תאריך תשלום *</label><input type="date" name="payDate" value="' + esc(d.payDate || '') + '"></div>'
        + '<div class="form-group"><label>סכום ₪ *</label><input type="number" name="amount" value="' + esc(d.amount != null ? d.amount : '') + '"></div></div>'
        + '<div class="form-group"><label>תשלום מקושר</label><select name="paymentKey"><option value="">—</option>' + mm.pays.map(p => '<option value="' + esc(p._key) + '"' + (p._key === d.paymentKey ? ' selected' : '') + '>' + esc(MH.date(p.date)) + ' · ' + money(p.amount) + '</option>').join('') + '</select></div>'
        + '<div class="form-row-2"><div class="form-group"><label>חודש מדד (YYYY-MM)</label><input type="text" name="indexMonth" placeholder="ריק = לפני ההצמדה" value="' + esc(im) + '"></div>'
        + '<div class="form-group"><label>מדד (נקודות שלך)</label><input type="number" step="any" name="indexValue" value="' + esc(iv) + '"></div></div>'
        + '<div class="form-group"><label>סכום חשוף אחרי התשלום (ריק = חישוב אוטומטי)</label><input type="number" name="exposedAfter" value="' + esc(d.exposedAfter != null ? d.exposedAfter : '') + '"></div>'
        + '<div class="form-group"><label>הערות</label><input type="text" name="notes" value="' + esc(d.notes || '') + '"></div>'
        + '<div class="mh-note">חודש המדד = החודש שלפני התשלום. הפרשי ההצמדה מחושבים אוטומטית מסדרת הלמ"ס.</div>',
      onSave: el => {
        const v = MH.formValues(el);
        if (!v.payDate || !(v.amount > 0)) { MH.toast('יש להזין תאריך וסכום'); return false; }
        if (v.indexMonth && !/^\d{4}-\d{2}$/.test(v.indexMonth)) { MH.toast('חודש מדד בפורמט YYYY-MM'); return false; }
        const obj = { payDate: v.payDate, amount: v.amount, paymentKey: v.paymentKey || '', indexMonth: v.indexMonth || null, indexValue: v.indexValue, exposedAfter: v.exposedAfter, notes: v.notes || '' };
        if (r) return MH.keyed.update('contract/indexRows/' + r._key, obj);
        Object.keys(obj).forEach(k => { if (obj[k] === null) delete obj[k]; });
        return MH.keyed.add('contract/indexRows', obj);
      },
      danger: r ? { label: '🗑️ מחק שורה', onClick: async () => (await MH.confirm('למחוק את שורת ההצמדה מ-' + MH.date(r.payDate) + '?')) ? MH.keyed.remove('contract/indexRows/' + r._key) : false } : null,
    });
  }
  function extraSheet(key) {
    if (!C) return;
    const x = key ? entries(C.extras).find(e => e._key === key) : null;
    const d = x || { date: MH.todayISO(), linked: true, financedByMortgage: true, dueAt: 'delivery', indexBaseMonth: prevMonthKey(MH.todayISO()) };
    MH.sheet({
      title: x ? '✏️ תשלום נוסף' : '＋ תשלום נוסף לקבלן',
      html: '<div class="form-group"><label>תיאור *</label><input type="text" name="title" value="' + esc(d.title || '') + '"></div>'
        + '<div class="form-row-2"><div class="form-group"><label>סכום ₪ (כולל מע"מ) *</label><input type="number" step="any" name="amount" value="' + esc(d.amount != null ? d.amount : '') + '"></div>'
        + '<div class="form-group"><label>תאריך</label><input type="date" name="date" value="' + esc(d.date || '') + '"></div></div>'
        + '<div class="form-row-2"><div class="form-group"><label>מועד תשלום</label><input type="text" name="dueAt" placeholder="delivery או YYYY-MM-DD" value="' + esc(d.dueAt || '') + '"></div>'
        + '<div class="form-group"><label>מדד בסיס (YYYY-MM)</label><input type="text" name="indexBaseMonth" value="' + esc(d.indexBaseMonth || '') + '"></div></div>'
        + '<div class="form-group"><label><input type="checkbox" name="linked"' + (d.linked ? ' checked' : '') + '> צמוד למדד תשומות הבנייה</label></div>'
        + '<div class="form-group"><label><input type="checkbox" name="financedByMortgage"' + (d.financedByMortgage ? ' checked' : '') + '> ימומן במשכנתא</label></div>'
        + '<div class="form-group"><label><input type="checkbox" name="paid"' + (d.paid ? ' checked' : '') + '> שולם</label></div>'
        + '<div class="form-group"><label>הערות</label><textarea name="notes">' + esc(d.notes || '') + '</textarea></div>',
      onSave: el => {
        const v = MH.formValues(el);
        if (!v.title || !(v.amount > 0)) { MH.toast('יש להזין תיאור וסכום'); return false; }
        const obj = { title: v.title, amount: v.amount, date: v.date || '', dueAt: v.dueAt || '', indexBaseMonth: v.indexBaseMonth || '', linked: v.linked, financedByMortgage: v.financedByMortgage, paid: v.paid, notes: v.notes || '' };
        return x ? MH.keyed.update('contract/extras/' + x._key, obj) : MH.keyed.add('contract/extras', obj);
      },
      danger: x ? { label: '🗑️ מחק', onClick: async () => (await MH.confirm('למחוק את "' + x.title + '"?')) ? MH.keyed.remove('contract/extras/' + x._key) : false } : null,
    });
  }
  function targetSheet() {
    const mm = model(), fin = financing(mm);
    MH.sheet({
      title: '🎯 יעד משכנתא',
      html: '<div class="form-group"><label>סכום משכנתא מבוקש ₪ (ריק = לפי החישוב)</label><input type="number" name="targetAmount" value="' + esc(fin.target || '') + '" placeholder="' + Math.round(fin.est) + '"></div>'
        + '<div class="mh-note">חישוב אוטומטי: ' + money(fin.est) + ' (סה"כ נדרש ' + money(fin.total) + ' פחות הון עצמי ' + money(fin.cash) + '). את ההון העצמי מעדכנים במסך ההגדרות/החיסכון.</div>',
      onSave: el => M ? setv('mortgage/targetAmount', MH.formValues(el).targetAmount) : upd('mortgage', {}),
    });
  }
  function mortSheet() {
    const m = M || {};
    MH.sheet({
      title: '🏦 פרטי משכנתא',
      html: '<div class="form-group"><label>יועץ משכנתאות</label><input type="text" name="advisor" value="' + esc(m.advisor || '') + '"></div>'
        + '<div class="form-group"><label>בנק</label><input type="text" name="bank" value="' + esc(m.bank || '') + '"></div>'
        + '<div class="form-group"><label>הערות</label><textarea name="notes">' + esc(m.notes || '') + '</textarea></div>',
      onSave: el => { const v = MH.formValues(el); return upd('mortgage', { advisor: v.advisor, bank: v.bank, notes: v.notes }); },
    });
  }
  function ckSheet(key) {
    const items = checklistItems();
    const x = key ? items.find(i => i._key === key) : null;
    const dOpts = docOptions(x && x.docKey);
    MH.sheet({
      title: x ? '✏️ פריט במסמכים' : '＋ פריט למשכנתא',
      html: '<div class="form-group"><label>שם הפריט *</label><input type="text" name="label" value="' + esc(x ? x.label : '') + '"></div>'
        + (dOpts ? '<div class="form-group"><label>מסמך מקושר</label><select name="docKey">' + dOpts + '</select></div>' : ''),
      onSave: el => {
        const v = MH.formValues(el);
        if (!v.label) { MH.toast('יש להזין שם'); return false; }
        const obj = { label: v.label }; if ('docKey' in v) obj.docKey = v.docKey || '';
        if (x) return MH.keyed.update('mortgage/checklist/' + x._key, obj);
        return MH.keyed.add('mortgage/checklist', Object.assign({ done: false, docKey: '', order: items.reduce((mx, i) => Math.max(mx, i.order || 0), 0) + 1 }, obj));
      },
      danger: x ? { label: '🗑️ מחק פריט', onClick: async () => (await MH.confirm('למחוק את "' + x.label + '"?')) ? MH.keyed.remove('mortgage/checklist/' + x._key) : false } : null,
    });
  }
  function trackSheet(key) {
    const x = key ? entries(M && M.tracks).find(t => t._key === key) : null;
    MH.sheet({
      title: x ? '✏️ מסלול' : '＋ מסלול משכנתא',
      html: '<div class="form-group"><label>סוג מסלול</label><select name="type">' + TRACK_TYPES.map(t => '<option' + (x && x.type === t ? ' selected' : '') + '>' + esc(t) + '</option>').join('') + '</select></div>'
        + '<div class="form-group"><label>סכום ₪ *</label><input type="number" name="amount" value="' + esc(x ? x.amount : '') + '"></div>'
        + '<div class="form-row-2"><div class="form-group"><label>ריבית %</label><input type="number" step="any" name="rate" value="' + esc(x ? x.rate : '') + '"></div>'
        + '<div class="form-group"><label>שנים</label><input type="number" name="years" value="' + esc(x ? x.years : '') + '"></div></div>',
      onSave: el => {
        const v = MH.formValues(el);
        if (!(v.amount > 0)) { MH.toast('יש להזין סכום'); return false; }
        const obj = { type: v.type, amount: v.amount, rate: v.rate || 0, years: v.years || 0 };
        return x ? MH.keyed.update('mortgage/tracks/' + x._key, obj) : MH.keyed.add('mortgage/tracks', obj);
      },
      danger: x ? { label: '🗑️ מחק מסלול', onClick: async () => (await MH.confirm('למחוק את המסלול?')) ? MH.keyed.remove('mortgage/tracks/' + x._key) : false } : null,
    });
  }

  // ── events ──
  let bound = null;
  function bindRoot(root) {
    if (bound === root) return; bound = root;
    root.addEventListener('toggle', e => { const d = e.target; if (d && d.dataset && d.dataset.det) ui[d.dataset.det] = d.open; }, true);
    root.addEventListener('click', e => {
      const b = e.target.closest('[data-act]'); if (!b || !root.contains(b)) return;
      const a = b.dataset.act, k = b.dataset.k;
      if (a === 'add-pay') { if (C) paySheet(null); }
      else if (a === 'edit-pay') { if (e.target.closest('.py-doc')) return; paySheet(k); }
      else if (a === 'open-doc') { e.stopPropagation(); try { const D = window.DOCS_API; if (D && D.openEditor) D.openEditor(k); else if (D && D.open) D.open(k); else if (typeof switchPage === 'function') switchPage('docs'); } catch (er) {} }
      else if (a === 'refresh-index') { if (!ui.fetching) refreshIndex({ force: true }).then(r => MH.toast(r === 'updated' ? '📈 המדד עודכן מהלמ"ס' : r === 'current' ? '✓ המדד מעודכן' : '⚠️ עדכון המדד נכשל — מוצג מדד שמור')); }
      else if (a === 'edit-ixrow') ixRowSheet(k);
      else if (a === 'add-ixrow') ixRowSheet(null);
      else if (a === 'ix-paid') { if (C) setv('contract/indexDiffPaid', !!b.checked); }
      else if (a === 'edit-extra') extraSheet(k);
      else if (a === 'add-extra') extraSheet(null);
      else if (a === 'extra-paid') { const x = entries(C && C.extras).find(e => e._key === k); if (x) MH.keyed.update('contract/extras/' + k, { paid: !x.paid }); }
      else if (a === 'edit-target') targetSheet();
      else if (a === 'edit-mort') mortSheet();
      else if (a === 'stage') { const s = STAGES[Number(b.dataset.i)]; if (s && M && M.stage !== s) setv('mortgage/stage', s); }
      else if (a === 'ck') { const it = checklistItems().find(i => i._key === k); if (it) MH.keyed.update('mortgage/checklist/' + k, { done: !it.done }); }
      else if (a === 'edit-ck') ckSheet(k);
      else if (a === 'add-ck') ckSheet(null);
      else if (a === 'add-track') trackSheet(null);
      else if (a === 'edit-track') trackSheet(k);
    });
  }

  // ── public API ──
  function summary() {
    const mm = model(), loan = loanInfo(), fin = financing(mm);
    const ck = checklistItems();
    const n = mm.next;
    const si = M ? STAGES.indexOf(M.stage) : -1;
    return {
      price: mm.price, paid: mm.paid, remaining: mm.remaining, pct: Math.round(mm.pct * 10) / 10,
      nextInstallment: n ? { label: n.label, amount: n.amount, dueDate: n.dueDate, remaining: n._rem, days: n._days } : null,
      deliveryDate: mm.c.deliveryDate || null, daysToDelivery: MH.daysUntil(mm.c.deliveryDate),
      deliveryLatest: mm.deliveryLatest, daysToDeliveryLatest: MH.daysUntil(mm.deliveryLatest),
      indexEstimate: mm.indexEstimate,        // accrued now (past rows + since last payment), minus past if indexDiffPaid
      indexProjection: mm.indexProjection,    // projected index cost still to pay at the final payment
      indexRisePct: mm.ix.baseMonth && mm.ix.chain(mm.ix.latestMonth) ? (mm.ix.chain(mm.ix.latestMonth) / mm.ix.chain(mm.ix.baseMonth) - 1) * 100 : null,
      index: {
        latestMonth: mm.ix.latestMonth, latestValueUser: mm.ix.latestValueUser, latestValueCbs: mm.ix.latestValueCbs,
        avgMonthlyPct: mm.ix.avgMonthly * 100, avgAnnualPct: mm.ix.avgAnnual * 100,
        accruedPast: mm.ix.accruedPast, accruedCurrent: mm.ix.accruedCurrent, accruedTotal: mm.ix.accruedTotal, paidPast: mm.ix.paidPast,
        exposed: mm.ix.exposed, baseMonth: mm.ix.baseMonth, projectionMonth: mm.ix.projMonth, projectionMonthLate: mm.ix.lateMonth,
        projectedIndex: mm.ix.projIndexUser, projectedIndexCbs: mm.ix.projIndexCbs, projectedTotal: mm.ix.projectedTotal, projectedTotalLate: mm.ix.projectedTotalLate,
        updatedAt: mm.ix.updatedAt, source: mm.ix.source, stale: mm.ix.stale, fetchFailed: !!ui.fetchFailed,
      },
      extras: mm.extras.map(x => ({ key: x._key, title: x.title, amount: num(x.amount) || 0, indexProjected: x._ixProj, financedByMortgage: !!x.financedByMortgage, paid: !!x.paid, dueAt: x.dueAt || null })),
      extrasFinancedTotal: fin.extras,
      mortgageCategories: fin.extrasList.length ? ['שינוי דיירים'] : [],
      loanEnd: loan.end, loanDaysLeft: loan.days,
      mortgageStage: (M && M.stage) || STAGES[0], mortgageStageIndex: Math.max(0, si),
      checklistDone: ck.filter(x => x.done).length, checklistTotal: ck.length,
      financingNeed: fin.mortgage,            // מה צריך לממן במשכנתא (יעד ידני אם הוגדר, אחרת החישוב)
      financingTotal: fin.total,
      installments: mm.inst.map(i => ({ key: i._key, n: i.n, label: i.label, amount: num(i.amount) || 0, dueDate: i.dueDate, paid: i._paid, remaining: i._rem, status: i._status })), // status: full|partial|future|late              // סה"כ נדרש במסירה לפני הון עצמי
      loaded: cLoaded && mLoaded,
    };
  }
  function upcoming(days) {
    const lim = days == null ? 60 : days;
    const out = [];
    model().inst.forEach(i => {
      if (i._rem > 0 && i._days != null && i._days <= lim) out.push({ date: i.dueDate, title: (i._days < 0 ? 'באיחור: ' : '') + (i.label || 'תשלום לקבלן'), amount: i._rem, kind: 'payment' });
    });
    const l = loanInfo();
    if (l.days != null && l.days <= lim && l.days >= -30) out.push({ date: l.end, title: 'סיום הלוואת קבלן — המשכנתא צריכה להחליף אותה', amount: Number(l.amount) || 0, kind: 'loan' });
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }
  window.PAY_API = { summary, upcoming, seed, refreshIndex, STAGES: STAGES.slice(), _parseCbs: parseCbs };

  // ── subscriptions ──
  MH.db.ref('contract').on('value', snap => {
    C = snap.val(); cLoaded = true;
    if (C === null) seed();
    else {
      seedContractExtras();
      if (!ui.autoTried) { ui.autoTried = true; setTimeout(() => refreshIndex(), 0); }
    }
    MH.emit('contract'); MH.refreshIfShown('payments');
  });
  MH.db.ref('mortgage').on('value', snap => {
    M = snap.val(); mLoaded = true;
    if (M === null) seed();
    MH.emit('mortgage'); MH.refreshIfShown('payments');
  });
  ['expenses', 'settings', 'docs'].forEach(ev => MH.on(ev, () => MH.refreshIfShown('payments')));
  MH.registerPage('payments', { render });
})();
