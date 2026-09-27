// ═══════════════════════════════════════════════════════════════
// docs.js — תיעוד מסמכים (page id: docs, root: #docs-root)
// Data: docs/{pushKey} = {title, cat, status, date, expiry, link, path, owner,
//        notes, required, relatedTaskId(task.id string), relatedPayment, createdAt, updatedAt, updatedBy}
// Public: window.DOCS_API (see bottom)
// ═══════════════════════════════════════════════════════════════
(function () {
  'use strict';
  const MH = window.MH;
  const PATH = 'docs';

  const CATS = ['חוזה ונספחים', 'תשלומים וקבלות', 'משכנתא ובנק', 'שינויי דיירים ותוכניות', 'ביטוח', 'מסירה ובדק בית', 'ספקים והצעות מחיר', 'אחר'];
  const CAT_EMOJI = { 'חוזה ונספחים': '📜', 'תשלומים וקבלות': '🧾', 'משכנתא ובנק': '🏦', 'שינויי דיירים ותוכניות': '📐', 'ביטוח': '🛡️', 'מסירה ובדק בית': '🔑', 'ספקים והצעות מחיר': '🤝', 'אחר': '📎' };
  const STATUSES = ['חסר', 'ממתין', 'התקבל', 'נחתם'];
  const STATUS_RANK = { 'חסר': 0, 'ממתין': 1, 'התקבל': 2, 'נחתם': 2 };
  const STATUS_CLS = { 'חסר': 'red', 'ממתין': 'yellow', 'התקבל': 'green', 'נחתם': 'green' };
  const OWNERS = ['עידן', 'שני', 'שניכם'];
  const EXPIRY_WARN_DAYS = 60;

  // ── state ──
  let docs = null;        // raw object from DB (null until loaded / when empty)
  let loaded = false;
  let seeding = false;
  const ui = { q: '', status: 'all', cat: '', open: {} };

  // ── CSS ──
  function injectCss() {
    if (document.getElementById('docs-css')) return;
    const st = document.createElement('style'); st.id = 'docs-css';
    st.textContent = `
#docs-root{overflow-x:hidden}
.dc-sum{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.dc-sum button{flex:1 1 0;min-width:0;border:1.5px solid var(--border);background:var(--card);border-radius:12px;padding:7px 4px;font-family:inherit;cursor:pointer;box-shadow:var(--shadow);text-align:center}
.dc-sum b{display:block;font-size:1rem;font-weight:900;color:var(--ink);font-variant-numeric:tabular-nums}
.dc-sum span{display:block;font-size:.62rem;color:var(--muted);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dc-sum button.dc-miss{border-color:#fecaca;background:var(--red-50)}
.dc-sum button.dc-miss b,.dc-sum button.dc-miss span{color:#b91c1c}
.dc-sum button.on{border-color:var(--accent)}
.dc-filters{background:var(--card);border-radius:14px;padding:10px 12px;margin-bottom:12px;box-shadow:var(--shadow)}
.dc-search{width:100%;border:1.5px solid var(--border);border-radius:10px;padding:9px 12px;font-family:inherit;font-size:.85rem;color:var(--ink);outline:none;background:var(--bg);margin-bottom:8px}
.dc-search:focus{border-color:var(--accent);background:#fff}
.dc-filters .mh-seg{margin-bottom:8px}
.dc-cats{display:flex;gap:6px;overflow-x:auto;padding-bottom:2px;scrollbar-width:none}
.dc-cats::-webkit-scrollbar{display:none}
.dc-cats .chip{flex-shrink:0}
.dc-row{display:flex;align-items:flex-start;gap:9px;padding:11px 14px;border-top:1px solid var(--border);cursor:pointer}
.dc-row:active{background:var(--soft)}
.dc-row .mh-badge{margin-top:2px;flex-shrink:0;min-width:40px;text-align:center}
.dc-info{flex:1;min-width:0}
.dc-title{font-size:.84rem;font-weight:700;line-height:1.35;word-break:break-word}
.dc-sub{font-size:.68rem;color:var(--muted);margin-top:3px;display:flex;flex-wrap:wrap;gap:4px 6px;align-items:center}
.dc-path{font-size:.64rem;color:#9ca3af;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dc-acts{display:flex;gap:2px;flex-shrink:0;align-items:center}
.dc-acts a{text-decoration:none}
.dc-task{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dc-req{color:var(--red);font-weight:700}
.dc-cnt-miss{color:var(--red);font-weight:700}
.dc-hint{font-size:.66rem;color:var(--muted);margin-top:-6px;margin-bottom:10px}
.dc-chk{display:flex;align-items:center;gap:8px;font-size:.85rem;font-weight:600;color:var(--ink)!important;cursor:pointer}
`;
    document.head.appendChild(st);
  }

  // ── helpers ──
  const esc = s => MH.esc(s);
  const tasks = () => (typeof TASKS !== 'undefined' && Array.isArray(TASKS)) ? TASKS : [];
  function taskById(id) { return id ? tasks().find(t => t && t.id === id) || null : null; }
  // resolve a doc's linked task: relatedTaskId (stable) -> legacy numeric relatedTask (display fallback only)
  function taskOf(d) {
    if (!d) return null;
    if (d.relatedTaskId) return taskById(d.relatedTaskId);
    const n = d.relatedTask;
    if (n !== null && n !== undefined && n !== '' && !isNaN(n)) return tasks()[Number(n)] || null;
    return null;
  }
  function forTask(taskId) { return taskId ? list().filter(d => d.relatedTaskId === taskId).sort(sortDocs) : []; }
  function list() {
    if (!docs || typeof docs !== 'object') return [];
    return Object.keys(docs).filter(k => docs[k] && typeof docs[k] === 'object').map(k => Object.assign({ key: k }, docs[k]));
  }
  function get(key) { return key && docs && docs[key] ? Object.assign({ key }, docs[key]) : null; }
  function sortDocs(a, b) {
    const r = (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3); if (r) return r;
    const da = a.date || '9999', db = b.date || '9999'; if (da !== db) return da < db ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  }
  function catOf(d) { return CATS.includes(d.cat) ? d.cat : 'אחר'; }
  function safeLink(u) { return typeof u === 'string' && /^https?:\/\/\S+$/i.test(u.trim()); }
  function isMissingRequired(d) { return !!d.required && d.status === 'חסר'; }
  function expiryInfo(d) {
    if (!d.expiry) return null;
    const n = MH.daysUntil(d.expiry);
    if (n === null || isNaN(n)) return null;
    if (n < 0) return { cls: 'red', text: 'פג תוקף', days: n };
    if (n <= EXPIRY_WARN_DAYS) return { cls: 'yellow', text: n === 0 ? 'פג היום' : 'פג בעוד ' + n + ' ימים', days: n };
    return null;
  }
  function missingRequired() { return list().filter(isMissingRequired).sort(sortDocs); }
  function expiringSoon(days) {
    const lim = days == null ? EXPIRY_WARN_DAYS : Number(days);
    return list().filter(d => d.expiry && d.status !== 'חסר')
      .map(d => Object.assign(d, { daysLeft: MH.daysUntil(d.expiry) }))
      .filter(d => d.daysLeft !== null && !isNaN(d.daysLeft) && d.daysLeft <= lim)
      .sort((a, b) => a.daysLeft - b.daysLeft);
  }

  // ── seed: at most once ever — guarded by meta/seeded/docs flag (transaction) AND docs==null ──
  function buildSeed() {
    const now = Date.now(), by = MH.me || 'seed';
    const C = 'חוזה מכר ונספחים חתומים/', P = 'תשלומים לקבלן/';
    const base = { link: '', expiry: '', notes: '' }; // no task links in seed (task ids may not exist yet)
    const rows = [
      // contract & annexes — signed 2025-03-24
      { title: 'חוזה מכר – חלק 1 (סרוק)', path: C + '00003927-1.Pdf' },
      { title: 'חוזה מכר – גוף החוזה (38 עמ\')', path: C + '00003927-2.pdf' },
      { title: 'מפרט טכני חתום', path: C + 'מפרט חתום.pdf' },
      { title: 'נספח ב\'2 – עמלת ערבות חוק מכר', path: C + 'נספח בנק חתום.pdf', notes: 'עמלת ערבות 0.65% לשנה — משולמת ע"י החברה' },
      { title: 'נספח ג\' – נספח תשלומים', path: C + 'נספח תשלומים חתום.pdf', notes: 'מחיר ₪1,790,000 כולל מע"מ: 330K / 700K / 760K' },
      { title: 'נספח סבסוד הלוואה (בנק הפועלים)', path: C + 'סבסוד הלוואה חתום נכון.pdf', notes: 'עד ₪700,000, עד 30 חודשים ממשיכה — החברה משלמת ריבית והצמדה' },
      { title: 'תוספת בעניין המפרט', path: C + 'תוספת בעניין המפרט חתום.pdf' },
      { title: 'תוספת משפטית (חתומה ומאומתת)', path: C + 'תוספת משפטית חתום ומאומת.pdf' },
      { title: 'תכנית מכר חתומה', path: C + 'תכנית מכר חתומה.pdf' },
    ].map(r => Object.assign({}, base, { cat: 'חוזה ונספחים', status: 'נחתם', date: '2025-03-24', owner: 'שניכם', required: true }, r));
    const inv = [
      ['18304', '2025-04-02', '₪330,000', 'תשלום 1'],
      ['18673', '2025-06-11', '₪700,000', 'תשלום 2'],
      ['19513', '2025-12-25', '₪65,000', 'מקדמה על תשלום 3'],
      ['19915', '2026-03-11', '₪52,500', 'מקדמה על תשלום 3'],
    ].map(([no, date, amt, lbl]) => Object.assign({}, base, {
      title: 'חשבונית מס ' + no + ' — ' + amt + ' (' + lbl + ')', cat: 'תשלומים וקבלות', status: 'התקבל',
      date, owner: 'עידן', required: true, path: P, notes: 'רכישת נכס',
    }));
    const other = [
      { title: 'תוכנית שינויי דיירים – מהדורה 2 (אדריכלות, אינסטלציה, חשמל, ספרינקלרים)', cat: 'שינויי דיירים ותוכניות', status: 'נחתם', date: '2026-01-11', owner: 'שניכם', path: 'חתום- מהדורה 2.pdf' },
      { title: 'תוכנית מטבח – בניין 6 דירה 24', cat: 'שינויי דיירים ותוכניות', status: 'התקבל', owner: 'שניכם', path: 'תוכנית מטבח- בניין 6 דירה 24.pdf' },
      { title: 'מפרט מיזוג אוויר', cat: 'ספקים והצעות מחיר', status: 'התקבל', owner: 'עידן', path: 'מפרט_מיזוג_ממן.docx' },
      { title: 'חישובי מיזוג (עומסים)', cat: 'ספקים והצעות מחיר', status: 'התקבל', owner: 'עידן', path: 'חישובי_מיזוג_ממן.xlsx' },
    ].map(r => Object.assign({}, base, { date: '', required: false }, r));
    const missing = [
      { title: 'ערבות בנקאית לפי חוק המכר', cat: 'תשלומים וקבלות', owner: 'עידן', notes: 'לדרוש ערבות על כל תשלום: חשבוניות 18304, 18673, 19513, 19915' },
      { title: 'אישור עקרוני למשכנתא', cat: 'משכנתא ובנק', owner: 'שניכם' },
      { title: 'פוליסת ביטוח דירה/מבנה', cat: 'ביטוח', owner: 'עידן' },
      { title: 'פרוטוקול מסירה', cat: 'מסירה ובדק בית', owner: 'שניכם' },
      { title: 'דו"ח בדק בית', cat: 'מסירה ובדק בית', owner: 'שניכם' },
      { title: 'טופס 4', cat: 'מסירה ובדק בית', owner: 'שניכם' },
    ].map(r => Object.assign({}, base, { status: 'חסר', date: '', path: '', required: true }, r));

    const out = {};
    const ref = MH.db.ref(PATH);
    rows.concat(inv, other, missing).forEach(d => {
      const k = ref.push().key; // local key generation only (no write)
      const o = MH.clean(Object.assign(d, { createdAt: now, updatedAt: now, updatedBy: by }));
      Object.keys(o).forEach(f => { if (o[f] === null) delete o[f]; }); // RTDB doesn't store nulls
      out[k] = o;
    });
    return out;
  }
  const FLAG = 'meta/seeded/docs';
  let seedTried = false;
  function seedIfEmpty() {
    if (seeding) return Promise.resolve({ committed: false });
    seeding = true;
    const done = r => { seeding = false; if (!docs) MH.refreshIfShown('docs'); return r; };
    return MH.db.ref(FLAG).transaction(cur => (cur === true ? undefined : true)) // claim the one-time seed
      .then(res => {
        if (!res || res.committed === false) return { committed: false };
        return MH.db.ref(PATH).once('value').then(snap => {
          if (snap.val() !== null) return { committed: false, flagged: true }; // data exists: only mark as seeded
          const seed = buildSeed(), upd = {};
          Object.keys(seed).forEach(k => { upd[PATH + '/' + k] = seed[k]; });
          return MH.db.ref().update(upd).then(() => ({ committed: true }));
        });
      })
      .then(done, err => { console.error('[docs] seed failed', err); return done({ committed: false }); });
  }

  // ── subscribe ──
  MH.db.ref(PATH).on('value', snap => {
    docs = snap.val();
    loaded = true;
    if (!seedTried) { seedTried = true; seedIfEmpty(); } // once per session; the flag makes it once ever
    MH.emit('docs');
    MH.refreshIfShown('docs');
  });

  // ── render ──
  function filtered() {
    const q = ui.q.trim().toLowerCase();
    return list().filter(d => {
      if (ui.status === 'inhand') { if (d.status !== 'התקבל' && d.status !== 'נחתם') return false; }
      else if (ui.status !== 'all' && d.status !== ui.status) return false;
      if (ui.cat && catOf(d) !== ui.cat) return false;
      if (q && !((d.title || '') + ' ' + (d.notes || '') + ' ' + (d.path || '')).toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function rowHtml(d) {
    const ex = expiryInfo(d);
    const sub = [];
    if (d.date) sub.push('<span>📅 ' + esc(MH.date(d.date)) + '</span>');
    if (d.owner) sub.push('<span>👤 ' + esc(MH.ownerName(d.owner)) + '</span>');
    const tk = taskOf(d);
    if (tk && tk.desc) sub.push('<span class="dc-task">✅ ' + esc(tk.desc) + '</span>');
    if (isMissingRequired(d)) sub.push('<span class="dc-req">מסמך חובה</span>');
    if (ex) sub.push('<span class="mh-badge ' + ex.cls + '">' + esc(ex.text) + '</span>');
    const link = safeLink(d.link)
      ? '<a class="icon-btn" data-dc="link" href="' + esc(d.link.trim()) + '" target="_blank" rel="noopener noreferrer" title="פתח קישור">🔗</a>' : '';
    return '<div class="dc-row" data-key="' + esc(d.key) + '">'
      + '<span class="mh-badge ' + (STATUS_CLS[d.status] || '') + '">' + esc(d.status || '—') + '</span>'
      + '<div class="dc-info"><div class="dc-title">' + esc(d.title || '(ללא שם)') + '</div>'
      + (sub.length ? '<div class="dc-sub">' + sub.join('') + '</div>' : '')
      + (d.path ? '<div class="dc-path" title="' + esc(d.path) + '">📂 ' + pathHtml(d.path) + '</div>' : '')
      + '</div>'
      + '<div class="dc-acts">' + link + '<button class="icon-btn" data-dc="edit" title="עריכה">✏️</button></div>'
      + '</div>';
  }

  // Mixed Hebrew/Latin paths: isolate each segment (and the extension) so bidi doesn't scramble them
  function pathHtml(p) {
    return String(p).split('/').map(seg => seg ? '<bdi dir="auto">' + esc(seg) + '</bdi>' : '').join('/');
  }

  function listHtml() {
    const items = filtered();
    if (!items.length) return '<div class="mh-card mh-empty">' + (list().length ? 'אין מסמכים שתואמים לסינון' : 'אין עדיין מסמכים — הוסיפו עם ＋ מסמך') + '</div>';
    const filtering = !!(ui.q.trim() || ui.status !== 'all' || ui.cat);
    const groups = {};
    items.forEach(d => (groups[catOf(d)] = groups[catOf(d)] || []).push(d));
    return CATS.filter(c => groups[c]).map(c => {
      const arr = groups[c].sort(sortDocs);
      const open = filtering || ui.open[c] !== false;
      const miss = arr.filter(d => d.status === 'חסר').length;
      const ok = arr.filter(d => d.status === 'התקבל' || d.status === 'נחתם').length;
      return '<div class="cat-card" data-cat="' + esc(c) + '">'
        + '<div class="cat-header" data-dc="toggle" style="border-bottom-color:' + (open ? 'var(--border)' : 'transparent') + '">'
        + '<div class="cat-left"><span class="cat-emoji">' + (CAT_EMOJI[c] || '📎') + '</span>'
        + '<div class="cat-info"><div class="cat-name">' + esc(c) + '</div>'
        + '<div class="cat-badge">' + arr.length + ' מסמכים · ' + ok + ' בידינו' + (miss ? ' · <span class="dc-cnt-miss">' + miss + ' חסרים</span>' : '') + '</div></div></div>'
        + '<span class="cat-toggle' + (open ? ' open' : '') + '">▼</span></div>'
        + '<div class="cat-body' + (open ? ' open' : '') + '">' + arr.map(rowHtml).join('') + '</div></div>';
    }).join('');
  }

  function render() {
    injectCss();
    const root = document.getElementById('docs-root');
    if (!root) return;
    if (!loaded || (docs === null && seeding)) {
      root.innerHTML = '<div class="loading"><div class="spinner"></div><div>טוען מסמכים...</div></div>';
      return;
    }
    const all = list();
    const inHand = all.filter(d => d.status === 'התקבל' || d.status === 'נחתם').length;
    const pending = all.filter(d => d.status === 'ממתין').length;
    const missReq = all.filter(isMissingRequired).length;
    const focused = document.activeElement && document.activeElement.id === 'dc-search';
    const caret = focused ? document.activeElement.selectionStart : null;
    const present = CATS.filter(c => all.some(d => catOf(d) === c));
    const seg = [['all', 'הכל']].concat(STATUSES.map(s => [s, s]));

    root.innerHTML = '<div class="mh-h1"><span>📁 מסמכים</span><button class="mh-btn" data-dc="add">＋ מסמך</button></div>'
      + '<div class="dc-sum">'
      + '<button data-dc="sum" data-st="all" class="' + (ui.status === 'all' ? 'on' : '') + '"><b>' + all.length + '</b><span>סה"כ</span></button>'
      + '<button data-dc="sum" data-st="inhand" class="' + (ui.status === 'inhand' ? 'on' : '') + '"><b>' + inHand + '</b><span>נחתם/התקבל</span></button>'
      + '<button data-dc="sum" data-st="ממתין" class="' + (ui.status === 'ממתין' ? 'on' : '') + '"><b>' + pending + '</b><span>ממתין</span></button>'
      + '<button data-dc="sum" data-st="חסר" class="dc-miss' + (ui.status === 'חסר' ? ' on' : '') + '"><b>' + missReq + '</b><span>חסר (' + missReq + ')</span></button>'
      + '</div>'
      + '<div class="dc-filters">'
      + '<input type="search" id="dc-search" class="dc-search" placeholder="🔍 חיפוש לפי שם או הערות..." value="' + esc(ui.q) + '">'
      + '<div class="mh-seg" id="dc-seg">' + seg.map(([v, l]) => '<button data-dc="status" data-st="' + esc(v) + '" class="' + (ui.status === v ? 'on' : '') + '">' + esc(l) + '</button>').join('') + '</div>'
      + '<div class="dc-cats" id="dc-cats"><span class="chip' + (!ui.cat ? ' active' : '') + '" data-dc="cat" data-cat="">הכל</span>'
      + present.map(c => '<span class="chip' + (ui.cat === c ? ' active' : '') + '" data-dc="cat" data-cat="' + esc(c) + '">' + (CAT_EMOJI[c] || '') + ' ' + esc(c) + '</span>').join('')
      + '</div></div>'
      + '<div id="dc-list">' + listHtml() + '</div>';

    if (focused) { const s = document.getElementById('dc-search'); s.focus(); try { s.setSelectionRange(caret, caret); } catch (e) {} }
  }

  function renderList() { const el = document.getElementById('dc-list'); if (el) el.innerHTML = listHtml(); }

  // ── events (delegated, bound once) ──
  function bind() {
    const root = document.getElementById('docs-root');
    if (!root || root.__dcBound) return;
    root.__dcBound = true;
    root.addEventListener('input', e => { if (e.target.id === 'dc-search') { ui.q = e.target.value; renderList(); } });
    root.addEventListener('click', e => {
      const t = e.target.closest('[data-dc]');
      const row = e.target.closest('.dc-row');
      const act = t ? t.getAttribute('data-dc') : null;
      if (act === 'link') return; // anchor opens in new tab
      if (act === 'add') return openEditor(null);
      if (act === 'status' || act === 'sum') {
        let st = t.getAttribute('data-st');
        if (act === 'sum' && ui.status === st && st !== 'all') st = 'all';
        ui.status = st; return render();
      }
      if (act === 'cat') { ui.cat = t.getAttribute('data-cat') || ''; return render(); }
      if (act === 'toggle') {
        const c = t.closest('.cat-card').getAttribute('data-cat');
        const body = t.parentNode.querySelector('.cat-body');
        const open = !body.classList.contains('open');
        ui.open[c] = open;
        body.classList.toggle('open', open);
        t.querySelector('.cat-toggle').classList.toggle('open', open);
        t.style.borderBottomColor = open ? 'var(--border)' : 'transparent';
        return;
      }
      if (row) return openEditor(row.getAttribute('data-key'));
    });
  }

  // ── editor ──
  function opt(v, label, sel) { return '<option value="' + esc(v) + '"' + (sel ? ' selected' : '') + '>' + esc(label) + '</option>'; }

  // openEditor(key|null, presets?, onSaved?(key))
  function openEditor(key, presets, onSaved) {
    const existing = key ? get(key) : null;
    if (key && !existing) { MH.toast('⚠️ המסמך לא נמצא (אולי נמחק)'); return; }
    const d = Object.assign({ title: '', cat: 'אחר', status: 'התקבל', date: existing ? '' : MH.todayISO(), expiry: '', owner: MH.me || 'שניכם', link: '', path: '', required: false, relatedTaskId: '', notes: '' },
      existing || {}, existing ? {} : (presets || {}));
    const owner = MH.ownerName(d.owner);
    const curTask = taskOf(d);
    const rt = curTask && curTask.id ? curTask.id : '';
    const taskOpts = opt('', '— ללא —', rt === '') + tasks().map((t, i) => (t && t.id) ? opt(t.id, (i + 1) + '. ' + (t.desc || ''), rt === t.id) : '').join('');
    const html = ''
      + '<div class="form-group"><label>שם המסמך *</label><input name="title" id="dc-f-title" value="' + esc(d.title) + '" placeholder="למשל: אישור עקרוני למשכנתא"></div>'
      + '<div class="form-row-2">'
      + '<div class="form-group"><label>קטגוריה</label><select name="cat">' + CATS.map(c => opt(c, (CAT_EMOJI[c] || '') + ' ' + c, catOf(d) === c)).join('') + '</select></div>'
      + '<div class="form-group"><label>סטטוס</label><select name="status">' + STATUSES.map(s => opt(s, s, d.status === s)).join('') + '</select></div>'
      + '</div><div class="form-row-2">'
      + '<div class="form-group"><label>תאריך</label><input type="date" name="date" value="' + esc(d.date || '') + '"></div>'
      + '<div class="form-group"><label>תוקף עד</label><input type="date" name="expiry" value="' + esc(d.expiry || '') + '"></div>'
      + '</div>'
      + '<div class="form-group"><label>אחראי</label><select name="owner">' + OWNERS.map(o => opt(o, o, owner === o)).join('') + (owner && !OWNERS.includes(owner) ? opt(owner, owner, true) : '') + '</select></div>'
      + '<div class="form-group"><label>קישור Google Drive</label><input type="url" name="link" id="dc-f-link" dir="ltr" value="' + esc(d.link || '') + '" placeholder="https://drive.google.com/..."></div>'
      + '<div class="form-group"><label>נתיב בתיקייה המקומית</label><input name="path" dir="auto" value="' + esc(d.path || '') + '" placeholder="חוזה מכר ונספחים חתומים/..."></div>'
      + '<div class="form-group"><label class="dc-chk"><input type="checkbox" name="required"' + (d.required ? ' checked' : '') + '> מסמך חובה</label></div>'
      + '<div class="form-group"><label>משימה קשורה</label><select name="relatedTaskId">' + taskOpts + '</select></div>'
      + '<div class="form-group"><label>הערות</label><textarea name="notes">' + esc(d.notes || '') + '</textarea></div>';

    MH.sheet({
      title: existing ? '✏️ עריכת מסמך' : '📄 מסמך חדש',
      html,
      onSave: async sh => {
        const v = MH.formValues(sh);
        if (!v.title) { MH.toast('⚠️ חובה למלא שם מסמך'); sh.querySelector('#dc-f-title').focus(); return false; }
        if (v.link && !safeLink(v.link)) { MH.toast('⚠️ הקישור חייב להתחיל ב-http'); return false; }
        const out = {
          title: v.title, cat: CATS.includes(v.cat) ? v.cat : 'אחר', status: STATUSES.includes(v.status) ? v.status : 'התקבל',
          date: v.date || '', expiry: v.expiry || '', owner: v.owner || '', link: v.link || '', path: v.path || '',
          required: !!v.required, relatedTaskId: v.relatedTaskId || null, notes: v.notes || '',
        };
        try {
          let k = key;
          if (existing) {
            // legacy numeric link: drop it once it was resolvable (shown in the select) — the select is now the truth
            if (existing.relatedTask !== undefined && (out.relatedTaskId || rt)) out.relatedTask = null;
            const r = await MH.keyed.update(PATH + '/' + key, out);
            if (r && r.committed === false) return; // deleted elsewhere — keyed.update already toasted
          }
          else {
            const add = Object.assign({}, out);
            if (presets && presets.relatedPayment) add.relatedPayment = presets.relatedPayment;
            delete add.relatedTask;
            Object.keys(add).forEach(f => { if (add[f] === null) delete add[f]; });
            k = await MH.keyed.add(PATH, add);
          }
          MH.toast(existing ? '✓ המסמך עודכן' : '✓ המסמך נוסף');
          if (typeof onSaved === 'function') { try { onSaved(k); } catch (e) { console.error(e); } }
        } catch (e) { return false; }
      },
      danger: existing ? {
        label: '🗑️ מחק מסמך',
        onClick: async () => {
          if (!await MH.confirm('למחוק את המסמך "' + (existing.title || '') + '"?')) return false;
          try { await MH.keyed.remove(PATH + '/' + key); MH.toast('🗑️ המסמך נמחק'); } catch (e) { return false; }
        },
      } : null,
    });
  }

  function optionsHtml(selectedKey) {
    const all = list();
    let h = opt('', '— ללא מסמך —', !selectedKey);
    CATS.forEach(c => {
      const arr = all.filter(d => catOf(d) === c).sort(sortDocs);
      if (!arr.length) return;
      h += '<optgroup label="' + esc((CAT_EMOJI[c] || '') + ' ' + c) + '">'
        + arr.map(d => opt(d.key, (d.status === 'חסר' ? '⚠️ ' : '') + (d.title || ''), d.key === selectedKey)).join('') + '</optgroup>';
    });
    return h;
  }

  MH.registerPage('docs', { render() { bind(); render(); } });
  MH.on('ready', bind);
  MH.on('tasks', () => MH.refreshIfShown('docs')); // task names / ids (ensureIds) resolve later

  window.DOCS_API = {
    CATS: CATS.slice(), STATUSES: STATUSES.slice(), CAT_EMOJI: Object.assign({}, CAT_EMOJI),
    list: () => list().sort(sortDocs),
    get,
    missingRequired,
    forTask,          // docs whose relatedTaskId === taskId
    taskOf,           // resolve linked task object (by id; legacy index fallback)
    expiringSoon,
    openEditor,
    optionsHtml,
    seedIfEmpty,
    loaded: () => loaded,
  };
})();
