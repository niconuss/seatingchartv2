// Firestore backs shared chart data so more than one person can access the same
// chart from their own device. No login system — the chart ID already in the URL
// is the shared secret, same as how the whole app worked before this existed.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
import { getFirestore, doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyAclAGH4gXJti0qePUs9KEIkne4i6QY_-E",
  authDomain: "seatingchartv2.firebaseapp.com",
  projectId: "seatingchartv2",
  storageBucket: "seatingchartv2.firebasestorage.app",
  messagingSenderId: "69278715489",
  appId: "1:69278715489:web:4d7d0fa3220d74389fe420",
};

const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);

export async function fetchChart(chartId) {
  const snap = await getDoc(doc(db, 'charts', chartId));
  return snap.exists() ? snap.data() : null;
}

export async function saveChart(chartId, state) {
  await setDoc(doc(db, 'charts', chartId), state);
}
