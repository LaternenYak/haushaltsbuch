import { initializeApp } from "firebase/app";
import {
  connectAuthEmulator, getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, updateProfile, signOut
} from "firebase/auth";
import {
  connectFirestoreEmulator, initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, onSnapshot, setDoc, deleteDoc, updateDoc, getDoc,
  arrayUnion, arrayRemove, deleteField, writeBatch
} from "firebase/firestore";

/* ---------- Grundlagen ---------- */
const CATS = {
  out: [
    ["food","Lebensmittel","🛒","#16a34a"],["home","Wohnen","🏠","#2563eb"],["car","Mobilität","🚗","#7c3aed"],
    ["eat","Essen gehen","🍽️","#ea580c"],["fun","Freizeit","🎉","#db2777"],["health","Gesundheit","💊","#0891b2"],
    ["clothes","Kleidung","👕","#ca8a04"],["subs","Abos & Handy","📱","#4f46e5"],["kids","Kinder","🧸","#e11d48"],
    ["gifts","Geschenke","🎁","#9333ea"],["travel","Reisen","✈️","#0d9488"],["misc","Sonstiges","📦","#64748b"]
  ],
  in: [
    ["salary","Gehalt","💼","#15803d"],["side","Nebenjob","🛠️","#0369a1"],["giftin","Geschenk","🎁","#9333ea"],
    ["refund","Erstattung","↩️","#0891b2"],["miscin","Sonstiges","✨","#64748b"]
  ]
};
const GOAL_EMOJIS = ["🐷","🛟","✈️","🚗","🏠","🎓","💍","🎁","💻","🚲","👶","🌴"];
const catMap = {};
for (const k of ["out","in"]) for (const [id,name,ico,col] of CATS[k]) catMap[id] = {id,name,ico,col,kind:k};

const $ = s => document.querySelector(s);
const eur = new Intl.NumberFormat("de-DE",{style:"currency",currency:"EUR"});
const fmt = c => eur.format(c/100);
const pad = n => String(n).padStart(2,"0");
const todayStr = () => { const d=new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; };
const monthNames = ["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2,8);
const parseAmount = s => {
  s = String(s||"").trim().replace(/\s|€/g,"");
  if (!s) return NaN;
  if (s.includes(",")) s = s.replace(/\./g,"").replace(",",".");
  const n = Number(s);
  return isFinite(n) ? Math.round(n*100) : NaN;
};
const toInput = c => c ? (c/100).toLocaleString("de-DE",{maximumFractionDigits:2}) : "";

function toast(msg){
  const t=$("#toast"); t.textContent=msg; t.classList.add("on");
  clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.remove("on"),2600);
}
function setSync(state, text){ $("#sync").innerHTML = `<i class="dot ${state}"></i><span>${esc(text)}</span>`; }

/* ---------- Firebase ---------- */
const cfg = window.FIREBASE_CONFIG;
if (!cfg || !cfg.apiKey || cfg.apiKey.startsWith("HIER")) {
  document.body.innerHTML = `<div style="padding:40px 24px;font-family:sans-serif;text-align:center">
    <div style="font-size:40px">⚙️</div><h2>Noch nicht eingerichtet</h2>
    <p>In <code>firebase-config.js</code> fehlen die Firebase-Zugangsdaten.</p></div>`;
  throw new Error("Firebase-Konfiguration fehlt");
}
const fbApp = initializeApp(cfg);
const auth = getAuth(fbApp);
auth.languageCode = "de";
let fs;
try { fs = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch { fs = initializeFirestore(fbApp, {}); }
if (cfg.emulator) { connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true }); connectFirestoreEmulator(fs, "127.0.0.1", 8080); }

// Schreiben: sofort lokal, Server bestätigt später (funktioniert auch offline)
function write(p){
  p.catch(err => {
    console.error(err);
    toast(err && err.code === "permission-denied" ? "Keine Berechtigung – bist du noch im Haushalt?" : "Konnte nicht speichern");
  });
}

/* ---------- Zustand ---------- */
let me = null;            // Firebase-User
let hid = null;           // Haushalts-ID
let household = null;     // {name, owner, members, memberNames, budget}
let txs = [], goals = [];
let unsubs = [];
let cur = new Date(); cur = { y: cur.getFullYear(), m: cur.getMonth() };

const effect = t => t.kind==="in" ? t.cents : t.kind==="out" ? -t.cents : -(t.dir||1)*t.cents;
const saveNet = t => t.kind==="save" ? (t.dir||1)*t.cents : 0;
const goalSaved = (g, exceptId) => (g.start||0) + txs.reduce((a,t)=> a + (t.goal===g.id && t.id!==exceptId ? saveNet(t) : 0), 0);
const goalById = id => goals.find(g=>g.id===id);
const nameOf = uid => uid === me?.uid ? "dir" : ((household?.memberNames||{})[uid] || "Ehemaliges Mitglied");
const colRef = name => collection(fs, "households", hid, name);

