// ═══════════════════════════════════════════════════════════════
// tasks-plus.js — שדרוג מודול המשימות (סטטוסים, סינון, תצוגת תאריכים, API)
// Loads right after legacy.js and overrides its global task functions.
// Relies on legacy globals: TASKS, refTasks, editingTaskIdx, PHASE_CONFIG,
// openTaskSheet, closeTaskSheet, askDeleteTask, showToast.
// ═══════════════════════════════════════════════════════════════
(function () {
  'use strict';
  if (typeof refTasks === 'undefined' || !window.MH) { console.error('[tasks-plus] legacy tasks module missing'); return; }

  // ── constants ───────────────────────────────────────────────
  const STATUS = {
    todo:    { label: 'לביצוע',        cls: '' },
    doing:   { label: 'בתהליך',        cls: 'blue' },
    waiting: { label: "ממתין לצד ג'",  cls: 'purple' },
    done:    { label: 'הושלם',         cls: 'green' },
  };
  const ORDER = ['todo', 'doing', 'waiting', 'done'];
  const OWNERS = ['עידן', 'שני', 'שניכם'];
  const PHASE_TARGET = { 1: 'הושלם 2025', 2: '2025–2026', 3: 'עד מסירה 31.12.2027', 4: 'אחרי מסירה 2028' };
  const PRI = { high: { l: '🔴 דחוף', c: 'badge-high', s: 0 }, med: { l: '🟡 בינוני', c: 'badge-med', s: 1 }, low: { l: '🟢 נמוך', c: 'badge-low', s: 2 } };
  const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  const LS_KEY = 'mh.tasks.ui';
  const esc = MH.esc;

  // ── UI state (persisted per device) ─────────────────────────
  const ui = { view: 'phase', owner: 'all', status: 'all', q: '' };
  let hadStored = false;
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (s && typeof s === 'object') {
      hadStored = true;
      if (s.view === 'phase' || s.view === 'date') ui.view = s.view;
      if (s.owner === 'all' || OWNERS.includes(s.owner)) ui.owner = s.owner;
      if (s.status === 'all' || s.status === 'open' || STATUS[s.status]) ui.status = s.status;
    }
  } catch (e) { /* storage unavailable */ }
  let meApplied = hadStored;
  function saveUi() { try { localStorage.setItem(LS_KEY, JSON.stringify({ view: ui.view, owner: ui.owner, status: ui.status })); } catch (e) {} }
  const groupOpen = {};          // user toggles: 'p1'..'p4', 'past' → bool
  const expanded = new Set();    // task idx with notes expanded

  // ── model helpers ───────────────────────────────────────────
  function statusOf(t) {
    if (!t) return 'todo';
    const s = STATUS[t.status] ? t.status : null;
    if (t.done) return 'done';                 // `done` is the source of truth for completion
    return s && s !== 'done' ? s : 'todo';
  }
  function decorate(t, i) {
    const statusKey = statusOf(t);
    const daysLeft = t.date ? MH.daysUntil(t.date) : null;
    return Object.assign({}, t, { idx: i, statusKey, daysLeft, overdue: statusKey !== 'done' && daysLeft !== null && daysLeft < 0 });
  }
  function all() { return (TASKS || []).map((t, i) => t ? decorate(t, i) : null).filter(Boolean); }
  function cmpTasks(a, b) {
    const ad = a.statusKey === 'done', bd = b.statusKey === 'done';
    if (ad !== bd) return ad ? 1 : -1;
    const da = a.date || '9999', db = b.date || '9999';
    if (da !== db) return da < db ? -1 : 1;
    return ((PRI[a.priority] || PRI.med).s) - ((PRI[b.priority] || PRI.med).s);
  }
  function withStatus(old, status) {
    const m = Object.assign({}, old, { status, done: status === 'done' }, MH.stamp());
    if (status === 'done') m.doneAt = old.doneAt && old.done ? old.doneAt : MH.todayISO();
    else delete m.doneAt;
    return m;
  }
  // All writes go through id-based transactions: `before` is the item as the user saw it.
  function updateTask(before, after) { return MH.itemUpdate(refTasks, before, after); }
  function quickStatus(idx, nextFn) {
    const before = MH.snap(TASKS[idx]); if (!before) return Promise.resolve();
    const next = nextFn(before);
    return updateTask(before, withStatus(before, next)).then(() => next);
  }

  function docsList() {
    try {
      if (window.DOCS_API && typeof window.DOCS_API.list === 'function') {
        const l = window.DOCS_API.list();
        return Array.isArray(l) ? l.filter(Boolean) : [];
      }
    } catch (e) { console.warn('[tasks-plus] DOCS_API.list failed', e); }
    return [];
  }
  const docKey = d => d.key || d.id || d._key || '';
  function docLinksTo(d, t) {
    if (d.relatedTaskId != null && d.relatedTaskId !== '') return !!t.id && d.relatedTaskId === t.id;
    return d.relatedTask != null && d.relatedTask !== '' && Number(d.relatedTask) === t.idx; // legacy fallback
  }
  function linkedDocs(t, docs) {
    const keys = new Set(Array.isArray(t.docKeys) ? t.docKeys : []);
    (docs || []).forEach(d => { if (docKey(d) && docLinksTo(d, t)) keys.add(docKey(d)); });
    return [...keys];
  }

  // ── text helpers ────────────────────────────────────────────
  function rel(d) {
    if (d === null || d === undefined) return '';
    if (d === 0) return 'היום';
    if (d === 1) return 'מחר';
    const a = Math.abs(d);
    let s;
    if (a === 1) s = 'יום';
    else if (a === 2) s = 'יומיים';
    else if (a <= 60) s = a + ' ימים';
    else { const m = Math.round(a / 30.44); s = m === 1 ? 'חודש' : m === 2 ? 'חודשיים' : m + ' חודשים'; }
    return (d < 0 ? 'באיחור ' : 'בעוד ') + s;
  }
  function statusBadge(t) {
    const s = STATUS[t.statusKey];
    return '<button type="button" class="tk-st" data-act="st" data-idx="' + t.idx + '" title="הקש לשינוי סטטוס"><span class="mh-badge ' + s.cls + '">' + s.label + '</span></button>';
  }
  function dateBadge(t) {
    if (!t.date) return '';
    const done = t.statusKey === 'done';
    const cls = t.overdue ? 'badge-overdue' : (!done && t.daysLeft <= 7 ? 'tk-soon' : 'badge-date');
    return '<span class="task-badge ' + cls + '">📅 ' + esc(MH.date(t.date)) + (done ? '' : ' · ' + rel(t.daysLeft)) + '</span>';
  }

  // ── filtering ───────────────────────────────────────────────
  function matches(t, f) {
    f = f || ui;
    if (f.owner && f.owner !== 'all' && MH.ownerName(t.owner) !== f.owner) return false;
    if (f.status === 'open' && t.statusKey === 'done') return false;
    if (f.status && STATUS[f.status] && t.statusKey !== f.status) return false;
    if (f.phase && Number(t.phase) !== Number(f.phase)) return false;
    const q = (f.q || '').trim().toLowerCase();
    if (q && !((t.desc || '') + ' ' + (t.notes || '')).toLowerCase().includes(q)) return false;
    return true;
  }
  const filterActive = () => ui.owner !== 'all' || ui.status !== 'all' || !!ui.q.trim();

  // ── CSS ─────────────────────────────────────────────────────
  function injectCss() {
    if (document.getElementById('tasks-plus-css')) return;
    const st = document.createElement('style'); st.id = 'tasks-plus-css';
    st.textContent = `
#tasks-dashboard.tk-tiles{display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-bottom:10px}
.tk-tile{background:var(--card);border-radius:12px;box-shadow:var(--shadow);padding:9px 6px 8px;text-align:center;cursor:pointer;border:none;font-family:inherit;color:var(--ink);min-width:0;border-top:3px solid var(--accent)}
.tk-tile.red{border-top-color:var(--red)}.tk-tile.yellow{border-top-color:var(--yellow)}.tk-tile.green{border-top-color:var(--green)}
.tk-tile-num{font-size:1.15rem;font-weight:900;font-variant-numeric:tabular-nums;line-height:1.1}
.tk-tile.red .tk-tile-num.hot{color:var(--red)}
.tk-tile-lbl{font-size:.64rem;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tk-tile .mh-meter{height:5px;margin-top:5px}
.tk-bar{background:var(--card);border-radius:14px;box-shadow:var(--shadow);padding:10px;margin-bottom:12px}
.tk-bar .mh-seg{margin-bottom:8px}
.tk-bar .mh-seg button{padding:6px 4px;font-size:.72rem}
.tk-row1{display:flex;gap:6px;margin-bottom:8px}
.tk-row1 input{flex:1;min-width:0;border:1.5px solid var(--border);border-radius:10px;padding:8px 10px;font-family:inherit;font-size:.85rem;color:var(--ink);outline:none;background:var(--bg)}
.tk-row1 input:focus{border-color:var(--accent);background:#fff}
.tk-chips{display:flex;gap:5px;overflow-x:auto;padding-bottom:2px;scrollbar-width:none}
.tk-chips::-webkit-scrollbar{display:none}
.tk-chips .chip{padding:4px 10px;font-size:.7rem;font-family:inherit}
.tk-count{font-size:.68rem;color:var(--muted);margin-top:6px}
.tk-st{border:none;background:none;font-family:inherit;cursor:pointer;min-height:32px;padding:0 2px;display:inline-flex;align-items:center}
.tk-st .mh-badge{line-height:1.4}
#page-tasks .task-chk{width:28px;height:28px;margin-top:0;font-size:.8rem;position:relative}
#page-tasks .task-chk::before{content:'';position:absolute;inset:-6px}
#page-tasks .task-actions .icon-btn,#page-tasks .tk-urg-row .icon-btn{min-width:34px;min-height:34px;padding:4px;display:inline-flex;align-items:center;justify-content:center}
#page-tasks .task-actions{gap:0}
.tk-ic{min-height:24px;position:relative}.tk-ic::before{content:'';position:absolute;inset:-5px 0}
.tk-st .mh-badge::after{content:' ⟲';opacity:.55}
.tk-soon{background:#fef3c7;color:#92400e}
.tk-ic{border:none;background:#f3f4f6;color:var(--muted);font-family:inherit;cursor:pointer;line-height:1.4}
.tk-ic.on{background:#dbeafe;color:#1d4ed8}
.tk-more{margin-top:6px;font-size:.74rem;color:var(--ink-2);background:var(--bg);border-radius:8px;padding:7px 9px;white-space:pre-wrap;line-height:1.5;word-break:break-word}
.tk-more .tk-doc{display:block;margin-top:3px;color:var(--accent);font-weight:600}
#tasks-container .task-row{align-items:flex-start}
#tasks-container .task-row.tk-done .task-info{opacity:.55}
.tk-grp{background:var(--card);border-radius:14px;box-shadow:var(--shadow);margin-bottom:10px;overflow:hidden}
.tk-grp-h{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px;font-weight:800;font-size:.85rem;cursor:pointer;border-bottom:3px solid var(--border)}
.tk-grp-h.red{border-bottom-color:var(--red);color:#b91c1c}.tk-grp-h.blue{border-bottom-color:var(--accent)}.tk-grp-h.muted{color:var(--muted)}
.tk-grp-h small{font-size:.68rem;font-weight:600;color:var(--muted)}
.tk-phase-flags{display:flex;gap:4px;margin-top:3px;flex-wrap:wrap}
.tk-urg{background:var(--card);border-radius:14px;box-shadow:var(--shadow);overflow:hidden}
.tk-urg-h{padding:10px 14px;border-bottom:3px solid var(--red);display:flex;align-items:center;justify-content:space-between;font-weight:800;font-size:.86rem}
.tk-urg-h small{font-size:.68rem;color:var(--muted);font-weight:600}
.tk-urg-row{display:flex;align-items:flex-start;gap:10px;padding:10px 14px;border-top:1px solid var(--border)}
.tk-rank{width:22px;height:22px;border-radius:50%;color:#fff;display:flex;align-items:center;justify-content:center;font-size:.72rem;font-weight:900;flex-shrink:0;margin-top:1px}
.tk-docs{max-height:190px;overflow-y:auto;border:1.5px solid var(--border);border-radius:10px;background:var(--bg);padding:4px 8px}
.tk-docs label{display:flex!important;align-items:center;gap:8px;padding:6px 0;margin:0!important;border-top:1px solid var(--border);font-size:.8rem!important;color:var(--ink)!important;font-weight:600;cursor:pointer}
.tk-docs label:first-child{border-top:none}
.tk-docs input{width:auto!important;flex-shrink:0}
.tk-docs small{color:var(--muted);font-weight:500;font-size:.66rem}
.tk-docs .mh-empty{padding:10px 4px}
`;
    document.head.appendChild(st);
  }

  // ── toolbar (built once, persists across renders) ───────────
  function ensureToolbar() {
    let bar = document.getElementById('tk-toolbar');
    if (bar) return bar;
    const cont = document.getElementById('tasks-container');
    if (!cont) return null;
    bar = document.createElement('div'); bar.id = 'tk-toolbar'; bar.className = 'tk-bar';
    cont.parentNode.insertBefore(bar, cont);
    bar.addEventListener('click', e => {
      const b = e.target.closest('[data-k]'); if (!b) return;
      const k = b.getAttribute('data-k'), v = b.getAttribute('data-v');
      if (k === 'add') { openNew(null); return; }
      ui[k] = v; saveUi(); renderTasks();
    });
    bar.addEventListener('input', e => {
      if (e.target.id === 'tk-q') { ui.q = e.target.value; renderList(); syncToolbar(); }
    });
    return bar;
  }
  function syncToolbar() {
    const bar = ensureToolbar(); if (!bar) return;
    if (!meApplied && MH.me && OWNERS.includes(MH.me)) { ui.owner = MH.me; meApplied = true; }
    const seg = (k, opts) => '<div class="mh-seg" role="tablist">' + opts.map(([v, l]) =>
      '<button type="button" data-k="' + k + '" data-v="' + esc(v) + '" class="' + (ui[k] === v ? 'on' : '') + '">' + esc(l) + '</button>').join('') + '</div>';
    const ownerOpts = [['all', 'הכל']].concat(OWNERS.map(o => [o, o + (MH.me === o ? ' (אני)' : '')]));
    const stOpts = [['all', 'הכל'], ['open', 'פתוחות']].concat(ORDER.map(s => [s, STATUS[s].label]));
    const chips = '<div class="tk-chips">' + stOpts.map(([v, l]) =>
      '<button type="button" class="chip' + (ui.status === v ? ' active' : '') + '" data-k="status" data-v="' + v + '">' + esc(l) + '</button>').join('') + '</div>';
    const q = document.getElementById('tk-q');
    if (!q) {
      bar.innerHTML = '<div class="tk-row1"><input type="search" id="tk-q" placeholder="🔍 חיפוש משימה או הערה..." autocomplete="off">'
        + '<button type="button" class="mh-btn" data-k="add">＋ משימה</button></div>'
        + '<div id="tk-bar-dyn"></div>';
      document.getElementById('tk-q').value = ui.q;
    }
    const n = all().filter(t => matches(t)).length;
    document.getElementById('tk-bar-dyn').innerHTML =
      seg('view', [['phase', '📂 לפי שלב'], ['date', '📅 לפי תאריך']])
      + seg('owner', ownerOpts) + chips
      + '<div class="tk-count">' + n + ' משימות מוצגות' + (filterActive() ? ' (מסונן)' : '') + '</div>';
  }

  // ── summary tiles + urgent block ────────────────────────────
  function renderSummary() {
    injectCss();
    const el = document.getElementById('tasks-dashboard'); if (!el) return;
    el.removeAttribute('style'); el.classList.add('tk-tiles');
    const L = all();
    const total = L.length, done = L.filter(t => t.statusKey === 'done').length;
    const open = total - done;
    const overdue = L.filter(t => t.overdue).length;
    const week = L.filter(t => t.statusKey !== 'done' && t.daysLeft !== null && t.daysLeft >= 0 && t.daysLeft <= 7).length;
    const pct = total ? Math.round(done / total * 100) : 0;
    el.innerHTML =
      '<button type="button" class="tk-tile" data-tile="open"><div class="tk-tile-num" id="tk-n-open">' + open + '</div><div class="tk-tile-lbl">פתוחות</div></button>'
      + '<button type="button" class="tk-tile red" data-tile="overdue"><div class="tk-tile-num' + (overdue ? ' hot' : '') + '" id="tk-n-overdue">' + overdue + '</div><div class="tk-tile-lbl">⚠️ באיחור</div></button>'
      + '<button type="button" class="tk-tile yellow" data-tile="week"><div class="tk-tile-num" id="tk-n-week">' + week + '</div><div class="tk-tile-lbl">השבוע</div></button>'
      + '<button type="button" class="tk-tile green" data-tile="done"><div class="tk-tile-num" id="tk-n-done">' + done + '/' + total + '</div><div class="tk-tile-lbl">הושלמו</div><div class="mh-meter"><i style="width:' + pct + '%"></i></div></button>';
    if (!el._tk) {
      el._tk = true;
      el.addEventListener('click', e => {
        const b = e.target.closest('[data-tile]'); if (!b) return;
        const k = b.getAttribute('data-tile');
        if (k === 'done') { ui.status = 'done'; }
        else { ui.status = 'open'; if (k !== 'open') ui.view = 'date'; }
        saveUi(); renderTasks();
        const bar = document.getElementById('tk-toolbar'); if (bar && bar.scrollIntoView) bar.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
    renderUrgent();
  }
  function urgentList(n) {
    return all().filter(t => t.statusKey !== 'done').sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      return cmpTasks(a, b);
    }).slice(0, n);
  }
  function renderUrgent() {
    const block = document.getElementById('urgent-tasks-block'); if (!block) return;
    const list = urgentList(3);
    if (!list.length) { block.innerHTML = ''; return; }
    const colors = ['#ef4444', '#f59e0b', '#3b82f6'];
    block.innerHTML = '<div class="tk-urg"><div class="tk-urg-h"><span>🔥 3 המשימות הדחופות</span><small>באיחור קודם, אחר כך הקרובות</small></div>'
      + list.map((t, r) => {
        const ph = PHASE_CONFIG[t.phase] || { emoji: '📋', color: '#6b7280' };
        return '<div class="tk-urg-row"><div class="tk-rank" style="background:' + colors[r] + '">' + (r + 1) + '</div>'
          + '<div class="mh-grow"><div class="task-name">' + esc(t.desc) + '</div><div class="task-meta">'
          + statusBadge(t) + dateBadge(t)
          + '<span class="task-badge badge-owner">👤 ' + esc(MH.ownerName(t.owner) || '—') + '</span>'
          + '<span class="task-badge" style="background:#f3f4f6;color:' + ph.color + '">' + ph.emoji + ' שלב ' + esc(t.phase) + '</span>'
          + '</div></div>'
          + '<button type="button" class="icon-btn" data-act="edit" data-idx="' + t.idx + '" aria-label="עריכה">✏️</button></div>';
      }).join('') + '</div>';
    if (!block._tk) { block._tk = true; block.addEventListener('click', onAction); }
  }

  // ── task row ────────────────────────────────────────────────
  function rowHtml(t, docs) {
    const done = t.statusKey === 'done';
    const pri = PRI[t.priority] || PRI.med;
    const dk = linkedDocs(t, docs);
    const hasMore = !!(t.notes || dk.length);
    const isOpen = expanded.has(t.id || 'i' + t.idx);
    let more = '';
    if (isOpen && hasMore) {
      const byKey = {}; docs.forEach(d => { byKey[docKey(d)] = d; });
      more = '<div class="tk-more">' + (t.notes ? esc(t.notes) : '')
        + dk.map(k => {
          const d = byKey[k];
          const title = d ? (d.title || k) : k;
          const href = d && d.link ? String(d.link) : '';
          return /^https?:\/\//i.test(href)
            ? '<a class="tk-doc" href="' + esc(href) + '" target="_blank" rel="noopener">📎 ' + esc(title) + '</a>'
            : '<span class="tk-doc">📎 ' + esc(title) + '</span>';
        }).join('') + '</div>';
    }
    return '<div class="task-row' + (done ? ' tk-done' : '') + '" data-idx="' + t.idx + '">'
      + '<div class="task-chk' + (done ? ' on' : '') + '" data-act="chk" data-idx="' + t.idx + '" role="checkbox" aria-checked="' + done + '">' + (done ? '✓' : '') + '</div>'
      + '<div class="task-info"><div class="task-name' + (done ? ' done' : '') + '">' + esc(t.desc) + '</div>'
      + '<div class="task-meta">' + statusBadge(t)
      + '<span class="task-badge ' + pri.c + '">' + pri.l + '</span>'
      + '<span class="task-badge badge-owner">' + esc(MH.ownerName(t.owner) || '—') + '</span>'
      + dateBadge(t)
      + (t.notes ? '<button type="button" class="task-badge tk-ic' + (isOpen ? ' on' : '') + '" data-act="more" data-idx="' + t.idx + '" aria-label="הערות">💬</button>' : '')
      + (dk.length ? '<button type="button" class="task-badge tk-ic' + (isOpen ? ' on' : '') + '" data-act="more" data-idx="' + t.idx + '" aria-label="מסמכים">📎 ' + dk.length + '</button>' : '')
      + '</div>' + more + '</div>'
      + '<div class="task-actions">'
      + (t.link && /^https?:\/\//i.test(t.link) ? '<a class="icon-btn" href="' + esc(t.link) + '" target="_blank" rel="noopener" style="text-decoration:none">🔗</a>' : '')
      + '<button type="button" class="icon-btn" data-act="edit" data-idx="' + t.idx + '" aria-label="עריכה">✏️</button>'
      + '<button type="button" class="icon-btn del" data-act="del" data-idx="' + t.idx + '" aria-label="מחיקה">🗑️</button>'
      + '</div></div>';
  }

  // ── list rendering ──────────────────────────────────────────
  function renderList() {
    const cont = document.getElementById('tasks-container'); if (!cont) return;
    if (!cont._tk) { cont._tk = true; cont.addEventListener('click', onAction); }
    const docs = docsList();
    const L = all();
    const F = L.filter(t => matches(t));
    let html = '';
    if (ui.view === 'date') html = dateView(F, docs);
    else html = phaseView(L, F, docs);
    if (!F.length && filterActive()) html = '<div class="mh-card mh-empty">אין משימות שמתאימות לסינון</div>' + (ui.view === 'phase' ? '' : html);
    cont.innerHTML = html;
  }

  function phaseView(L, F, docs) {
    const fa = filterActive();
    return [1, 2, 3, 4].map(p => {
      const cfg = PHASE_CONFIG[p] || { name: 'שלב ' + p, emoji: '📋', color: '#6b7280' };
      const allP = L.filter(t => Number(t.phase) === p);
      const shown = F.filter(t => Number(t.phase) === p).sort(cmpTasks);
      if (fa && !shown.length) return '';
      const done = allP.filter(t => t.statusKey === 'done').length;
      const pct = allP.length ? Math.round(done / allP.length * 100) : 0;
      const complete = allP.length > 0 && done === allP.length;
      const key = 'p' + p;
      const isOpen = key in groupOpen ? groupOpen[key] : (fa ? true : !complete);
      const od = allP.filter(t => t.overdue).length;
      const doing = allP.filter(t => t.statusKey === 'doing' || t.statusKey === 'waiting').length;
      const flags = (complete ? '<span class="mh-badge green">✓ הושלם</span>' : '')
        + (od ? '<span class="mh-badge red">' + od + ' באיחור</span>' : '')
        + (doing ? '<span class="mh-badge blue">' + doing + ' בתהליך/ממתין</span>' : '');
      return '<div class="task-phase-block" data-phase="' + p + '">'
        + '<div class="task-phase-header" data-act="grp" data-key="' + key + '" data-open="' + (isOpen ? 1 : 0) + '" style="border-bottom-color:' + cfg.color + '">'
        + '<div class="task-phase-left"><span class="task-phase-emoji">' + cfg.emoji + '</span><div class="task-phase-info">'
        + '<div class="task-phase-name" style="color:' + cfg.color + '">' + esc(cfg.name) + '</div>'
        + '<div class="task-phase-sub">יעד: ' + esc(PHASE_TARGET[p] || cfg.target || '') + '</div>'
        + (flags ? '<div class="tk-phase-flags">' + flags + '</div>' : '') + '</div></div>'
        + '<div class="task-phase-right"><div class="task-phase-pct" style="color:' + cfg.color + '">' + pct + '%</div>'
        + '<div class="task-phase-count">' + done + '/' + allP.length + '</div>'
        + '<div class="task-phase-pbar"><div class="task-phase-pbar-fill" style="width:' + pct + '%;background:' + cfg.color + '"></div></div></div>'
        + '<span class="task-phase-toggle' + (isOpen ? ' open' : '') + '">▾</span></div>'
        + '<div class="task-phase-body' + (isOpen ? ' open' : '') + '">'
        + shown.map(t => rowHtml(t, docs)).join('')
        + (fa && shown.length < allP.length ? '<div class="mh-sub" style="padding:6px 14px">' + (allP.length - shown.length) + ' משימות מוסתרות ע"י הסינון</div>' : '')
        + '<button type="button" class="task-add-btn" data-act="add" data-phase="' + p + '">＋ הוסף משימה לשלב ' + p + '</button>'
        + '</div></div>';
    }).join('');
  }

  function dateView(F, docs) {
    const now = MH.today();
    const curYM = now.getFullYear() * 12 + now.getMonth();
    const groups = {};
    const add = (k, meta, t) => { (groups[k] = groups[k] || Object.assign({ items: [] }, meta)).items.push(t); };
    F.forEach(t => {
      if (t.overdue) return add('0', { label: '⚠️ באיחור', cls: 'red', ord: -2 }, t);
      if (!t.date) return add('none', { label: 'ללא תאריך', cls: 'muted', ord: 1e7 }, t);
      const [y, m] = String(t.date).split('-').map(Number);
      const ym = y * 12 + (m - 1);
      if (ym < curYM) return add('past', { label: '✓ עבר', cls: 'muted', ord: 1e7 + 1, collapsed: true }, t);
      const label = ym === curYM ? 'החודש · ' + MONTHS[m - 1] : ym === curYM + 1 ? 'החודש הבא · ' + MONTHS[m - 1] : MONTHS[m - 1] + ' ' + y;
      add('m' + ym, { label, cls: ym <= curYM + 1 ? 'blue' : '', ord: ym }, t);
    });
    const keys = Object.keys(groups).sort((a, b) => groups[a].ord - groups[b].ord);
    if (!keys.length) return filterActive() ? '' : '<div class="mh-card mh-empty">אין משימות</div>';
    return keys.map(k => {
      const g = groups[k];
      const items = g.items.sort(k === 'past' ? (a, b) => (b.date || '').localeCompare(a.date || '') : cmpTasks);
      const openN = items.filter(t => t.statusKey !== 'done').length;
      const isOpen = k in groupOpen ? groupOpen[k] : !g.collapsed;
      return '<div class="tk-grp" data-group="' + k + '"><div class="tk-grp-h ' + g.cls + '" data-act="grp" data-key="' + k + '">'
        + '<span>' + esc(g.label) + '</span><small>' + (openN ? openN + ' פתוחות · ' : '') + items.length + ' סה"כ ' + (isOpen ? '▴' : '▾') + '</small></div>'
        + (isOpen ? items.map(t => rowHtml(t, docs)).join('') : '') + '</div>';
    }).join('');
  }

  // ── actions (event delegation) ──────────────────────────────
  function onAction(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.getAttribute('data-act');
    const idx = b.hasAttribute('data-idx') ? Number(b.getAttribute('data-idx')) : null;
    if (act === 'grp') {
      const k = b.getAttribute('data-key');
      groupOpen[k] = b.getAttribute('data-open') !== '1'; renderList(); return;
    }
    if (act === 'add') { openNew(Number(b.getAttribute('data-phase')) || null); return; }
    if (idx === null || !TASKS[idx]) return;
    e.stopPropagation();
    if (act === 'chk') {
      const willDone = statusOf(TASKS[idx]) !== 'done';
      b.classList.toggle('on', willDone); b.textContent = willDone ? '✓' : '';
      quickStatus(idx, cur => statusOf(cur) === 'done' ? (STATUS[cur.status] && cur.status !== 'done' ? cur.status : 'todo') : 'done');
    } else if (act === 'st') {
      quickStatus(idx, cur => ORDER[(ORDER.indexOf(statusOf(cur)) + 1) % ORDER.length])
        .then(next => { if (next) MH.toast('סטטוס: ' + STATUS[next].label); });
    } else if (act === 'more') {
      const ek = TASKS[idx].id || 'i' + idx;
      if (expanded.has(ek)) expanded.delete(ek); else expanded.add(ek);
      renderList();
    } else if (act === 'edit') openTaskSheet(idx);
    else if (act === 'del') askDeleteTask(idx);
  }

  // ── edit sheet extension ────────────────────────────────────
  function ensureSheetFields() {
    if (document.getElementById('tf-status')) return;
    const saveBtn = document.getElementById('taskSaveBtn'); if (!saveBtn) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = '<div class="form-group" id="tk-fg-status"><label>סטטוס</label><select id="tf-status">'
      + ORDER.map(s => '<option value="' + s + '">' + STATUS[s].label + '</option>').join('') + '</select></div>'
      + '<div class="form-group" id="tk-fg-docs"><label>📎 מסמכים מקושרים</label><div class="tk-docs" id="tf-docs"></div></div>';
    while (wrap.firstChild) saveBtn.parentNode.insertBefore(wrap.firstChild, saveBtn);
  }
  function fillDocs(selected) {
    const box = document.getElementById('tf-docs'); if (!box) return;
    const docs = docsList().slice().sort((a, b) => ((a.cat || '') + (a.title || '')).localeCompare((b.cat || '') + (b.title || ''), 'he'));
    const sel = new Set(selected || []);
    const known = new Set(docs.map(docKey));
    let html = docs.filter(d => docKey(d)).map(d => {
      const k = docKey(d);
      return '<label><input type="checkbox" class="tk-doc-cb" value="' + esc(k) + '"' + (sel.has(k) ? ' checked' : '') + '>'
        + '<span class="mh-grow">' + esc(d.title || k) + (d.cat ? ' <small>· ' + esc(d.cat) + '</small>' : '') + '</span>'
        + (d.status ? '<small>' + esc(d.status) + '</small>' : '') + '</label>';
    }).join('');
    // keep links to docs we can't see (module absent / not loaded yet)
    html += [...sel].filter(k => !known.has(k)).map(k =>
      '<label><input type="checkbox" class="tk-doc-cb" value="' + esc(k) + '" checked><span class="mh-grow">' + esc(k) + ' <small>· לא נמצא</small></span></label>').join('');
    box.innerHTML = html || '<div class="mh-empty">' + (window.DOCS_API ? 'אין מסמכים עדיין' : 'מודול המסמכים לא זמין') + '</div>';
  }
  const legacyOpenTaskSheet = window.openTaskSheet;
  let sheetSnap = null; // the task as it was when the sheet opened (id-based write target)
  window.openTaskSheet = function (idx) {
    injectCss(); ensureSheetFields();
    if (idx === undefined) idx = null;
    legacyOpenTaskSheet(idx);
    const t = idx !== null ? TASKS[idx] : null;
    sheetSnap = t ? MH.snap(t) : null;
    const s = document.getElementById('tf-status'); if (s) s.value = t ? statusOf(t) : 'todo';
    fillDocs(t && Array.isArray(t.docKeys) ? t.docKeys : []);
  };
  function openNew(phase) {
    window.openTaskSheet(null);
    if (phase) document.getElementById('tf-phase').value = String(phase);
    const o = document.getElementById('tf-owner');
    if (o && ui.owner !== 'all') o.value = ui.owner;
  }
  window.saveTask = function () {
    const $ = id => document.getElementById(id);
    const desc = $('tf-desc').value.trim();
    if (!desc) { MH.toast('⚠️ חובה להכניס תיאור'); return; }
    const status = ($('tf-status') && STATUS[$('tf-status').value]) ? $('tf-status').value : 'todo';
    const docKeys = [...document.querySelectorAll('#tf-docs .tk-doc-cb:checked')].map(c => c.value).filter(Boolean);
    const fields = {
      desc, phase: parseInt($('tf-phase').value, 10) || 3,
      date: $('tf-date').value, owner: $('tf-owner').value,
      priority: $('tf-priority').value, notes: $('tf-notes').value.trim(), link: $('tf-link').value.trim(),
      docKeys: docKeys.length ? docKeys : undefined,
    };
    const idx = editingTaskIdx;
    if (idx !== null && idx !== undefined) {
      const before = sheetSnap;
      if (!before) { MH.toast('⚠️ המשימה לא נמצאה — ייתכן שנמחקה במכשיר אחר'); closeTaskSheet(); return; }
      // don't rewrite legacy owner 'אשתי' → 'שני' unless the user actually changed it
      if (MH.ownerName(before.owner) === fields.owner) fields.owner = before.owner;
      // touch status/done/doneAt only if the user changed the status (so a concurrent status change isn't overwritten)
      const after = status !== statusOf(before) ? withStatus(Object.assign({}, before, fields), status) : Object.assign({}, before, fields, MH.stamp());
      if (!docKeys.length) delete after.docKeys;
      updateTask(before, after).then(r => { if (r && r.committed !== false) MH.toast('✏️ משימה עודכנה'); });
    } else {
      const task = withStatus(fields, status);
      if (!docKeys.length) delete task.docKeys;
      task.createdAt = Date.now();
      MH.itemAdd(refTasks, task);
      MH.toast('✅ משימה נוספה');
    }
    sheetSnap = null;
    closeTaskSheet();
  };

  // ── legacy overrides ────────────────────────────────────────
  window.renderTasksDashboard = renderSummary;
  window.renderUrgentTasks = renderUrgent;
  window.renderTasks = function () {
    injectCss();
    renderSummary();
    syncToolbar();
    renderList();
  };
  window.exportTasksExcel = function () {
    if (typeof XLSX === 'undefined') { MH.toast('⚠️ XLSX לא נטען'); return; }
    const wb = XLSX.utils.book_new();
    const phaseNames = { 1: 'שלב 1 — חתימה', 2: 'שלב 2 — בנייה', 3: 'שלב 3 — לפני מסירה', 4: 'שלב 4 — אחרי מסירה' };
    const priNames = { high: 'גבוהה', med: 'בינונית', low: 'נמוכה' };
    const L = all();
    const rows = [['שלב', 'תיאור', 'אחראי', 'עדיפות', 'תאריך יעד', 'סטטוס', 'ימים ליעד', 'הערות']];
    L.slice().sort((a, b) => (a.phase - b.phase) || cmpTasks(a, b)).forEach(t => rows.push([
      phaseNames[t.phase] || 'שלב ' + t.phase, t.desc || '', MH.ownerName(t.owner), priNames[t.priority] || t.priority || '',
      t.date || '', STATUS[t.statusKey].label, t.statusKey === 'done' || t.daysLeft === null ? '' : t.daysLeft, t.notes || '']));
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 22 }, { wch: 38 }, { wch: 10 }, { wch: 10 }, { wch: 13 }, { wch: 14 }, { wch: 10 }, { wch: 35 }];
    XLSX.utils.book_append_sheet(wb, ws, 'כל המשימות');
    const sum = [['שלב', 'סה"כ', 'לביצוע', 'בתהליך', "ממתין לצד ג'", 'הושלמו', '% השלמה']];
    [1, 2, 3, 4].forEach(p => {
      const pt = L.filter(t => Number(t.phase) === p);
      const c = s => pt.filter(t => t.statusKey === s).length;
      sum.push([phaseNames[p], pt.length, c('todo'), c('doing'), c('waiting'), c('done'), pt.length ? Math.round(c('done') / pt.length * 100) + '%' : '0%']);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sum), 'סיכום לפי שלב');
    const urg = [['דירוג', 'תיאור', 'שלב', 'אחראי', 'תאריך יעד', 'סטטוס', 'מצב']];
    urgentList(10).forEach((t, i) => urg.push([i + 1, t.desc, phaseNames[t.phase] || '', MH.ownerName(t.owner), t.date || '', STATUS[t.statusKey].label, rel(t.daysLeft)]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(urg), 'משימות דחופות');
    XLSX.writeFile(wb, 'משימות_דירה_' + MH.todayISO() + '.xlsx');
    MH.toast('📊 Excel יוצא בהצלחה!');
  };

  // ── public API ──────────────────────────────────────────────
  window.TASKS_API = {
    STATUS: Object.keys(STATUS).reduce((o, k) => (o[k] = STATUS[k].label, o), {}),
    statusOf,
    all,
    open(filter) { return all().filter(t => t.statusKey !== 'done' && matches(t, Object.assign({ owner: 'all', status: 'all', q: '' }, filter || {}))).sort(cmpTasks); },
    upcoming(days) {
      const n = days == null ? 30 : Number(days);
      return all().filter(t => t.statusKey !== 'done' && t.daysLeft !== null && t.daysLeft <= n)
        .sort((a, b) => (a.daysLeft - b.daysLeft) || cmpTasks(a, b));
    },
    overdue() { return all().filter(t => t.overdue).sort(cmpTasks); },
    byOwner() {
      const o = { 'עידן': 0, 'שני': 0, 'שניכם': 0 };
      all().forEach(t => { if (t.statusKey === 'done') return; const n = MH.ownerName(t.owner) || 'שניכם'; o[n] = (o[n] || 0) + 1; });
      return o;
    },
    statusCounts() {
      const o = { todo: 0, doing: 0, waiting: 0, done: 0 };
      all().forEach(t => { o[t.statusKey]++; });
      return o;
    },
    setStatus(idx, status) { if (!TASKS[idx] || !STATUS[status]) return Promise.reject(new Error('bad args')); return quickStatus(idx, () => status); },
    edit: idx => window.openTaskSheet(idx),
    add: phase => openNew(phase || null),
  };

  // docs may load after us — re-render so 📎 counts appear
  MH.on('docs', () => { if (MH.currentPage() === 'tasks') renderList(); });
  MH.on('ready', () => { if (MH.currentPage() === 'tasks') window.renderTasks(); });
})();
