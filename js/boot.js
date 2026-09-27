// ═══════════════════════════════════════════════════════════════
// boot.js — אתחול Firebase, שער התחברות, ו-API משותף (window.MH)
// ═══════════════════════════════════════════════════════════════
(function () {
  'use strict';
  const cfg = window.FIREBASE_CONFIG || {};
  firebase.initializeApp(cfg);
  const db = firebase.database();

  // ── API משותף לכל המודולים ─────────────────────────────────────
  const listeners = {};
  const pageHooks = {};
  const MH = {
    db,
    user: null,          // {email, name} אחרי התחברות, או null במצב פתוח
    me: null,            // 'עידן' | 'שני' | null
    authEnabled: false,
    version: window.APP_VERSION || '',

    // אירועים בין מודולים: MH.on('tasks', fn) / MH.emit('tasks')
    on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); },
    emit(evt, data) {
      (listeners[evt] || []).concat(listeners['*'] || []).forEach(fn => {
        try { fn(data, evt); } catch (e) { console.error('[MH] listener error', evt, e); }
      });
    },

    // רישום עמוד: MH.registerPage('docs', {render(){...}})
    registerPage(id, hooks) { pageHooks[id] = hooks; },
    pageShown(id) {
      const h = pageHooks[id];
      if (h && h.render) { try { h.render(); } catch (e) { console.error('[MH] render', id, e); } }
    },
    currentPage() {
      const p = document.querySelector('.page.active');
      return p ? p.id.replace('page-', '') : '';
    },
    // מרנדר מחדש רק אם העמוד פתוח כרגע
    refreshIfShown(id) { if (MH.currentPage() === id) MH.pageShown(id); },

    // ── כתיבה בטוחה למערכים (expenses / tasks / kitchen) ─────────────
    // כל פריט מקבל מזהה קבוע `id`. כל כתיבה היא טרנזקציה שמאתרת את הפריט לפי id
    // (או לפי תוכן זהה אם עדיין אין id) ומעדכנת *רק את השדות שהשתנו*.
    // כך עריכה/מחיקה אף פעם לא נוחתת על פריט אחר, גם אם המכשיר השני הוסיף/מחק בינתיים,
    // ושינוי של שדה אחד לא דורס שינוי של המשתמש השני בשדה אחר.
    clean(obj) { return JSON.parse(JSON.stringify(obj, (k, v) => (k.startsWith && k.startsWith('_')) ? undefined : v)); },
    snap(obj) { return obj == null ? null : MH.clean(obj); },
    stamp() { return { updatedAt: Date.now(), updatedBy: MH.me || (MH.user && MH.user.email) || '' }; },
    canon(v) { // stringify יציב (סדר מפתחות קבוע) להשוואת תוכן
      if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
      if (Array.isArray(v)) return '[' + v.map(MH.canon).join(',') + ']';
      return '{' + Object.keys(v).filter(k => v[k] !== undefined && !k.startsWith('_')).sort().map(k => JSON.stringify(k) + ':' + MH.canon(v[k])).join(',') + '}';
    },
    uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); },
    toArr(v) { // מערך/אובייקט/חורים → מערך נקי של פריטים (אינדקס תצוגה בלבד)
      const vals = Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.keys(v).sort((a, b) => (+a) - (+b) || (a < b ? -1 : 1)).map(k => v[k]) : []);
      return vals.filter(x => x && typeof x === 'object');
    },
    _pristine: {},
    // מחזיק עותק "נקי" של מה שהשרת שלח לאחרונה, לכל נתיב מעקב
    track(path) {
      if (MH._pristine[path] !== undefined) return;
      MH._pristine[path] = [];
      db.ref(path).on('value', s => { MH._pristine[path] = MH.toArr(s.val()).map(MH.snap); });
    },
    _pathOf(ref) { try { return decodeURIComponent(new URL(ref.toString()).pathname).replace(/^\/+|\/+$/g, ''); } catch (e) { return ''; } },
    debug() { try { if (localStorage.getItem('mh.debug')) console.log.apply(console, arguments); } catch (e) {} },
    pristineAt(ref, idx) { const a = MH._pristine[MH._pathOf(ref)]; return a && a[idx] ? MH.snap(a[idx]) : null; },
    _findKey(cur, before) {
      if (!cur || typeof cur !== 'object' || !before) return null;
      const keys = Array.isArray(cur) ? cur.map((_, i) => i) : Object.keys(cur);
      if (before.id) { const k = keys.find(k => cur[k] && cur[k].id === before.id); return k === undefined ? null : k; }
      const want = MH.canon(before);
      const hits = keys.filter(k => cur[k] && MH.canon(cur[k]) === want);
      return hits.length ? hits[0] : null;
    },
    _diff(before, after) {
      const d = {}; const empty = v => v === undefined || v === null || v === '';
      new Set([...Object.keys(before || {}), ...Object.keys(after || {})]).forEach(k => {
        if (k.startsWith('_') || k === 'id') return;
        const a = before ? before[k] : undefined, b = after ? after[k] : undefined;
        if (empty(a) && empty(b)) return;
        if (MH.canon(a) !== MH.canon(b)) d[k] = b === undefined ? null : MH.snap(b);
      });
      return d;
    },
    _conflict(msg) { MH.toast(msg || '⚠️ הפריט שונה או נמחק במכשיר אחר — השינוי לא נשמר. בדוק ונסה שוב.'); try { setSyncStatus('connected', 'מסונכרן ✓'); } catch (e) {} },
    // עדכון פריט: before = איך הפריט נראה כשהמשתמש התחיל לערוך; after = הגרסה החדשה
    itemUpdate(ref, before, after) {
      const diff = MH._diff(before, after);
      if (!Object.keys(diff).length) return Promise.resolve({ committed: true, noop: true });
      MH.syncing();
      return ref.transaction(cur => {
        const k = MH._findKey(cur, before);
        if (k === null) return; // abort — הפריט לא נמצא
        const item = cur[k];
        Object.keys(diff).forEach(f => { if (diff[f] === null) delete item[f]; else item[f] = diff[f]; });
        return cur;
      }).then(res => { if (res && res.committed === false) MH._conflict(); else MH.saved(); return res; }, MH.saveError);
    },
    itemRemove(ref, before) {
      MH.syncing();
      return ref.transaction(cur => {
        const k = MH._findKey(cur, before);
        if (k === null) return;
        if (Array.isArray(cur)) cur.splice(k, 1); else delete cur[k];
        return cur;
      }).then(res => { if (res && res.committed === false) MH._conflict('⚠️ הפריט כבר נמחק או שונה במכשיר אחר.'); else MH.saved(); return res; }, MH.saveError);
    },
    itemAdd(ref, obj) {
      MH.syncing();
      const item = MH.clean(obj); if (!item.id) item.id = MH.uid();
      return ref.transaction(cur => {
        if (Array.isArray(cur)) { cur.push(item); return cur; }
        if (cur && typeof cur === 'object') { const n = Object.keys(cur).reduce((m, k) => Math.max(m, isNaN(+k) ? -1 : +k), -1) + 1; cur[n] = item; return cur; }
        return [item];
      }).then(res => { MH.saved(); return item.id; }, MH.saveError);
    },
    // תאימות לאחור: arrSet(ref, idx, newObj, before?) — אם לא נמסר before, נלקח המצב האחרון מהשרת באותו אינדקס
    arrSet(ref, idx, obj, before) { return MH.itemUpdate(ref, before || MH.pristineAt(ref, idx) || obj, obj); },
    arrPush(ref, obj) { return MH.itemAdd(ref, obj); },
    arrRemove(ref, idx, expected) { return MH.itemRemove(ref, expected || MH.pristineAt(ref, idx)); },
    // מיגרציה חד-פעמית: מוסיף id לפריטים שאין להם (טרנזקציה — לא כותבת אם אין מה להוסיף)
    ensureIds(path) {
      return db.ref(path).transaction(cur => {
        if (!cur || typeof cur !== 'object') return;
        let changed = false;
        Object.keys(cur).forEach(k => { const it = cur[k]; if (it && typeof it === 'object' && !it.id) { it.id = MH.uid(); changed = true; } });
        return changed ? cur : undefined;
      }).catch(e => console.warn('[MH] ensureIds', path, e));
    },
    // אוספים מבוססי מפתח (docs/, contract/payments/ ...)
    keyed: {
      add(path, obj) { MH.syncing(); const r = db.ref(path).push(); return r.set(Object.assign(MH.clean(obj), MH.stamp(), { createdAt: Date.now() })).then(() => { MH.saved(); return r.key; }, MH.saveError); },
      // מעדכן רק אם הרשומה עדיין קיימת (לא "מחייה" רשומה שנמחקה במכשיר אחר)
      update(path, obj) {
        MH.syncing();
        const patch = Object.assign(MH.clean(obj), MH.stamp());
        return db.ref(path).transaction(cur => {
          if (cur === null || typeof cur !== 'object') return;
          Object.keys(patch).forEach(k => { if (patch[k] === null) delete cur[k]; else cur[k] = patch[k]; });
          return cur;
        }).then(res => { if (res && res.committed === false) MH._conflict('⚠️ הרשומה נמחקה במכשיר אחר — השינוי לא נשמר.'); else MH.saved(); return res; }, MH.saveError);
      },
      remove(path) { MH.syncing(); return db.ref(path).remove().then(MH.saved, MH.saveError); },
    },

    syncing() { try { setSyncStatus('syncing', 'שומר...'); } catch (e) {} },
    saved() { try { setSyncStatus('connected', 'נשמר ✓'); setTimeout(() => setSyncStatus('connected', 'מסונכרן ✓'), 1800); } catch (e) {} },
    saveError(err) {
      console.error('[MH] save failed', err);
      try { setSyncStatus('', 'שגיאת שמירה'); } catch (e) {}
      MH.toast('❌ שמירה נכשלה: ' + (err && err.message || err));
      throw err;
    },

    // ── עזרי תצוגה ──
    esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
    money(n, opts) {
      if (n === null || n === undefined || n === '' || isNaN(n)) return '—';
      const v = Math.round(Number(n));
      return (v < 0 ? '−' : '') + '₪' + Math.abs(v).toLocaleString('he-IL');
    },
    moneyK(n) { // ₪1.15M / ₪642K
      if (n === null || n === undefined || isNaN(n)) return '—';
      const a = Math.abs(n), s = n < 0 ? '−' : '';
      if (a >= 1e6) return s + '₪' + (a / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M';
      if (a >= 1e4) { const k = a / 1e3; return s + '₪' + (k >= 100 && Math.abs(k - Math.round(k)) < 0.05 ? Math.round(k) : (Math.round(k * 10) / 10)) + 'K'; }
      return s + '₪' + Math.round(a).toLocaleString('he-IL');
    },
    date(iso) { if (!iso) return ''; const [y, m, d] = String(iso).slice(0, 10).split('-'); return d && m && y ? `${d}/${m}/${y}` : String(iso); },
    today() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; },
    todayISO() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); },
    daysUntil(iso) { if (!iso) return null; const t = new Date(String(iso).slice(0, 10) + 'T00:00:00'); return Math.round((t - MH.today()) / 864e5); },
    ownerName(o) { return o === 'אשתי' ? 'שני' : (o || ''); },
    toast(msg) { try { showToast(msg); } catch (e) { console.log(msg); } },

    // ── Bottom sheet גנרי ──
    // MH.sheet({title, html, saveLabel, onSave(el) → false כדי להשאיר פתוח, onMount(el), danger:{label,onClick}})
    sheet(opts) {
      MH.closeSheet();
      const ov = document.createElement('div'); ov.className = 'sheet-overlay open'; ov.id = 'mhSheetOverlay';
      const sh = document.createElement('div'); sh.className = 'sheet'; sh.id = 'mhSheet';
      sh.innerHTML = '<div class="sheet-handle"></div><div class="sheet-title">' + MH.esc(opts.title || '') + '</div>'
        + '<div class="mh-sheet-body">' + (opts.html || '') + '</div>'
        + (opts.onSave ? '<button class="btn-save" data-mh="save">' + MH.esc(opts.saveLabel || 'שמור') + '</button>' : '')
        + (opts.danger ? '<button class="btn-cancel" style="color:var(--red);border-color:#fecaca" data-mh="danger">' + MH.esc(opts.danger.label) + '</button>' : '')
        + '<button class="btn-cancel" data-mh="close">' + (opts.onSave ? 'ביטול' : 'סגור') + '</button>';
      document.body.appendChild(ov); document.body.appendChild(sh);
      ov.addEventListener('click', MH.closeSheet);
      sh.addEventListener('click', async e => {
        const b = e.target.closest('[data-mh]'); if (!b) return;
        const a = b.getAttribute('data-mh');
        if (a === 'close') MH.closeSheet();
        if (a === 'save') { const r = await opts.onSave(sh); if (r !== false) MH.closeSheet(); }
        if (a === 'danger') { const r = await opts.danger.onClick(sh); if (r !== false) MH.closeSheet(); }
      });
      requestAnimationFrame(() => sh.classList.add('open'));
      if (opts.onMount) opts.onMount(sh);
      return sh;
    },
    closeSheet() { ['mhSheetOverlay', 'mhSheet'].forEach(id => { const el = document.getElementById(id); if (el) el.remove(); }); },
    confirm(text, okLabel) {
      return new Promise(res => {
        const ov = document.createElement('div'); ov.className = 'confirm-overlay open';
        ov.innerHTML = '<div class="confirm-box"><h3>אישור</h3><p>' + MH.esc(text) + '</p>'
          + '<button class="confirm-del">' + MH.esc(okLabel || 'כן, מחק') + '</button><button class="confirm-cancel">ביטול</button></div>';
        document.body.appendChild(ov);
        ov.addEventListener('click', e => {
          if (e.target.classList.contains('confirm-del')) { ov.remove(); res(true); }
          else if (e.target.classList.contains('confirm-cancel') || e.target === ov) { ov.remove(); res(false); }
        });
      });
    },
    // קריאת ערכי טופס מתוך sheet לפי name
    formValues(root) {
      const out = {};
      root.querySelectorAll('[name]').forEach(el => {
        const n = el.getAttribute('name');
        if (el.type === 'checkbox') out[n] = el.checked;
        else if (el.type === 'number') out[n] = el.value === '' ? null : Number(el.value);
        else out[n] = el.value.trim();
      });
      return out;
    },
  };
  // גיבוי מלא של כל ה-Database לקובץ JSON
  MH.exportBackup = function () {
    db.ref().once('value').then(snap => {
      const blob = new Blob([JSON.stringify(snap.val(), null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'maman_house_backup_' + MH.todayISO() + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      MH.toast('📥 הגיבוי ירד למכשיר');
    }).catch(e => MH.toast('❌ ' + e.message));
  };
  window.MH = MH;

  // ── טעינת קבצי האפליקציה לפי הסדר ──────────────────────────────
  const APP_SCRIPTS = ['js/legacy.js', 'js/tasks-plus.js', 'js/docs.js', 'js/payments.js', 'js/dashboard.js'];
  function loadScripts(list, done) {
    if (!list.length) return done();
    const s = document.createElement('script');
    s.src = list[0] + '?v=' + encodeURIComponent(MH.version);
    s.onload = () => loadScripts(list.slice(1), done);
    s.onerror = () => { console.error('[boot] failed to load', list[0]); loadScripts(list.slice(1), done); };
    document.body.appendChild(s);
  }
  let started = false;
  function startApp() {
    if (started) return; started = true;
    document.getElementById('loginScreen').style.display = 'none';
    const ai = document.getElementById('acctInfo');
    if (ai) ai.textContent = MH.user ? ('מחובר/ת כ-' + MH.me + ' (' + MH.user.email + ')') : 'מצב פתוח — ללא התחברות (ראה js/config.js)';
    const so = document.getElementById('signOutBtn'); if (so && MH.user) so.style.display = '';
    // עותק "נקי" של המערכים הישנים + מיגרציית מזהים קבועים (חד-פעמית, בטרנזקציה)
    ['expenses', 'tasks', 'kitchen'].forEach(p => { MH.track(p); MH.ensureIds(p); });
    loadScripts(APP_SCRIPTS, () => {
      MH.emit('ready');
      const h = (location.hash || '').slice(1);
      if (h && document.getElementById('page-' + h) && typeof switchPage === 'function') switchPage(h);
      else MH.pageShown(MH.currentPage());
    });
  }

  // ── שער התחברות ─────────────────────────────────────────────
  const allowed = window.ALLOWED_USERS || {};
  const login = document.getElementById('loginScreen');
  const loginMsg = document.getElementById('loginMsg');
  MH.authEnabled = !!(cfg.apiKey && Object.keys(allowed).length);

  if (!MH.authEnabled) { startApp(); return; }
  // ההתחברות מוגדרת אבל ספריית ה-Auth לא נטענה (רשת/חוסם פרסומות) → לא נכנסים במצב פתוח
  if (!firebase.auth) {
    login.style.display = 'flex';
    loginMsg.textContent = '⚠️ רכיב ההתחברות לא נטען. בדוק חיבור לאינטרנט / חוסם פרסומות ורענן את הדף.';
    document.getElementById('loginBtn').onclick = () => location.reload();
    return;
  }

  login.style.display = 'flex';
  const auth = firebase.auth();
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  document.getElementById('loginBtn').addEventListener('click', () => {
    loginMsg.textContent = '';
    // חלון קופץ בלבד: signInWithRedirect לא אמין ב-iOS Safari כשהאתר ב-github.io וה-authDomain ב-firebaseapp.com
    auth.signInWithPopup(provider).catch(err => {
      if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') return;
      if (err.code === 'auth/popup-blocked') loginMsg.textContent = '⚠️ הדפדפן חסם את חלון ההתחברות. אפשר חלונות קופצים לאתר ולחץ שוב.';
      else if (err.code === 'auth/unauthorized-domain') loginMsg.textContent = '⚠️ הדומיין של האתר לא מאושר ב-Firebase (Authentication → Settings → Authorized domains).';
      else loginMsg.textContent = 'שגיאת התחברות: ' + err.message;
    });
  });
  auth.onAuthStateChanged(u => {
    if (!u) { login.style.display = 'flex'; return; }
    const email = (u.email || '').toLowerCase();
    if (!allowed[email]) {
      loginMsg.textContent = '⛔ המייל ' + email + ' לא מורשה לאפליקציה הזו.';
      auth.signOut();
      return;
    }
    MH.user = { email, name: u.displayName || '' };
    MH.me = allowed[email];
    const chip = document.getElementById('userChip');
    if (chip) { chip.textContent = '👤 ' + MH.me; chip.style.display = ''; }
    startApp();
  });
  MH.signOut = () => auth.signOut().then(() => location.reload());
})();