/* ---------- Anmeldung ---------- */
let authMode = "login";
function showGate(part, msg){
  $("#gate").hidden = false; $("#app").hidden = true;
  $("#fab").style.display = "none"; document.querySelector("nav").style.display = "none";
  $("#authForm").hidden = part !== "auth";
  $("#setup").hidden = part !== "setup";
  $("#gateMsg").textContent = msg || "";
}
function showApp(){
  $("#gate").hidden = true; $("#app").hidden = false;
  document.querySelector("nav").style.display = "";
  show(currentView);
}
function setAuthMode(m){
  authMode = m;
  document.querySelectorAll("#authSeg button").forEach(b=>b.classList.toggle("on", b.dataset.m===m));
  $("#nameRow").hidden = m !== "signup";
  $("#authBtn").textContent = m === "signup" ? "Konto erstellen" : "Anmelden";
  $("#aPass").autocomplete = m === "signup" ? "new-password" : "current-password";
  $("#forgotBtn").hidden = m === "signup";
}
document.querySelectorAll("#authSeg button").forEach(b => b.onclick = () => setAuthMode(b.dataset.m));

const authErr = e => ({
  "auth/invalid-email": "Diese E-Mail-Adresse ist ungültig.",
  "auth/email-already-in-use": "Mit dieser E-Mail gibt es schon ein Konto. Bitte anmelden.",
  "auth/weak-password": "Das Passwort muss mindestens 6 Zeichen haben.",
  "auth/invalid-credential": "E-Mail oder Passwort stimmt nicht.",
  "auth/wrong-password": "E-Mail oder Passwort stimmt nicht.",
  "auth/user-not-found": "E-Mail oder Passwort stimmt nicht.",
  "auth/too-many-requests": "Zu viele Versuche. Bitte warte kurz.",
  "auth/network-request-failed": "Keine Internetverbindung.",
  "auth/operation-not-allowed": "Anmeldung per E-Mail ist in Firebase noch nicht aktiviert."
}[e?.code] || "Das hat nicht geklappt. Bitte nochmal versuchen.");

$("#authForm").onsubmit = async e => {
  e.preventDefault();
  const email = $("#aEmail").value.trim(), pass = $("#aPass").value;
  const btn = $("#authBtn"); btn.disabled = true;
  try {
    if (authMode === "signup") {
      const name = $("#aName").value.trim();
      if (!name) { toast("Bitte gib deinen Vornamen ein"); btn.disabled = false; return; }
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      await updateProfile(cred.user, { displayName: name });
      await setDoc(doc(fs, "users", cred.user.uid), { name }, { merge: true });
      if (!$("#setup").hidden && $("#joinCard").hidden) $("#gateMsg").textContent = `Hallo ${name}! Lege dein Haushaltsbuch an.`;
    } else {
      await signInWithEmailAndPassword(auth, email, pass);
    }
  } catch (err) { toast(authErr(err)); }
  btn.disabled = false;
};
$("#forgotBtn").onclick = async () => {
  const email = $("#aEmail").value.trim();
  if (!email) { toast("Gib zuerst deine E-Mail-Adresse ein"); $("#aEmail").focus(); return; }
  try { await sendPasswordResetEmail(auth, email); toast("E-Mail zum Zurücksetzen verschickt"); }
  catch (err) { toast(authErr(err)); }
};
const logout = async () => { stopListeners(); await signOut(auth); };
$("#logoutBtn").onclick = logout;
$("#logoutBtn2").onclick = logout;

/* ---------- Einladung / Haushalt ---------- */
const pendingJoin = (() => {
  const m = location.hash.match(/join=([A-Za-z0-9]+)/);
  if (m) { try { localStorage.setItem("hb.join", m[1]); } catch {} history.replaceState(null, "", location.pathname); return m[1]; }
  try { return localStorage.getItem("hb.join"); } catch { return null; }
})();
const clearJoin = () => { try { localStorage.removeItem("hb.join"); } catch {} };

function stopListeners(){ unsubs.forEach(u=>u()); unsubs = []; txs = []; goals = []; household = null; hid = null; }

let userUnsub = null;
onAuthStateChanged(auth, u => {
  if (userUnsub) { userUnsub(); userUnsub = null; }
  stopListeners();
  me = u;
  if (!u) { setAuthMode(pendingJoin ? "signup" : "login"); showGate("auth", pendingJoin ? "Du wurdest eingeladen! Erstelle ein Konto oder melde dich an." : ""); return; }
  start(u);
});

