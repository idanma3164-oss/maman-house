// ═══════════════════════════════════════════════════════════════
// cashflow.js — תחזית תזרים חודשית להוצאות הנלוות (v2.2)
// ───────────────────────────────────────────────────────────────
// מקור: DATA (הוצאות) — יתרה לתשלום = price − paid לכל פריט שלא סומן "הושלם".
//   • פריט עם payDate → בחודש של התאריך (תאריך שעבר → החודש הנוכחי, מסומן "באיחור")
//   • פריט בלי תאריך → משובץ לפי שלב: 1–2 → החודש הנוכחי, 3 → חודש לפני המסירה, 4 → חודש אחרי המסירה
// תשלומי הקבלן מוצגים כאירוע נפרד (סדר גודל אחר, ממומן ברובו במשכנתא) — לא על אותו ציר.
// Public: window.CASHFLOW_API = { model(), section() } — מוצג בתוך תמונת המצב.
// ═══════════════════════════════════════════════════════════════
(function () {
  'use strict';
  const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  const C_SCHED = '#2563eb', C_EST = '#60a5fa';
  const ui = { sel: null, table: false };
  const esc = s => MH.esc(s);
  const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };

  // ── month helpers (YYYY-MM strings) ──
  const ymOf = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  const ymIso = iso => String(iso || '').slice(0, 7);
  function addM(ym, n) { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return ymOf(d); }
  function diffM(a, b) { const [ya, ma] = a.split('-').map(Number), [yb, mb] = b.split('-').map(Number); return (yb - ya) * 12 + (mb - ma); }
  const ymLabel = ym => { const [y, m] = ym.split('-'); return MONTHS[Number(m) - 1] + ' ' + y; };
  const ymShort = ym => { const [y, m] = ym.split('-'); return m + '/' + y.slice(2); };

  function payS() { try { const s = window.PAY_API && PAY_API.summary(); return s && s.loaded ? s : null; } catch (e) { return null; } }
  function data() { try { return typeof DATA !== 'undefined' && Array.isArray(DATA) ? DATA.filter(Boolean) : []; } catch (e) { return []; } }

  function model() {
    const S = payS();
    const cur = ymOf(MH.today());
    const delivery = ymIso((S && S.deliveryDate) || '2027-12-31');
    let end = addM(delivery, 3);
    const items = [];
    let unscheduled = 0, overdue = 0;
    const mc = (S && S.mortgageCategories) || [];
    let mortgageFinanced = 0;
    data().forEach(it => {
      if (it.done) return;
      if (mc.includes(it.cat)) { mortgageFinanced += num(it.price) - num(it.paid); return; }   // ימומן במשכנתא — לא מזומן
      const rem = num(it.price) - num(it.paid);
      if (!rem) return;
      let ym, kind, late = false, why = '';
      if (it.payDate && /^\d{4}-\d{2}/.test(it.payDate)) {
        ym = ymIso(it.payDate); kind = 'sched';
        if (diffM(cur, ym) < 0) { ym = cur; late = true; overdue++; }
      } else {
        kind = 'est'; unscheduled++;
        const ph = Number(it.phase) || 3;
        if (ph <= 2) { ym = cur; why = 'שלב ' + ph + ' → עכשיו'; }
        else if (ph === 3) { ym = addM(delivery, -1); why = 'שלב 3 → חודש לפני המסירה'; }
        else { ym = addM(delivery, 1); why = 'שלב 4 → אחרי המסירה'; }
        if (diffM(cur, ym) < 0) ym = cur;
      }
      if (diffM(end, ym) > 0) end = ym;
      items.push({ ym, kind, late, why, amount: rem, desc: it.desc || '', cat: it.cat || '', payDate: it.payDate || '' });
    });
    if (diffM(cur, end) > 36) end = addM(cur, 36);
    const months = [];
    for (let m = cur; diffM(m, end) >= 0; m = addM(m, 1)) months.push({ ym: m, sched: 0, est: 0, items: [], events: [] });
    const byYm = {}; months.forEach(x => { byYm[x.ym] = x; });
    items.forEach(i => { const b = byYm[i.ym] || months[months.length - 1]; b[i.kind] += i.amount; b.items.push(i); });
    // contractor installments & loan end — events, not bars
    if (S && Array.isArray(S.installments)) {
      S.installments.filter(i => i.remaining > 0).forEach(i => {
        const b = byYm[ymIso(i.dueDate)] || null;
        const ev = { icon: '🏗️', title: 'יתרה לקבלן', amount: i.remaining, extra: S.indexProjection || S.indexEstimate || 0, date: i.dueDate };
        if (b) b.events.push(ev);
      });
    }
    if (S && Array.isArray(S.extras)) {
      const dYm = ymIso(S.deliveryDate || '2027-12-31');
      S.extras.filter(x => !x.paid).forEach(x => { const b = byYm[dYm]; if (b) b.events.push({ icon: '🔧', title: x.title + (x.financedByMortgage ? ' (ימומן במשכנתא)' : ''), amount: x.amount, extra: x.indexProjected || 0, date: S.deliveryDate, loan: true }); });
    }
    if (S && S.loanEnd && byYm[ymIso(S.loanEnd)]) byYm[ymIso(S.loanEnd)].events.push({ icon: '💰', title: 'סיום הלוואת קבלן (מוחלפת במשכנתא)', amount: 700000, date: S.loanEnd, loan: true });
    months.forEach(x => { x.total = x.sched + x.est; x.items.sort((a, b) => b.amount - a.amount); });
    const sumN = n => months.slice(0, n).reduce((s, x) => s + x.total, 0);
    const total = months.reduce((s, x) => s + x.total, 0);
    const estTotal = months.reduce((s, x) => s + x.est, 0);
    const peak = months.reduce((p, x) => (!p || x.total > p.total) ? x : p, null);
    return { cur, delivery, end, months, total, estTotal, next3: sumN(3), next12: sumN(12), peak, unscheduled, overdue, mortgageFinanced, mortgageCats: mc, loaded: data().length > 0 };
  }

  function niceMax(v) {
    if (v <= 0) return 1000;
    const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }

  function chart(M) {
    const W = 340, H = 172, padL = 40, padR = 6, padT = 22, padB = 22;
    const n = M.months.length, plotW = W - padL - padR, plotH = H - padT - padB;
    const slot = plotW / n, bw = Math.max(5, Math.min(22, slot * 0.64));
    const maxV = niceMax(Math.max(1, ...M.months.map(x => Math.max(0, x.total))));
    const y = v => padT + plotH - (Math.max(0, v) / maxV) * plotH;
    const x0 = i => padL + i * slot + (slot - bw) / 2;
    const k = Math.max(1, Math.ceil(n / 6));
    let g = '';
    // grid + y labels (recessive)
    [0, 0.5, 1].forEach(t => {
      const yy = y(maxV * t);
      g += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + yy + '" y2="' + yy + '" class="cf-grid"/>'
        + '<text x="' + (padL - 5) + '" y="' + (yy + 3.5) + '" class="cf-ax" text-anchor="end">' + esc(MH.moneyK(maxV * t).replace('₪0', '0')) + '</text>';
    });
    M.months.forEach((m, i) => {
      const sel = ui.sel === m.ym;
      if (sel) g += '<rect x="' + (padL + i * slot) + '" y="' + padT + '" width="' + slot + '" height="' + plotH + '" class="cf-sel"/>';
      const xs = x0(i);
      let top = y(0);
      if (m.sched > 0) { const h = y(0) - y(m.sched); g += '<rect x="' + xs + '" y="' + (top - h) + '" width="' + bw + '" height="' + h + '" rx="2" fill="' + C_SCHED + '"/>'; top -= h; }
      if (m.est > 0) {
        const h = y(0) - y(m.est); const gap = m.sched > 0 ? 2 : 0;
        g += '<rect x="' + xs + '" y="' + (top - h - gap) + '" width="' + bw + '" height="' + Math.max(0, h - 0) + '" rx="2" fill="url(#cfHatch)"/>';
      }
      if (i % k === 0 || i === n - 1 && n - 1 - (Math.floor((n - 1) / k) * k) > k / 2) {
        g += '<text x="' + (padL + i * slot + slot / 2) + '" y="' + (H - 6) + '" class="cf-ax" text-anchor="middle">' + esc(ymShort(m.ym)) + '</text>';
      }
      if (m.ym === M.delivery) {
        const cx = padL + i * slot + slot / 2;
        g += '<line x1="' + cx + '" x2="' + cx + '" y1="' + (padT - 4) + '" y2="' + (padT + plotH) + '" class="cf-deliv"/>'
          + '<text x="' + cx + '" y="' + (padT - 8) + '" class="cf-ax cf-deliv-t" text-anchor="' + (i > n * 0.7 ? 'end' : 'middle') + '">🔑 מסירה</text>';
      }
      if (m.events.some(e => !e.loan) && m.ym !== M.delivery) {
        const cx = padL + i * slot + slot / 2;
        g += '<text x="' + cx + '" y="' + (padT - 8) + '" class="cf-ax" text-anchor="middle">🏗️</text>';
      }
      // hit target: full column
      g += '<rect x="' + (padL + i * slot) + '" y="0" width="' + slot + '" height="' + H + '" fill="transparent" class="cf-hit" data-cf-ym="' + m.ym + '" tabindex="0" role="button" aria-label="' + esc(ymLabel(m.ym) + ': ' + MH.money(m.total)) + '"/>';
    });
    g += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(0) + '" y2="' + y(0) + '" class="cf-base"/>';
    return '<svg class="cf-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="תזרים הוצאות נלוות לפי חודש" dir="ltr">'
      + '<defs><pattern id="cfHatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="' + C_EST + '"/><line x1="0" y1="0" x2="0" y2="5" stroke="#fff" stroke-width="1.6" stroke-opacity=".75"/></pattern></defs>'
      + g + '</svg>';
  }

  function detail(M) {
    const m = M.months.find(x => x.ym === ui.sel) || M.months.find(x => x.total > 0 || x.events.length) || M.months[0];
    if (!m) return '';
    let h = '<div class="cf-det"><div class="cf-det-h"><b>' + esc(ymLabel(m.ym)) + '</b><span>' + esc(MH.money(m.total)) + '</span></div>';
    if (m.total) h += '<div class="cf-det-s">מתוזמן ' + esc(MH.money(m.sched)) + ' · הערכה לפי שלב ' + esc(MH.money(m.est)) + '</div>';
    m.events.forEach(e => { h += '<div class="cf-ev">' + esc(e.icon) + ' ' + esc(e.title) + ' <b>' + esc(MH.money(e.amount)) + '</b><small>עד ' + esc(MH.date(e.date)) + (e.extra ? ' · + הצמדה צפויה עד מועד התשלום כ-' + esc(MH.money(e.extra)) : '') + (e.loan ? '' : ' · ממומן בעיקר במשכנתא') + '</small></div>'; });
    const top = m.items.slice(0, 6);
    top.forEach(i => {
      h += '<div class="cf-it"><span class="cf-dot ' + (i.kind === 'sched' ? 's' : 'e') + '" aria-hidden="true"></span><span class="mh-grow">' + esc(i.desc)
        + '<small>' + (i.kind === 'sched' ? (i.late ? '⚠️ תאריך עבר (' + esc(MH.date(i.payDate)) + ')' : '📅 ' + esc(MH.date(i.payDate))) : '≈ ' + esc(i.why)) + '</small></span><b>' + esc(MH.money(i.amount)) + '</b></div>';
    });
    if (m.items.length > top.length) h += '<div class="cf-det-s">+ עוד ' + (m.items.length - top.length) + ' פריטים</div>';
    if (!m.total && !m.events.length) h += '<div class="cf-det-s">אין תשלומים צפויים בחודש זה</div>';
    return h + '</div>';
  }

  function table(M) {
    const rows = M.months.filter(m => m.total || m.events.length).map(m => '<tr><td>' + esc(ymShort(m.ym)) + '</td><td>' + esc(MH.money(m.sched)) + '</td><td>' + esc(MH.money(m.est)) + '</td><td><b>' + esc(MH.money(m.total)) + '</b>'
      + (m.events.length ? '<br><small>' + m.events.map(e => esc(e.icon + ' ' + MH.moneyK(e.amount))).join(' ') + '</small>' : '') + '</td></tr>').join('');
    return '<table class="cf-tbl"><thead><tr><th>חודש</th><th>מתוזמן</th><th>הערכה</th><th>סה"כ</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function section() {
    injectCss();
    const M = model();
    if (!M.loaded) return '';
    if (ui.sel && !M.months.some(x => x.ym === ui.sel)) ui.sel = null;
    const peak = M.peak && M.peak.total > 0 ? M.peak : null;
    let h = '<section class="mh-card cf" data-sec="cashflow"><div class="mh-card-title"><span>💸 תזרים צפוי — הוצאות נלוות</span><small>עד ' + esc(ymShort(M.end)) + '</small></div>';
    h += '<div class="cf-stats">'
      + '<div><span>3 חודשים קרובים</span><b>' + esc(MH.moneyK(M.next3)) + '</b></div>'
      + '<div><span>12 חודשים</span><b>' + esc(MH.moneyK(M.next12)) + '</b></div>'
      + '<div><span>חודש השיא' + (peak ? ' · ' + esc(ymShort(peak.ym)) : '') + '</span><b>' + (peak ? esc(MH.moneyK(peak.total)) : '—') + '</b></div></div>';
    h += '<div class="cf-legend"><span><i class="s"></i>מתוזמן (יש תאריך)</span><span><i class="e"></i>הערכה לפי שלב</span><span>🔑 מסירה · 🏗️ תשלום לקבלן</span></div>';
    h += ui.table ? table(M) : chart(M) + detail(M);
    h += '<div class="cf-foot"><button class="ds-link cf-btn" data-cf-table="1">' + (ui.table ? '📊 גרף' : '📋 טבלה') + '</button>';
    if (M.mortgageFinanced > 0) h += '<div class="mh-sub" style="margin-top:6px">🏦 ' + esc(MH.money(M.mortgageFinanced)) + ' בקטגוריה ' + esc(M.mortgageCats.join(', ')) + ' לא נכללים בתזרים — ישולמו במסירה וימומנו במשכנתא.</div>';
    if (M.unscheduled) h += '<button class="ds-link cf-btn" data-go="home">' + M.unscheduled + ' פריטים בלי תאריך (' + esc(MH.moneyK(M.estTotal)) + ') — הוספת תאריכים תשפר את התחזית ›</button>';
    h += '</div>';
    if (M.overdue) h += '<div class="cf-warn">⚠️ ' + M.overdue + ' פריטים עם תאריך תשלום שעבר ועדיין לא שולמו במלואם — הוצגו בחודש הנוכחי.</div>';
    return h + '</section>';
  }

  // interactions (delegated; the dashboard re-renders the whole page)
  function rerender() { if (window.DASH_API) DASH_API.render(); }
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-cf-ym],[data-cf-table]'); if (!t) return;
    if (t.dataset.cfTable) { ui.table = !ui.table; rerender(); return; }
    ui.sel = t.getAttribute('data-cf-ym'); rerender();
    const d = document.querySelector('.cf-det'); if (d && d.scrollIntoView) d.scrollIntoView({ block: 'nearest' });
  });
  document.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-cf-ym]')) { e.preventDefault(); ui.sel = e.target.getAttribute('data-cf-ym'); rerender(); }
  });
  let hoverT = null;
  document.addEventListener('mouseover', e => {
    const t = e.target.closest && e.target.closest('[data-cf-ym]'); if (!t || window.matchMedia('(hover: none)').matches) return;
    const ym = t.getAttribute('data-cf-ym'); if (ym === ui.sel) return;
    clearTimeout(hoverT); hoverT = setTimeout(() => { ui.sel = ym; rerender(); }, 60);
  });

  function injectCss() {
    if (document.getElementById('cashflow-css')) return;
    const st = document.createElement('style'); st.id = 'cashflow-css';
    st.textContent = `
.cf-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px}
.cf-stats>div{background:var(--bg);border-radius:10px;padding:8px 10px}
.cf-stats span{display:block;font-size:.66rem;color:var(--muted)}
.cf-stats b{font-size:1rem;font-weight:900;font-variant-numeric:tabular-nums}
.cf-stats small{font-size:.64rem;color:var(--muted);margin-inline-start:4px}
.cf-legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:.66rem;color:var(--muted);margin-bottom:4px}
.cf-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-inline-end:4px;vertical-align:-1px}
.cf-legend i.s{background:${C_SCHED}}
.cf-legend i.e{background:repeating-linear-gradient(45deg,${C_EST} 0 3px,#cfe2fd 3px 5px)}
.cf-svg{width:100%;height:auto;display:block;touch-action:manipulation}
.cf-grid{stroke:#e5e7eb;stroke-width:1}
.cf-base{stroke:#9ca3af;stroke-width:1}
.cf-ax{font-size:8.5px;fill:#6b7280;font-family:Heebo,sans-serif;font-variant-numeric:tabular-nums}
.cf-deliv{stroke:#1a1a2e;stroke-width:1.2;stroke-dasharray:3 3}
.cf-deliv-t{fill:#1a1a2e;font-weight:700}
.cf-sel{fill:#eff6ff}
.cf-hit{cursor:pointer;outline:none}
.cf-hit:focus-visible{stroke:#2563eb;stroke-width:1.5}
.cf-det{background:var(--bg);border-radius:10px;padding:10px 12px;margin-top:6px}
.cf-det-h{display:flex;justify-content:space-between;font-size:.85rem}
.cf-det-h span{font-weight:900;font-variant-numeric:tabular-nums}
.cf-det-s{font-size:.7rem;color:var(--muted);margin-top:3px}
.cf-ev{font-size:.74rem;margin-top:6px;padding:6px 8px;background:#fff;border-radius:8px;border-inline-start:3px solid #1a1a2e}
.cf-ev small{display:block;color:var(--muted);font-size:.66rem;margin-top:2px}
.cf-it{display:flex;align-items:center;gap:8px;font-size:.76rem;padding:6px 0;border-top:1px solid var(--border)}
.cf-it:first-of-type{border-top:none}
.cf-it small{display:block;font-size:.64rem;color:var(--muted)}
.cf-it b{font-variant-numeric:tabular-nums;white-space:nowrap}
.cf-dot{width:9px;height:9px;border-radius:2px;flex-shrink:0}
.cf-dot.s{background:${C_SCHED}}.cf-dot.e{background:repeating-linear-gradient(45deg,${C_EST} 0 3px,#cfe2fd 3px 5px)}
.cf-foot{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.cf-btn{min-height:36px;text-align:start}
.cf-warn{font-size:.7rem;color:#92400e;background:#fffbeb;border-radius:8px;padding:6px 8px;margin-top:6px}
.cf-tbl{width:100%;border-collapse:collapse;font-size:.74rem;font-variant-numeric:tabular-nums}
.cf-tbl th{font-size:.66rem;color:var(--muted);font-weight:700;text-align:start;padding:4px}
.cf-tbl td{padding:6px 4px;border-top:1px solid var(--border)}
.cf-tbl small{color:var(--muted)}
`;
    document.head.appendChild(st);
  }

  window.CASHFLOW_API = { model, section };
})();
