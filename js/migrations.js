// ═══════════════════════════════════════════════════════════════
// migrations.js — עדכוני נתונים חד-פעמיים (כל אחד מוגן בדגל meta/seeded/*)
// ═══════════════════════════════════════════════════════════════
(function () {
  'use strict';
  const db = MH.db;
  // מריץ fn פעם אחת בלבד בכל המכשירים: תופס את הדגל בטרנזקציה ורק אם הצליח — מבצע
  function once(flag, fn) {
    return db.ref('meta/seeded/' + flag).transaction(cur => (cur ? undefined : true))
      .then(res => { if (res && res.committed) return fn(); })
      .catch(e => console.warn('[migrations]', flag, e));
  }

  // v2.3 — רישום "חשבון שינויים מס' 1" במסמכים (אם עוד לא קיים)
  function docTenantChanges1() {
    return db.ref('docs').once('value').then(s => {
      const docs = s.val() || {};
      if (Object.values(docs).some(d => d && /חשבון שינויים מס'? ?1/.test(d.title || ''))) return;
      return MH.keyed.add('docs', {
        title: "חשבון שינויים מס' 1 — ₪8,707 (ישולם במסירה, צמוד למדד)",
        cat: 'שינויי דיירים ותוכניות', status: 'נחתם', date: '2026-01-07', expiry: '',
        link: '', path: "תשלומים לקבלן/חשבון שינויים מס' 1- בניין 6 דירה 24.pdf", owner: 'שניכם',
        notes: '₪8,020 − 8% הנחה = ₪7,378.40 + מע"מ = ₪8,707. צמוד למדד תשומות הבנייה הידוע ביום התשלום. תשלום מלא — תנאי לקבלת החזקה. מזכה את החברה בדחיית מסירה עד 03/03/2028 (63 ימי עבודה). מתוכנן למימון במשכנתא.',
        required: true,
      });
    });
  }

  // רץ רק אחרי שה-seed הראשוני של המסמכים בוצע (אחרת הוספה מוקדמת הייתה "מבטלת" אותו)
  let done = false;
  function tryRun() {
    if (done) return;
    db.ref('meta/seeded/docs').once('value').then(s => {
      if (s.val() !== true || done) return;
      done = true;
      once('docTenantChanges1', docTenantChanges1);
    }).catch(() => {});
  }
  MH.on('ready', tryRun);
  MH.on('docs', tryRun);
})();