function start(u){
  if (userUnsub) return;
  showGate("none", "Lädt …");
  userUnsub = onSnapshot(doc(fs, "users", u.uid), snap => {
    const data = snap.data() || {};
    const join = pendingJoin && (() => { try { return localStorage.getItem("hb.join"); } catch { return pendingJoin; } })();
    if (join && join !== data.household) {
      showGate("setup", data.household ? "Achtung: Wenn du beitrittst, verlässt du dein bisheriges Haushaltsbuch." : "");
      $("#joinCard").hidden = false;
      $("#joinBtn").onclick = () => joinHousehold(join, data.household);
      return;
    }
    $("#joinCard").hidden = true;
    if (!data.household) { stopListeners(); showGate("setup", `Hallo${u.displayName ? " " + u.displayName : ""}! Lege dein Haushaltsbuch an.`); return; }
    if (data.household !== hid) openHousehold(data.household);
  }, err => { console.error(err); showGate("setup", "Konnte dein Konto nicht laden."); });
}

async function joinHousehold(id, oldId){
  const btn = $("#joinBtn"); btn.disabled = true;
  try {
    const name = me.displayName || "Mitglied";
    await updateDoc(doc(fs, "households", id), { members: arrayUnion(me.uid), [`memberNames.${me.uid}`]: name });
    if (oldId && oldId !== id) {
      try { await updateDoc(doc(fs, "households", oldId), { members: arrayRemove(me.uid) }); } catch {}
    }
    clearJoin();
    await setDoc(doc(fs, "users", me.uid), { household: id }, { merge: true });
    toast("Willkommen im Haushaltsbuch! 🎉");
  } catch (err) {
    console.error(err);
    clearJoin();
    toast(err?.code === "not-found" || err?.code === "permission-denied" ? "Der Einladungslink ist ungültig oder abgelaufen." : "Beitreten hat nicht geklappt.");
    $("#joinCard").hidden = true;
    const snap = await getDoc(doc(fs, "users", me.uid)).catch(()=>null);
    if (!snap?.data()?.household) showGate("setup", "");
  }
  btn.disabled = false;
}

$("#createBtn").onclick = async () => {
  const name = $("#hhInp").value.trim() || "Unser Haushalt";
  const btn = $("#createBtn"); btn.disabled = true;
  try {
    const id = (crypto.randomUUID ? crypto.randomUUID().replace(/-/g,"") : newId() + newId());
    await setDoc(doc(fs, "households", id), {
      name, owner: me.uid, members: [me.uid], memberNames: { [me.uid]: me.displayName || "Ich" }, budget: 0, created: Date.now()
    });
    await setDoc(doc(fs, "users", me.uid), { household: id }, { merge: true });
  } catch (err) { console.error(err); toast("Anlegen hat nicht geklappt. Sind die Firebase-Regeln gesetzt?"); }
  btn.disabled = false;
};

function openHousehold(id){
  stopListeners();
  hid = id;
  setSync("", "Lädt …");
  showApp();
  render();
  unsubs.push(onSnapshot(doc(fs, "households", id), { includeMetadataChanges: true }, snap => {
    if (!snap.exists() || !(snap.data().members||[]).includes(me.uid)) { kicked(); return; }
    household = snap.data();
    setSync(snap.metadata.fromCache ? "local" : "ok", snap.metadata.fromCache ? "Offline" : "Gespeichert");
    render();
  }, err => { console.error(err); kicked(); }));
  for (const name of ["tx","goals"]) {
    unsubs.push(onSnapshot(colRef(name), snap => {
      const arr = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      if (name === "tx") txs = arr; else goals = arr;
      render();
    }, err => console.error(err)));
  }
}
function kicked(){
  if (!me) return;
  stopListeners();
  setDoc(doc(fs, "users", me.uid), { household: deleteField() }, { merge: true }).catch(()=>{});
  showGate("setup", "Du bist nicht mehr Mitglied in diesem Haushaltsbuch.");
}

$("#invite").onclick = async () => {
  const url = `${location.origin}${location.pathname}#join=${hid}`;
  const text = `Mach mit bei unserem Haushaltsbuch „${household?.name || ""}“: ${url}`;
  if (navigator.share) {
    try { await navigator.share({ title: "Haushaltsbuch", text: `Mach mit bei unserem Haushaltsbuch „${household?.name || ""}“`, url }); return; }
    catch (e) { if (e && e.name === "AbortError") return; }
  }
  try { await navigator.clipboard.writeText(text); toast("Einladungslink kopiert – jetzt z. B. per WhatsApp schicken"); }
  catch { prompt("Diesen Link verschicken:", url); }
};
$("#members").onclick = e => {
  const b = e.target.closest("button[data-rm]"); if (!b) return;
  if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Sicher?"; return; }
  const uid = b.dataset.rm;
  write(updateDoc(doc(fs, "households", hid), { members: arrayRemove(uid), [`memberNames.${uid}`]: deleteField() }));
  toast("Mitglied entfernt");
};
$("#leaveBtn").onclick = () => {
  const b = $("#leaveBtn");
  if (household?.owner === me.uid && (household.members||[]).length > 1) { toast("Als Ersteller kannst du nicht austreten, solange andere Mitglieder dabei sind."); return; }
  if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Wirklich verlassen?"; setTimeout(()=>{ b.dataset.confirm=""; b.textContent="Haushalt verlassen"; }, 4000); return; }
  const id = hid;
  stopListeners();
  updateDoc(doc(fs, "households", id), { members: arrayRemove(me.uid) }).catch(()=>{});
  setDoc(doc(fs, "users", me.uid), { household: deleteField() }, { merge: true }).catch(()=>{});
};

