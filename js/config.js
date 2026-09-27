// ═══════════════════════════════════════════════════════════════
// הגדרות Firebase + משתמשים מורשים
// ═══════════════════════════════════════════════════════════════
// ה-apiKey של אפליקציית Web אינו סוד — הוא מזהה את הפרויקט.
// מה שמגן על הנתונים הם ה-Rules ב-Firebase (database.rules.json).

window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyD4b7eFfPSNCNo2r3qHt37eJ0JEhi8p9KQ",
  authDomain: "maman-house.firebaseapp.com",
  databaseURL: "https://maman-house-default-rtdb.firebaseio.com",
  projectId: "maman-house",
  storageBucket: "maman-house.firebasestorage.app",
  messagingSenderId: "758287504199",
  appId: "1:758287504199:web:03418a5bcd70f54113b262"
};

// מייל (באותיות קטנות) → שם שיוצג באפליקציה
window.ALLOWED_USERS = {
  "idanma3164@gmail.com": "עידן",
  "shanis4020@gmail.com": "שני",
};

window.APP_VERSION = "2.1.1";
