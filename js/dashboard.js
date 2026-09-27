// ═══════════════════════════════════════════════════════════════
// dashboard.js — "תמונת מצב" (page: dash) — read-only status home screen
// Reads: PAY_API, DOCS_API, TASKS_API + legacy DATA / SETTINGS / CAT_META / PHASE_CONFIG.
// Writes: nothing. Public: window.DASH_API.{model(), render()}
// ═══════════════════════════════════════════════════════════════
(function () {
  'use strict';
  const MH = window.MH;
  const esc = s => MH.esc(s);
  const money = n => MH.money(n);
  const moneyK = n => MH.moneyK(n);
  const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? 0 : Number(v);
  const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  const MON_S = ['ינו׳', 'פבר׳', 'מרץ', 'אפר׳', 'מאי', 'יוני', 'יולי', 'אוג׳', 'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳'];
  const SEV = { red: { lbl: 'דחוף', icon: '⛔' }, yellow: { lbl: 'שים לב', icon: '⚠️' }, blue: { lbl: 'לידיעה', icon: 'ℹ️' } };
  const ALERT_CAP = 6, CAT_CAP = 8, WINDOW = 60;

  const ui = { owner: 'all', allCats: false, allAlerts: false };
  let lastRender = null;

  // ── safe accessors (every source may be missing / not loaded yet) ──
  // legacy globals live in the shared global lexical scope (let/const), not on window
  function data() { try { return typeof DATA !== 'undefined' && Array.isArray(DATA) ? DATA.filter(Boolean) : []; } catch (e) { return []; } }
  function settings() { try { return (typeof SETTINGS !== 'undefined' && SETTINGS) || { available: 0, moveInDate: '2027-08-01' }; } catch (e) { return { available: 0, moveInDate: '2027-08-01' }; } }
  function catMeta(c) { let m = {}; try { if (typeof CAT_META !== 'undefined' && CAT_META) m = CAT_META; } catch (e) {} const x = m[c] && typeof m[c] === 'object' ? m[c] : {}; return { emoji: String(x.emoji || '📋'), color: safeColor(x.color) }; }
  function phaseConfig() { try { return typeof PHASE_CONFIG !== 'undefined' ? PHASE_CONFIG : {}; } catch (e) { return {}; } }
  function pay() { const P = window.PAY_API; if (!P) return null; try { const s = P.summary(); return s && s.loaded ? s : null; } catch (e) { return null; } }
  function payUpcoming(d) { try { return window.PAY_API ? window.PAY_API.upcoming(d) || [] : []; } catch (e) { return []; } }
  function docsReady() { const D = window.DOCS_API; try { return !!(D && D.loaded && D.loaded()); } catch (e) { return false; } }
  function tasksApi() { return window.TASKS_API || null; }
  function tasksAll() { const T = tasksApi(); try { return T ? T.all() : []; } catch (e) { return []; } }

  // ── small helpers ──
  const dt = iso => esc(MH.date(iso));
  const pct1 = (a, b) => (b > 0 ? Math.round(a / b * 1000) / 10 : 0) + '%';
  const HEX = /^#[0-9a-f]{3,8}$/i;
  function safeColor(c) { return HEX.test(String(c || '')) ? c : '#6b7280'; }
  function pct(a, b) { return b > 0 ? Math.max(0, Math.min(100, a / b * 100)) : 0; }
  function pctTxt(a, b) { if (!(b > 0)) return '0%'; const p = a / b * 100; return (p >= 10 || p === 0 ? Math.round(p) : p.toFixed(1)) + '%'; }
  function monthsFromDays(d) { return Math.max(0, Math.round(d / 30.44)); }
  function rel(d) {
    if (d === null || d === undefined || isNaN(d)) return '';
    if (d < -1) return 'לפני ' + (-d) + ' ימים';
    if (d === -1) return 'אתמול';
    if (d === 0) return 'היום';
    if (d === 1) return 'מחר';
    if (d <= 60) return 'בעוד ' + d + ' ימים';
    return 'בעוד כ-' + monthsFromDays(d) + ' חודשים';
  }
  function shortDate(iso) { if (!iso) return ''; const [y, m, d] = String(iso).slice(0, 10).split('-'); return d + '/' + m + '/' + String(y).slice(2); }
  function ownerOf(t) { return MH.ownerName(t && t.owner) || 'שניכם'; }
  function ownerMatch(t) { if (ui.owner === 'all') return true; const o = ownerOf(t); return o === ui.owner || o === 'שניכם'; }
  function chip(o) { const cls = o === 'עידן' ? 'blue' : o === 'שני' ? 'purple' : ''; return '<span class="mh-badge ' + cls + ' ds-owner">' + esc(o) + '</span>'; }
  function meter(p, label, cls) {
    return '<div class="ds-meter ' + (cls || '') + '" role="img" aria-label="' + esc(label) + '"><i style="width:' + p.toFixed(1) + '%"></i></div>';
  }

  // ── model ──
  function expenseModel() {
    const items = data();
    let budget = 0, paid = 0;
    const cats = {};
    items.forEach(it => {
      const p = num(it.price), pd = num(it.paid), c = it.cat || 'כללי';
      budget += p; paid += pd;
      const x = cats[c] || (cats[c] = { cat: c, budget: 0, paid: 0, credits: 0, n: 0 });
      x.budget += p; x.paid += pd; x.n++;
      if (p < 0) x.credits += -p;
    });
    const priced = items.filter(it => num(it.price) > 0);
    const pricedPaid = priced.filter(it => num(it.paid) >= num(it.price)).length;
    const list = Object.values(cats);
    const bars = list.filter(c => Math.round(c.budget) !== 0).sort((a, b) => b.budget - a.budget);
    const zero = list.filter(c => Math.round(c.budget) === 0);
    const toPrice = items.filter(it => !num(it.price) && /לעדכן מחיר/.test(String(it.notes || ''))).length;
    const s = settings();
    const avail = num(s.available), moveIn = s.moveInDate || '2027-08-01';
    let sv;
    if (typeof _calcSavings === 'function') { try { sv = _calcSavings(avail, moveIn); } catch (e) { sv = null; } }
    if (!sv) {
      const monthsLeft = Math.max(0, Math.ceil((new Date(moveIn) - MH.today()) / (864e5 * 30.44)));
      const need = Math.max(0, budget - paid - avail);
      sv = { monthsLeft, stillNeeded: need, perMonth: monthsLeft > 0 ? Math.ceil(need / monthsLeft) : need };
    }
    return { count: items.length, budget, paid, remaining: budget - paid, priced: priced.length, pricedPaid, bars, zero,
      zeroItems: zero.reduce((s2, c) => s2 + c.n, 0), toPrice, avail, moveIn, savings: sv, loaded: items.length > 0 };
  }
  function taskModel() {
    const all = tasksAll();
    const open = all.filter(t => t.statusKey !== 'done');
    const overdue = open.filter(t => t.overdue).sort((a, b) => a.daysLeft - b.daysLeft);
    const phases = [1, 2, 3, 4].map(p => { const pt = all.filter(t => Number(t.phase) === p); return { p, total: pt.length, done: pt.filter(t => t.statusKey === 'done').length }; });
    return { loaded: !!tasksApi() && all.length > 0, total: all.length, open: open.length, overdue, phases };
  }
  function docModel() {
    const D = window.DOCS_API;
    if (!docsReady()) return { loaded: false, missing: [], expiring: [] };
    let missing = [], expiring = [];
    try { missing = D.missingRequired() || []; } catch (e) {}
    try { expiring = D.expiringSoon(WINDOW) || []; } catch (e) {}
    return { loaded: true, missing, expiring };
  }

  function alerts(S, T, Dm, E) {
    const out = [];
    if (T.overdue.length) {
      const t = T.overdue[0];
      out.push(T.overdue.length === 1
        ? { sev: 'red', icon: '⏰', go: 'tasks', title: 'משימה באיחור: ' + (t.desc || ''), sub: 'יעד ' + MH.date(t.date) + ' · ' + rel(t.daysLeft) + ' · ' + ownerOf(t) }
        : { sev: 'red', icon: '⏰', go: 'tasks', title: T.overdue.length + ' משימות באיחור', sub: T.overdue.slice(0, 2).map(x => x.desc).join(' · ') });
    }
    if (S) {
      const n = S.nextInstallment;
      if (n && n.remaining > 0 && n.days !== null && n.days <= 90) {
        out.push({ sev: n.days < 0 ? 'red' : 'yellow', icon: '🏗️', go: 'payments',
          title: (n.days < 0 ? 'תשלום לקבלן באיחור: ' : 'תשלום לקבלן מתקרב: ') + money(n.remaining),
          sub: (n.label || '') + ' · עד ' + MH.date(n.dueDate) + ' (' + rel(n.days) + ')' });
      }
      if (S.loanDaysLeft !== null && S.loanDaysLeft <= 365) {
        out.push({ sev: S.loanDaysLeft < 183 ? 'red' : 'yellow', icon: '💰', go: 'payments',
          title: S.loanDaysLeft < 0 ? 'הלוואת הקבלן הסתיימה' : 'הלוואת הקבלן מסתיימת ' + rel(S.loanDaysLeft),
          sub: 'עד ' + MH.date(S.loanEnd) + ' המשכנתא צריכה להחליף את ההלוואה (₪700K) — אחרת הריבית עוברת אליכם' });
      }
      if (S.deliveryLatest && S.loanEnd && S.deliveryLatest > S.loanEnd && S.loanDaysLeft !== null && S.loanDaysLeft >= 0) {
        const gap = Math.round((new Date(S.deliveryLatest) - new Date(S.loanEnd)) / 864e5);
        out.push({ sev: 'yellow', icon: '📆', go: 'payments', title: 'פער אפשרי בין סיום הלוואת הקבלן למסירה',
          sub: 'ההלוואה מסתיימת ' + MH.date(S.loanEnd) + ', והמסירה עשויה להידחות עד ' + MH.date(S.deliveryLatest) + ' (כ-' + gap + ' ימים) — לברר מול בנק הפועלים/הקבלן' });
      }
      if (S.mortgageStageIndex === 0 && S.loanDaysLeft !== null && S.loanDaysLeft < 456) {
        out.push({ sev: 'yellow', icon: '🏦', go: 'payments', title: 'תהליך המשכנתא טרם התחיל',
          sub: 'הלוואת הקבלן מסתיימת ' + MH.date(S.loanEnd) + ' (' + rel(S.loanDaysLeft) + ') — כדאי להתחיל באיסוף מסמכים' });
      }
    }
    if (Dm.loaded && Dm.missing.length) {
      out.push({ sev: 'yellow', icon: '📁', go: 'docs', title: Dm.missing.length + ' מסמכים נדרשים חסרים',
        sub: Dm.missing.slice(0, 2).map(d => d.title).join(' · ') + (Dm.missing.length > 2 ? ' ועוד ' + (Dm.missing.length - 2) : '') });
    }
    if (Dm.loaded && Dm.expiring.length) {
      const exp = Dm.expiring.filter(d => d.daysLeft < 0).length;
      out.push({ sev: exp ? 'red' : 'yellow', icon: '📄', go: 'docs',
        title: exp ? exp + ' מסמכים שפג תוקפם' + (Dm.expiring.length > exp ? ' (+' + (Dm.expiring.length - exp) + ' בקרוב)' : '') : Dm.expiring.length + ' מסמכים פגים ב-60 הימים הקרובים',
        sub: Dm.expiring.slice(0, 2).map(d => d.title + ' — ' + MH.date(d.expiry)).join(' · ') });
    }
    if (E.toPrice) {
      out.push({ sev: 'blue', icon: '🏷️', go: 'home', title: E.toPrice + ' פריטים ממתינים לעדכון מחיר', sub: 'מסומנים "לעדכן מחיר" ומחירם ₪0 — חסרים בתקציב' });
    }
    if (backup.loaded) {
      const days = backup.at ? Math.floor((Date.now() - backup.at) / 864e5) : null;
      if (days === null || days > 30) {
        out.push({ sev: days === null || days > 60 ? 'yellow' : 'blue', icon: '💾', act: 'backup',
          title: days === null ? 'עדיין לא נשמר גיבוי של הנתונים' : 'הגיבוי האחרון לפני ' + days + ' ימים',
          sub: 'הקש כאן להורדת גיבוי מלא (JSON) למכשיר — מומלץ פעם בחודש' });
      }
    }
    const rank = { red: 0, yellow: 1, blue: 2 };
    return out.sort((a, b) => rank[a.sev] - rank[b.sev]);
  }

  function timeline(S) {
    const T = tasksApi();
    const items = [];
    const pushTask = t => items.push({ date: t.date, days: t.daysLeft, title: t.desc || '', kind: 'task', icon: '', owner: ownerOf(t), go: 'tasks', sub: 'משימה · ' + (t.statusKey && T.STATUS ? T.STATUS[t.statusKey] : '') });
    const pushPay = p => items.push({ date: p.date, days: MH.daysUntil(p.date), title: p.title, kind: p.kind, icon: p.kind === 'loan' ? '💰' : '🏗️', go: 'payments', sub: (p.kind === 'loan' ? 'הלוואת קבלן · ' : 'תשלום לקבלן · ') + money(p.amount) });
    if (T) { try { T.upcoming(WINDOW).filter(ownerMatch).forEach(pushTask); } catch (e) {} }
    payUpcoming(WINDOW).forEach(pushPay);
    const Dm = docModel();
    Dm.expiring.forEach(d => items.push({ date: d.expiry, days: d.daysLeft, title: (d.daysLeft < 0 ? 'פג תוקף: ' : 'תוקף מסתיים: ') + (d.title || ''), kind: 'doc', icon: '📄', go: 'docs', sub: 'מסמך · ' + (d.cat || '') }));
    items.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const overdue = items.filter(i => i.days < 0);
    const soon = items.filter(i => !(i.days < 0));
    // if the window is sparse, show what comes next so the section is never a dead end
    let later = [];
    if (soon.length < 3) {
      const L = [];
      if (T) { try { T.upcoming(3650).filter(t => t.daysLeft > WINDOW && ownerMatch(t)).forEach(t => L.push({ date: t.date, days: t.daysLeft, title: t.desc || '', kind: 'task', icon: '', owner: ownerOf(t), go: 'tasks', sub: 'משימה' })); } catch (e) {} }
      payUpcoming(3650).filter(p => MH.daysUntil(p.date) > WINDOW).forEach(p => L.push({ date: p.date, days: MH.daysUntil(p.date), title: p.title, kind: p.kind, icon: p.kind === 'loan' ? '💰' : '🏗️', go: 'payments', sub: money(p.amount) }));
      later = L.sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, 3);
    }
    return { overdue, soon, later };
  }

  function model() {
    const S = pay(), E = expenseModel(), T = taskModel(), Dm = docModel();
    return { S, E, T, Dm, alerts: alerts(S, T, Dm, E), tl: timeline(S) };
  }

  // ── sections ──
  function secHero(M) {
    const S = M.S;
    const hi = MH.me ? 'שלום ' + esc(MH.me) + ' 👋' : 'תמונת מצב';
    const today = MH.today();
    const head = '<div class="ds-hero-top"><div><div class="ds-hi">' + hi + '</div><div class="ds-hero-sub">צרפתי בנאות הדרים · בניין 6, דירה 24</div></div>'
      + '<div class="ds-today">' + today.getDate() + ' ב' + MONTHS[today.getMonth()] + ' ' + today.getFullYear() + '</div></div>';
    if (!S) return '<section class="ds-hero" data-sec="hero">' + head + '<div class="ds-ph">טוען נתוני חוזה ותשלומים…</div></section>';
    const days = S.daysToDelivery;
    // next milestone: nearest of overdue task / next installment / loan end
    const cand = [];
    if (M.T.overdue.length) { const t = M.T.overdue[0]; cand.push({ d: t.daysLeft, go: 'tasks', icon: '⚠️', txt: 'באיחור: ' + t.desc, when: rel(t.daysLeft) }); }
    if (S.nextInstallment && S.nextInstallment.remaining > 0) { const n = S.nextInstallment; cand.push({ d: n.days, go: 'payments', icon: '🏗️', txt: 'יתרת תשלום לקבלן ' + moneyK(n.remaining), when: MH.date(n.dueDate) + ' · ' + rel(n.days) }); }
    if (S.loanEnd && S.loanDaysLeft >= -30) cand.push({ d: S.loanDaysLeft, go: 'payments', icon: '💰', txt: 'סיום הלוואת קבלן', when: MH.date(S.loanEnd) + ' · ' + rel(S.loanDaysLeft) });
    cand.sort((a, b) => a.d - b.d);
    const nx = cand[0];
    const p = pct(S.paid, S.price);
    return '<section class="ds-hero" data-sec="hero">' + head
      + '<div class="ds-hero-main">'
      + '<button class="ds-count" data-go="payments" aria-label="' + days + ' ימים עד המסירה">'
      + '<span class="ds-count-n">' + (days == null ? '—' : Math.max(0, days)) + '</span>'
      + '<span class="ds-count-l">ימים עד המסירה</span><span class="ds-count-d">🔑 ' + dt(S.deliveryDate) + (days > 60 ? ' · כ-' + monthsFromDays(days) + ' חודשים' : '') + '</span>' + (S.deliveryLatest ? '<span class="ds-count-d">ייתכן עד ' + dt(S.deliveryLatest) + '</span>' : '') + '</button>'
      + '<button class="ds-paid" data-go="payments">'
      + '<span class="ds-paid-row"><span class="ds-paid-l">שולם לקבלן</span><span class="ds-paid-p">' + pct1(S.paid, S.price) + '</span></span>'
      + '<span class="ds-hbar" role="img" aria-label="שולם ' + esc(money(S.paid)) + ' מתוך ' + esc(money(S.price)) + ' (' + pct1(S.paid, S.price) + ')"><i style="width:' + p.toFixed(1) + '%"></i></span>'
      + '<span class="ds-paid-v"><b>' + moneyK(S.paid) + '</b> מתוך ' + moneyK(S.price) + '</span></button>'
      + '</div>'
      + (nx ? '<button class="ds-next" data-go="' + esc(nx.go) + '"><span class="ds-next-k">הבא:</span><span class="ds-next-t">' + esc(nx.icon) + ' ' + esc(nx.txt) + '</span><span class="ds-next-w">' + esc(nx.when) + '</span></button>' : '')
      + '</section>';
  }

  function secKpis(M) {
    const S = M.S, E = M.E, T = M.T;
    const tile = (go, lbl, val, sub, extra, aria) => '<button class="mh-kpi ds-kpi" data-go="' + go + '" data-kpi="' + go + '" aria-label="' + esc(aria) + '">'
      + '<span class="ds-kpi-lbl">' + lbl + '</span><span class="ds-kpi-val">' + val + '</span>' + (sub ? '<span class="ds-kpi-sub">' + sub + '</span>' : '') + (extra || '') + '</button>';
    const ph = '<span class="ds-dim">טוען…</span>';
    let h = '<section class="mh-kpis ds-kpis" data-sec="kpis">';
    if (S) {
      h += tile('payments', 'שולם לקבלן', moneyK(S.paid), pct1(S.paid, S.price) + ' ממחיר הדירה', meter(pct(S.paid, S.price), 'שולם ' + pct1(S.paid, S.price)), 'שולם לקבלן ' + money(S.paid));
      const ixAuto = S.indexEstimate != null;
      const ix = ixAuto ? S.indexEstimate : (data().find(x => String(x.desc || '').includes('מדד')) || {}).price;
      h += tile('payments', 'יתרה לקבלן', moneyK(S.remaining), ix ? (ixAuto ? '+ הצמדה עד היום ' : '+ הערכת הצמדה ') + '<bdi>' + moneyK(ix) + '</bdi>' : '+ הפרשי הצמדה', '', 'יתרה לקבלן ' + money(S.remaining));
    } else {
      h += tile('payments', 'שולם לקבלן', ph, '', '', 'שולם לקבלן') + tile('payments', 'יתרה לקבלן', ph, '', '', 'יתרה לקבלן');
    }
    if (E.loaded) {
      h += tile('home', 'הוצאות נלוות', moneyK(E.paid) + '<small> / ' + moneyK(E.budget) + '</small>', E.pricedPaid + '/' + E.priced + ' פריטים שולמו',
        meter(pct(E.paid, E.budget), 'שולם ' + pctTxt(E.paid, E.budget) + ' מהתקציב'), 'הוצאות נלוות: שולם ' + money(E.paid) + ' מתוך תקציב ' + money(E.budget));
    } else h += tile('home', 'הוצאות נלוות', ph, '', '', 'הוצאות נלוות');
    if (T.loaded) {
      const od = T.overdue.length;
      h += tile('tasks', 'משימות פתוחות', String(T.open), od ? '<span class="ds-bad">⚠️ ' + od + ' באיחור</span>' : '<span class="ds-good">✓ אין באיחור</span>',
        '', 'משימות פתוחות ' + T.open + ', באיחור ' + od);
    } else h += tile('tasks', 'משימות פתוחות', ph, '', '', 'משימות');
    return h + '</section>';
  }

  function secAlerts(M) {
    const A = M.alerts;
    if (!A.length) return '';
    const shown = ui.allAlerts ? A : A.slice(0, ALERT_CAP);
    const rows = shown.map(a => '<button class="ds-alert ds-sev-' + a.sev + '" ' + (a.act === 'backup' ? 'data-backup="1"' : 'data-go="' + esc(a.go) + '"') + '>'
      + '<span class="ds-al-ic" aria-hidden="true">' + esc(a.icon) + '</span>'
      + '<span class="mh-grow"><span class="ds-al-t">' + esc(a.title) + '</span><span class="ds-al-s">' + esc(a.sub) + '</span></span>'
      + '<span class="ds-al-tag">' + SEV[a.sev].icon + ' ' + SEV[a.sev].lbl + '</span></button>').join('');
    const more = A.length > ALERT_CAP ? '<button class="ds-more" data-toggle="alerts">' + (ui.allAlerts ? 'הצג פחות' : '+ עוד ' + (A.length - ALERT_CAP)) + '</button>' : '';
    const red = A.filter(a => a.sev === 'red').length;
    return '<section class="mh-card ds-attn" data-sec="alerts"><div class="mh-card-title"><span>🚩 דורש תשומת לב</span><small>'
      + (red ? red + ' דחופים · ' : '') + A.length + ' פריטים</small></div>' + rows + more + '</section>';
  }

  function secTimeline(M) {
    const tl = M.tl;
    const seg = '<div class="mh-seg ds-seg" role="tablist" aria-label="סינון לפי אחראי">' + [['all', 'הכל'], ['עידן', 'עידן'], ['שני', 'שני']].map(([k, l]) =>
      '<button role="tab" aria-selected="' + (ui.owner === k) + '" class="' + (ui.owner === k ? 'on' : '') + '" data-owner="' + k + '">' + l + '</button>').join('') + '</div>';
    const row = (i, cls) => {
      const [y, m, d] = String(i.date).split('-');
      return '<button class="ds-tl-item ' + (cls || '') + '" data-go="' + esc(i.go) + '" data-kind="' + esc(i.kind) + '">'
        + '<span class="ds-tl-date"><b>' + (Number(d) || '') + '</b><span>' + (MON_S[Number(m) - 1] || '') + '</span></span>'
        + '<span class="mh-grow"><span class="ds-tl-t">' + (i.icon ? esc(i.icon) + ' ' : '') + esc(i.title) + '</span><span class="ds-tl-s">' + esc(i.sub) + (i.days != null ? ' · ' + esc(rel(i.days)) : '') + '</span></span>'
        + (i.owner ? chip(i.owner) : '') + '</button>';
    };
    let body = '';
    if (tl.overdue.length) body += '<div class="ds-tl-g ds-tl-g-red">⚠️ באיחור (' + tl.overdue.length + ')</div>' + tl.overdue.map(i => row(i, 'ds-late')).join('');
    let cur = '';
    tl.soon.forEach(i => {
      const [y, m] = String(i.date).split('-'); const k = y + '-' + m;
      if (k !== cur) { cur = k; body += '<div class="ds-tl-g">' + esc((MONTHS[Number(m) - 1] || '') + ' ' + y) + '</div>'; }
      body += row(i);
    });
    if (!tl.soon.length) body += '<div class="ds-tl-empty">✓ אין ' + (tl.overdue.length ? 'פריטים נוספים' : 'משימות או תשלומים') + ' ב-60 הימים הקרובים' + (ui.owner !== 'all' ? ' עבור ' + esc(ui.owner) : '') + '</div>';
    if (tl.later.length) body += '<div class="ds-tl-g">בהמשך</div>' + tl.later.map(i => row(i, 'ds-dimrow')).join('');
    return '<section class="mh-card" data-sec="timeline"><div class="mh-card-title"><span>📅 60 הימים הקרובים</span><small>משימות · תשלומים · מסמכים</small></div>'
      + seg + '<div class="ds-tl">' + body + '</div></section>';
  }

  function secBudget(M) {
    const E = M.E;
    if (!E.loaded) return '<section class="mh-card" data-sec="budget"><div class="mh-card-title">💸 תקציב מול ביצוע</div><div class="ds-ph dark">טוען הוצאות…</div></section>';
    const max = Math.max(1, ...E.bars.map(c => c.budget));
    const shown = ui.allCats ? E.bars : E.bars.slice(0, CAT_CAP);
    const rows = shown.map(c => {
      const meta = catMeta(c.cat);
      const w = Math.max(0, c.budget) / max * 100;
      const f = pct(c.paid, c.budget);
      const over = c.paid > c.budget && c.budget > 0;
      return '<button class="ds-cat" data-cat="' + esc(c.cat) + '">'
        + '<span class="ds-cat-h"><span class="ds-cat-n">' + esc(meta.emoji) + ' ' + esc(c.cat) + '</span><span class="ds-cat-v"><b>' + money(c.paid) + '</b> / ' + money(c.budget) + '</span></span>'
        + '<span class="ds-cbar" role="img" aria-label="' + esc(c.cat + ': שולם ' + money(c.paid) + ' מתוך ' + money(c.budget)) + '"><span class="ds-cbar-b" style="width:' + Math.max(w, 1.2).toFixed(1) + '%"><i style="width:' + f.toFixed(1) + '%"></i></span></span>'
        + ((c.credits || over) ? '<span class="ds-cat-note">' + (c.credits ? 'נטו, כולל זיכויים ' + money(c.credits) : '') + (over ? (c.credits ? ' · ' : '') + 'שולם מעל התקציב' : '') + '</span>' : '')
        + '</button>';
    }).join('');
    const toggle = E.bars.length > CAT_CAP ? '<button class="ds-more" data-toggle="cats">' + (ui.allCats ? 'הצג פחות' : 'הצג הכל (' + E.bars.length + ' קטגוריות)') + '</button>' : '';
    const zero = E.zero.length ? '<div class="ds-zero">ללא הערכת מחיר (' + E.zeroItems + ' פריטים): ' + E.zero.map(c => esc(catMeta(c.cat).emoji + ' ' + c.cat)).join(' · ') + '</div>' : '';
    const total = '<div class="ds-total"><span class="ds-cat-h"><span class="ds-cat-n">סה״כ הוצאות נלוות</span><span class="ds-cat-v"><b>' + money(E.paid) + '</b> / ' + money(E.budget) + '</span></span>'
      + meter(pct(E.paid, E.budget), 'סה"כ שולם ' + pctTxt(E.paid, E.budget)) + '<span class="ds-cat-note">שולם ' + pctTxt(E.paid, E.budget) + ' · נותר ' + money(E.remaining) + '</span></div>';
    return '<section class="mh-card" data-sec="budget"><div class="mh-card-title"><span>💸 תקציב מול ביצוע</span>'
      + '<span class="ds-legend"><span><i class="ds-sw paid"></i>שולם</span><span><i class="ds-sw bud"></i>תקציב</span></span></div>'
      + '<div class="ds-cats">' + rows + '</div>' + toggle + zero + total + '</section>';
  }

  function secContractor(M) {
    const S = M.S;
    if (!S) return '<section class="mh-card" data-sec="contractor"><div class="mh-card-title">🏗️ תשלומים לקבלן</div><div class="ds-ph dark">טוען…</div></section>';
    const inst = (Array.isArray(S.installments) && S.installments.length)
      ? S.installments.map(i => ({ n: i.n, label: i.label, amount: num(i.amount), dueDate: i.dueDate, paid: num(i.paid) })).filter(i => i.amount > 0).sort((a, b) => num(a.n) - num(b.n))
      : contractInstallments();
    const total = inst.reduce((s, i) => s + i.amount, 0) || 1;
    const segs = inst.map(i => {
      const f = pct(i.paid, i.amount);
      const st = i.paid >= i.amount ? '✓ שולם' : i.paid > 0 ? 'שולם ' + pctTxt(i.paid, i.amount) : 'עתידי';
      return '<div class="ds-inst" style="flex:' + (i.amount / total).toFixed(4) + ' 1 0">'
        + '<span class="ds-ibar" role="img" aria-label="' + esc('תשלום ' + i.n + ': שולם ' + money(i.paid) + ' מתוך ' + money(i.amount)) + '"><i style="width:' + f.toFixed(1) + '%"></i></span>'
        + '<span class="ds-inst-a">' + moneyK(i.amount) + '</span><span class="ds-inst-s">' + st + '</span><span class="ds-inst-d">' + esc(shortDate(i.dueDate)) + '</span></div>';
    }).join('');
    const n = S.nextInstallment;
    return '<section class="mh-card ds-tap" data-sec="contractor" data-go="payments" role="button" tabindex="0"><div class="mh-card-title"><span>🏗️ תשלומים לקבלן</span><small>' + money(S.paid) + ' / ' + money(S.price) + '</small></div>'
      + '<div class="ds-steps">' + segs + '</div>'
      + (n && n.remaining > 0 ? '<div class="mh-note">נותר ' + money(n.remaining) + ' ב' + esc((n.label || '').split('—')[0].trim() || 'תשלום הבא') + ' · עד ' + dt(n.dueDate) + '</div>' : '<div class="mh-note">✓ כל התשלומים שולמו</div>')
      + '</section>';
  }
  // fallback only: older PAY_API without summary().installments
  let contractSnap = null;
  MH.db.ref('contract/installments').on('value', s => { contractSnap = s.val(); });
  let paySnap = null;
  MH.db.ref('contract/payments').on('value', s => { paySnap = s.val(); schedule(); });
  function contractInstallments() {
    const inst = contractSnap && typeof contractSnap === 'object' ? Object.keys(contractSnap).map(k => Object.assign({ key: k }, contractSnap[k])) : [];
    const pays = paySnap && typeof paySnap === 'object' ? Object.values(paySnap) : [];
    return inst.filter(i => i && num(i.amount) > 0).sort((a, b) => num(a.n) - num(b.n)).map(i => ({
      n: i.n, label: i.label, amount: num(i.amount), dueDate: i.dueDate,
      paid: pays.filter(p => p && p.installmentKey === i.key).reduce((s, p) => s + num(p.amount), 0),
    }));
  }

  function secMortgage(M) {
    const S = M.S;
    if (!S) return '<section class="mh-card" data-sec="mortgage"><div class="mh-card-title">🏦 משכנתא ומימון</div><div class="ds-ph dark">טוען…</div></section>';
    const ST = (window.PAY_API && window.PAY_API.STAGES) || [];
    const si = S.mortgageStageIndex;
    const steps = ST.map((s, i) => '<i class="' + (i < si ? 'done' : i === si ? 'cur' : '') + '" title="' + esc(s) + '"></i>').join('');
    const lm = S.loanDaysLeft;
    const lsev = lm < 183 ? 'red' : (lm <= 365 || (si === 0 && lm < 456)) ? 'yellow' : 'ok';
    const ck = S.checklistTotal ? S.checklistDone + '/' + S.checklistTotal : '—';
    return '<section class="mh-card ds-tap" data-sec="mortgage" data-go="payments" role="button" tabindex="0"><div class="mh-card-title"><span>🏦 משכנתא ומימון</span><small>שלב ' + (si + 1) + ' מתוך ' + ST.length + '</small></div>'
      + '<div class="ds-stage" role="img" aria-label="' + esc('שלב ' + (si + 1) + ' מתוך ' + ST.length + ': ' + S.mortgageStage) + '">' + steps + '</div>'
      + '<div class="ds-stage-l"><b>' + esc(S.mortgageStage) + '</b>' + (ST[si + 1] ? '<span>הבא: ' + esc(ST[si + 1]) + '</span>' : '') + '</div>'
      + '<div class="ds-kv"><span>צ׳קליסט מסמכים</span><b>' + ck + '</b></div>' + meter(pct(S.checklistDone, S.checklistTotal), 'צ׳קליסט ' + ck)
      + '<div class="ds-kv"><span>סכום משכנתא משוער</span><b>' + money(S.financingNeed) + '</b></div>'
      + '<div class="ds-kv sub"><span>כולל החזר הלוואת הקבלן, בניכוי הון זמין</span></div>'
      + '<div class="ds-kv"><span>הלוואת קבלן מסתיימת</span><b class="ds-t-' + lsev + '">' + (lsev === 'ok' ? '' : lsev === 'red' ? '⛔ ' : '⚠️ ') + dt(S.loanEnd) + '</b></div>'
      + '<div class="ds-kv sub"><span>' + (lm < 0 ? 'ההלוואה הסתיימה' : 'עוד ' + monthsFromDays(lm) + ' חודשים (' + lm + ' ימים)') + '</span></div>'
      + '</section>';
  }

  function secCashflow() { return window.CASHFLOW_API ? window.CASHFLOW_API.section() : ''; }

  function secSavings(M) {
    const E = M.E;
    if (!E.loaded) return '';
    const sv = E.savings;
    return '<section class="mh-card ds-tap" data-sec="savings" data-edit="savings" role="button" tabindex="0"><div class="mh-card-title"><span>💰 קצב חיסכון</span><small>עד אכלוס ' + dt(E.moveIn) + ' · ✏️ עדכון</small></div>'
      + '<div class="ds-sv">'
      + '<div><span>נותר לשלם</span><b>' + moneyK(E.remaining) + '</b></div>'
      + '<div><span>זמין עכשיו</span><b>' + moneyK(E.avail) + '</b></div>'
      + '<div class="hl"><span>לחסוך בחודש</span><b>' + esc(money(sv.perMonth)) + '</b></div></div>'
      + '<div class="ds-cat-note">' + esc(sv.monthsLeft) + ' חודשים · הוצאות נלוות בלבד — יתרת הקבלן ממומנת במשכנתא</div></section>';
  }

  function secPhases(M) {
    const T = M.T;
    if (!T.loaded) return '';
    const PC = phaseConfig();
    const rows = T.phases.map(p => {
      const c = PC[p.p] || { name: 'שלב ' + p.p, emoji: '•' };
      const name = String(c.name || '').replace(/^שלב \d+\s*—\s*/, '');
      return '<div class="ds-ph-row"><span class="ds-ph-n">' + esc(c.emoji) + ' ' + esc(name) + '</span><span class="ds-ph-v">' + p.done + '/' + p.total + '</span>'
        + meter(pct(p.done, p.total), name + ': ' + p.done + ' מתוך ' + p.total + ' הושלמו', p.total && p.done === p.total ? 'full' : '') + '</div>';
    }).join('');
    return '<section class="mh-card ds-tap" data-sec="phases" data-go="tasks" role="button" tabindex="0"><div class="mh-card-title"><span>🗂️ משימות לפי שלב</span><small>הושלמו / סה״כ</small></div>' + rows + '</section>';
  }

  function secFooter() {
    const d = new Date(); const t = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const b = backup.at ? 'גיבוי אחרון ' + MH.date(new Date(backup.at).toISOString().slice(0, 10)) : 'לא נשמר גיבוי';
    return '<footer class="ds-foot" data-sec="footer"><span>עודכן ' + t + ' · ' + esc(b) + '</span><button class="ds-link" data-backup="1">📥 גיבוי</button></footer>';
  }

  // ── render ──
  function safe(fn, M) { try { return fn(M); } catch (e) { console.warn('[dash] section failed', fn.name, e); return ''; } }
  function render() {
    injectCss();
    const root = document.getElementById('dash-root'); if (!root) return;
    bind(root);
    const M = model();
    lastRender = Date.now();
    root.innerHTML = '<div class="ds">'
      + safe(secHero, M) + safe(secKpis, M) + safe(secAlerts, M) + safe(secTimeline, M) + safe(secCashflow, M) + safe(secBudget, M)
      + '<div class="ds-grid">' + safe(secContractor, M) + safe(secMortgage, M) + '</div>'
      + '<div class="ds-grid">' + safe(secSavings, M) + safe(secPhases, M) + '</div>'
      + secFooter() + '</div>';
  }

  function go(page) { if (typeof switchPage === 'function' && document.getElementById('page-' + page)) switchPage(page); }
  function openCategory(cat) {
    const s = document.getElementById('srch'); if (s) s.value = '';
    go('home');
    try {
      if (typeof catOpen !== 'undefined' && catOpen) catOpen[cat] = true;
      if (typeof renderAll === 'function') renderAll();
    } catch (e) {}
    setTimeout(() => {
      const card = Array.from(document.querySelectorAll('#catContainer .cat-card')).find(c => { const n = c.querySelector('.cat-name'); return n && n.textContent.trim() === cat; });
      if (card) card.scrollIntoView({ block: 'start' });
    }, 30);
  }
  function savingsSheet() {
    const s = settings();
    MH.sheet({
      title: '💰 תכנון חיסכון לאכלוס',
      html: '<div class="form-group"><label>🏦 כסף זמין עכשיו (₪)</label><input type="number" inputmode="numeric" name="available" value="' + esc(s.available || '') + '"></div>'
        + '<div class="form-group"><label>🏠 תאריך אכלוס מתוכנן</label><input type="date" name="moveInDate" value="' + esc(s.moveInDate || '') + '"></div>'
        + '<div class="mh-note">החיסכון החודשי הנדרש = (יתרת ההוצאות הנלוות − הכסף הזמין) ÷ החודשים עד האכלוס. יתרת התשלום לקבלן ממומנת במשכנתא ולא נכללת כאן.</div>',
      onSave: el => {
        const v = MH.formValues(el);
        if (!v.moveInDate) { MH.toast('⚠️ חסר תאריך אכלוס'); return false; }
        MH.syncing();
        return MH.db.ref('settings').update({ available: Number(v.available) || 0, moveInDate: v.moveInDate }).then(MH.saved, MH.saveError);
      },
    });
  }
  let bound = null;
  function bind(root) {
    if (bound === root) return; bound = root;
    root.addEventListener('click', e => {
      const t = e.target.closest('[data-owner],[data-toggle],[data-backup],[data-cat],[data-edit],[data-go]');
      if (!t || !root.contains(t)) return;
      if (t.dataset.owner) { ui.owner = t.dataset.owner; render(); return; }
      if (t.dataset.toggle === 'cats') { ui.allCats = !ui.allCats; render(); return; }
      if (t.dataset.toggle === 'alerts') { ui.allAlerts = !ui.allAlerts; render(); return; }
      if (t.dataset.backup) { if (MH.exportBackup) MH.exportBackup(); return; }
      if (t.dataset.cat) { openCategory(t.dataset.cat); return; }
      if (t.dataset.edit === 'savings') { savingsSheet(); return; }
      if (t.dataset.go) go(t.dataset.go);
    });
    root.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.ds-tap')) { e.preventDefault(); if (e.target.dataset.edit === 'savings') savingsSheet(); else go(e.target.dataset.go); }
    });
  }

  const backup = { loaded: false, at: null };
  MH.db.ref('meta/lastBackup').on('value', sn => { const v = sn.val(); backup.loaded = true; backup.at = v && v.at ? Number(v.at) : null; schedule(); }, () => { backup.loaded = false; });
  let timer = null;
  function schedule() { clearTimeout(timer); timer = setTimeout(() => MH.refreshIfShown('dash'), 100); }
  ['expenses', 'tasks', 'settings', 'docs', 'contract', 'mortgage', 'ready'].forEach(ev => MH.on(ev, schedule));
  MH.registerPage('dash', { render });
  window.DASH_API = { model, render };

  // ── CSS ──
  function injectCss() {
    if (document.getElementById('dashboard-css')) return;
    const st = document.createElement('style'); st.id = 'dashboard-css';
    st.textContent = `
.ds{font-variant-numeric:tabular-nums}
.ds button{font-family:inherit;color:inherit;text-align:inherit;background:none;border:none;padding:0;cursor:pointer;-webkit-tap-highlight-color:transparent}
.ds .mh-card{min-width:0}
.ds-tap{cursor:pointer}
.ds .mh-seg button{padding:8px 10px;min-height:36px;text-align:center;border-radius:8px}
.ds .mh-seg button.on{background:#fff}
.ds-tap:active,.ds-kpi:active,.ds-alert:active,.ds-cat:active,.ds-tl-item:active{opacity:.7}
.ds-ph{color:rgba(255,255,255,.75);font-size:.8rem;padding:18px 0 6px}
.ds-ph.dark{color:var(--muted);padding:8px 0}
.ds-dim{color:var(--muted);font-size:.8rem;font-weight:600}

/* hero */
.ds-hero{background:linear-gradient(155deg,#1a1a2e 0%,#2d3a6b 100%);color:#fff;border-radius:18px;padding:16px;margin-bottom:12px;box-shadow:0 6px 18px rgba(26,26,46,.22)}
.ds-hero-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
.ds-hi{font-size:1.05rem;font-weight:900}
.ds-hero-sub{font-size:.68rem;color:rgba(255,255,255,.65);margin-top:2px}
.ds-today{font-size:.68rem;color:rgba(255,255,255,.7);white-space:nowrap;padding-top:3px}
.ds-hero-main{display:flex;gap:14px;align-items:stretch;margin-top:14px}
.ds-count{display:flex!important;flex-direction:column;align-items:center;justify-content:center;background:rgba(255,255,255,.08)!important;border-radius:14px!important;padding:10px 12px!important;min-width:112px;text-align:center!important}
.ds-count-n{font-size:2.5rem;font-weight:900;line-height:1;letter-spacing:-.5px}
.ds-count-l{font-size:.72rem;font-weight:700;margin-top:4px}
.ds-count-d{font-size:.62rem;color:rgba(255,255,255,.7);margin-top:3px;white-space:nowrap}
.ds-paid{flex:1;min-width:0;display:flex!important;flex-direction:column;justify-content:center;gap:7px}
.ds-paid-row{display:flex;justify-content:space-between;align-items:baseline}
.ds-paid-l{font-size:.78rem;font-weight:700;color:rgba(255,255,255,.85)}
.ds-paid-p{font-size:1.5rem;font-weight:900}
.ds-hbar{display:block;height:12px;background:rgba(255,255,255,.18);border-radius:6px;overflow:hidden}
.ds-hbar>i{display:block;height:100%;background:#34d399;border-radius:6px}
.ds-paid-v{font-size:.74rem;color:rgba(255,255,255,.75)}
.ds-paid-v b{color:#fff;font-size:.9rem}
.ds-next{display:flex!important;flex-wrap:wrap;align-items:center;min-height:38px;gap:2px 6px;width:100%;margin-top:12px;background:rgba(255,255,255,.1)!important;border-radius:10px!important;padding:8px 10px!important;font-size:.76rem}
.ds-next-k{color:rgba(255,255,255,.6);font-weight:700}
.ds-next-t{font-weight:800;min-width:0;overflow-wrap:anywhere}
.ds-next-w{color:rgba(255,255,255,.7);font-size:.7rem;margin-inline-start:auto;white-space:nowrap}

/* KPI tiles */
.ds-kpi{display:flex!important;flex-direction:column;align-items:stretch;min-width:0;background:var(--card)!important;border-radius:var(--r)!important;padding:12px 13px!important;box-shadow:var(--shadow)}
.ds-kpi-lbl{font-size:.7rem;color:var(--muted);font-weight:700}
.ds-kpi-val{font-size:1.28rem;font-weight:900;margin-top:3px;white-space:nowrap}
.ds-kpi-val small{font-size:.74rem;color:var(--muted);font-weight:700}
.ds-kpi-sub{font-size:.68rem;color:var(--muted);margin-top:3px}
.ds-bad{color:#b91c1c;font-weight:800}
.ds-good{color:#15803d;font-weight:700}
.ds-meter{height:6px;background:#dbeafe;border-radius:3px;overflow:hidden;margin-top:8px}
.ds-meter>i{display:block;height:100%;background:var(--accent);border-radius:3px}
.ds-meter.full>i{background:var(--green)}

/* alerts */
.ds-attn{border:1.5px solid #fecaca}
.ds-attn .mh-card-title{margin-bottom:6px}
.ds-alert{display:flex!important;align-items:center;gap:10px;width:100%;padding:9px 10px!important;margin-top:6px;border:1px solid var(--border)!important;border-inline-start:4px solid var(--border)!important;border-radius:10px!important;background:#fff!important}
.ds-sev-red{border-inline-start-color:var(--red)!important}
.ds-sev-yellow{border-inline-start-color:var(--yellow)!important}
.ds-sev-blue{border-inline-start-color:var(--accent)!important}
.ds-al-ic{font-size:1.15rem;width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.ds-sev-red .ds-al-ic{background:var(--red-50)}.ds-sev-yellow .ds-al-ic{background:var(--yellow-50)}.ds-sev-blue .ds-al-ic{background:var(--blue-50)}
.ds-al-t{display:block;font-size:.82rem;font-weight:800;line-height:1.3}
.ds-al-s{display:block;font-size:.69rem;color:var(--muted);margin-top:2px;line-height:1.4}
.ds-al-tag{font-size:.6rem;font-weight:800;padding:2px 6px;border-radius:8px;white-space:nowrap;flex-shrink:0;align-self:flex-start;margin-top:2px}
.ds-sev-red .ds-al-tag{background:#fee2e2;color:#b91c1c}.ds-sev-yellow .ds-al-tag{background:#fef3c7;color:#92400e}.ds-sev-blue .ds-al-tag{background:#dbeafe;color:#1d4ed8}
.ds-more{display:flex!important;align-items:center;justify-content:center;width:100%;min-height:40px;font-size:.76rem;font-weight:800;color:var(--accent)!important;margin-top:4px}

/* timeline */
.ds-seg{margin-bottom:6px}
.ds-tl-g{font-size:.7rem;font-weight:800;color:var(--muted);margin:10px 0 2px;padding-bottom:3px;border-bottom:1px solid var(--border)}
.ds-tl-g-red{color:#b91c1c;border-color:#fecaca}
.ds-tl-item{display:flex!important;align-items:center;gap:10px;width:100%;padding:8px 0!important}
.ds-tl-item+.ds-tl-item{border-top:1px dashed #eef0f3!important}
.ds-tl-date{flex-shrink:0;width:42px;height:42px;border-radius:10px;background:var(--blue-50);color:#1d4ed8;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1}
.ds-tl-date b{font-size:1rem;font-weight:900}
.ds-tl-date span{font-size:.6rem;font-weight:700;margin-top:2px}
.ds-late .ds-tl-date{background:#fee2e2;color:#b91c1c}
.ds-dimrow .ds-tl-date{background:var(--bg);color:var(--muted)}
.ds-tl-t{display:block;font-size:.8rem;font-weight:700;line-height:1.3}
.ds-late .ds-tl-t{color:#b91c1c}
.ds-tl-s{display:block;font-size:.67rem;color:var(--muted);margin-top:2px}
.ds-owner{flex-shrink:0}
.ds-tl-empty{font-size:.76rem;color:#15803d;background:var(--green-50);border-radius:10px;padding:10px;margin-top:8px;text-align:center}

/* budget bars */
.ds-legend{display:flex;gap:10px;font-size:.66rem;color:var(--muted);font-weight:600}
.ds-legend>span{display:inline-flex;align-items:center;gap:4px}
.ds-sw{display:inline-block;width:10px;height:10px;border-radius:3px}
.ds-sw.paid{background:var(--accent)}.ds-sw.bud{background:#dbeafe}
.ds-cat{display:block!important;width:100%;padding:6px 0!important;min-height:40px}
.ds-cat-h{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.ds-cat-n{font-size:.78rem;font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ds-cat-v{font-size:.7rem;color:var(--muted);white-space:nowrap}
.ds-cat-v b{color:var(--ink)}
.ds-cbar{display:block;margin-top:3px}
.ds-cbar-b{display:block;height:10px;background:#dbeafe;border-radius:4px;overflow:hidden;min-width:3px}
.ds-cbar-b>i{display:block;height:100%;background:var(--accent)}
.ds-cat-note{display:block;font-size:.64rem;color:var(--muted);margin-top:2px}
.ds-zero{font-size:.68rem;color:var(--muted);background:var(--bg);border-radius:10px;padding:8px 10px;margin-top:8px;line-height:1.5}
.ds-total{border-top:1.5px solid var(--border);margin-top:10px;padding-top:9px}
.ds-total .ds-cat-n{font-weight:900}

/* contractor stepper */
.ds-steps{display:flex;gap:4px;margin-bottom:10px}
.ds-inst{min-width:0;display:flex;flex-direction:column}
.ds-ibar{display:block;height:12px;background:#dbeafe;border-radius:4px;overflow:hidden}
.ds-ibar>i{display:block;height:100%;background:var(--accent)}
.ds-inst-a{font-size:.78rem;font-weight:900;margin-top:5px}
.ds-inst-s{font-size:.64rem;font-weight:700;color:var(--ink-2);white-space:nowrap}
.ds-inst-d{font-size:.62rem;color:var(--muted)}

/* mortgage */
.ds-stage{display:flex;gap:3px}
.ds-stage i{flex:1;height:8px;border-radius:4px;background:#e5e7eb}
.ds-stage i.done{background:var(--accent)}
.ds-stage{align-items:center}
.ds-stage i.cur{background:var(--accent);height:12px;border-radius:6px}
.ds-stage-l{display:flex;justify-content:space-between;gap:8px;font-size:.76rem;margin:7px 0 8px}
.ds-stage-l span{color:var(--muted);font-size:.7rem}
.ds-kv{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:.76rem;margin-top:9px}
.ds-kv span{color:var(--ink-2)}
.ds-kv.sub{margin-top:1px}.ds-kv.sub span{font-size:.66rem;color:var(--muted)}
.ds-t-red{color:#b91c1c}.ds-t-yellow{color:#92400e}.ds-t-green{color:#15803d}

/* savings */
.ds-sv{display:grid;grid-template-columns:1fr 1fr 1.2fr;gap:6px}
.ds-sv>div{background:var(--bg);border-radius:10px;padding:8px;min-width:0}
.ds-sv span{display:block;font-size:.64rem;color:var(--muted);font-weight:600}
.ds-sv b{display:block;font-size:.92rem;font-weight:900;margin-top:2px;white-space:nowrap}
.ds-sv .hl{background:var(--blue-50)}.ds-sv .hl b{color:#1d4ed8}

/* phases */
.ds-ph-row{display:grid;grid-template-columns:1fr auto;align-items:baseline;margin-top:8px}
.ds-ph-row:first-of-type{margin-top:0}
.ds-ph-n{font-size:.76rem;font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ds-ph-v{font-size:.72rem;color:var(--muted);font-weight:700}
.ds-ph-row .ds-meter{grid-column:1/-1;margin-top:4px}

/* footer */
.ds-foot{display:flex;justify-content:center;align-items:center;gap:14px;font-size:.7rem;color:var(--muted);padding:6px 0 4px}
.ds-link{color:var(--accent)!important;font-weight:800;font-size:.72rem;min-height:40px;padding:0 12px!important;display:inline-flex!important;align-items:center}

@media (min-width:720px){
  .ds-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}
  .ds-count-n{font-size:3rem}
}
`;
    document.head.appendChild(st);
  }
})();