/* ---------- Ansicht ---------- */
const inMonth = (t, y, m) => (t.date||"").startsWith(`${y}-${pad(m+1)}`);

function render(){
  if (!hid) return;
  const budget = household?.budget || 0;
  $("#monthLabel").textContent = `${monthNames[cur.m]} ${cur.y}`;
  const month = txs.filter(t=>inMonth(t,cur.y,cur.m));
  const sumIn = month.filter(t=>t.kind==="in").reduce((a,t)=>a+t.cents,0);
  const sumOut = month.filter(t=>t.kind==="out").reduce((a,t)=>a+t.cents,0);
  const saved = month.reduce((a,t)=>a+saveNet(t),0);
  const left = sumIn - sumOut - saved;
  const now = new Date();
  const isCur = now.getFullYear()===cur.y && now.getMonth()===cur.m;
  const isPast = cur.y < now.getFullYear() || (cur.y===now.getFullYear() && cur.m < now.getMonth());

  $("#leftLbl").textContent = isCur ? "Übrig in diesem Monat" : `Übrig im ${monthNames[cur.m]}`;
  $("#left").textContent = fmt(left);
  $("#hero").classList.toggle("minus", left < 0);
  let sub;
  if (!sumIn && !sumOut && !saved) sub = "Trage zuerst eure Einnahmen ein, zum Beispiel das Gehalt.";
  else if (!sumIn) sub = "Noch keine Einnahmen eingetragen.";
  else if (left < 0) sub = `${fmt(-left)} mehr ausgegeben und gespart als eingenommen.`;
  else if (isCur) {
    const daysLeft = new Date(cur.y, cur.m+1, 0).getDate() - now.getDate() + 1;
    sub = daysLeft > 1 ? `Das sind etwa ${fmt(Math.floor(left/daysLeft))} pro Tag für die restlichen ${daysLeft} Tage.`
                       : "Heute ist der letzte Tag des Monats.";
  } else if (isPast) sub = left > 0 ? "Diesen Rest könntet ihr noch in ein Sparziel einzahlen." : "Genau aufgegangen.";
  else sub = "Einnahmen minus Ausgaben und Gespartes.";
  $("#leftSub").textContent = sub;
  $("#sIn").textContent = fmt(sumIn);
  $("#sOut").textContent = fmt(sumOut);
  $("#sSave").textContent = fmt(saved);

  if (budget > 0) {
    const pct = sumOut / budget;
    $("#bText").textContent = `${fmt(sumOut)} / ${fmt(budget)}`;
    const bar = $("#bBar"); bar.style.width = Math.min(100, pct*100) + "%"; bar.classList.toggle("over", pct>1);
    const rest = budget - sumOut;
    $("#bHint").textContent = rest >= 0 ? `Noch ${fmt(rest)} vom Budget übrig.` : `Budget um ${fmt(-rest)} überschritten.`;
  } else {
    $("#bText").textContent = ""; $("#bBar").style.width = "0";
    $("#bHint").innerHTML = 'Noch kein Budget festgelegt. <a href="#" id="toSet" style="color:var(--brand)">Jetzt festlegen</a>';
    const a = $("#toSet"); if (a) a.onclick = e => { e.preventDefault(); show("settings"); $("#budgetInp").focus(); };
  }

  const showBy = (household?.members||[]).length > 1 || new Set(txs.map(t=>t.by).filter(Boolean)).size > 1;
  const list = $("#list");
  if (!month.length) {
    list.innerHTML = `<div class="empty"><div>🧾</div>Noch keine Einträge in diesem Monat.<br>Tippe auf <b>+</b>, um loszulegen.</div>`;
  } else {
    const sorted = month.slice().sort((a,b)=> b.date.localeCompare(a.date) || (b.created||0)-(a.created||0));
    const groups = {};
    for (const t of sorted) (groups[t.date] ||= []).push(t);
    const wd = new Intl.DateTimeFormat("de-DE",{weekday:"long", day:"numeric", month:"long"});
    let html = "<h2>Einträge</h2>";
    for (const d of Object.keys(groups)) {
      const [y,m,dd] = d.split("-").map(Number);
      const daySum = groups[d].reduce((a,t)=>a+effect(t),0);
      const label = d===todayStr() ? "Heute" : wd.format(new Date(y,m-1,dd));
      html += `<div class="day"><span>${label}</span><span>${(daySum>0?"+":"")+fmt(daySum)}</span></div><div class="list">`;
      for (const t of groups[d]) {
        let ico, col, title, subt, cls;
        if (t.kind==="save") {
          const g = goalById(t.goal) || {name:"Sparziel", ico:"🐷"};
          ico = g.ico; col = "#0f766e"; cls = "sav";
          title = t.note || g.name;
          subt = (t.dir===-1 ? "Aus Sparziel entnommen" : "Gespart") + (t.note ? " · " + g.name : "");
        } else {
          const c = catMap[t.cat] || catMap[t.kind==="in"?"miscin":"misc"];
          ico = c.ico; col = c.col; cls = t.kind==="in" ? "pos" : "";
          title = t.note || c.name; subt = t.note ? c.name : "";
        }
        if (showBy && t.by) subt += (subt ? " · " : "") + "von " + nameOf(t.by);
        const e = effect(t);
        html += `<button class="tx" data-id="${esc(t.id)}">
          <div class="ico" style="background:${col}22">${esc(ico)}</div>
          <div class="t"><b>${esc(title)}</b><span>${esc(subt)}</span></div>
          <div class="a ${cls}">${e>0?"+":"−"}${fmt(Math.abs(e))}</div></button>`;
      }
      html += "</div>";
    }
    list.innerHTML = html;
  }

  // Sparen
  const total = goals.reduce((a,g)=>a+goalSaved(g),0);
  $("#saveTotal").textContent = fmt(total);
  $("#saveSub").textContent = goals.length
    ? `Im ${monthNames[cur.m]}: ${saved>=0?"+":"−"}${fmt(Math.abs(saved))}`
    : "Legt ein Sparziel an und zahlt Geld darauf ein.";
  $("#goals").innerHTML = goals.length ? goals.slice().sort((a,b)=>(a.created||0)-(b.created||0)).map(g => {
    const s = goalSaved(g);
    const pct = g.target ? Math.min(100, Math.max(0, s/g.target*100)) : 0;
    const info = g.target
      ? (s >= g.target ? "🎉 Ziel erreicht!" : `Noch ${fmt(g.target - s)} bis zum Ziel · ${Math.floor(pct)} %`)
      : "Ohne Zielbetrag";
    return `<div class="goal">
      <button class="head" data-edit="${esc(g.id)}"><div class="ico" style="background:var(--brand-soft)">${esc(g.ico||"🐷")}</div>
        <div class="t"><b>${esc(g.name)}</b><span>${info}</span></div><span style="font-size:20px">✎</span></button>
      <div class="amt">${fmt(s)}${g.target ? ` <small>von ${fmt(g.target)}</small>` : ""}</div>
      ${g.target ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ""}
      <div class="acts">
        <button class="btn" data-dep="${esc(g.id)}">Einzahlen</button>
        <button class="btn ghost" data-wd="${esc(g.id)}">Entnehmen</button>
      </div></div>`;
  }).join("") : `<div class="empty"><div>🐷</div>Noch keine Sparziele.<br>Zum Beispiel: Urlaub, Notgroschen oder ein neues Handy.</div>`;

  // Statistik
  const byCat = {};
  for (const t of month) if (t.kind==="out") byCat[t.cat] = (byCat[t.cat]||0) + t.cents;
  const cats = Object.entries(byCat).sort((a,b)=>b[1]-a[1]);
  const max = cats.length ? cats[0][1] : 0;
  $("#catStats").innerHTML = cats.length ? cats.map(([id,v]) => {
    const c = catMap[id] || catMap.misc;
    return `<div class="catrow"><div class="ico" style="background:${c.col}22">${c.ico}</div>
      <div class="t"><div><span>${c.name} <span style="color:var(--muted)">· ${Math.round(v/sumOut*100)} %</span></span><b>${fmt(v)}</b></div>
      <div class="bar"><i style="width:${v/max*100}%;background:${c.col}"></i></div></div></div>`;
  }).join("") : `<div class="hint">Keine Ausgaben in diesem Monat.</div>`;
  const months = [];
  for (let i=5;i>=0;i--) { const d = new Date(cur.y, cur.m - i, 1); months.push({y:d.getFullYear(), m:d.getMonth()}); }
  const vals = months.map(({y,m}) => txs.filter(t=>t.kind==="out" && inMonth(t,y,m)).reduce((a,t)=>a+t.cents,0));
  const vmax = Math.max(1, ...vals);
  $("#trend").innerHTML = months.map(({m},i) => `<div class="col ${i===5?"cur":""}" title="${fmt(vals[i])}">
     <span style="font-size:10px">${vals[i] ? Math.round(vals[i]/100)+" €" : ""}</span>
     <i style="height:${vals[i]/vmax*100}%"></i><span>${monthNames[m].slice(0,3)}</span></div>`).join("");

  // Einstellungen
  $("#cntAll").textContent = txs.length;
  $("#meInfo").textContent = me ? `${me.displayName || ""} (${me.email})` : "";
  $("#hhName").textContent = household?.name ? "· " + household.name : "";
  const isOwner = household?.owner === me?.uid;
  $("#members").innerHTML = (household?.members||[]).map(uid => `<div class="setrow"><span>${esc((household.memberNames||{})[uid] || "Mitglied")}${uid===me.uid?" (du)":""}${uid===household.owner?" · Ersteller":""}</span>
     ${isOwner && uid!==me.uid ? `<button class="btn danger" style="width:auto;padding:6px 10px;font-size:14px" data-rm="${esc(uid)}">Entfernen</button>` : ""}</div>`).join("");
  if (document.activeElement !== $("#budgetInp")) $("#budgetInp").value = toInput(budget);
}

/* ---------- Navigation ---------- */
let currentView = "home";
function show(v){
  currentView = v;
  document.querySelectorAll(".view").forEach(e=>e.classList.toggle("on", e.id==="v-"+v));
  document.querySelectorAll("nav button").forEach(b=>b.classList.toggle("on", b.dataset.v===v));
  $("#fab").style.display = (v==="settings" || v==="save") ? "none" : "";
  window.scrollTo(0,0);
}
document.querySelectorAll("nav button").forEach(b => b.onclick = () => show(b.dataset.v));
$("#prev").onclick = () => { cur.m--; if (cur.m<0){cur.m=11;cur.y--;} render(); };
$("#next").onclick = () => { cur.m++; if (cur.m>11){cur.m=0;cur.y++;} render(); };
let sx=null, sy=null;
document.addEventListener("touchstart", e => { if (e.target.closest(".sheet,.gate")) return; sx=e.touches[0].clientX; sy=e.touches[0].clientY; }, {passive:true});
document.addEventListener("touchend", e => {
  if (sx===null) return;
  const dx=e.changedTouches[0].clientX-sx, dy=e.changedTouches[0].clientY-sy; sx=null;
  if (Math.abs(dx)>70 && Math.abs(dx)>Math.abs(dy)*1.5) (dx<0?$("#next"):$("#prev")).click();
}, {passive:true});

/* ---------- Sheets ---------- */
function openS(id){ document.querySelectorAll(".sheet").forEach(s=>s.classList.toggle("on", s.id===id)); $("#backdrop").classList.add("on"); }
function closeS(){ document.querySelectorAll(".sheet").forEach(s=>s.classList.remove("on")); $("#backdrop").classList.remove("on"); document.activeElement && document.activeElement.blur(); }
$("#backdrop").onclick = closeS;

/* ---------- Eintrag-Formular ---------- */
let editing = null, kind = "out", cat = "food", goalSel = null, dir = 1, confirmDel = false;
function renderCats(){
  if (kind === "save") {
    $("#catLbl").textContent = "Sparziel";
    $("#cats").innerHTML = goals.map(g =>
      `<button type="button" data-g="${esc(g.id)}" class="${g.id===goalSel?"on":""}"><span>${esc(g.ico||"🐷")}</span>${esc(g.name)}</button>`).join("")
      + `<button type="button" data-newgoal="1"><span>➕</span>Neues Ziel</button>`;
  } else {
    $("#catLbl").textContent = "Kategorie";
    $("#cats").innerHTML = CATS[kind].map(([id,name,ico]) =>
      `<button type="button" data-c="${id}" class="${id===cat?"on":""}"><span>${ico}</span>${name}</button>`).join("");
  }
}
function setKind(k){
  kind = k;
  document.querySelectorAll(".seg button[data-k]").forEach(b=>b.classList.toggle("on", b.dataset.k===k));
  $("#dirSeg").hidden = k !== "save";
  if (k !== "save" && !CATS[k].some(c=>c[0]===cat)) cat = CATS[k][0][0];
  if (k === "save" && !goalById(goalSel)) goalSel = goals[0] ? goals[0].id : null;
  renderCats();
}
function setDir(d){ dir = d; document.querySelectorAll("#dirSeg button").forEach(b=>b.classList.toggle("on", Number(b.dataset.d)===d)); }
document.querySelectorAll(".seg button[data-k]").forEach(b => b.onclick = () => setKind(b.dataset.k));
document.querySelectorAll("#dirSeg button").forEach(b => b.onclick = () => setDir(Number(b.dataset.d)));
$("#cats").onclick = e => {
  const b=e.target.closest("button"); if(!b) return;
  if (b.dataset.newgoal) { openGoal(null, true); return; }
  if (b.dataset.g) goalSel = b.dataset.g; else cat = b.dataset.c;
  renderCats();
};
const fitAmt = () => { const a=$("#amt"); a.style.width = Math.max(4.2, (a.value||"0,00").length + 0.6) + "ch"; };
$("#amt").addEventListener("input", fitAmt);

function openSheet(tx, preset){
  editing = tx || null; confirmDel = false;
  const k = tx ? tx.kind : (preset && preset.kind) || "out";
  $("#sheetTitle").textContent = tx ? "Eintrag bearbeiten" : k==="save" ? "Sparen" : "Neuer Eintrag";
  $("#delBtn").hidden = !tx; $("#delBtn").textContent = "Löschen";
  if (tx && tx.cat) cat = tx.cat; else if (!tx) cat = "food";
  goalSel = tx ? (tx.goal || null) : (preset && preset.goal) || goalSel;
  setDir(tx ? (tx.dir||1) : (preset && preset.dir) || 1);
  setKind(k);
  $("#amt").value = tx ? (tx.cents/100).toLocaleString("de-DE",{minimumFractionDigits:2}) : "";
  fitAmt();
  $("#note").value = tx ? (tx.note||"") : "";
  const now = new Date();
  const defDate = (now.getFullYear()===cur.y && now.getMonth()===cur.m) ? todayStr() : `${cur.y}-${pad(cur.m+1)}-01`;
  $("#date").value = tx ? tx.date : defDate;
  openS("sheet");
  if (!tx) setTimeout(()=>$("#amt").focus(), 260);
}
$("#fab").onclick = () => openSheet();
$("#cancelBtn").onclick = closeS;
$("#list").onclick = e => { const b=e.target.closest(".tx"); if(!b) return; openSheet(txs.find(t=>t.id===b.dataset.id)); };

$("#form").onsubmit = e => {
  e.preventDefault();
  const cents = parseAmount($("#amt").value);
  if (!(cents > 0)) { toast("Bitte einen gültigen Betrag eingeben"); $("#amt").focus(); return; }
  const date = $("#date").value || todayStr();
  const tx = {
    kind, cents, note: $("#note").value.trim().slice(0,80), date,
    created: editing ? (editing.created||Date.now()) : Date.now(),
    by: editing ? (editing.by || me.uid) : me.uid
  };
  const id = editing ? editing.id : newId();
  if (kind === "save") {
    const g = goalById(goalSel);
    if (!g) { toast("Bitte zuerst ein Sparziel wählen oder anlegen"); return; }
    if (dir === -1 && cents > goalSaved(g, id)) { toast(`Im Ziel „${g.name}“ sind nur ${fmt(goalSaved(g, id))}`); return; }
    tx.goal = g.id; tx.dir = dir;
  } else tx.cat = cat;
  const wasEdit = !!editing;
  closeS();
  const [y,m] = date.split("-").map(Number);
  if (y!==cur.y || m-1!==cur.m) { cur = {y, m:m-1}; render(); }
  write(setDoc(doc(colRef("tx"), id), tx));
  toast(wasEdit ? "Geändert" : kind==="save" ? (dir===1 ? `${fmt(cents)} gespart 🐷` : `${fmt(cents)} entnommen`) : "Gespeichert");
};
$("#delBtn").onclick = () => {
  if (!confirmDel) { confirmDel = true; $("#delBtn").textContent = "Wirklich löschen?"; return; }
  const id = editing.id; closeS();
  write(deleteDoc(doc(colRef("tx"), id))); toast("Gelöscht");
};

/* ---------- Sparziele ---------- */
let gEditing = null, gIco = "🐷", gConfirm = false, gReturn = false;
function renderEmojis(){ $("#gEmojis").innerHTML = GOAL_EMOJIS.map(e=>`<button type="button" class="${e===gIco?"on":""}">${e}</button>`).join(""); }
$("#gEmojis").onclick = e => { const b=e.target.closest("button"); if(!b) return; gIco=b.textContent; renderEmojis(); };
function openGoal(g, returnToTx){
  gEditing = g || null; gConfirm = false; gReturn = !!returnToTx;
  gIco = g ? (g.ico||"🐷") : "🐷"; renderEmojis();
  $("#gTitle").textContent = g ? "Sparziel bearbeiten" : "Neues Sparziel";
  $("#gName").value = g ? g.name : "";
  $("#gTarget").value = g ? toInput(g.target) : "";
  $("#gStart").value = g ? toInput(g.start) : "";
  $("#gDel").hidden = !g; $("#gDel").textContent = "Löschen";
  openS("gsheet");
  if (!g) setTimeout(()=>$("#gName").focus(), 260);
}
$("#newGoal").onclick = () => openGoal(null);
$("#gCancel").onclick = () => { if (gReturn) openS("sheet"); else closeS(); };
$("#goals").onclick = e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.edit) openGoal(goalById(b.dataset.edit));
  else if (b.dataset.dep) openSheet(null, {kind:"save", goal:b.dataset.dep, dir:1});
  else if (b.dataset.wd) openSheet(null, {kind:"save", goal:b.dataset.wd, dir:-1});
};
$("#gform").onsubmit = e => {
  e.preventDefault();
  const name = $("#gName").value.trim().slice(0,40);
  if (!name) { toast("Bitte gib dem Sparziel einen Namen"); $("#gName").focus(); return; }
  const tv = $("#gTarget").value.trim(), sv = $("#gStart").value.trim();
  const target = tv ? parseAmount(tv) : 0, start = sv ? parseAmount(sv) : 0;
  if ((tv && !(target>0)) || (sv && !(start>=0))) { toast("Bitte gültige Beträge eingeben"); return; }
  const id = gEditing ? gEditing.id : newId();
  const g = { name, ico: gIco, target, start, created: gEditing ? (gEditing.created||Date.now()) : Date.now(), by: gEditing ? (gEditing.by||me.uid) : me.uid };
  write(setDoc(doc(colRef("goals"), id), g));
  if (!goalById(id)) goals = goals.concat([{ id, ...g }]);
  if (gReturn && !gEditing) { goalSel = id; setKind("save"); openS("sheet"); }
  else closeS();
  toast(gEditing ? "Sparziel geändert" : "Sparziel angelegt");
};
$("#gDel").onclick = () => {
  const g = gEditing; if (!g) return;
  const deps = txs.filter(t=>t.goal===g.id);
  if (!gConfirm) {
    gConfirm = true;
    $("#gDel").textContent = deps.length ? `Ziel und ${deps.length} Buchung${deps.length>1?"en":""} löschen?` : "Wirklich löschen?";
    return;
  }
  closeS();
  const batch = writeBatch(fs);
  for (const t of deps) batch.delete(doc(colRef("tx"), t.id));
  batch.delete(doc(colRef("goals"), g.id));
  write(batch.commit());
  toast("Sparziel gelöscht");
};

/* ---------- Einstellungen ---------- */
$("#saveBudget").onclick = () => {
  const v = $("#budgetInp").value.trim();
  const c = v ? parseAmount(v) : 0;
  if (v && !(c>0)) { toast("Bitte eine gültige Zahl eingeben"); return; }
  $("#budgetInp").blur();
  write(updateDoc(doc(fs, "households", hid), { budget: c }));
  toast(c ? "Budget gespeichert" : "Budget entfernt");
};
$("#copyCsv").onclick = async () => {
  const rows = [["Datum","Typ","Kategorie / Sparziel","Betrag","Notiz","Von"]];
  for (const t of txs.slice().sort((a,b)=>a.date.localeCompare(b.date))) {
    const typ = t.kind==="in" ? "Einnahme" : t.kind==="out" ? "Ausgabe" : (t.dir===-1 ? "Sparen (Entnahme)" : "Sparen");
    const what = t.kind==="save" ? ((goalById(t.goal)||{}).name||"") : ((catMap[t.cat]||{}).name||t.cat);
    rows.push([t.date, typ, what, (effect(t)/100).toFixed(2).replace(".",","), t.note||"", t.by ? ((household?.memberNames||{})[t.by]||"") : ""]);
  }
  const csv = rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(";")).join("\n");
  try { await navigator.clipboard.writeText(csv); toast(`${txs.length} Einträge kopiert`); }
  catch { toast("Kopieren nicht möglich"); }
};
$("#importBtn").onclick = async () => {
  let data;
  try { data = JSON.parse($("#importTxt").value.trim()); } catch { toast("Der eingefügte Text ist nicht lesbar"); return; }
  if (!data || data.app !== "haushaltsbuch") { toast("Das sieht nicht nach einem Haushaltsbuch-Export aus"); return; }
  const have = new Set(txs.map(t=>t.id)), haveG = new Set(goals.map(g=>g.id));
  const items = [
    ...(data.goals||[]).filter(g=>g && g.id && !haveG.has(g.id)).map(g=>["goals", g]),
    ...(data.txs||[]).filter(t=>t && t.id && !have.has(t.id)).map(t=>["tx", t])
  ];
  if (!items.length) { toast("Nichts Neues zum Übernehmen"); return; }
  for (let i=0;i<items.length;i+=400) {
    const batch = writeBatch(fs);
    for (const [col, it] of items.slice(i,i+400)) {
      const { id, ...rest } = it;
      batch.set(doc(colRef(col), String(id)), Object.assign(rest, { by: me.uid }));
    }
    write(batch.commit());
  }
  if (data.settings && data.settings.budget && !household?.budget) write(updateDoc(doc(fs, "households", hid), { budget: data.settings.budget }));
  $("#importTxt").value = "";
  toast(`${items.length} Einträge übernommen`);
};

/* ---------- Offline-Fähigkeit ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(()=>{}));
}
