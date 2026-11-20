import { Chessground } from 'chessground';
import { Chess } from 'chess.js';
import { PRESETS } from './presets.js';
import * as C from './core.js';
import { Engine, formatEval, evalShare } from './engine.js';
import * as X from './explorer.js';
import * as Cloud from './cloud.js';

let engine = null;
// Wird beim Bauen gesetzt: true = eigenständige Website, false = claude.ai-Artefakt
// eslint-disable-next-line no-undef
const IS_WEB = typeof __WEB__ !== 'undefined' && __WEB__;
const prefs = { engine: false, db: true };

// ======================================================================
// Zustand
// ======================================================================
const app = {
  reps: [],
  settings: { newLinesPerDay: 5, notation: 'de', newLog: {}, spar: null },
  storage: 'loading', // 'cloud' | 'local' | 'loading'
  view: 'home',
};

const $ = (sel, el = document) => el.querySelector(sel);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};
const fmt = (san) => (app.settings.notation === 'de' ? C.toGerman(san) : san);
const colorName = (c) => (c === 'w' ? 'Weiß' : 'Schwarz');
const cgColor = (c) => (c === 'w' ? 'white' : 'black');
const uid = () => Math.random().toString(36).slice(2, 10);

function toast(msg, kind = '') {
  const t = h('div', { class: 'toast ' + kind }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.classList.add('out'), 2600);
  setTimeout(() => t.remove(), 3000);
}

// ======================================================================
// Speicherung: im Claude-Konto (db) oder notfalls im Browser
// ======================================================================
const LS_KEY = 'schach-anki-v1';
const store = {
  db: null, uid: null, timers: new Map(), pending: new Map(), writing: new Set(),

  serializeRep(rep) {
    return {
      kind: 'rep', name: rep.name, color: rep.color, description: rep.description || '',
      presetId: rep.presetId || null, tree: C.serializeTree(rep.root),
      srs: Object.entries(rep.srs), lines: Object.entries(rep.lines || {}), createdAt: rep.createdAt, updatedAt: rep.updatedAt || Date.now(),
    };
  },
  deserializeRep(id, d) {
    return {
      id, name: d.name || 'Repertoire', color: d.color === 'b' ? 'b' : 'w', description: d.description || '',
      presetId: d.presetId || null, root: C.deserializeTree(d.tree), srs: Object.fromEntries(d.srs || []), lines: Object.fromEntries(d.lines || []),
      createdAt: d.createdAt || Date.now(), updatedAt: d.updatedAt || 0,
    };
  },

  async init() {
    if (IS_WEB) return this.initWeb();
    let db = null, user = null;
    try {
      if (!IS_WEB && window.claude?.use) {
        const timeout = new Promise((r) => setTimeout(() => r(null), 10000));
        [db, user] = await Promise.all([
          Promise.race([window.claude.use('db'), timeout]),
          Promise.race([window.claude.use('user'), timeout]),
        ]);
      }
    } catch (e) { db = null; }
    let id = null;
    try { id = user ? await user.id() : null; } catch (e) { id = null; }
    if (db && id) {
      try {
        const snap = await Promise.race([
          db.collection('data/users/' + id).get(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
        ]);
        this.db = db; this.uid = id; app.storage = 'cloud';
        const reps = [];
        for (const doc of snap.docs) {
          const d = JSON.parse(JSON.stringify(doc.data() || {})); // Snapshots sind eingefroren – Kopie zum Bearbeiten
          if (doc.id === 'settings') app.settings = { ...app.settings, ...d };
          else if (doc.id.startsWith('rep_') && d) reps.push(this.deserializeRep(doc.id, d));
        }
        app.reps = reps.sort((a, b) => a.createdAt - b.createdAt);
        // Lokale Daten aus einer früheren Sitzung ohne Konto übernehmen
        if (!snap.docs.length) {
          const local = this.readLocal();
          if (local && local.reps.length) {
            app.reps = local.reps; app.settings = { ...app.settings, ...local.settings };
            app.reps.forEach((r) => this.saveRep(r));
            this.saveSettings();
          }
        }
        return;
      } catch (e) { /* weiter mit lokal */ }
    }
    app.storage = 'local';
    const local = this.readLocal();
    if (local) { app.reps = local.reps; app.settings = { ...app.settings, ...local.settings }; }
  },

  readLocal() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      return {
        reps: Object.entries(d.reps || {}).map(([id, r]) => this.deserializeRep(id, r)).sort((a, b) => a.createdAt - b.createdAt),
        settings: d.settings || {},
      };
    } catch (e) { return null; }
  },
  writeLocal() {
    try {
      const reps = {};
      for (const r of app.reps) reps[r.id] = this.serializeRep(r);
      localStorage.setItem(LS_KEY, JSON.stringify({ reps, settings: app.settings }));
      setSaved(true);
    } catch (e) { /* Speicher nicht verfügbar */ }
  },

  schedule(docId, getData) {
    if (app.storage !== 'cloud') { clearTimeout(this.timers.get('local')); this.timers.set('local', setTimeout(() => this.writeLocal(), 400)); return; }
    clearTimeout(this.timers.get(docId));
    this.timers.set(docId, setTimeout(() => { this.pending.set(docId, getData()); this.flush(docId); }, 700));
  },
  async flush(docId) {
    if (this.writing.has(docId) || !this.pending.has(docId)) return;
    const data = this.pending.get(docId);
    this.pending.delete(docId);
    this.writing.add(docId);
    const ref = this.db.collection('data/users/' + this.uid).doc(docId);
    try {
      if (data === null) await ref.delete(); else await ref.set(data);
      setSaved(true);
    } catch (e) {
      if (e?.code === 'unavailable') { this.pending.set(docId, this.pending.get(docId) ?? data); setTimeout(() => this.flush(docId), 1500 + Math.random() * 1500); }
      else if (e?.code === 'quota_exceeded') toast('Speicher voll – bitte ein Repertoire löschen.', 'bad');
      else { toast('Speichern im Konto nicht möglich – Daten bleiben in diesem Browser.', 'bad'); app.storage = 'local'; this.writeLocal(); renderStatus(); }
    } finally {
      this.writing.delete(docId);
      if (this.pending.has(docId)) this.flush(docId);
    }
  },
  saveRep(rep) { rep.updatedAt = Date.now(); setSaved(false); this.schedule(rep.id, () => this.serializeRep(rep)); if (app.storage === 'account') this.markDirty('rep', rep.id); },
  deleteRep(rep) { this.schedule(rep.id, () => null); if (app.storage === 'account') this.markDirty('del', rep.id); },
  saveSettings() { app.settings._ts = Date.now(); this.schedule('settings', () => ({ ...app.settings })); if (app.storage === 'account') this.markDirty('settings'); },

  // ================= Konto (Supabase) – nur Website =================
  user: null, pushing: false, pushAgain: false, offline: false, lastPull: 0, pushTimer: null,
  DIRTY: 'schach-anki-dirty', OWNER: 'schach-anki-owner',

  async initWeb() {
    app.storage = 'local';
    const local = this.readLocal();
    if (local) { app.reps = local.reps; app.settings = { ...app.settings, ...local.settings }; }
    const client = Cloud.sb();
    if (!client) return;
    try {
      const { data } = await client.auth.getSession();
      client.auth.onAuthStateChange((event, session) => this.onAuth(event, session));
      if (data?.session) {
        this.user = data.session.user;
        app.storage = 'account';
        try { await this.pull(); } catch (e) { this.offline = true; }
      }
    } catch (e) { /* ohne Konto weiter */ }
    window.addEventListener('online', () => { this.offline = false; this.schedulePush(0); });
    window.addEventListener('focus', () => {
      if (app.storage !== 'account' || Date.now() - this.lastPull < 60000 || app.view !== 'home') return;
      this.pull().then(() => { if (app.view === 'home') setView('home'); }).catch(() => {});
    });
  },

  async onAuth(event, session) {
    if (event === 'PASSWORD_RECOVERY') { openNewPassword(); return; }
    if (event === 'SIGNED_IN' && session?.user && this.user?.id !== session.user.id) {
      this.user = session.user;
      app.storage = 'account';
      renderStatus();
      try { await this.pull({ interactive: true }); toast(`Angemeldet als ${session.user.email}`, 'good'); }
      catch (e) { this.offline = true; toast('Angemeldet – Daten konnten noch nicht geladen werden.', 'bad'); }
      renderStatus();
      if (app.view === 'home') setView('home');
    }
  },

  loadDirty() { try { return { reps: {}, del: {}, settings: 0, ...JSON.parse(localStorage.getItem(this.DIRTY) || '{}') }; } catch (e) { return { reps: {}, del: {}, settings: 0 }; } },
  saveDirty(d) { try { localStorage.setItem(this.DIRTY, JSON.stringify(d)); } catch (e) { /* egal */ } },
  dirtyCount() { const d = this.loadDirty(); return Object.keys(d.reps).length + Object.keys(d.del).length + (d.settings ? 1 : 0); },
  markDirty(kind, id) {
    const d = this.loadDirty();
    const stamp = Date.now() + Math.random();
    if (kind === 'rep') { d.reps[id] = stamp; delete d.del[id]; }
    else if (kind === 'del') { d.del[id] = Date.now(); delete d.reps[id]; }
    else d.settings = stamp;
    this.saveDirty(d);
    this.schedulePush();
    renderStatus();
  },
  schedulePush(ms = 1200) {
    if (app.storage !== 'account') return;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => this.push(), ms);
  },

  // Geänderte Daten ins Konto hochladen
  async push() {
    if (app.storage !== 'account') return;
    if (this.pushing) { this.pushAgain = true; return; }
    const d = this.loadDirty();
    const repIds = Object.keys(d.reps), delIds = Object.keys(d.del);
    if (!repIds.length && !delIds.length && !d.settings) { renderStatus(); return; }
    this.pushing = true; renderStatus();
    const client = Cloud.sb();
    try {
      const rows = [];
      for (const id of repIds) {
        const r = app.reps.find((x) => x.id === id);
        if (r) rows.push({ user_id: this.user.id, id, data: this.serializeRep(r), deleted: false, updated_at: new Date(r.updatedAt || Date.now()).toISOString() });
      }
      for (const id of delIds) rows.push({ user_id: this.user.id, id, data: null, deleted: true, updated_at: new Date(d.del[id]).toISOString() });
      if (rows.length) { const { error } = await client.from('repertoires').upsert(rows, { onConflict: 'user_id,id' }); if (error) throw error; }
      if (d.settings) {
        const { error } = await client.from('user_settings').upsert({ user_id: this.user.id, data: app.settings, updated_at: new Date(app.settings._ts || Date.now()).toISOString() }, { onConflict: 'user_id' });
        if (error) throw error;
      }
      // Nur das als erledigt markieren, was sich seitdem nicht erneut geändert hat
      const now = this.loadDirty();
      for (const id of repIds) if (now.reps[id] === d.reps[id]) delete now.reps[id];
      for (const id of delIds) if (now.del[id] === d.del[id]) delete now.del[id];
      if (now.settings === d.settings) now.settings = 0;
      this.saveDirty(now);
      this.offline = false;
    } catch (e) {
      this.offline = true;
      clearTimeout(this.pushTimer);
      this.pushTimer = setTimeout(() => this.push(), 30000);
    } finally {
      this.pushing = false;
      renderStatus();
      if (this.pushAgain) { this.pushAgain = false; this.schedulePush(300); }
    }
  },

  // Daten aus dem Konto laden und mit dem Browser abgleichen (neuere Version gewinnt)
  async pull({ interactive = false } = {}) {
    const client = Cloud.sb();
    const [repRes, setRes] = await Promise.all([
      client.from('repertoires').select('id,data,deleted,updated_at'),
      client.from('user_settings').select('data,updated_at').maybeSingle(),
    ]);
    if (repRes.error) throw repRes.error;
    if (setRes.error) throw setRes.error;
    const rows = repRes.data || [];
    const uid = this.user.id;
    let owner = null;
    try { owner = localStorage.getItem(this.OWNER); } catch (e) { /* egal */ }
    let d = this.loadDirty();

    if (owner && owner !== uid) {
      // Die Daten im Browser gehören zu einem anderen Konto → nicht vermischen
      app.reps = []; d = { reps: {}, del: {}, settings: 0 };
      app.settings = { newLinesPerDay: 5, notation: app.settings.notation || 'de', newLog: {}, spar: null };
    } else if (!owner && app.reps.length) {
      // Erste Anmeldung in diesem Browser mit vorhandenen Daten
      const remoteCount = rows.filter((r) => !r.deleted).length;
      const take = interactive || !remoteCount ? await askTakeLocal(app.reps.length, remoteCount) : true;
      if (take) { for (const r of app.reps) d.reps[r.id] = Date.now() + Math.random(); d.settings = Date.now(); }
      else { app.reps = []; }
    }
    try { localStorage.setItem(this.OWNER, uid); } catch (e) { /* egal */ }

    for (const row of rows) {
      const ts = Date.parse(row.updated_at) || 0;
      const i = app.reps.findIndex((r) => r.id === row.id);
      const local = i >= 0 ? app.reps[i] : null;
      if (row.deleted) {
        if (local && !(d.reps[row.id] && (local.updatedAt || 0) > ts)) { app.reps.splice(i, 1); delete d.reps[row.id]; }
        continue;
      }
      if (!row.data) continue;
      if (d.del[row.id]) continue; // lokal gelöscht, Löschung wird noch hochgeladen
      if (!local) { app.reps.push(this.deserializeRep(row.id, row.data)); continue; }
      if (ts > (local.updatedAt || 0)) { app.reps[i] = this.deserializeRep(row.id, row.data); delete d.reps[row.id]; }
      else if ((local.updatedAt || 0) > ts) d.reps[row.id] = d.reps[row.id] || Date.now() + Math.random();
    }
    // Nur lokal vorhandene Repertoires hochladen
    for (const r of app.reps) if (!rows.some((x) => x.id === r.id)) d.reps[r.id] = d.reps[r.id] || Date.now() + Math.random();
    app.reps.sort((a, b) => a.createdAt - b.createdAt);

    const remoteSet = setRes.data;
    if (remoteSet && !d.settings && (Date.parse(remoteSet.updated_at) || 0) > (app.settings._ts || 0)) {
      app.settings = { ...app.settings, ...remoteSet.data };
    } else if (!remoteSet || (app.settings._ts || 0) > (Date.parse(remoteSet.updated_at) || 0)) {
      d.settings = d.settings || Date.now();
    }
    this.saveDirty(d);
    this.writeLocal();
    this.lastPull = Date.now();
    this.offline = false;
    renderStatus();
    this.schedulePush(100);
  },

  async logout() {
    if (this.dirtyCount()) { await this.push(); }
    if (this.dirtyCount()) {
      const ok = await new Promise((res) => confirmDialog('Noch nicht alles übertragen', 'Einige Änderungen sind noch nicht im Konto gespeichert (keine Verbindung?). Trotzdem abmelden? Diese Änderungen gehen dann verloren.', 'Trotzdem abmelden', () => res(true)) || setTimeout(() => res(false), 600000));
      if (!ok) return;
    }
    try { await Cloud.sb().auth.signOut(); } catch (e) { /* egal */ }
    // Daten aus diesem Browser entfernen – sie liegen sicher im Konto
    try { [LS_KEY, this.DIRTY, this.OWNER].forEach((k) => localStorage.removeItem(k)); } catch (e) { /* egal */ }
    this.user = null;
    app.storage = 'local';
    app.reps = [];
    app.settings = { newLinesPerDay: 5, notation: app.settings.notation || 'de', newLog: {}, spar: null };
    renderStatus();
    setView('home');
    toast('Abgemeldet');
  },
};

// ---------- Konto-Dialoge ----------
function askTakeLocal(nLocal, nRemote) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const close = modal('Daten aus diesem Browser übernehmen?', h('div', { class: 'form' },
      h('p', {}, `In diesem Browser sind ${nLocal} Repertoire${nLocal === 1 ? '' : 's'} gespeichert` + (nRemote ? `, in deinem Konto ${nRemote}.` : '. Dein Konto ist noch leer.')),
      h('p', { class: 'muted small' }, 'Übernehmen: Die Repertoires aus diesem Browser kommen zusätzlich in dein Konto (bei gleichen Repertoires gewinnt die neuere Version). Nicht übernehmen: Es wird nur verwendet, was im Konto liegt.')),
    (c) => [
      h('button', { class: 'btn ghost', onclick: () => { c(); finish(false); } }, 'Nicht übernehmen'),
      h('button', { class: 'btn primary', onclick: () => { c(); finish(true); } }, 'Übernehmen'),
    ]);
    // Schließen ohne Auswahl = übernehmen (es geht nichts verloren)
    const wrap = document.querySelector('.modal-wrap:last-of-type');
    if (wrap) new MutationObserver((m, o) => { if (!document.body.contains(wrap)) { o.disconnect(); finish(true); } }).observe(document.body, { childList: true });
    void close;
  });
}

function openAccount() {
  if (store.user) {
    const n = store.dirtyCount();
    modal('Dein Konto', h('div', { class: 'form' },
      h('p', {}, 'Angemeldet als ', h('strong', {}, store.user.email || '')),
      h('p', { class: 'muted small' }, store.offline ? 'Gerade keine Verbindung – Änderungen werden übertragen, sobald du wieder online bist.'
        : n ? `${n} Änderung${n === 1 ? '' : 'en'} werden gerade übertragen …` : 'Alles ist mit deinem Konto synchronisiert. Du kannst dich auf jedem Gerät anmelden und findest dort dieselben Daten.'),
    ), (close) => [
      h('button', { class: 'btn ghost', onclick: async () => { close(); try { await store.push(); await store.pull(); toast('Synchronisiert', 'good'); if (app.view === 'home') setView('home'); } catch (e) { toast('Keine Verbindung zum Konto.', 'bad'); } } }, '⟳ Jetzt synchronisieren'),
      h('button', { class: 'btn', onclick: () => { close(); store.logout(); } }, 'Abmelden'),
    ]);
    return;
  }
  let mode = 'login';
  const email = h('input', { type: 'email', placeholder: 'deine@email.de', autocomplete: 'email' });
  const pw = h('input', { type: 'password', placeholder: 'Passwort (mind. 8 Zeichen)', autocomplete: 'current-password' });
  const err = h('p', { class: 'error' });
  const info = h('p', { class: 'muted small' });
  const tabs = h('div', { class: 'tabs' });
  const submit = h('button', { class: 'btn primary' });
  const paint = () => {
    tabs.innerHTML = '';
    tabs.append(
      h('button', { class: 'tab' + (mode === 'login' ? ' on' : ''), onclick: () => { mode = 'login'; paint(); } }, 'Anmelden'),
      h('button', { class: 'tab' + (mode === 'signup' ? ' on' : ''), onclick: () => { mode = 'signup'; paint(); } }, 'Konto erstellen'));
    submit.textContent = mode === 'login' ? 'Anmelden' : 'Konto erstellen';
    pw.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    info.textContent = mode === 'signup'
      ? 'Du bekommst eine E-Mail mit einem Bestätigungslink. Danach sind deine Repertoires in deinem Konto gespeichert und auf allen Geräten verfügbar.'
      : '';
    err.textContent = '';
  };
  const forgot = h('button', { class: 'linkish', onclick: async () => {
    if (!email.value.includes('@')) { err.textContent = 'Bitte zuerst deine E-Mail-Adresse eintragen.'; return; }
    const { error } = await Cloud.sb().auth.resetPasswordForEmail(email.value.trim(), { redirectTo: location.origin + location.pathname });
    err.textContent = '';
    info.textContent = error ? 'Das hat nicht geklappt: ' + error.message : 'Wir haben dir eine E-Mail zum Zurücksetzen des Passworts geschickt.';
  } }, 'Passwort vergessen?');
  modal('Konto', h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); submit.click(); } }, tabs,
    h('label', {}, 'E-Mail', email), h('label', {}, 'Passwort', pw), err, info, forgot,
    h('p', { class: 'muted small' }, 'Ohne Konto funktioniert alles weiter – dann wird nur in diesem Browser gespeichert.')),
  (close) => {
    submit.onclick = async () => {
      err.textContent = ''; info.textContent = '';
      const e = email.value.trim(), p = pw.value;
      if (!e.includes('@')) { err.textContent = 'Bitte eine gültige E-Mail-Adresse eingeben.'; return; }
      if (p.length < 8) { err.textContent = 'Das Passwort muss mindestens 8 Zeichen haben.'; return; }
      submit.disabled = true;
      try {
        const auth = Cloud.sb().auth;
        if (mode === 'login') {
          const { error } = await auth.signInWithPassword({ email: e, password: p });
          if (error) throw error;
          close();
        } else {
          const { data, error } = await auth.signUp({ email: e, password: p, options: { emailRedirectTo: location.origin + location.pathname } });
          if (error) throw error;
          if (data?.session) close();
          else info.textContent = '✉️ Fast geschafft! Bitte bestätige deine E-Mail-Adresse über den Link in der Mail, die wir dir gerade geschickt haben. Danach bist du hier automatisch angemeldet.';
        }
      } catch (ex) {
        const m = String(ex?.message || ex);
        err.textContent = /Invalid login/i.test(m) ? 'E-Mail oder Passwort stimmt nicht.'
          : /not confirmed/i.test(m) ? 'Bitte bestätige zuerst deine E-Mail-Adresse (Link in der Mail).'
            : /already registered/i.test(m) ? 'Für diese E-Mail gibt es schon ein Konto – bitte anmelden.'
              : /rate limit/i.test(m) ? 'Zu viele Versuche – bitte in ein paar Minuten nochmal.'
                : /fetch|network/i.test(m) ? 'Keine Verbindung zum Server.' : m;
      } finally { submit.disabled = false; }
    };
    return [h('button', { class: 'btn ghost', type: 'button', onclick: close }, 'Abbrechen'), submit];
  });
  paint();
}

function openNewPassword() {
  const pw = h('input', { type: 'password', placeholder: 'Neues Passwort (mind. 8 Zeichen)', autocomplete: 'new-password' });
  const err = h('p', { class: 'error' });
  modal('Neues Passwort festlegen', h('div', { class: 'form' }, h('label', {}, 'Neues Passwort', pw), err), (close) => [
    h('button', { class: 'btn primary', onclick: async () => {
      if (pw.value.length < 8) { err.textContent = 'Mindestens 8 Zeichen.'; return; }
      const { error } = await Cloud.sb().auth.updateUser({ password: pw.value });
      if (error) { err.textContent = error.message; return; }
      close(); toast('Passwort geändert', 'good');
    } }, 'Speichern'),
  ]);
}

function setSaved(ok) {
  const el = $('#save-state');
  if (el) el.textContent = ok ? '' : '…';
}

// ======================================================================
// Brett
// ======================================================================
function destsOf(fen) {
  const ch = new Chess(fen);
  const d = new Map();
  for (const m of ch.moves({ verbose: true })) {
    if (!d.has(m.from)) d.set(m.from, []);
    d.get(m.from).push(m.to);
  }
  return d;
}
function inCheck(fen) { try { return new Chess(fen).inCheck(); } catch (e) { return false; } }
function lastMoveOf(node) {
  if (!node || !node.parent) return undefined;
  const m = C.moveInfo(node.parent.fen, node.san);
  return m ? [m.from, m.to] : undefined;
}

// Kurzes Symbol (✓ / ✗) auf einem Feld einblenden
function flashMark(boardEl, square, ok) {
  const orient = cg?.state?.orientation || 'white';
  const f = square.charCodeAt(0) - 97, r = +square[1] - 1;
  const x = orient === 'white' ? f : 7 - f;
  const y = orient === 'white' ? 7 - r : r;
  const holder = boardEl.parentElement;
  const cls = ok === 'alt' ? 'alt' : ok ? 'ok' : 'bad';
  const m = h('div', { class: 'sq-mark ' + cls, style: `left:${x * 12.5}%;top:${y * 12.5}%` }, h('span', {}, ok === 'alt' ? '↔' : ok ? '✓' : '✕'));
  holder.append(m);
  setTimeout(() => m.remove(), 900);
}

function makeBoard(el, opts = {}) {
  return Chessground(el, {
    fen: C.START_FEN,
    coordinates: true,
    animation: { enabled: true, duration: 220 },
    highlight: { lastMove: true, check: true },
    premovable: { enabled: false },
    draggable: { showGhost: true },
    drawable: { enabled: true, visible: true, brushes: { engine: { key: 'en', color: '#d08a1d', opacity: 0.85, lineWidth: 9 }, hover: { key: 'hv', color: '#7b5cd6', opacity: 0.75, lineWidth: 10 } } },
    ...opts,
  });
}

// ======================================================================
// Ansicht: Übersicht
// ======================================================================
let cg = null;
let keyHandler = null;
let cleanupView = null;

function setView(view, params = {}) {
  if (cleanupView) { cleanupView(); cleanupView = null; }
  if (cg) { cg.destroy(); cg = null; }
  if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
  app.view = view;
  const main = $('#main');
  main.innerHTML = '';
  main.className = 'view-' + view;
  window.scrollTo(0, 0);
  if (view === 'home') renderHome(main);
  if (view === 'train') renderTrain(main, params);
  if (view === 'edit') renderEdit(main, params);
  if (view === 'spar') renderSpar(main, params);
}

// Tageslimit für neue Stellungen – pro Repertoire, wie die Stapel in Anki
function newUsed(repId) {
  const day = app.settings.newLog?.[C.todayKey()];
  return day && typeof day === 'object' ? day[repId] || 0 : 0;
}
function newQuotaLeft(repId) {
  return Math.max(0, (app.settings.newLinesPerDay ?? 5) - newUsed(repId));
}
function bumpNew(repId, delta) {
  const k = C.todayKey();
  const day = app.settings.newLog?.[k];
  const obj = day && typeof day === 'object' ? { ...day } : {};
  obj[repId] = (obj[repId] || 0) + delta;
  app.settings.newLog = { [k]: obj };
  store.saveSettings();
}

function totals(reps) {
  const now = Date.now();
  let due = 0, fresh = 0, newToday = 0;
  let nextDue = Infinity;
  for (const r of reps) {
    const s = C.lineStats(r, now);
    due += s.due; fresh += s.fresh; newToday += Math.min(s.fresh, newQuotaLeft(r.id));
    nextDue = Math.min(nextDue, s.nextDue);
  }
  return { due, fresh, newToday, nextDue };
}

function pieceIcon(color) {
  // kleines König-Symbol in der Spielfarbe
  return h('span', { class: 'piece-icon ' + (color === 'w' ? 'pw' : 'pb'), title: 'Ich spiele ' + colorName(color) }, '♚');
}

function renderHome(main) {
  const t = totals(app.reps);
  const startCount = t.due + t.newToday;

  const hero = h('section', { class: 'hero' },
    h('div', { class: 'hero-text' },
      h('h1', {}, startCount ? 'Bereit fürs Training?' : app.reps.length ? 'Für heute alles erledigt' : 'Willkommen bei Schach-Anki'),
      h('p', {}, app.reps.length
        ? startCount
          ? `${t.due} Wiederholung${t.due === 1 ? '' : 'en'} fällig, ${t.newToday} neue Variante${t.newToday === 1 ? '' : 'n'} stehen an.`
          : t.nextDue < Infinity ? `Nächste Wiederholung in ${C.formatInterval(t.nextDue - Date.now())}. Du kannst trotzdem neue Varianten hinzufügen.` : 'Du kannst neue Varianten hinzufügen.'
        : 'Füge unten eine Vorlage hinzu oder lege dein eigenes Repertoire an. Danach trainierst du jeden Tag ein paar Minuten, und die App sorgt dafür, dass du jede Stellung genau dann wiederholst, wenn du sie fast vergessen hättest.'),
      app.reps.length ? h('div', { class: 'hero-actions' },
        h('button', { class: 'btn primary big', disabled: !startCount, onclick: () => setView('train', { repIds: app.reps.map((r) => r.id) }) }, startCount ? `Alles trainieren (${startCount})` : 'Nichts fällig 🎉'),
      ) : null,
    ),
    h('div', { class: 'hero-stats' },
      stat('Fällig', t.due, 'due'), stat('Neu heute', t.newToday, 'new'), stat('Repertoires', app.reps.length, ''),
    ),
  );

  const sp = sparState();
  hero.querySelector('.hero-text').append(h('div', { class: 'hero-actions spar-cta' },
    h('button', { class: 'btn big', onclick: () => setView('spar') }, '⚔ Sparring gegen die Engine'),
    h('span', { class: 'muted small' }, `Wertung ${Math.round(sp.rating)} · ${SPAR_MOVES} Züge, danach Auswertung`)));
  const repGrid = h('div', { class: 'grid' });
  for (const rep of app.reps) repGrid.append(repCard(rep));
  repGrid.append(h('button', { class: 'card add-card', onclick: openNewRepDialog },
    h('span', { class: 'plus' }, '+'), h('strong', {}, 'Eigenes Repertoire'), h('span', { class: 'muted' }, 'Züge auf dem Brett eingeben oder PGN einfügen')));

  const available = PRESETS.filter((p) => !app.reps.some((r) => r.presetId === p.id));
  const presetGrid = h('div', { class: 'grid' });
  for (const p of available) {
    const tmpRoot = C.makeRoot(); C.importLines(tmpRoot, p.lines);
    const n = C.collectCards(tmpRoot, p.color).length;
    presetGrid.append(h('div', { class: 'card preset' },
      h('div', { class: 'card-head' }, pieceIcon(p.color), h('h3', {}, p.name)),
      h('p', { class: 'muted' }, p.description),
      h('div', { class: 'card-foot' }, h('span', { class: 'chip' }, `${n} Stellungen · ${colorName(p.color)}`),
        h('button', { class: 'btn', onclick: () => addPreset(p) }, 'Hinzufügen')),
    ));
  }

  main.append(
    hero,
    h('section', {}, h('h2', {}, 'Meine Repertoires'), repGrid),
    available.length ? h('section', {}, h('h2', {}, 'Vorlagen'), h('p', { class: 'muted section-sub' }, 'Fertige Einsteiger-Repertoires. Nach dem Hinzufügen kannst du alles anpassen.'), presetGrid) : null,
    h('section', { class: 'howto' },
      h('h2', {}, 'So funktioniert’s'),
      h('ol', {},
        h('li', {}, h('strong', {}, 'Repertoire anlegen. '), 'Jede Variante – vom ersten Zug bis zum Ende einer Abzweigung – wird zu einer Karteikarte.'),
        h('li', {}, h('strong', {}, 'Neue Züge lernen. '), 'Du spielst die ganze Variante durch, der Gegner zieht automatisch. Bei neuen Zügen zeigt ein Pfeil, was zu spielen ist.'),
        h('li', {}, h('strong', {}, 'Wiederholen. '), 'Fehlerfrei gespielte Varianten kommen in immer größeren Abständen wieder (1 Tag, 3 Tage, 1 Woche …), Varianten mit Fehlern bald nochmal.'),
      ),
    ),
  );
}

function stat(label, value, cls) {
  return h('div', { class: 'stat ' + cls }, h('span', { class: 'stat-num' }, value), h('span', { class: 'stat-label' }, label));
}

function repCard(rep) {
  const s = C.lineStats(rep);
  const pct = s.total ? Math.round((s.seen / s.total) * 100) : 0;
  const quota = newQuotaLeft(rep.id);
  const todo = s.due + Math.min(s.fresh, quota);
  const myMoves = (() => { let n = 0; C.walk(rep.root, (x) => { if (C.isOwnMove(x, rep.color) && !x.bad) n++; }); return n; })();
  const otherMoves = (() => { let n = 0; C.walk(rep.root, (x) => { if (x.parent && !C.isOwnMove(x, rep.color)) n++; }); return n; })();
  const emptyHint = s.total ? null
    : !rep.root.children.length ? 'Noch keine Züge – leg sie im Editor an.'
    : !myMoves ? `Es gibt noch keine Züge für ${colorName(rep.color)}. Spielst du eigentlich ${colorName(rep.color === 'w' ? 'b' : 'w')}? Dann stell die Farbe im Editor um.`
    : s.paused ? 'Alle Stellungen sind pausiert.'
    : `Es fehlen eigene Antworten: Ergänze nach den Zügen von ${colorName(rep.color === 'w' ? 'b' : 'w')} jeweils deinen Zug.`;
  void otherMoves;
  return h('div', { class: 'card rep' },
    h('div', { class: 'card-head' }, pieceIcon(rep.color), h('h3', {}, rep.name)),
    h('div', { class: 'progress', title: `${s.seen} von ${s.total} Varianten gelernt` }, h('div', { class: 'bar', style: `width:${pct}%` })),
    h('div', { class: 'rep-nums' },
      h('span', { class: 'n new' }, h('b', {}, s.fresh), ' neu'),
      h('span', { class: 'n learn' }, h('b', {}, s.learning), ' in Lernphase'),
      h('span', { class: 'n due' }, h('b', {}, s.due), ' fällig'),
      h('span', { class: 'n' }, h('b', {}, s.total), s.total === 1 ? ' Variante' : ' Varianten'),
      s.paused ? h('span', { class: 'n' }, h('b', {}, s.paused), ' pausiert') : null,
    ),
    emptyHint ? h('p', { class: 'empty-hint' }, emptyHint) : null,
    h('div', { class: 'card-foot' },
      h('button', { class: 'btn ghost', onclick: () => setView('edit', { repId: rep.id }) }, 'Bearbeiten'),
      s.total
        ? h('button', { class: 'btn primary', onclick: () => setView('train', { repIds: [rep.id] }) }, todo ? `Trainieren (${todo})` : 'Trainieren')
        : h('button', { class: 'btn primary', onclick: () => setView('edit', { repId: rep.id }) }, 'Züge ergänzen'),
    ),
  );
}

function addPreset(p) {
  const root = C.makeRoot();
  C.importLines(root, p.lines);
  const rep = { id: 'rep_' + uid(), name: p.name, color: p.color, description: p.description, presetId: p.id, root, srs: {}, lines: {}, createdAt: Date.now() };
  app.reps.push(rep);
  store.saveRep(rep);
  toast(`„${p.name}“ hinzugefügt`, 'good');
  setView('home');
}

// ---------- Dialoge ----------
function modal(title, body, actions) {
  const close = () => wrap.remove();
  const wrap = h('div', { class: 'modal-wrap', onclick: (e) => { if (e.target === wrap) close(); } },
    h('div', { class: 'modal', role: 'dialog' },
      h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'icon-btn', onclick: close, 'aria-label': 'Schließen' }, '✕')),
      h('div', { class: 'modal-body' }, body),
      h('div', { class: 'modal-actions' }, actions(close)),
    ));
  document.body.append(wrap);
  const first = wrap.querySelector('input, textarea, select');
  if (first) setTimeout(() => first.focus(), 30);
  return close;
}

function openNewRepDialog() {
  const name = h('input', { type: 'text', placeholder: 'z. B. Sizilianisch Drachen', maxlength: 60 });
  const color = h('select', {}, h('option', { value: 'w' }, 'Weiß'), h('option', { value: 'b' }, 'Schwarz'));
  const pgn = h('textarea', { rows: 5, placeholder: '1.e4 c5 2.Sf3 d6 3.d4 cxd4 4.Sxd4 Sf6 5.Sc3 g6\n\nOder PGN aus Lichess/Chessable einfügen, gern mit Varianten in (Klammern).' });
  const err = h('p', { class: 'error' });
  modal('Neues Repertoire', h('div', { class: 'form' },
    h('label', {}, 'Name', name),
    h('label', {}, 'Ich spiele mit', color),
    h('label', {}, 'Züge (optional)', pgn),
    h('p', { class: 'muted small' }, 'Du kannst die Züge auch später direkt auf dem Brett eingeben.'),
    err,
  ), (close) => [
    h('button', { class: 'btn ghost', onclick: close }, 'Abbrechen'),
    h('button', { class: 'btn primary', onclick: () => {
      const root = C.makeRoot();
      if (pgn.value.trim()) {
        const r = C.importPgn(root, pgn.value);
        if (!r.added) { err.textContent = r.errors[0] || 'Keine Züge erkannt.'; return; }
        if (r.errors.length) toast(`${r.errors.length} Zug/Züge übersprungen: ${r.errors[0]}`, 'bad');
      }
      const rep = { id: 'rep_' + uid(), name: name.value.trim() || 'Mein Repertoire', color: color.value, description: '', root, srs: {}, lines: {}, createdAt: Date.now() };
      app.reps.push(rep);
      store.saveRep(rep);
      close();
      setView('edit', { repId: rep.id });
    } }, 'Anlegen'),
  ]);
}

function openSettings() {
  const npd = h('input', { type: 'number', min: 0, max: 100, value: app.settings.newLinesPerDay ?? 5 });
  const not = h('select', {}, h('option', { value: 'de', selected: app.settings.notation === 'de' }, 'Deutsch (K D T L S)'), h('option', { value: 'en', selected: app.settings.notation === 'en' }, 'Englisch (K Q R B N)'));
  modal('Einstellungen', h('div', { class: 'form' },
    h('label', {}, 'Neue Varianten pro Tag (je Repertoire)', npd),
    h('label', {}, 'Notation', not),
    h('p', { class: 'muted small' }, app.storage === 'cloud'
      ? 'Dein Repertoire und Lernfortschritt werden in deinem Claude-Konto gespeichert und sind nur für dich sichtbar.'
      : IS_WEB ? 'Deine Daten werden in diesem Browser gespeichert. Sichere sie ab und zu mit „Backup herunterladen“ – z. B. bevor du den Browser-Verlauf löschst.'
        : 'Dein Repertoire wird nur in diesem Browser gespeichert. Öffne die Seite angemeldet über claude.ai, um sie im Konto zu sichern.'),
    backupSection(),
  ), (close) => [
    h('button', { class: 'btn primary', onclick: () => {
      app.settings.newLinesPerDay = Math.max(0, Math.min(100, parseInt(npd.value, 10) || 0));
      app.settings.notation = not.value;
      store.saveSettings();
      close();
      setView(app.view === 'home' ? 'home' : app.view, lastParams);
    } }, 'Speichern'),
  ]);
}

// ---------- Backup: alles exportieren / importieren ----------
function makeBackup() {
  const reps = {};
  for (const r of app.reps) reps[r.id] = store.serializeRep(r);
  return { app: 'schach-anki', version: 1, exported: new Date().toISOString(), reps, settings: app.settings };
}
function restoreBackup(text) {
  let d;
  try { d = JSON.parse(text); } catch (e) { throw new Error('Das ist keine gültige Backup-Datei.'); }
  if (!d || d.app !== 'schach-anki' || !d.reps) throw new Error('Das ist kein Schach-Anki-Backup.');
  let added = 0, replaced = 0;
  for (const [id, data] of Object.entries(d.reps)) {
    const rep = store.deserializeRep(id, data);
    const i = app.reps.findIndex((r) => r.id === id);
    if (i >= 0) { app.reps[i] = rep; replaced++; } else { app.reps.push(rep); added++; }
    store.saveRep(rep);
  }
  const s = d.settings || {};
  const mySpar = app.settings.spar, theirSpar = s.spar;
  app.settings = { ...app.settings, ...s, spar: (theirSpar?.games?.length || 0) >= (mySpar?.games?.length || 0) ? theirSpar || mySpar : mySpar };
  store.saveSettings();
  return { added, replaced };
}
function backupSection() {
  const ta = h('textarea', { rows: 3, placeholder: 'Backup-Text hier einfügen …' });
  const file = h('input', { type: 'file', accept: '.json,application/json', class: 'hidden' });
  const doRestore = (text) => {
    try {
      const r = restoreBackup(text);
      toast(`Backup eingespielt: ${r.added} neu, ${r.replaced} ersetzt`, 'good');
      document.querySelector('.modal-wrap')?.remove();
      setView('home');
    } catch (e) { toast(e.message, 'bad'); }
  };
  file.addEventListener('change', async () => { const f = file.files[0]; if (f) doRestore(await f.text()); });
  return h('div', { class: 'backup' },
    h('h4', {}, 'Backup'),
    h('p', { class: 'muted small' }, 'Sichert alle Repertoires, deinen Lernstand und die Sparring-Partien. So kannst du deine Daten auch auf eine andere Seite oder ein anderes Gerät mitnehmen.'),
    h('div', { class: 'add-actions' },
      h('button', { class: 'btn small', onclick: () => {
        const json = JSON.stringify(makeBackup());
        try {
          const a = h('a', { href: URL.createObjectURL(new Blob([json], { type: 'application/json' })), download: `schach-anki-backup-${C.todayKey()}.json` });
          document.body.append(a); a.click(); a.remove();
          if (!IS_WEB) toast('Falls kein Download startet: „Backup kopieren“ nutzen.');
        } catch (e) { toast('Download nicht möglich – nutze „Backup kopieren“.', 'bad'); }
      } }, '💾 Backup herunterladen'),
      h('button', { class: 'btn small', onclick: async (e) => {
        const json = JSON.stringify(makeBackup());
        try { await navigator.clipboard.writeText(json); e.target.textContent = 'Kopiert ✓'; }
        catch (err) { ta.value = json; ta.select(); e.target.textContent = 'Markiert – jetzt Strg+C'; }
      } }, '📋 Backup kopieren')),
    h('div', { class: 'add-actions' },
      h('button', { class: 'btn small', onclick: () => file.click() }, '📂 Backup-Datei einspielen'), file),
    ta,
    h('button', { class: 'btn small', onclick: () => { if (ta.value.trim()) doRestore(ta.value.trim()); } }, 'Eingefügten Text einspielen'));
}

function confirmDialog(title, text, okLabel, onOk) {
  modal(title, h('p', {}, text), (close) => [
    h('button', { class: 'btn ghost', onclick: close }, 'Abbrechen'),
    h('button', { class: 'btn danger', onclick: () => { close(); onOk(); } }, okLabel),
  ]);
}

// ======================================================================
// Ansicht: Training
// ======================================================================
let lastParams = {};

function renderTrain(main, { repIds, cram = false }) {
  lastParams = { repIds, cram };
  const reps = app.reps.filter((r) => repIds.includes(r.id));
  const session = { done: 0, clean: 0, lastKey: null, sinceNew: 0 };
  let cramQueue = null;

  const boardEl = h('div', { class: 'board' });
  const counters = h('div', { class: 'counters' });
  const title = h('div', { class: 'train-title' });
  const prog = h('div', { class: 'line-prog' });
  const moves = h('div', { class: 'movelist' });
  const histNav = h('div', { class: 'hist-nav' });
  const altEl = h('div', { class: 'alt-moves hidden' });
  const feedback = h('div', { class: 'feedback' });
  const commentEl = h('div', { class: 'comment-box hidden' });
  const actions = h('div', { class: 'train-actions' });

  main.append(
    h('div', { class: 'topline' },
      h('button', { class: 'btn ghost', onclick: () => setView('home') }, '← Übersicht'),
      counters),
    h('div', { class: 'layout' },
      h('div', { class: 'board-col' }, h('div', { class: 'board-holder' }, boardEl)),
      h('aside', { class: 'panel' }, title, prog, moves, histNav, altEl, feedback, commentEl, actions),
    ),
  );

  cg = makeBoard(boardEl, { movable: { free: false, color: undefined } });

  // ---------- Auswahl der nächsten Variante ----------
  function items() {
    const out = [];
    reps.forEach((rep, ri) => {
      const lines = C.collectLines(rep.root, rep.color);
      const keys = new Set(lines.map((l) => l.key));
      for (const line of lines) {
        if (line.weight === 'pause') continue;
        out.push({ rep, line, s: C.lineSrs(rep.lines, line, keys), sortNew: line.prio * 1e9 + ri * 1e6 + line.order });
      }
    });
    return out;
  }
  function candidates() {
    const now = Date.now();
    const learn = [], review = [], fresh = [], ahead = [];
    for (const it of items()) {
      const s = it.s;
      if (!s || s.state === 'new') fresh.push(it);
      else if (s.due <= now) (s.state === 'review' ? review : learn).push(it);
      else if (s.state !== 'review' && s.due - now < 20 * 60 * 1000) ahead.push(it);
    }
    learn.sort((a, b) => a.s.due - b.s.due);
    review.sort((a, b) => a.s.due - b.s.due);
    fresh.sort((a, b) => a.sortNew - b.sortNew);
    ahead.sort((a, b) => a.s.due - b.s.due);
    const left = new Map(reps.map((r) => [r.id, newQuotaLeft(r.id)]));
    const freshAllowed = fresh.filter((i) => { const n = left.get(i.rep.id); if (n > 0) { left.set(i.rep.id, n - 1); return true; } return false; });
    return { learn, review, fresh: freshAllowed, freshAll: fresh.length, ahead };
  }
  function pickCram() {
    if (!cramQueue) {
      const all = items();
      const seen = all.filter((i) => i.s && i.s.state !== 'new');
      cramQueue = (seen.length ? seen : all).sort(() => Math.random() - 0.5);
    }
    counters.innerHTML = '';
    counters.append(h('span', { class: 'cnt cram' }, `Freies Üben · ${cramQueue.length} Varianten übrig`));
    return cramQueue.shift() || null;
  }
  function pick() {
    if (cram) return pickCram();
    const c = candidates();
    counters.innerHTML = '';
    counters.append(
      h('span', { class: 'cnt new', title: 'Neue Varianten' }, c.fresh.length),
      h('span', { class: 'cnt learn', title: 'Varianten in der Lernphase' }, c.learn.length + c.ahead.length),
      h('span', { class: 'cnt due', title: 'Fällige Wiederholungen' }, c.review.length),
    );
    const id = (i) => i.rep.id + '|' + i.line.key;
    const notLast = (arr) => arr.find((i) => id(i) !== session.lastKey) || arr[0];
    if (c.learn.length && (c.learn.length > 1 || (!c.review.length && !c.fresh.length) || id(c.learn[0]) !== session.lastKey)) return notLast(c.learn);
    if (c.fresh.length && (!c.review.length || session.sinceNew >= 3)) { session.sinceNew = 0; return c.fresh[0]; }
    if (c.review.length) { session.sinceNew++; return notLast(c.review); }
    if (c.ahead.length) return notLast(c.ahead);
    return null;
  }

  let timers = [];
  const later = (fn, ms) => timers.push(setTimeout(fn, ms));
  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };
  cleanupView = clearTimers;
  let keys = {};
  keyHandler = (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (e.key === 'ArrowLeft' && keys.left) { e.preventDefault(); keys.left(); }
    else if (e.key === 'ArrowRight' && keys.right) { e.preventDefault(); keys.right(); }
    else if ((e.key === 'Enter' || e.key === ' ') && keys.enter) { e.preventDefault(); keys.enter(); }
  };
  document.addEventListener('keydown', keyHandler);

  function finish() {
    keys = {};
    cg.set({ movable: { color: undefined, dests: new Map() } });
    cg.setAutoShapes([]);
    [title, prog, moves, histNav, actions].forEach((e) => { e.innerHTML = ''; });
    altEl.classList.add('hidden'); commentEl.classList.add('hidden');
    const stats = reps.map((r) => C.lineStats(r));
    const nextDue = Math.min(...stats.map((s) => s.nextDue), Infinity);
    const total = stats.reduce((n, s) => n + s.total, 0);
    const c = cram ? null : candidates();
    const blockedNew = c ? c.freshAll - c.fresh.length : 0;
    feedback.className = 'feedback done';
    feedback.innerHTML = '';
    feedback.append(...[
      h('div', { class: 'big-emoji' }, '🏁'),
      h('h3', {}, cram ? 'Freies Üben beendet' : session.done ? 'Geschafft!' : 'Gerade nichts zu tun'),
      session.done ? h('p', {}, `${session.done} Variante${session.done === 1 ? '' : 'n'} ${cram ? 'geübt' : 'trainiert'}, ${session.clean} davon fehlerfrei.`) : null,
      blockedNew ? h('p', {}, `Das Tageslimit für neue Varianten ist erreicht – ${blockedNew} weitere warten noch.`) : null,
      !cram && nextDue < Infinity ? h('p', { class: 'muted' }, `Nächste Wiederholung in ${C.formatInterval(nextDue - Date.now())}.`) : null,
      !total ? h('p', { class: 'muted' }, 'In diesem Repertoire gibt es noch keine Varianten mit eigenen Zügen. Prüf im Editor die Farbe und ergänze deine Züge.') : null,
      h('div', { class: 'done-actions' },
        blockedNew ? h('button', { class: 'btn primary', onclick: () => { reps.forEach((r) => bumpNew(r.id, -5)); setView('train', { repIds }); } }, '5 weitere neue Varianten lernen') : null,
        total ? h('button', { class: 'btn' + (blockedNew ? '' : ' primary'), title: 'Alle Varianten in zufälliger Reihenfolge – ändert nichts an der Wiederholungsplanung', onclick: () => setView('train', { repIds, cram: true }) }, cram ? 'Nochmal frei üben' : 'Freies Üben') : null,
        h('button', { class: 'btn ghost', onclick: () => setView('home') }, 'Zur Übersicht')),
    ].filter(Boolean));
  }

  function next() {
    clearTimers();
    const item = pick();
    if (!item) return finish();
    show(item);
  }

  // ---------- Eine Variante abspielen ----------
  function show({ rep, line, s }) {
    const isNew = !cram && (!s || s.state === 'new');
    const learned = isNew ? C.learnedPositions(rep) : new Set();
    const opp = colorName(rep.color === 'w' ? 'b' : 'w');
    let idx = 0;                 // Index des nächsten Zugs in line.nodes
    let ready = false, done = false, viewing = null;
    let tries = 0, helped = false, arrowOn = false;
    const errors = [];           // Züge, bei denen ein Fehler passiert ist
    session.lastKey = rep.id + '|' + line.key;
    const ownTotal = line.ownCount;

    // Kopf
    title.innerHTML = '';
    const vn = C.variationName(line.leaf);
    const eco = vn.length ? null : X.openingName(line.leaf);
    const sub = vn.length ? vn.join(' › ') : eco ? eco.name : '';
    title.append(pieceIcon(rep.color), h('span', { class: 'tt' }, h('span', {}, rep.name), sub ? h('span', { class: 'tsub' }, sub) : null),
      h('span', { class: 'badges' },
        line.important ? h('span', { class: 'badge imp' }, '! Wichtig') : null,
        line.weight && C.WEIGHTS[line.weight] ? h('span', { class: 'badge wt w-' + line.weight, title: C.WEIGHTS[line.weight].label }, C.WEIGHTS[line.weight].icon + ' ' + C.WEIGHTS[line.weight].short) : null,
        cram ? h('span', { class: 'badge multi' }, 'Freies Üben') : isNew ? h('span', { class: 'badge new' }, 'Neue Variante') : s.state === 'review' ? h('span', { class: 'badge due' }, 'Wiederholung') : h('span', { class: 'badge learn' }, 'Lernphase')));

    feedback.className = 'feedback'; feedback.innerHTML = '';
    actions.innerHTML = '';
    altEl.classList.add('hidden');
    commentEl.classList.add('hidden');
    cg.setAutoShapes([]);
    cg.set({ orientation: cgColor(rep.color), fen: C.START_FEN, lastMove: undefined, check: false, movable: { color: undefined, dests: new Map() } });

    const pos = () => (idx === 0 ? rep.root : line.nodes[idx - 1]);
    const ownDone = () => line.nodes.slice(0, idx).filter((n) => C.isOwnMove(n, rep.color)).length;

    function renderProg() {
      prog.innerHTML = '';
      const d = ownDone();
      prog.append(h('div', { class: 'lp-bar' }, h('div', { class: 'lp-fill', style: `width:${(d / ownTotal) * 100}%` })),
        h('span', { class: 'muted small' }, `Deine Züge: ${d} / ${ownTotal}` + (errors.length ? ` · ${errors.length} Fehler` : '')));
    }

    function renderMoves() {
      const played = line.nodes.slice(0, idx);
      const shown = viewing;
      moves.innerHTML = '';
      const ml = h('div', { class: 'line' });
      ml.append(h('span', { class: 'mv start' + (shown === rep.root ? ' cur' : ''), title: 'Startstellung', onclick: () => viewAt(rep.root) }, '⌂'));
      for (const n of played) {
        const ply = C.plyOf(n);
        if (ply % 2 === 1) ml.append(h('span', { class: 'num' }, `${Math.ceil(ply / 2)}.`));
        const sib = n.parent.children.length - 1;
        const err = errors.includes(n);
        ml.append(h('span', { class: 'mv' + (n === shown ? ' cur' : '') + (n.bad ? ' bad' : '') + (err ? ' err' : ''), onclick: () => viewAt(n), title: sib ? `Hier gibt es noch ${sib} weitere${sib === 1 ? 'n Zug' : ' Züge'} im Repertoire` : '' },
          fmt(n.san) + (n.bad ? '??' : ''), sib ? h('sup', { class: 'sib' }, '+' + sib) : null));
      }
      if (!done && idx < line.nodes.length && C.isOwnMove(line.nodes[idx], rep.color)) {
        const ply = C.plyOf(line.nodes[idx]);
        if (ply % 2 === 1) ml.append(h('span', { class: 'num' }, `${Math.ceil(ply / 2)}.`));
        ml.append(h('span', { class: 'mv q' + (viewing ? '' : ' cur'), onclick: back }, '?'));
      }
      moves.append(ml);
      histNav.innerHTML = '';
      histNav.append(h('span', { class: 'hist-inner' },
        h('button', { class: 'icon-btn', title: 'Vorheriger Zug (←)', disabled: !(ready || done) || !played.length, onclick: () => keys.left() }, '◀'),
        h('button', { class: 'icon-btn', title: 'Nächster Zug (→)', disabled: !viewing, onclick: () => keys.right() }, '▶'),
        viewing ? h('span', { class: 'view-note' }, 'Rückblick') : null,
        viewing ? h('button', { class: 'btn small', onclick: back }, done ? 'Zur Endstellung' : 'Zurück zur Aufgabe') : null));
    }
    function viewAt(n) {
      if (!(ready || done)) return;
      if (n === pos()) return back();
      clearTimers();
      viewing = n;
      cg.set({ fen: n.fen, turnColor: cgColor(C.turnOf(n.fen)), lastMove: lastMoveOf(n), check: inCheck(n.fen), movable: { color: undefined, dests: new Map() } });
      cg.setAutoShapes([]);
      renderMoves();
    }
    function back() {
      viewing = null;
      if (done) { const p = pos(); cg.set({ fen: p.fen, lastMove: lastMoveOf(p), check: inCheck(p.fen), movable: { color: undefined, dests: new Map() } }); cg.setAutoShapes([]); }
      else enable();
      renderMoves();
    }
    keys = {
      left: () => { if (!(ready || done)) return; const p = [rep.root, ...line.nodes.slice(0, idx)]; const i = p.indexOf(viewing || pos()); if (i > 0) viewAt(p[i - 1]); },
      right: () => { if (!viewing) return; const p = [rep.root, ...line.nodes.slice(0, idx)]; const i = p.indexOf(viewing); if (p[i + 1]) viewAt(p[i + 1]); },
      enter: null,
    };

    function showAlts(n) {
      const alts = n.parent.children.filter((c) => c !== n);
      altEl.innerHTML = '';
      altEl.classList.toggle('hidden', !alts.length);
      if (alts.length) altEl.append(h('span', { class: 'alt-icon' }, '⑂'),
        h('span', {}, `${opp} hat hier ${alts.length === 1 ? 'noch einen weiteren Zug' : `noch ${alts.length} weitere Züge`} in deinem Repertoire: `,
          ...alts.map((c) => h('span', { class: 'alt-chip' + (c.bad ? ' bad' : '') }, fmt(c.san) + (c.bad ? '??' : '')))));
    }
    function showComment(n) {
      if (!n.comment) return;
      commentEl.innerHTML = '';
      commentEl.append(h('strong', {}, fmt(n.san) + ': '), n.comment);
      commentEl.classList.remove('hidden');
    }

    const expected = () => line.nodes[idx];
    function shapes() {
      const p = pos(), e = expected();
      if (!e) return [];
      const m = C.moveInfo(p.fen, e.san);
      if (arrowOn) return [{ orig: m.from, dest: m.to, brush: 'green' }];
      if (helped) return [{ orig: m.from, brush: 'yellow' }];
      return [];
    }
    function enable() {
      const p = pos();
      cg.set({
        fen: p.fen, turnColor: cgColor(C.turnOf(p.fen)), lastMove: lastMoveOf(p), check: inCheck(p.fen),
        movable: { free: false, color: cgColor(rep.color), dests: destsOf(p.fen), showDests: true, events: { after: onMove } },
      });
      cg.setAutoShapes(shapes());
    }
    function prompt() {
      feedback.className = 'feedback'; feedback.innerHTML = '';
      const e = expected(), p = pos();
      if (arrowOn && tries === 0) feedback.append(h('p', {}, h('strong', {}, 'Neu: '), 'Spiel den markierten Zug.'));
      else feedback.append(h('p', {}, p.parent && !C.isOwnMove(p, rep.color) ? `${opp} hat ${fmt(p.san)}${p.bad ? '??' : ''} gespielt. ` : '', h('strong', {}, p.bad && !C.isOwnMove(p, rep.color) ? 'Wie bestrafst du den Fehler?' : 'Dein Zug?')));
      void e;
      actions.innerHTML = '';
      actions.append(
        h('button', { class: 'btn ghost', onclick: hint }, 'Tipp'),
        h('button', { class: 'btn ghost', onclick: reveal }, 'Zug zeigen'),
        analyseBtn());
    }
    const analyseBtn = () => h('button', { class: 'btn ghost', title: 'Stellung auf dem Analysebrett ansehen', onclick: () => setView('edit', { repId: rep.id, key: C.keyOf(viewing || pos()), engine: true, analysis: true, back: { repIds, cram } }) }, '🔍 Analysebrett');
    function markError() { const e = expected(); if (!errors.includes(e)) errors.push(e); renderProg(); }
    function hint() { if (!ready || viewing) return; if (!isNew || learned.has(C.keyOf(pos()))) markError(); helped = true; cg.setAutoShapes(shapes()); }
    function reveal() { if (!ready || viewing) return; if (!arrowOn) markError(); arrowOn = true; cg.setAutoShapes(shapes()); feedback.innerHTML = ''; feedback.append(h('p', {}, 'Richtig ist ', h('strong', {}, fmt(expected().san)), '. Spiel den Zug nach.')); }

    function onMove(orig, dest) {
      if (!ready || viewing || done) return;
      const p = pos(), e = expected();
      const piece = cg.state.pieces.get(dest);
      const promo = piece && piece.role === 'pawn' && (dest[1] === '8' || dest[1] === '1') ? 'q' : undefined;
      const r = C.tryMove(p.fen, { from: orig, to: dest, promotion: promo || 'q' });
      if (r && r.san === e.san) {
        flashMark(boardEl, dest, true);
        ready = false;
        idx++;
        showComment(e);
        feedback.className = 'feedback ok'; feedback.innerHTML = '';
        feedback.append(h('p', {}, h('strong', {}, '✓ ' + fmt(e.san))));
        renderProg();
        later(step, 120);
        return;
      }
      const other = r && C.goodChildren(p).find((c) => c.san === r.san);
      if (other) {
        // Auch im Repertoire – aber nicht in dieser Variante
        flashMark(boardEl, dest, 'alt');
        arrowOn = true;
        feedback.className = 'feedback meh'; feedback.innerHTML = '';
        feedback.append(h('p', {}, h('strong', {}, `${fmt(r.san)} ist auch in deinem Repertoire. `), 'In dieser Variante spielen wir aber ', h('strong', {}, fmt(e.san)), '.'));
        later(enable, 450);
        return;
      }
      flashMark(boardEl, dest, false);
      tries++;
      markError();
      if (tries >= 2) arrowOn = true;
      const trap = r && C.badChildren(p).find((c) => c.san === r.san);
      feedback.className = 'feedback bad'; feedback.innerHTML = '';
      if (trap) {
        feedback.append(h('p', {}, h('strong', {}, `⚠ Falle! ${fmt(r.san)}?? ist ein bekannter Fehler.`)));
        if (trap.comment) feedback.append(h('p', { class: 'comment' }, trap.comment));
      } else feedback.append(h('p', {}, h('strong', {}, r ? `✕ ${fmt(r.san)} ist nicht in deinem Repertoire.` : '✕ Ungültiger Zug.')));
      feedback.append(h('p', {}, arrowOn ? ['Richtig ist ', h('strong', {}, fmt(e.san)), '. Spiel den Zug nach.'] : 'Versuch es gleich nochmal – oder „Zug zeigen“.'));
      later(enable, trap ? 700 : 300);
    }

    // Gegnerzüge automatisch, bei eigenen Zügen warten
    function step() {
      if (idx >= line.nodes.length) return finishLine();
      const n = line.nodes[idx];
      const p = pos();
      renderMoves();
      if (!C.isOwnMove(n, rep.color)) {
        ready = false;
        cg.set({ movable: { color: undefined, dests: new Map() } });
        cg.setAutoShapes([]);
        later(() => {
          const m = C.moveInfo(p.fen, n.san);
          if (m) cg.move(m.from, m.to);
          idx++;
          showAlts(n);
          if (n.comment) showComment(n);
          later(step, 220);
        }, idx === 0 ? 400 : 260);
        return;
      }
      tries = 0; helped = false;
      arrowOn = isNew && !learned.has(C.keyOf(p));
      ready = true;
      enable();
      prompt();
      renderMoves();
      renderProg();
    }

    function finishLine() {
      done = true; ready = false;
      cg.set({ movable: { color: undefined, dests: new Map() } });
      cg.setAutoShapes([]);
      const clean = errors.length === 0;
      let after = s;
      if (!cram) {
        const grade = clean ? 'good' : 'again';
        after = C.schedule(s && s.state !== 'new' ? s : null, grade, Date.now(), line.factor);
        rep.lines[line.key] = after;
        if (s?.inherited) delete rep.lines[s.inherited];
        if (isNew) bumpNew(rep.id, 1);
        store.saveRep(rep);
      }
      session.done++;
      if (clean) session.clean++;
      renderMoves();
      renderProg();
      feedback.className = 'feedback ' + (clean ? 'ok' : 'meh');
      feedback.innerHTML = '';
      feedback.append(h('p', {}, h('strong', {}, clean ? '✓ Variante fehlerfrei gespielt!' : `Variante beendet – ${errors.length} Fehler`)));
      if (!clean) feedback.append(h('p', { class: 'small' }, 'Fehler bei: ', ...errors.map((n, i) => {
        const ply = C.plyOf(n);
        return h('span', { class: 'err-chip', onclick: () => viewAt(n) }, `${Math.ceil(ply / 2)}${ply % 2 ? '.' : '…'} ${fmt(n.san)}`, i < errors.length - 1 ? ' ' : '');
      })));
      if (!cram) feedback.append(h('p', { class: 'muted small' }, `Nächste Abfrage in ${C.formatInterval(after.due - Date.now())}.`));
      actions.innerHTML = '';
      if (!cram && clean && s?.state === 'review') {
        actions.append(h('button', { class: 'btn ghost', title: 'Längeres Intervall', onclick: () => {
          rep.lines[line.key] = C.schedule(s, 'easy', Date.now(), line.factor); store.saveRep(rep); next();
        } }, 'Zu leicht'));
      }
      actions.append(analyseBtn(), h('button', { class: 'btn primary', onclick: next }, 'Weiter'));
      keys.enter = next;
      if (clean && commentEl.classList.contains('hidden')) later(() => { if (!viewing) next(); }, 1100);
    }

    renderProg();
    renderMoves();
    step();
  }

  next();
}


// ======================================================================
// Varianten-Assistent: schlägt anhand der Meisterpartien Linien vor
// ======================================================================
async function suggestLines(rep, start, opts) {
  const lines = [];
  const maxPly = rep.color === 'w' ? opts.toMove * 2 - 1 : opts.toMove * 2; // endet nach meinem N. Zug
  let budget = 400; // max. Datenbankabfragen
  async function rec(fen, treeNode, path, ply, share) {
    if (lines.length >= 60 || budget-- <= 0) { lines.push({ path, share }); return; }
    const mine = C.turnOf(fen) === rep.color;
    if (ply >= maxPly && !mine) { lines.push({ path, share }); return; }
    let res;
    try { res = await X.lookup(fen); } catch (e) { lines.push({ path, share }); return; }
    let picks = [];
    if (mine) {
      const own = treeNode ? C.goodChildren(treeNode).map((c) => c.san) : [];
      if (own.length) picks = own.map((san) => ({ san, share: 1 }));
      else if (res.total >= opts.minGames) {
        const cand = res.moves.filter((m) => m.n >= Math.max(3, opts.minGames / 4) && m.share >= 0.05);
        const bad = new Set(treeNode ? C.badChildren(treeNode).map((c) => c.san) : []);
        const pool = cand.filter((m) => !bad.has(m.san));
        let best = null;
        if (opts.own === 'popular') best = pool[0];
        else best = pool.filter((m) => m.share >= 0.1).sort((a, b) => b.score - a.score)[0] || pool[0];
        if (best) picks = [{ san: best.san, share: 1, stat: best }];
      }
    } else {
      const seen = new Set();
      if (res.total >= opts.minGames) {
        for (const m of res.moves.filter((m) => m.share >= opts.oppShare).slice(0, opts.oppMax)) { picks.push({ san: m.san, share: m.share, stat: m }); seen.add(m.san); }
      }
      if (treeNode) for (const c of treeNode.children) if (!seen.has(c.san) && !c.bad) { const st = res.moves.find((m) => m.san === c.san); picks.push({ san: c.san, share: st ? st.share : 0 }); }
    }
    if (!picks.length) { lines.push({ path, share }); return; }
    for (const p of picks) {
      const r = C.tryMove(fen, p.san);
      if (!r) continue;
      const child = treeNode ? treeNode.children.find((c) => c.san === r.san) || null : null;
      await rec(r.fen, child, [...path, { san: r.san, isNew: !child, stat: p.stat }], ply + 1, share * p.share);
    }
  }
  await rec(start.fen, start, [], C.plyOf(start), 1);
  return lines.filter((l) => l.path.some((m) => m.isNew)).sort((a, b) => b.share - a.share);
}

function openWizard(rep, start, onDone) {
  const startPly = C.plyOf(start);
  const minTo = Math.max(3, Math.ceil((startPly + 2) / 2));
  const toSel = h('select', {}, [6, 7, 8, 9, 10, 11].filter((n) => n >= minTo).concat(minTo > 11 ? [] : []).map((n) => h('option', { value: n, selected: n === Math.min(11, Math.max(minTo, Math.ceil(startPly / 2) + 3)) }, `bis Zug ${n}`)));
  if (!toSel.options.length) toSel.append(h('option', { value: 11 }, 'bis Zug 11'));
  const shareSel = h('select', {}, [['0.05', 'ab 5 %'], ['0.1', 'ab 10 %'], ['0.2', 'ab 20 %'], ['0.3', 'ab 30 %']].map(([v, l]) => h('option', { value: v, selected: v === '0.2' }, l)));
  const maxSel = h('select', {}, [1, 2, 3, 4].map((n) => h('option', { value: n, selected: n === 2 }, `höchstens ${n}`)));
  const ownSel = h('select', {}, h('option', { value: 'popular' }, 'Meistgespielter Zug'), h('option', { value: 'score' }, 'Beste Ergebnisse'));
  const list = h('div', { class: 'wiz-list' });
  const info = h('p', { class: 'muted small' });
  let lines = [];
  let addBtn;
  let calc = 0;

  const startLabel = start.parent ? `nach ${Math.ceil(startPly / 2)}${startPly % 2 ? '.' : '…'} ${fmt(start.san)}` : 'ab der Startstellung';
  const body = h('div', { class: 'form' },
    h('p', { class: 'muted small' }, `Der Assistent baut ${startLabel} Varianten aus den Meisterpartien: Für dich wählt er einen Zug (oder nimmt deinen vorhandenen), für den Gegner alle häufigen Antworten. Du siehst die Vorschläge und wählst aus, was übernommen wird.`),
    h('div', { class: 'wiz-opts' },
      h('label', {}, 'Tiefe', toSel),
      h('label', {}, 'Gegnerzüge', shareSel),
      h('label', {}, 'pro Stellung', maxSel),
      h('label', {}, 'Mein Zug', ownSel)),
    info, list);

  async function compute() {
    const id = ++calc;
    list.innerHTML = '';
    info.textContent = 'Berechne Vorschläge …';
    if (addBtn) addBtn.disabled = true;
    const opts = { toMove: +toSel.value, oppShare: +shareSel.value, oppMax: +maxSel.value, own: ownSel.value, minGames: 10 };
    lines = await suggestLines(rep, start, opts);
    if (id !== calc) return;
    if (!lines.length) { info.textContent = 'Keine neuen Vorschläge – entweder ist hier schon alles abgedeckt oder die Stellung ist in der Datenbank zu selten.'; return; }
    const newMoves = new Set();
    lines.forEach((l) => { let k = C.keyOf(start); l.path.forEach((m) => { k += ' ' + m.san; if (m.isNew) newMoves.add(k); }); });
    info.textContent = `${lines.length} Variante${lines.length === 1 ? '' : 'n'} mit ${newMoves.size} neuen Zügen. Neue Züge sind hervorgehoben.`;
    lines.forEach((l, i) => {
      l.checked = true;
      const cb = h('input', { type: 'checkbox', checked: true, onchange: () => { l.checked = cb.checked; updateBtn(); } });
      const mv = h('span', { class: 'wiz-moves' });
      let ply = startPly;
      l.path.forEach((m, j) => {
        ply++;
        if (ply % 2 === 1) mv.append(h('span', { class: 'num' }, `${Math.ceil(ply / 2)}.`));
        else if (j === 0) mv.append(h('span', { class: 'num' }, `${Math.ceil(ply / 2)}…`));
        mv.append(h('span', { class: m.isNew ? 'new' : 'old' }, fmt(m.san)), ' ');
      });
      list.append(h('label', { class: 'wiz-line' }, cb, mv, h('span', { class: 'wiz-share', title: 'Anteil der Meisterpartien, die (ab hier) in diese Variante laufen' }, l.share >= 0.01 ? Math.round(l.share * 100) + '%' : '<1%')));
      void i;
    });
    updateBtn();
  }
  function updateBtn() {
    if (!addBtn) return;
    const n = lines.filter((l) => l.checked).length;
    addBtn.disabled = !n;
    addBtn.textContent = n ? `${n} Variante${n === 1 ? '' : 'n'} übernehmen` : 'Nichts ausgewählt';
  }
  [toSel, shareSel, maxSel, ownSel].forEach((s) => s.addEventListener('change', compute));

  const close = modal('✨ Varianten-Assistent', body, (closeFn) => {
    addBtn = h('button', { class: 'btn primary', disabled: true, onclick: () => {
      let added = 0;
      for (const l of lines.filter((x) => x.checked)) {
        let n = start;
        for (const m of l.path) { const r = C.addChild(n, m.san); if (!r) break; if (r.created) added++; n = r.node; }
      }
      store.saveRep(rep);
      closeFn();
      toast(`${added} Züge hinzugefügt`, 'good');
      onDone(start);
    } }, 'Übernehmen');
    return [h('button', { class: 'btn ghost', onclick: closeFn }, 'Abbrechen'), addBtn];
  });
  document.querySelector('.modal')?.classList.add('wide');
  void close;
  compute();
}

// ======================================================================
// Ansicht: Sparring – 15 Züge gegen die Engine, danach Auswertung
// ======================================================================
const SPAR_MOVES = 15;
let sparEngine = null;

function sparState() {
  if (!app.settings.spar) app.settings.spar = { rating: 1200, games: [] };
  return app.settings.spar;
}
// Spielstärke der Engine passend zur eigenen Wertung (Stockfish „Skill Level“ 0–20)
const skillFor = (rating) => Math.max(0, Math.min(20, Math.round((rating - 800) / 85)));

// Grobe Zuordnung durchschnittlicher Zugverlust → Spielstärke
// (ACPL 10 ≈ 2800, 25 ≈ 2400, 50 ≈ 1880, 80 ≈ 1390, 120 ≈ 930)
function perfFromAcpl(acpl) {
  return Math.max(400, Math.min(2900, Math.round(3100 * Math.exp(-0.0105 * acpl))));
}

function evalText(cpUser) {
  const a = Math.abs(cpUser);
  const side = cpUser >= 0 ? 'Du stehst' : 'Die Engine steht';
  if (a < 50) return 'Die Stellung ist ausgeglichen.';
  if (a < 150) return `${side} leicht besser.`;
  if (a < 300) return `${side} deutlich besser.`;
  return cpUser >= 0 ? 'Du stehst auf Gewinn.' : 'Die Engine steht auf Gewinn.';
}

function renderSpar(main, params = {}) {
  lastParams = params;
  const st = sparState();
  if (params.report) return renderSparReport(main, params.report, params.sel);
  if (!params.color) return renderSparStart(main, st);
  renderSparGame(main, st, params.color, params.resume);
}

function renderSparStart(main, st) {
  const last = st.games.slice(-10).reverse();
  const pending = readPending();
  const choose = (c) => setView('spar', { color: c === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : c });
  main.append(
    h('div', { class: 'topline' }, h('button', { class: 'btn ghost', onclick: () => setView('home') }, '← Übersicht')),
    h('section', { class: 'hero spar-hero' },
      h('div', { class: 'hero-text' },
        h('h1', {}, '⚔ Sparring gegen die Engine'),
        h('p', {}, `Spiel ${SPAR_MOVES} Züge gegen Stockfish in voller Stärke. In der Eröffnung antwortet die Engine mit Hauptzügen aus Meisterpartien, danach rechnet sie selbst. Zum Schluss bekommst du eine Auswertung: Wie stehst du, wo bist du von deinem Repertoire abgewichen und wo waren Fehler?`),
        h('div', { class: 'hero-actions' },
          h('button', { class: 'btn primary big', onclick: () => choose('w') }, '♔ Mit Weiß'),
          h('button', { class: 'btn primary big', onclick: () => choose('b') }, '♚ Mit Schwarz'),
          h('button', { class: 'btn big', onclick: () => choose('r') }, 'Zufällig'))),
      h('div', { class: 'hero-stats' },
        stat('Deine Wertung', Math.round(st.rating), 'due'),
        stat('Partien', st.games.length, ''),
        stat('Letzte Leistung', st.games.length && st.games[st.games.length - 1].perf ? st.games[st.games.length - 1].perf : '–', 'new'))),
    pending && pending.sans?.length ? h('section', {}, h('div', { class: 'pending' },
      h('p', {}, h('strong', {}, 'Eine Partie wurde noch nicht ausgewertet. '), `(${colorName(pending.color)}, ${Math.ceil(pending.sans.length / 2)} Züge)`),
      h('div', { class: 'add-actions' },
        h('button', { class: 'btn primary', onclick: () => setView('spar', { color: pending.color, resume: pending.sans }) }, 'Jetzt auswerten'),
        h('button', { class: 'btn ghost', onclick: () => { try { localStorage.removeItem(PENDING_KEY); } catch (e) { /* egal */ } setView('spar'); } }, 'Verwerfen')))) : null,
    st.games.length >= 2 ? h('section', {}, h('h2', {}, 'Wertungsverlauf'), ratingChart(st.games)) : null,
    h('section', { class: 'howto' }, h('h2', {}, 'So funktioniert die Wertung'),
      h('p', { class: 'muted' }, 'Nach jeder Partie wird gemessen, wie viel du pro Zug im Schnitt gegenüber dem besten Engine-Zug verlierst (durchschnittlicher Zugverlust in Hundertstel-Bauern). Daraus ergibt sich eine Partie-Leistung – z. B. etwa 2400 bei 25, 1900 bei 50, 1400 bei 80 –, dazu kommen bis zu ±150 Punkte je nachdem, wie du nach 15 Zügen stehst. Deine Wertung bewegt sich schrittweise in Richtung dieser Leistung: in den ersten Partien schnell, danach immer ruhiger. Sie ist ein Trainingswert und nicht direkt mit Lichess oder DWZ vergleichbar.')),
    last.length ? h('section', {}, h('h2', {}, 'Letzte Partien'),
      h('div', { class: 'spar-hist' }, ...last.map((g) => h('div', { class: 'spar-row', onclick: () => setView('spar', { report: g }) },
        h('span', {}, new Date(g.d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })),
        pieceIcon(g.c),
        h('span', { class: 'spar-open' }, g.open || '–'),
        h('span', { class: 'spar-ev' }, (g.cpUser >= 0 ? '+' : '') + (g.cpUser / 100).toFixed(1)),
        h('span', {}, `${g.acc}%`),
        h('span', { class: 'muted' }, g.perf ? `≈${g.perf}` : ''),
        h('span', { class: g.delta >= 0 ? 'pos' : 'neg' }, (g.delta >= 0 ? '+' : '') + g.delta))))) : null,
  );
}

function ratingChart(games) {
  const pts = [games[0].rBefore ?? 1200, ...games.map((g) => g.rAfter)];
  const W = 640, H = 150, P = 24;
  const lo = Math.min(...pts) - 30, hi = Math.max(...pts) + 30;
  const x = (i) => P + (i * (W - 2 * P)) / Math.max(1, pts.length - 1);
  const y = (v) => H - P - ((v - lo) / (hi - lo)) * (H - 2 * P);
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="rchart"><path d="${d}" fill="none" stroke="#e2a54a" stroke-width="2.5"/>` +
    pts.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="3.5" fill="#e2a54a"><title>${v}</title></circle>`).join('') +
    `<text x="${P}" y="14" class="rc-l">${Math.round(hi - 30)}</text><text x="${P}" y="${H - 6}" class="rc-l">${Math.round(lo + 30)}</text></svg>`;
  return h('div', { class: 'rchart-wrap', html: svg });
}

const PENDING_KEY = 'schach-anki-spar-pending';
function readPending() { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); } catch (e) { return null; } }

function renderSparGame(main, st, color, resume) {
  const boardEl = h('div', { class: 'board' });
  const info = h('div', { class: 'spar-info' });
  const movesEl = h('div', { class: 'movelist' });
  const status = h('div', { class: 'feedback' });
  const openEl = h('div', { class: 'muted small' });
  main.append(
    h('div', { class: 'topline' },
      h('button', { class: 'btn ghost', onclick: () => confirmDialog('Partie abbrechen?', 'Die Partie wird nicht gewertet.', 'Abbrechen', () => setView('spar')) }, '← Abbrechen'),
      h('div', { class: 'counters' }, h('span', { class: 'cnt cram' }, `Wertung ${Math.round(st.rating)}`))),
    h('div', { class: 'layout' },
      h('div', { class: 'board-col' }, h('div', { class: 'board-holder' }, boardEl)),
      h('aside', { class: 'panel' }, h('div', { class: 'train-title' }, pieceIcon(color), h('span', { class: 'tt' }, h('span', {}, 'Sparring'), h('span', { class: 'tsub' }, `Du spielst ${colorName(color)} · Stockfish volle Stärke`))), info, openEl, movesEl, status)));

  const chess = new Chess();
  const sans = [];
  let thinking = false, over = false;
  let cancelled = false;
  cleanupView = () => { cancelled = true; };
  if (!sparEngine) sparEngine = new Engine(1);
  cg = makeBoard(boardEl, { orientation: cgColor(color), movable: { free: false, color: undefined } });

  const ownCount = () => sans.filter((_, i) => (i % 2 === 0) === (color === 'w')).length;
  function paint() {
    info.innerHTML = '';
    const n = ownCount();
    info.append(h('div', { class: 'lp-bar' }, h('div', { class: 'lp-fill', style: `width:${(n / SPAR_MOVES) * 100}%` })), h('span', { class: 'muted small' }, `Dein Zug ${Math.min(n + 1, SPAR_MOVES)} von ${SPAR_MOVES}`));
    movesEl.innerHTML = '';
    const line = h('div', { class: 'line' });
    sans.forEach((s, i) => { if (i % 2 === 0) line.append(h('span', { class: 'num' }, `${i / 2 + 1}.`)); line.append(h('span', { class: 'mv' }, fmt(s))); });
    if (!sans.length) line.append(h('span', { class: 'muted' }, 'Startstellung'));
    movesEl.append(line);
    X.loadNames().then(() => {
      let name = null; const c2 = new Chess();
      for (const s of sans) { c2.move(s); const x = X.nameOf(c2.fen()); if (x) name = x; }
      openEl.textContent = name ? `${name.eco} · ${name.name}` : '';
    }).catch(() => {});
  }
  function setBoard(lastMove) {
    const fen = chess.fen();
    const myTurn = chess.turn() === color && !over && !thinking;
    cg.set({ fen, turnColor: cgColor(chess.turn()), lastMove, check: chess.inCheck(), movable: { free: false, color: myTurn ? cgColor(color) : undefined, dests: myTurn ? destsOf(fen) : new Map(), events: { after: onMove } } });
  }
  function onMove(orig, dest) {
    if (over || thinking || chess.turn() !== color) return;
    let m;
    try { m = chess.move({ from: orig, to: dest, promotion: 'q' }); } catch (e) { setBoard(); return; }
    sans.push(m.san);
    paint();
    if (ownCount() >= SPAR_MOVES || chess.isGameOver()) return end();
    engineMove();
  }
  async function engineMove() {
    thinking = true;
    setBoard([sans.length ? undefined : undefined].filter(Boolean)[0]);
    status.className = 'feedback'; status.innerHTML = '';
    status.append(h('p', { class: 'muted' }, 'Die Engine überlegt …'));
    const fen = chess.fen();
    let uci = null, source = 'engine';
    // Eröffnungsphase: menschlich wirkende Züge aus den Meisterpartien
    if (sans.length < 20) {
      try {
        const res = await X.lookup(fen);
        const pool = res.moves.filter((m) => m.share >= 0.1 && m.score >= 0.4);
        if (res.total >= 20 && pool.length) {
          const sum = pool.reduce((a, m) => a + m.n, 0);
          let r = Math.random() * sum;
          for (const m of pool) { r -= m.n; if (r <= 0) { uci = m.from + m.to; break; } }
          uci = uci || pool[0].from + pool[0].to;
          source = 'book';
        }
      } catch (e) { /* Datenbank nicht erreichbar */ }
    }
    if (!uci) {
      try {
        const res = await sparEngine.run(fen, 'go movetime 1500', { skill: 20 });
        uci = res.best;
      } catch (e) { status.innerHTML = ''; status.append(h('p', {}, 'Die Engine konnte nicht geladen werden.')); return; }
    }
    if (cancelled) return;
    await new Promise((r) => setTimeout(r, source === 'book' ? 350 : 100));
    if (cancelled) return;
    const m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
    sans.push(m.san);
    thinking = false;
    setBoard([m.from, m.to]);
    paint();
    status.innerHTML = '';
    status.append(h('p', {}, h('strong', {}, 'Dein Zug.'), source === 'book' ? h('span', { class: 'muted' }, ' (Die Engine spielt noch Theorie.)') : ''));
    if (chess.isGameOver()) end();
  }

  async function end() {
    over = true;
    setBoard();
    const fens = [new Chess().fen()];
    const c2 = new Chess();
    for (const s of sans) { c2.move(s); fens.push(c2.fen()); }
    status.className = 'feedback'; status.innerHTML = '';
    const bar = h('div', { class: 'lp-fill', style: 'width:0%' });
    const txt = h('span', { class: 'muted small' }, `Stellung 0 von ${fens.length}`);
    status.append(h('p', {}, h('strong', {}, 'Partie beendet – die Engine wertet aus …')), h('div', { class: 'lp-bar' }, bar), txt);
    // Partie zwischenspeichern, damit sie bei einem Abbruch nicht verloren geht
    try { localStorage.setItem(PENDING_KEY, JSON.stringify({ color, sans, d: Date.now() })); } catch (e) { /* egal */ }
    try {
      // Jede Stellung bewerten (aus Sicht von Weiß) – höchstens ~0,6 s pro Stellung
      const evals = [];
      for (let i = 0; i < fens.length; i++) {
        if (cancelled) return;
        const ch = new Chess(fens[i]);
        if (ch.isCheckmate()) evals.push({ cp: ch.turn() === 'w' ? -1500 : 1500, best: null });
        else if (ch.isGameOver()) evals.push({ cp: 0, best: null });
        else {
          const r = await sparEngine.run(fens[i], 'go depth 14 movetime 600', { skill: 20, timeout: 2500 });
          const best = r.best && r.best !== '(none)' ? r.best : null;
          evals.push({ cp: C.evalToCp(r.lines[0]), best });
        }
        bar.style.width = ((i + 1) / fens.length) * 100 + '%';
        txt.textContent = `Stellung ${i + 1} von ${fens.length}`;
      }
      if (cancelled) return;
      const report = buildReport(color, sans, fens, evals, st);
      st.games.push(report);
      if (st.games.length > 40) st.games = st.games.slice(-40);
      store.saveSettings();
      try { localStorage.removeItem(PENDING_KEY); } catch (e) { /* egal */ }
      setView('spar', { report });
    } catch (e) {
      if (cancelled) return;
      status.className = 'feedback bad'; status.innerHTML = '';
      status.append(h('p', {}, h('strong', {}, 'Die Auswertung ist fehlgeschlagen.')),
        h('p', { class: 'muted small' }, String(e && e.message || e)),
        h('div', { class: 'train-actions' },
          h('button', { class: 'btn primary', onclick: () => end() }, 'Nochmal auswerten'),
          h('button', { class: 'btn ghost', onclick: () => setView('spar') }, 'Zurück')));
    }
  }

  if (resume) {
    for (const s of resume) { const m = chess.move(s); sans.push(m.san); }
    paint();
    end();
    return;
  }
  paint();
  setBoard();
  if (color === 'b') engineMove();
  else { status.append(h('p', {}, h('strong', {}, 'Du beginnst.'), ' Spiel deinen ersten Zug.')); }
}

function buildReport(color, sans, fens, evals, st) {
  const moves = [];
  let accSum = 0, accN = 0, cpLossSum = 0;
  const counts = { blunder: 0, mistake: 0, inacc: 0 };
  sans.forEach((san, i) => {
    const mine = (i % 2 === 0) === (color === 'w');
    const before = evals[i].cp, after = evals[i + 1].cp;
    const wb = C.winPct(before), wa = C.winPct(after);
    const loss = Math.max(0, color === 'w' ? wb - wa : wa - wb);
    const ch = new Chess(fens[i]);
    let bestSan = null;
    if (evals[i].best) { try { bestSan = ch.move({ from: evals[i].best.slice(0, 2), to: evals[i].best.slice(2, 4), promotion: evals[i].best[4] || 'q' }).san; } catch (e) { /* egal */ } }
    let cls = null;
    if (mine) {
      if (loss >= 30) { cls = 'blunder'; counts.blunder++; }
      else if (loss >= 20) { cls = 'mistake'; counts.mistake++; }
      else if (loss >= 10) { cls = 'inacc'; counts.inacc++; }
      else if (bestSan === san) cls = 'best';
      accSum += Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669));
      const cb = Math.max(-1000, Math.min(1000, before)), ca = Math.max(-1000, Math.min(1000, after));
      cpLossSum += Math.max(0, color === 'w' ? cb - ca : ca - cb);
      accN++;
    }
    moves.push({ san, mine, loss: Math.round(loss), cls, best: bestSan, bestUci: evals[i].best, cp: after });
  });
  const finalCp = evals[evals.length - 1].cp;
  const cpUser = color === 'w' ? finalCp : -finalCp;
  const acc = accN ? Math.round(accSum / accN) : 0;
  // Wertung: Partie gegen gleich starke Engine, Ergebnis = Gewinnchance der Endstellung
  // Leistung der Partie aus dem durchschnittlichen Verlust pro Zug (ACPL)
  const acpl = Math.round(cpLossSum / Math.max(1, accN));
  // Qualität der Züge (ACPL) plus ein kleiner Zuschlag / Abzug für die erreichte Stellung
  const perf = Math.max(400, Math.min(2900, Math.round(perfFromAcpl(acpl) + 300 * (C.winPct(cpUser) / 100 - 0.5))));
  const before = st.rating;
  const n = st.games.length;
  const k = n < 3 ? 0.5 : n < 10 ? 0.25 : 0.15; // anfangs schnell, später stabil
  st.rating = Math.round(before + k * (perf - before));
  const delta = st.rating - before;
  // Eröffnungsname
  let open = null;
  const c2 = new Chess();
  for (const s of sans) { c2.move(s); const x = X.nameOf(c2.fen()); if (x) open = x.name; }
  return { d: Date.now(), c: color, sans, moves, finalCp, cpUser, acc, counts, delta, rBefore: before, rAfter: st.rating, open, acpl, perf, startCp: evals[0].cp, v: 2 };
}

// Abgleich mit den eigenen Repertoires dieser Farbe
function repertoireCheck(color, sans) {
  let best = null;
  for (const rep of app.reps.filter((r) => r.color === color)) {
    let node = rep.root;
    let res = null;
    for (let i = 0; i < sans.length; i++) {
      const child = node.children.find((c) => c.san === sans[i]);
      const mine = (i % 2 === 0) === (color === 'w');
      if (child) {
        if (child.bad && mine) { res = { type: 'trap', ply: i, node, played: sans[i], rep }; break; }
        node = child; continue;
      }
      if (!node.children.length) { res = { type: 'end', ply: i, node, rep }; break; }
      res = mine
        ? { type: 'own', ply: i, node, played: sans[i], expected: C.goodChildren(node).map((c) => c.san), rep }
        : { type: 'opp', ply: i, node, played: sans[i], rep };
      break;
    }
    if (!res) res = { type: 'full', ply: sans.length, node, rep };
    if (!best || res.ply > best.ply) best = res;
  }
  return best;
}

function renderSparReport(main, g, initialSel) {
  if (!prefs.reportInit) { prefs.engine = true; prefs.db = true; prefs.reportInit = true; }
  const boardEl = h('div', { class: 'board' });
  const detail = h('div', { class: 'feedback' });
  const addBox = h('div', { class: 'add-box' });
  const fens = [new Chess().fen()];
  const c2 = new Chess();
  for (const s of g.sans) { c2.move(s); fens.push(c2.fen()); }
  const N = g.sans.length;
  const plyLabel = (i) => `${Math.floor(i / 2) + 1}${i % 2 === 0 ? '.' : '…'} ${fmt(g.sans[i])}`;
  const ICON = { blunder: ['??', 'Patzer'], mistake: ['?', 'Fehler'], inacc: ['?!', 'Ungenauigkeit'], best: ['★', 'Bester Zug'] };
  const isErr = (m) => m.mine && m.cls && m.cls !== 'best';

  // ----- Abgleich mit dem Repertoire -----
  const rc = repertoireCheck(g.c, g.sans);
  const inRep = (i) => rc && i < rc.ply;               // Zug stammt aus deinem Repertoire
  const devAt = rc && rc.ply < N ? rc.ply : -1;         // hier wurde das Repertoire verlassen

  // ----- Ereignisse: Abweichung + Fehler, in Partie-Reihenfolge -----
  const events = [];
  if (rc && devAt >= 0) {
    const ex = (rc.expected || []).map(fmt).join(' oder ');
    if (rc.type === 'own') events.push({ i: devAt, cls: 'dev', label: plyLabel(devAt), text: `Von „${rc.rep.name}“ abgewichen – vorbereitet war ${ex}` });
    if (rc.type === 'opp') events.push({ i: devAt, cls: 'oppdev', label: plyLabel(devAt), text: `Engine verlässt „${rc.rep.name}“ – keine vorbereitete Antwort` });
    if (rc.type === 'end') events.push({ i: devAt, cls: 'end', label: plyLabel(devAt), text: `Ende deines Repertoires „${rc.rep.name}“ – bis hier alles nach Plan` });
    if (rc.type === 'trap') events.push({ i: devAt, cls: 'dev', label: plyLabel(devAt), text: 'Selbst als Fehler (Falle) markierten Zug gespielt!' });
  }
  g.moves.forEach((m, i) => { if (isErr(m)) events.push({ i, cls: 'c-' + m.cls, label: plyLabel(i) + ICON[m.cls][0], text: `${ICON[m.cls][1]} · besser ${fmt(m.best || '?')}` }); });
  events.sort((a, b) => a.i - b.i);

  const listEl = h('div', { class: 'move-table' });
  let sel = initialSel ?? -1;

  function select(i) {
    sel = i;
    markChart(i);
    listEl.querySelectorAll('.rm').forEach((e) => e.classList.toggle('cur', +e.dataset.i === i));
    evBox.querySelectorAll('.err-btn').forEach((e) => e.classList.toggle('cur', +e.dataset.i === i));
    detail.className = 'feedback'; detail.innerHTML = '';
    if (i < 0) {
      cg.set({ fen: fens[0], lastMove: undefined, check: false, movable: { color: undefined, dests: new Map() } });
      baseShapes = []; shownFen = fens[0];
      detail.append(h('p', { class: 'muted' }, 'Startstellung – mit → durch die Partie blättern.'));
      paintAdd(); refreshTools();
      return;
    }
    const m = g.moves[i];
    const info = C.moveInfo(fens[i], m.san);
    const err = isErr(m) && m.bestUci;
    const shapes = [];
    // Bei Fehlern: Stellung VOR dem Zug, roter Pfeil = gespielt, grüner Pfeil = besser
    const fen = err ? fens[i] : fens[i + 1];
    if (err) {
      if (info) shapes.push({ orig: info.from, dest: info.to, brush: 'red' });
      shapes.push({ orig: m.bestUci.slice(0, 2), dest: m.bestUci.slice(2, 4), brush: 'green' });
    }
    if (i === devAt && rc.type === 'own') {
      for (const san of rc.expected || []) { const mi = C.moveInfo(fens[i], san); if (mi) shapes.push({ orig: mi.from, dest: mi.to, brush: 'blue' }); }
    }
    const prev = i > 0 ? C.moveInfo(fens[i - 1], g.sans[i - 1]) : null;
    const showBefore = err || (i === devAt && rc.type === 'own');
    cg.set({ fen: showBefore ? fens[i] : fen, lastMove: showBefore ? (prev ? [prev.from, prev.to] : undefined) : info ? [info.from, info.to] : undefined, check: inCheck(showBefore ? fens[i] : fen), movable: { color: undefined, dests: new Map() } });
    baseShapes = shapes; shownFen = showBefore ? fens[i] : fen;
    refreshTools();
    const curRow = listEl.querySelector('.rm.cur');
    if (curRow) curRow.scrollIntoView({ block: 'nearest' });
    detail.className = 'feedback' + (m.cls === 'blunder' || m.cls === 'mistake' ? ' bad' : m.cls === 'inacc' ? ' meh' : '');
    const ev = (m.cp >= 0 ? '+' : '') + (m.cp / 100).toFixed(2);
    detail.append(h('p', {}, h('strong', {}, plyLabel(i) + (isErr(m) ? ICON[m.cls][0] : '')), ` · Bewertung ${ev}`, m.mine ? '' : h('span', { class: 'muted' }, ' · Zug der Engine')));
    if (inRep(i)) detail.append(h('p', { class: 'tag-rep' }, `📖 Aus deinem Repertoire „${rc.rep.name}“`));
    if (i === devAt && rc.type === 'own') detail.append(h('p', { class: 'tag-dev' }, '⑂ Hier bist du von deiner Vorbereitung abgewichen. Vorbereitet war ', h('strong', {}, (rc.expected || []).map(fmt).join(' oder ')), ' (blauer Pfeil).'));
    if (i === devAt && rc.type === 'opp') detail.append(h('p', { class: 'tag-opp' }, '⑂ Diesen Zug hast du noch nicht vorbereitet – du kannst ihn unten ins Repertoire übernehmen.'));
    if (i === devAt && rc.type === 'end') detail.append(h('p', { class: 'muted' }, 'Ab hier hat dein Repertoire keine Züge mehr.'));
    if (isErr(m)) detail.append(h('p', {}, `${ICON[m.cls][1]} (−${m.loss} % Gewinnchance). Rot: dein Zug – besser war `, h('strong', {}, fmt(m.best || '?')), ' (grün). Engine und Datenbank zeigen die Stellung vor deinem Zug.'));
    else if (m.mine && m.cls === 'best') detail.append(h('p', {}, '★ Bester Zug laut Engine.'));
    paintAdd();
  }

  // ----- Ins Repertoire übernehmen -----
  const reps = () => app.reps.filter((r) => r.color === g.c);
  let addRepId = rc?.rep?.id || reps()[0]?.id || '__new';
  function countNew(rep, list) {
    if (!rep) return list.length;
    let n = rep.root, c = 0;
    for (const san of list) { const ch = n && n.children.find((x) => x.san === san); if (ch) n = ch; else { c++; n = null; } }
    return c;
  }
  function addMoves(list) {
    let rep = app.reps.find((r) => r.id === addRepId);
    if (!rep) {
      rep = { id: 'rep_' + uid(), name: g.open ? g.open.split(':')[0] : `Sparring ${colorName(g.c)}`, color: g.c, description: '', root: C.makeRoot(), srs: {}, lines: {}, createdAt: Date.now() };
      app.reps.push(rep);
      addRepId = rep.id;
    }
    let n = rep.root, created = 0;
    for (const san of list) { const r = C.addChild(n, san); if (!r) break; if (r.created) created++; n = r.node; }
    store.saveRep(rep);
    toast(created ? `${created} ${created === 1 ? 'Zug' : 'Züge'} zu „${rep.name}“ hinzugefügt` : 'War schon im Repertoire', 'good');
    setView('spar', { report: g, sel });
  }
  function paintAdd() {
    addBox.innerHTML = '';
    addBox.append(h('h4', {}, '➕ Ins Repertoire übernehmen'));
    if (sel < 0) { addBox.append(h('p', { class: 'muted small' }, 'Wähle einen Zug – dann kannst du die Partie bis dorthin übernehmen.')); return; }
    const m = g.moves[sel];
    const selEl = h('select', { onchange: () => { addRepId = selEl.value; paintAdd(); } },
      reps().map((r) => h('option', { value: r.id, selected: r.id === addRepId }, r.name)),
      h('option', { value: '__new', selected: addRepId === '__new' }, '+ Neues Repertoire'));
    const rep = app.reps.find((r) => r.id === addRepId);
    const upto = g.sans.slice(0, sel + 1);
    const nNew = countNew(rep, upto);
    addBox.append(h('label', { class: 'field' }, 'Repertoire', selEl));
    addBox.append(h('div', { class: 'add-actions' },
      h('button', { class: 'btn primary small', disabled: !nNew, onclick: () => addMoves(upto) },
        nNew ? `Partie bis ${plyLabel(sel)} übernehmen (${nNew} neu)` : `Bis ${plyLabel(sel)} schon im Repertoire`),
      isErr(m) && m.best ? h('button', { class: 'btn small', onclick: () => addMoves([...g.sans.slice(0, sel), m.best]) }, `Mit besserem Zug ${fmt(m.best)} übernehmen`) : null,
      !m.mine && sel + 1 < N && !isErr(g.moves[sel + 1]) ? h('button', { class: 'btn small', onclick: () => addMoves(g.sans.slice(0, sel + 2)) }, `Mit deiner Antwort ${plyLabel(sel + 1)} übernehmen`) : null,
      rep ? h('button', { class: 'btn ghost small', onclick: () => {
        let n = rep.root, k = 0;
        for (const san of upto) { const ch = n.children.find((x) => x.san === san); if (!ch) break; n = ch; k++; }
        setView('edit', { repId: rep.id, key: C.keyOf(n), analysis: true, back: { view: 'spar', report: g, sel }, preload: upto.slice(k) });
      } }, '🔍 Im Analysebrett') : null));
  }

  function markChart() { /* Graph entfernt */ }

  // ----- Engine & Datenbank für die angezeigte Stellung -----
  const toolsEl = h('div', { class: 'report-tools' });
  const dbEl = h('div', { class: 'dbx' });
  const engEl = h('div', { class: 'engine' });
  let shownFen = fens[0], baseShapes = [], engRes = null, dbReq = 0, engTimer = null, lastPaint = 0;
  if (!engine) engine = new Engine();
  const prevCleanup = cleanupView;
  cleanupView = () => { if (prevCleanup) prevCleanup(); engine.stop(); clearTimeout(engTimer); };
  function toolBtn(label, key) {
    return h('button', { class: 'btn small tool-' + key + (prefs[key] ? ' on' : ''), onclick: () => { prefs[key] = !prefs[key]; refreshTools(); } }, label);
  }
  function refreshTools() {
    toolsEl.innerHTML = '';
    toolsEl.append(h('div', { class: 'tool-row' }, toolBtn('📚 Datenbank', 'db'), toolBtn('⚙ Engine', 'engine')), dbEl, engEl);
    dbEl.classList.toggle('hidden', !prefs.db);
    engEl.classList.toggle('hidden', !prefs.engine);
    paintDbR(); runEngine();
  }
  function applyShapesR() {
    const sh = [...baseShapes];
    const best = prefs.engine && engRes?.fen === shownFen ? engRes.lines?.[0] : null;
    if (best?.pv?.[0]) sh.push({ orig: best.pv[0].slice(0, 2), dest: best.pv[0].slice(2, 4), brush: 'engine' });
    cg.setAutoShapes(sh);
  }
  function runEngine() {
    engRes = null; paintEng(); applyShapesR();
    if (!prefs.engine) { engine.stop(); return; }
    const fen = shownFen;
    if (new Chess(fen).isGameOver()) { engRes = { fen, lines: [], over: true }; paintEng(); return; }
    engine.analyse(fen, (res) => {
      if (res.fen !== shownFen || !prefs.engine) return;
      engRes = res;
      const now = Date.now();
      clearTimeout(engTimer);
      if (now - lastPaint > 150 || res.done) { lastPaint = now; paintEng(); applyShapesR(); }
      else engTimer = setTimeout(() => { lastPaint = Date.now(); paintEng(); applyShapesR(); }, 160);
    }).catch(() => { engRes = { fen, lines: [], error: true }; paintEng(); });
  }
  function paintEng() {
    engEl.innerHTML = '';
    if (!prefs.engine) return;
    const best = engRes?.lines?.[0];
    engEl.append(h('div', { class: 'engine-head' },
      h('span', { class: 'engine-eval' }, engRes?.over ? '–' : formatEval(best)),
      h('span', { class: 'muted small' }, engRes?.error ? 'Engine nicht verfügbar' : best ? `Stockfish · Tiefe ${best.depth}` + (engRes.done ? '' : ' …') : 'Stockfish rechnet …')));
    const ply0 = new Chess(shownFen).history().length; void ply0;
    const [, turn, , , , full] = shownFen.split(' ');
    for (const l of engRes?.lines || []) {
      if (!l || !l.san) continue;
      const mv = h('span', { class: 'emoves' });
      let num = +full, white = turn === 'w';
      l.san.forEach((san, i) => {
        if (white) mv.append(h('span', { class: 'num' }, `${num}.`));
        else if (i === 0) mv.append(h('span', { class: 'num' }, `${num}…`));
        mv.append(h('span', { class: i === 0 ? 'first' : '' }, fmt(san)), ' ');
        if (!white) num++;
        white = !white;
      });
      engEl.append(h('div', { class: 'eline static' }, h('span', { class: 'echip' + ((l.mate ?? l.cp) >= 0 ? ' w' : ' b') }, formatEval(l)), mv));
    }
  }
  async function paintDbR() {
    if (!prefs.db) return;
    const id = ++dbReq, fen = shownFen;
    let res;
    try { [res] = await Promise.all([X.lookup(fen), X.loadNames().catch(() => null)]); } catch (e) { dbEl.innerHTML = ''; dbEl.append(h('p', { class: 'muted small' }, 'Datenbank nicht verfügbar.')); return; }
    if (id !== dbReq) return;
    dbEl.innerHTML = '';
    const nm = X.nameOf(fen);
    dbEl.append(h('div', { class: 'db-head' },
      nm ? h('div', { class: 'db-name' }, h('span', { class: 'eco' }, nm.eco), nm.name) : null,
      h('div', { class: 'muted small' }, res.total ? `${res.total.toLocaleString('de-DE')} Meisterpartien` : 'Keine Meisterpartien mit dieser Stellung')));
    if (!res.total) return;
    const table = h('div', { class: 'db-table' }, h('div', { class: 'db-row head' }, h('span', {}, 'Zug'), h('span', {}, 'Anteil'), h('span', {}, 'Weiß / Remis / Schwarz')));
    for (const m of res.moves.slice(0, 8)) {
      const pct = (x) => Math.round((x / m.n) * 100);
      table.append(h('div', { class: 'db-row', onmouseenter: () => { baseShapes.push({ orig: m.from, dest: m.to, brush: 'hover' }); applyShapesR(); }, onmouseleave: () => { baseShapes = baseShapes.filter((x) => x.brush !== 'hover'); applyShapesR(); } },
        h('span', { class: 'db-move' }, fmt(m.san)),
        h('span', { class: 'db-n' }, h('b', {}, Math.round(m.share * 100) + '%'), ' ', h('span', { class: 'muted' }, m.n.toLocaleString('de-DE'))),
        h('span', { class: 'wdl' },
          h('span', { class: 'w', style: `width:${pct(m.w)}%` }, pct(m.w) >= 15 ? pct(m.w) + '%' : ''),
          h('span', { class: 'd', style: `width:${pct(m.d)}%` }, pct(m.d) >= 15 ? pct(m.d) + '%' : ''),
          h('span', { class: 'b', style: `width:${pct(m.b)}%` }, pct(m.b) >= 15 ? pct(m.b) + '%' : ''))));
    }
    dbEl.append(table);
  }

  // ----- Ereignisliste -----
  const evBox = h('div', { class: 'err-list' },
    events.length ? events.map((ev) => h('button', { class: 'err-btn ' + ev.cls, 'data-i': ev.i, onclick: () => select(ev.i) }, h('b', {}, ev.label), h('span', {}, ' ' + ev.text)))
      : null,
    !events.some((e) => e.cls.startsWith('c-')) ? h('p', { class: 'good-note' }, '✓ Keine Fehler – stark gespielt!') : null,
    !rc ? h('p', { class: 'muted small' }, `Du hast noch kein Repertoire für ${colorName(g.c)} – unten kannst du die Partie direkt als Repertoire übernehmen.`) : null);

  // ----- Zugliste (zwei Spalten) -----
  const cell = (i) => {
    if (i >= N) return h('span', { class: 'rm empty' });
    const m = g.moves[i];
    const cls = 'rm' + (m.mine ? ' mine' : '') + (m.cls ? ' c-' + m.cls : '') + (inRep(i) ? ' in-rep' : '') + (i === devAt ? ' dev-' + rc.type : '');
    return h('span', { class: cls, 'data-i': i, onclick: () => select(i), title: inRep(i) ? 'Aus deinem Repertoire' : i === devAt ? 'Hier wurde das Repertoire verlassen' : '' },
      i === devAt && (rc.type === 'own' || rc.type === 'opp') ? h('span', { class: 'devmark' }, '⑂') : inRep(i) ? h('span', { class: 'bookmark' }, '📖') : null,
      fmt(m.san), isErr(m) ? h('sup', {}, ICON[m.cls][0]) : m.cls === 'best' ? h('sup', { class: 'bst' }, '★') : null);
  };
  for (let i = 0; i < N; i += 2) listEl.append(h('div', { class: 'mt-row' }, h('span', { class: 'mt-num' }, `${i / 2 + 1}.`), cell(i), cell(i + 1)));

  // ----- Tastatur: ← → Züge, ↑ ↓ Ereignisse -----
  keyHandler = (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); select(Math.max(-1, sel - 1)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); select(Math.min(N - 1, sel + 1)); }
    else if (e.key === 'Home') { e.preventDefault(); select(-1); }
    else if (e.key === 'End') { e.preventDefault(); select(N - 1); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const list = events.map((x) => x.i);
      const nx = e.key === 'ArrowDown' ? list.find((x) => x > sel) : [...list].reverse().find((x) => x < sel);
      if (nx != null) select(nx);
    }
  };
  document.addEventListener('keydown', keyHandler);
  const navRow = h('div', { class: 'nav' },
    h('button', { class: 'icon-btn', title: 'Start (Pos1)', onclick: () => select(-1) }, '⏮'),
    h('button', { class: 'icon-btn', title: 'Zurück (←)', onclick: () => select(Math.max(-1, sel - 1)) }, '◀'),
    h('button', { class: 'icon-btn', title: 'Vor (→)', onclick: () => select(Math.min(N - 1, sel + 1)) }, '▶'),
    h('button', { class: 'icon-btn', title: 'Ende (Ende)', onclick: () => select(N - 1) }, '⏭'),
    h('button', { class: 'icon-btn', title: 'Nächstes Ereignis (↓)', onclick: () => { const nx = events.map((x) => x.i).find((x) => x > sel); if (nx != null) select(nx); } }, '⤓'));

  const cpTxt = (g.cpUser >= 0 ? '+' : '') + (g.cpUser / 100).toFixed(2);
  main.append(
    h('div', { class: 'topline' },
      h('button', { class: 'btn ghost', onclick: () => setView('spar') }, '← Sparring'),
      h('div', { class: 'topline-right' },
        h('button', { class: 'btn primary', onclick: () => setView('spar', { color: g.c }) }, `Neue Partie mit ${colorName(g.c)}`))),
    h('div', { class: 'layout' },
      h('div', { class: 'board-col' }, h('div', { class: 'board-holder' }, boardEl),
        navRow,
        h('p', { class: 'muted small center' }, '← → durch die Partie blättern · ↑ ↓ zum vorherigen / nächsten Ereignis (Abweichung oder Fehler). Rot = dein Zug, grün = besser, blau = vorbereitet, orange = Engine.'),
        detail,
        addBox),
      h('aside', { class: 'panel' },
        h('div', { class: 'train-title' }, pieceIcon(g.c), h('span', { class: 'tt' }, h('span', {}, 'Auswertung'), h('span', { class: 'tsub' }, g.open || 'Sparring'))),
        h('div', { class: 'res-box' },
          h('div', { class: 'res-row' },
            h('div', { class: 'res' }, h('b', {}, g.acc + '%'), h('span', {}, 'Genauigkeit')),
            h('div', { class: 'res' }, h('b', { class: 'c-blunder' }, g.counts.blunder), h('span', {}, 'Patzer')),
            h('div', { class: 'res' }, h('b', { class: 'c-mistake' }, g.counts.mistake), h('span', {}, 'Fehler')),
            h('div', { class: 'res' }, h('b', { class: 'c-inacc' }, g.counts.inacc), h('span', {}, 'Ungenau')),
            h('div', { class: 'res' }, h('b', {}, g.rAfter, h('small', { class: g.delta >= 0 ? 'pos' : 'neg' }, ' ' + (g.delta >= 0 ? '+' : '') + g.delta)), h('span', {}, 'Wertung'))),
          h('p', { class: 'small' }, h('strong', {}, evalText(g.cpUser)), ` (${cpTxt})`, g.perf ? h('span', { class: 'muted' }, ` · Partie-Leistung ≈ ${g.perf}`) : null)),
        h('h4', {}, 'Was ist passiert?'),
        evBox,
        toolsEl,
        h('h4', {}, 'Notation'),
        listEl)));

  cg = makeBoard(boardEl, { orientation: cgColor(g.c), movable: { color: undefined } });
  select(initialSel ?? (events.length ? events[0].i : -1));
}

// ======================================================================
// Ansicht: Editor
// ======================================================================
function renderEdit(main, { repId, key, engine: engineParam, analysis: analysisParam = false, back = null, preload = null }) {
  lastParams = { repId, key };
  let analysis = analysisParam;
  let tempTip = null; // Ende der ausprobierten (noch nicht gespeicherten) Linie
  if (engineParam) prefs.engine = true;
  const rep = app.reps.find((r) => r.id === repId);
  if (!rep) return setView('home');
  let cur = (key && C.findByKey(rep.root, key)) || rep.root;
  let orientation = cgColor(rep.color);

  const boardEl = h('div', { class: 'board' });
  const evalFill = h('div', { class: 'eval-fill' });
  const evalBar = h('div', { class: 'eval-bar', title: 'Bewertung der Engine' }, evalFill);
  const enginePanel = h('div', { class: 'engine' });
  const dbPanel = h('div', { class: 'dbx' });
  const tree = h('div', { class: 'tree' });
  const nodeInfo = h('div', { class: 'node-info' });
  const statsEl = h('div', { class: 'edit-stats' });
  const anaBox = h('div', { class: 'ana-box' });
  const modeBtn = h('button', { class: 'btn small mode-btn', onclick: () => { analysis = !analysis; paintMode(); } });
  const boardHint = h('p', { class: 'muted small center' });

  const nameInput = h('input', { class: 'title-input', value: rep.name, maxlength: 60, onchange: () => { rep.name = nameInput.value.trim() || rep.name; store.saveRep(rep); } });
  const colorSel = h('select', { onchange: () => { rep.color = colorSel.value; orientation = cgColor(rep.color); store.saveRep(rep); cg.set({ orientation }); refresh(); } },
    h('option', { value: 'w', selected: rep.color === 'w' }, 'Ich spiele Weiß'),
    h('option', { value: 'b', selected: rep.color === 'b' }, 'Ich spiele Schwarz'));

  const nav = h('div', { class: 'nav' },
    h('button', { class: 'icon-btn', title: 'Zum Anfang (Pos1)', onclick: () => go(rep.root) }, '⏮'),
    h('button', { class: 'icon-btn', title: 'Zurück (←)', onclick: () => cur.parent && go(cur.parent) }, '◀'),
    h('button', { class: 'icon-btn', title: 'Vor (→)', onclick: () => { const n = nextOf(cur); if (n) go(n); } }, '▶'),
    h('button', { class: 'icon-btn', title: 'Zum Ende der Hauptvariante (Ende)', onclick: () => { let n = cur; while (n.children[0]) n = n.children[0]; go(n); } }, '⏭'),
    h('button', { class: 'icon-btn', title: 'Brett drehen (F)', onclick: flip }, '⟲'),
    h('button', { class: 'btn small db-toggle', title: 'Datenbank an/aus (D)', onclick: () => { prefs.db = !prefs.db; paintDb(); applyShapes(); } }, '📚 Datenbank'),
    h('button', { class: 'btn small engine-toggle', title: 'Engine an/aus (E)', onclick: () => toggleEngine() }, '⚙ Engine'),
  );

  main.append(
    h('div', { class: 'topline' },
      back ? h('button', { class: 'btn primary', onclick: () => setView(back.view || 'train', back) }, back.view === 'spar' ? '← Zurück zur Auswertung' : '← Zurück zum Training') : h('button', { class: 'btn ghost', onclick: () => setView('home') }, '← Übersicht'),
      h('div', { class: 'topline-right' }, modeBtn,
        back ? null : h('button', { class: 'btn primary', onclick: () => setView('train', { repIds: [rep.id] }) }, 'Trainieren'))),
    h('div', { class: 'layout' },
      h('div', { class: 'board-col' }, h('div', { class: 'board-wrap' }, evalBar, boardEl), nav,
        boardHint),
      h('aside', { class: 'panel' },
        anaBox,
        h('div', { class: 'edit-head' }, nameInput, colorSel),
        statsEl,
        dbPanel,
        enginePanel,
        h('h4', {}, 'Zugbaum'),
        tree,
        nodeInfo,
        h('details', { class: 'io' },
          h('summary', {}, 'PGN importieren / exportieren'),
          pgnTools()),
        h('div', { class: 'danger-zone' },
          h('button', { class: 'btn ghost small', onclick: () => confirmDialog('Fortschritt zurücksetzen?', `Alle Lerndaten für „${rep.name}“ werden gelöscht. Die Züge bleiben erhalten.`, 'Zurücksetzen', () => { rep.srs = {}; rep.lines = {}; store.saveRep(rep); refresh(); toast('Fortschritt zurückgesetzt'); }) }, 'Fortschritt zurücksetzen'),
          h('button', { class: 'btn ghost small danger-text', onclick: () => confirmDialog('Repertoire löschen?', `„${rep.name}“ wird mit allen Zügen und Lerndaten gelöscht.`, 'Löschen', () => { app.reps = app.reps.filter((r) => r !== rep); store.deleteRep(rep); setView('home'); toast('Repertoire gelöscht'); }) }, 'Repertoire löschen'),
        ),
      ),
    ),
  );

  cg = makeBoard(boardEl, { orientation, movable: { free: false, color: 'both', showDests: true, events: { after: onMove } } });

  // ----- Engine -----
  let engineRes = null, engineTimer = null, lastPaint = 0;
  cleanupView = () => { if (engine) engine.stop(); clearTimeout(engineTimer); };
  function toggleEngine(on = !prefs.engine) {
    prefs.engine = on;
    if (!on && engine) engine.stop();
    engineRes = null;
    paintEngine();
    if (on) analyse();
    else applyShapes();
  }
  function analyse() {
    if (!prefs.engine) return;
    if (!engine) engine = new Engine();
    engineRes = null;
    paintEngine();
    const fen = cur.fen;
    const ch = new Chess(fen);
    if (ch.isGameOver()) { engineRes = { fen, lines: [], over: ch.isCheckmate() ? 'Matt' : 'Remis' }; paintEngine(); return; }
    engine.analyse(fen, (res) => {
      if (res.fen !== cur.fen || !prefs.engine) return;
      engineRes = res;
      const now = Date.now();
      clearTimeout(engineTimer);
      if (now - lastPaint > 150 || res.done) { lastPaint = now; paintEngine(); applyShapes(); }
      else engineTimer = setTimeout(() => { lastPaint = Date.now(); paintEngine(); applyShapes(); }, 160);
    }).catch(() => { engineRes = { fen, lines: [], error: true }; paintEngine(); });
  }
  function paintEngine() {
    main.querySelector('.engine-toggle')?.classList.toggle('on', prefs.engine);
    evalBar.classList.toggle('hidden', !prefs.engine);
    enginePanel.classList.toggle('hidden', !prefs.engine);
    if (!prefs.engine) return;
    const best = engineRes?.lines?.[0];
    const share = engineRes?.over === 'Matt' ? (C.turnOf(cur.fen) === 'w' ? 0 : 1) : evalShare(best);
    evalFill.style.height = (orientation === 'white' ? share : 1 - share) * 100 + '%';
    evalBar.classList.toggle('flipped', orientation !== 'white');
    enginePanel.innerHTML = '';
    const head = h('div', { class: 'engine-head' },
      h('span', { class: 'engine-eval' }, engineRes?.over || formatEval(best)),
      h('span', { class: 'muted small' }, engineRes?.error ? 'Engine konnte nicht geladen werden' : engineRes?.over ? '' : best ? `Stockfish 19 · Tiefe ${best.depth}` + (engineRes.done ? '' : ' …') : 'Stockfish lädt …'),
      h('button', { class: 'icon-btn small', title: 'Engine ausschalten', onclick: () => toggleEngine(false) }, '✕'));
    enginePanel.append(head);
    const ply0 = C.plyOf(cur);
    for (const l of engineRes?.lines || []) {
      if (!l) continue;
      const row = h('div', { class: 'eline', title: 'Klick: ersten Zug spielen', onclick: () => play(l.san[0]) },
        h('span', { class: 'echip' + ((l.mate ?? l.cp) >= 0 ? ' w' : ' b') }, formatEval(l)));
      const mv = h('span', { class: 'emoves' });
      l.san.forEach((san, i) => {
        const ply = ply0 + i + 1;
        const num = ply % 2 === 1 ? `${Math.ceil(ply / 2)}.` : i === 0 ? `${Math.ceil(ply / 2)}…` : '';
        mv.append(num ? h('span', { class: 'num' }, num) : '', h('span', { class: i === 0 ? 'first' : '' }, fmt(san)), ' ');
      });
      row.append(mv);
      enginePanel.append(row);
    }
  }
  let hoverArrow = null;
  let dbReq = 0;
  async function paintDb() {
    main.querySelector('.db-toggle')?.classList.toggle('on', prefs.db);
    dbPanel.classList.toggle('hidden', !prefs.db);
    if (!prefs.db) return;
    const id = ++dbReq;
    const node = cur;
    if (!dbPanel.childElementCount) dbPanel.append(h('div', { class: 'muted small' }, 'Datenbank lädt …'));
    let res;
    try { [res] = await Promise.all([X.lookup(node.fen), X.loadNames().catch(() => null)]); }
    catch (e) { if (id === dbReq) { dbPanel.innerHTML = ''; dbPanel.append(h('p', { class: 'muted small' }, 'Die Datenbank konnte nicht geladen werden.')); } return; }
    if (id !== dbReq) return;
    dbPanel.innerHTML = '';
    const on = X.openingName(node);
    const mine = C.turnOf(node.fen) === rep.color;
    dbPanel.append(h('div', { class: 'db-head' },
      h('div', { class: 'db-name' }, on ? h('span', { class: 'eco' }, on.eco) : null, on ? on.name : 'Startstellung'),
      h('div', { class: 'muted small' }, res.total ? `${res.total.toLocaleString('de-DE')} Meisterpartien` : 'Keine Meisterpartien')));
    if (!res.total) {
      dbPanel.append(h('p', { class: 'muted small' }, C.plyOf(node) >= 22 ? 'Die Datenbank reicht bis zum 11. Zug.' : 'Diese Stellung kam in den Meisterpartien (2400+) nicht oder nur sehr selten vor.'));
    } else {
      const table = h('div', { class: 'db-table' }, h('div', { class: 'db-row head' }, h('span', {}, 'Zug'), h('span', {}, 'Anteil'), h('span', {}, 'Weiß / Remis / Schwarz')));
      for (const m of res.moves) {
        const inRep = node.children.find((c) => c.san === m.san);
        const pct = (x) => Math.round((x / m.n) * 100);
        table.append(h('div', {
          class: 'db-row' + (inRep ? (inRep.bad ? ' rep-bad' : ' rep') : ''),
          title: inRep ? 'Schon im Repertoire – Klick: hingehen' : analysis ? 'Klick: Zug ausprobieren' : 'Klick: Zug ins Repertoire übernehmen',
          onclick: () => play(m.san),
          onmouseenter: () => { hoverArrow = { orig: m.from, dest: m.to, brush: 'hover' }; applyShapes(); },
          onmouseleave: () => { hoverArrow = null; applyShapes(); },
        },
        h('span', { class: 'db-move' }, fmt(m.san), inRep ? h('span', { class: 'inrep' }, inRep.bad ? '??' : '✓') : null),
        h('span', { class: 'db-n', title: `${m.n.toLocaleString('de-DE')} Partien` }, h('b', {}, Math.round(m.share * 100) + '%'), ' ', h('span', { class: 'muted' }, m.n.toLocaleString('de-DE'))),
        h('span', { class: 'wdl', title: `Weiß ${pct(m.w)}% · Remis ${pct(m.d)}% · Schwarz ${pct(m.b)}%` },
          h('span', { class: 'w', style: `width:${pct(m.w)}%` }, pct(m.w) >= 15 ? pct(m.w) + '%' : ''),
          h('span', { class: 'd', style: `width:${pct(m.d)}%` }, pct(m.d) >= 15 ? pct(m.d) + '%' : ''),
          h('span', { class: 'b', style: `width:${pct(m.b)}%` }, pct(m.b) >= 15 ? pct(m.b) + '%' : '')),
        ));
      }
      dbPanel.append(table);
      const missing = mine ? null : res.moves.filter((m) => m.share >= 0.1 && !node.children.some((c) => c.san === m.san));
      if (missing && missing.length) dbPanel.append(h('p', { class: 'small db-hint' }, `Häufige Gegnerzüge ohne Antwort in deinem Repertoire: ${missing.map((m) => fmt(m.san) + ' (' + Math.round(m.share * 100) + '%)').join(', ')}`));
    }
    dbPanel.append(h('button', { class: 'btn small wizard-btn', onclick: () => openWizard(rep, cur, (target) => { refresh(); go(target || cur); }) }, '✨ Varianten-Assistent: Vorschläge ab hier'));
  }

  function applyShapes() {
    const mine = C.turnOf(cur.fen) === rep.color;
    const shapes = cur.children.map((c, i) => {
      const m = C.moveInfo(cur.fen, c.san);
      const brush = c.bad ? 'red' : mine ? (i === 0 ? 'green' : 'paleGreen') : (i === 0 ? 'blue' : 'paleBlue');
      return { orig: m.from, dest: m.to, brush };
    });
    const best = prefs.engine && engineRes?.fen === cur.fen ? engineRes.lines?.[0] : null;
    if (best?.pv?.[0]) {
      const u = best.pv[0];
      const dup = shapes.some((s) => s.orig === u.slice(0, 2) && s.dest === u.slice(2, 4));
      if (!dup) shapes.push({ orig: u.slice(0, 2), dest: u.slice(2, 4), brush: 'engine' });
      else shapes.forEach((s) => { if (s.orig === u.slice(0, 2) && s.dest === u.slice(2, 4)) s.label = { text: '★', fill: '#d08a1d' }; });
    }
    if (hoverArrow) shapes.push(hoverArrow);
    cg.setAutoShapes(shapes);
  }

  function pgnTools() {
    const ta = h('textarea', { rows: 4, placeholder: 'PGN oder Zugfolge einfügen, z. B. 1.e4 e5 2.Sf3 Sc6 (2...d6 3.d4)' });
    const out = h('textarea', { rows: 4, readonly: true });
    const fill = () => { out.value = C.exportPgn(rep.root, { german: app.settings.notation === 'de' }); };
    const wrap = h('div', { class: 'io-body' },
      h('label', {}, 'Importieren (wird zum bestehenden Baum hinzugefügt)', ta),
      h('button', { class: 'btn', onclick: () => {
        if (!ta.value.trim()) return;
        const r = C.importPgn(rep.root, ta.value);
        if (r.added) { store.saveRep(rep); ta.value = ''; refresh(); toast(`${r.added} Züge hinzugefügt`, 'good'); }
        else if (!r.errors.length) toast('Alle Züge waren schon vorhanden.');
        if (r.errors.length) toast(r.errors[0], 'bad');
        fill();
      } }, 'Importieren'),
      h('label', {}, 'Export', out),
      h('button', { class: 'btn ghost', onclick: async (e) => {
        fill();
        try { await navigator.clipboard.writeText(out.value); e.target.textContent = 'Kopiert ✓'; } catch (err) { out.select(); e.target.textContent = 'Markiert – jetzt Strg+C'; }
        setTimeout(() => { e.target.textContent = 'In Zwischenablage kopieren'; }, 1800);
      } }, 'In Zwischenablage kopieren'),
    );
    wrap.addEventListener('toggle', fill);
    setTimeout(fill, 0);
    return wrap;
  }

  function flip() { orientation = orientation === 'white' ? 'black' : 'white'; cg.set({ orientation }); paintEngine(); }

  function onMove(orig, dest) {
    const piece = cg.state.pieces.get(dest);
    const promo = piece && piece.role === 'pawn' && (dest[1] === '8' || dest[1] === '1') ? 'q' : undefined;
    play({ from: orig, to: dest, promotion: promo || 'q' });
  }

  // Zug ausführen: im Bearbeiten-Modus wird er gespeichert, im Analysemodus nur ausprobiert
  function play(move, silent) {
    if (!analysis) {
      const r = C.addChild(cur, move);
      if (!r) { go(cur); return; }
      if (r.created) { store.saveRep(rep); if (!silent) toast(`${fmt(r.node.san)} hinzugefügt`, 'good'); }
      go(r.node);
      return;
    }
    const r = C.tryMove(cur.fen, move);
    if (!r) { go(cur); return; }
    const existing = cur.children.find((c) => c.san === r.san) || tempChild(cur, r.san);
    if (existing) { go(existing); return; }
    const t = { id: 't' + Math.random().toString(36).slice(2), san: r.san, fen: r.fen, parent: cur, children: [], comment: '', temp: true };
    tempTip = t;
    go(t);
  }
  function tempPath() { const p = []; for (let n = tempTip; n && n.temp; n = n.parent) p.unshift(n); return p; }
  function tempChild(node, san) { return tempPath().find((n) => n.parent === node && n.san === san) || null; }
  function nextOf(node) { return tempPath().find((n) => n.parent === node) || node.children[0] || null; }

  function addTempLine() {
    const path = tempPath();
    if (!path.length) return;
    let n = path[0].parent;
    let added = 0, target = n;
    for (const t of path) {
      const r = C.addChild(n, t.san);
      if (!r) break;
      if (r.created) added++;
      n = r.node;
      if (t === cur) target = n;
    }
    if (cur.temp && target === path[0].parent) target = n;
    tempTip = null;
    store.saveRep(rep);
    toast(added ? `Variante gespeichert (${added} ${added === 1 ? 'Zug' : 'Züge'})` : 'War schon im Repertoire', 'good');
    go(target);
  }
  function discardTemp() {
    const first = tempPath()[0];
    tempTip = null;
    if (cur.temp && first) go(first.parent); else paintMode();
  }

  function paintMode() {
    modeBtn.textContent = analysis ? '🔍 Analysemodus' : '✎ Bearbeiten';
    modeBtn.title = analysis ? 'Klick: in den Bearbeiten-Modus wechseln (Züge werden sofort gespeichert)' : 'Klick: in den Analysemodus wechseln (Züge nur ausprobieren)';
    modeBtn.classList.toggle('on', analysis);
    boardHint.textContent = analysis
      ? 'Analysemodus: Zieh beliebige Züge, um sie dir anzusehen. Gespeichert wird erst mit „Zur Variante hinzufügen“.'
      : 'Zieh auf dem Brett, um Züge hinzuzufügen. Bereits vorhandene Züge werden einfach nachgespielt.';
    anaBox.innerHTML = '';
    const path = tempPath();
    anaBox.classList.toggle('hidden', !analysis && !path.length);
    if (!analysis && !path.length) return;
    anaBox.append(h('div', { class: 'ana-head' }, h('strong', {}, '🔍 Analysebrett'), h('span', { class: 'muted small' }, path.length ? 'Ausprobierte Züge (noch nicht gespeichert):' : 'Züge ausprobieren, ohne das Repertoire zu ändern.')));
    if (path.length) {
      const line = h('div', { class: 'ana-line' });
      path.forEach((n, i) => {
        const ply = C.plyOf(n);
        if (ply % 2 === 1) line.append(h('span', { class: 'num' }, `${Math.ceil(ply / 2)}.`));
        else if (i === 0) line.append(h('span', { class: 'num' }, `${Math.ceil(ply / 2)}…`));
        line.append(h('span', { class: 'tmv' + (n === cur ? ' cur' : ''), onclick: () => go(n) }, fmt(n.san)));
      });
      anaBox.append(line, h('div', { class: 'ana-actions' },
        h('button', { class: 'btn primary small', onclick: addTempLine }, '➕ Zur Variante hinzufügen'),
        h('button', { class: 'btn ghost small', onclick: discardTemp }, 'Verwerfen')));
    }
  }

  function go(node) {
    cur = node;
    cg.set({
      fen: node.fen,
      turnColor: cgColor(C.turnOf(node.fen)),
      lastMove: lastMoveOf(node),
      check: inCheck(node.fen),
      movable: { color: cgColor(C.turnOf(node.fen)), dests: destsOf(node.fen) },
    });
    hoverArrow = null;
    applyShapes();
    refresh();
    paintMode();
    analyse();
    paintDb();
  }

  function refresh() {
    // Statistik
    const s = C.lineStats(rep);
    statsEl.innerHTML = '';
    statsEl.append(
      h('span', {}, h('b', {}, s.total), ' Varianten'),
      h('span', {}, h('b', {}, s.seen), ' gelernt'),
      h('span', {}, h('b', {}, s.due), ' fällig'),
    );
    renderTree();
    renderNodeInfo();
  }

  function renderTree() {
    tree.innerHTML = '';
    const learnedSet = C.learnedPositions(rep);
    if (!rep.root.children.length) {
      tree.append(h('p', { class: 'muted' }, 'Noch keine Züge. Spiel den ersten Zug auf dem Brett oder importiere eine PGN.'));
      return;
    }
    const mk = (n, withNum) => {
      const ply = C.plyOf(n);
      const num = ply % 2 === 1 ? `${Math.ceil(ply / 2)}. ` : withNum ? `${Math.ceil(ply / 2)}… ` : '';
      const mine = C.turnOf(n.parent.fen) === rep.color;
      const learned = mine && learnedSet.has(C.keyOf(n.parent));
      return h('span', { class: 'tmv' + (n === cur ? ' cur' : '') + (mine ? ' mine' : '') + (learned ? ' learned' : '') + (n.bad ? ' bad' : '') + (n.important ? ' imp' : ''), onclick: () => go(n), title: n.comment || '' },
        n.name ? h('span', { class: 'vname' }, n.name) : null,
        n.weight ? h('span', { class: 'wicon w-' + n.weight, title: C.WEIGHTS[n.weight].label }, C.WEIGHTS[n.weight].icon) : null,
        num, fmt(n.san), n.bad ? h('span', { class: 'qq' }, '??') : n.important ? h('span', { class: 'ex' }, '!') : null, n.comment ? h('span', { class: 'has-comment' }, '✎') : null);
    };
    // Rekursive Ausgabe im Lichess-Stil
    const line = (parent, container, forceNum) => {
      let n = parent;
      let force = forceNum;
      while (n.children.length) {
        const [main, ...alts] = n.children;
        container.append(mk(main, force));
        force = false;
        if (alts.length) {
          const box = h('div', { class: 'vars' });
          for (const a of alts) {
            const v = h('div', { class: 'var' });
            v.append(mk(a, true));
            line(a, v, false);
            box.append(v);
          }
          container.append(box);
          force = true;
        }
        n = main;
      }
    };
    const root = h('div', { class: 'mainline' });
    line(rep.root, root, false);
    tree.append(root);
    const curEl = tree.querySelector('.cur');
    if (curEl) curEl.scrollIntoView({ block: 'nearest' });
  }

  function renderNodeInfo() {
    nodeInfo.innerHTML = '';
    if (cur === rep.root) {
      nodeInfo.append(h('p', { class: 'muted small' }, 'Startstellung. Wähle einen Zug im Baum oder spiel auf dem Brett.'));
      return;
    }
    const ply = C.plyOf(cur);
    const label = `${Math.ceil(ply / 2)}${ply % 2 ? '.' : '…'} ${fmt(cur.san)}`;
    if (cur.temp) {
      nodeInfo.append(h('p', { class: 'muted small' }, `${label} ist ausprobiert und noch nicht im Repertoire. Mit „Zur Variante hinzufügen“ speicherst du die Linie.`));
      return;
    }
    const comment = h('textarea', { rows: 2, placeholder: 'Idee zu diesem Zug (wird beim Training angezeigt)', value: cur.comment || '' });
    comment.value = cur.comment || '';
    comment.addEventListener('change', () => { cur.comment = comment.value.trim(); store.saveRep(rep); renderTree(); });
    const idx = cur.parent.children.indexOf(cur);
    const mine = C.turnOf(cur.parent.fen) === rep.color;
    const nameIn = h('input', { type: 'text', maxlength: 60, placeholder: 'Name der Variante ab diesem Zug (optional)' });
    nameIn.value = cur.name || '';
    nameIn.addEventListener('change', () => { cur.name = nameIn.value.trim(); if (!cur.name) delete cur.name; store.saveRep(rep); renderTree(); });
    const sugg = X.nameOf(cur.fen);
    const inh = C.inheritedWeight(cur.parent);
    const weightSel = h('select', { title: 'Gilt für diesen Zug und alle Folgezüge' },
      h('option', { value: '' }, inh ? `Wie übergeordnet (${C.WEIGHTS[inh].short})` : 'Normal'),
      Object.entries(C.WEIGHTS).map(([k, w]) => h('option', { value: k, selected: cur.weight === k }, `${w.icon} ${w.label}`)));
    weightSel.addEventListener('change', () => { if (weightSel.value) cur.weight = weightSel.value; else delete cur.weight; store.saveRep(rep); refresh(); });
    nodeInfo.append(
      h('div', { class: 'node-head' }, h('strong', {}, label + (cur.bad ? '??' : cur.important ? '!' : '')), h('span', { class: 'chip' }, mine ? 'Dein Zug' : 'Gegnerzug')),
      h('label', { class: 'field' }, 'Variantenname', nameIn),
      sugg && sugg.name !== cur.name ? h('button', { class: 'btn ghost small sugg', title: 'Namen aus der Eröffnungsdatenbank übernehmen', onclick: () => { cur.name = sugg.name; store.saveRep(rep); refresh(); } }, `Vorschlag: ${sugg.eco} ${sugg.name}`) : null,
      h('label', { class: 'field' }, 'Gewichtung (dieser Zug und alle Folgezüge)', weightSel),
      h('label', { class: 'field' }, 'Kommentar', comment),
      h('div', { class: 'node-actions' },
        cur.bad ? null : h('button', { class: 'btn ghost small' + (cur.important ? ' on' : ' good'), title: 'Wichtige Züge werden zuerst gelernt und öfter abgefragt', onclick: () => {
          cur.important = !cur.important; if (!cur.important) delete cur.important; store.saveRep(rep); go(cur);
        } }, cur.important ? 'Wichtig-Markierung entfernen' : 'Als wichtig markieren (!)'),
        idx > 0 ? h('button', { class: 'btn ghost small', onclick: () => {
          const sib = cur.parent.children; sib.splice(idx, 1); sib.unshift(cur); store.saveRep(rep); renderTree();
        } }, 'Zur Hauptvariante machen') : null,
        h('button', { class: 'btn ghost small' + (cur.bad ? '' : ' warn'), onclick: () => {
          cur.bad = !cur.bad;
          if (cur.bad) delete cur.important;
          const keys = new Set(C.collectCards(rep.root, rep.color).map((c) => c.key));
          for (const k of Object.keys(rep.srs)) if (!keys.has(k)) delete rep.srs[k];
          store.saveRep(rep); go(cur);
        } }, cur.bad ? 'Fehler-Markierung entfernen' : 'Als Fehler markieren (??)'),
        h('button', { class: 'btn ghost small danger-text', onclick: () => {
          const n = cur; const parent = n.parent;
          let count = 0; C.walk(n, () => count++);
          const doIt = () => {
            C.removeNode(n);
            // verwaiste Lerndaten entfernen
            const keys = new Set(C.collectCards(rep.root, rep.color).map((c) => c.key));
            for (const k of Object.keys(rep.srs)) if (!keys.has(k)) delete rep.srs[k];
            store.saveRep(rep); go(parent);
          };
          if (count > 3) confirmDialog('Variante löschen?', `${fmt(n.san)} und ${count - 1} Folgezüge werden gelöscht.`, 'Löschen', doIt); else doIt();
        } }, 'Zug löschen (mit Folgezügen)'),
      ),
    );
    if (cur.important) nodeInfo.append(h('p', { class: 'muted small goodinfo' }, mine
      ? 'Schlüsselzug: Diese Stellung wird bei neuen Karten zuerst gelernt und öfter wiederholt.'
      : 'Wichtiger Gegnerzug: Die Stellung danach wird bevorzugt gelernt und öfter wiederholt.'));
    if (cur.bad) nodeInfo.append(h('p', { class: 'muted small badinfo' }, mine
      ? 'Als Fehler markiert: Dieser Zug ist eine Falle. Spielst du ihn im Training, wirst du gewarnt (der Kommentar wird angezeigt). Folgezüge zeigen, warum er schlecht ist, und werden nicht abgefragt.'
      : 'Als Gegnerfehler markiert: Die Stellung danach wird im Training als „Bestrafe den Fehler“ abgefragt.'));
    if (mine && C.goodChildren(cur.parent).length > 1 && !cur.bad) nodeInfo.append(h('p', { class: 'muted small' }, 'Hier hast du mehrere eigene Züge. Im Training wird gefragt, welche Züge spielbar sind – du musst alle finden.'));
  }

  keyHandler = (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (e.key === 'ArrowLeft' && cur.parent) { e.preventDefault(); go(cur.parent); }
    else if (e.key === 'ArrowRight' && nextOf(cur)) { e.preventDefault(); go(nextOf(cur)); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!cur.parent || cur.temp) return;
      const sib = cur.parent.children; const i = sib.indexOf(cur);
      const j = e.key === 'ArrowUp' ? i - 1 : i + 1;
      if (sib[j]) { e.preventDefault(); go(sib[j]); }
    }
    else if (e.key === 'Home') go(rep.root);
    else if (e.key === 'End') { let n = cur; while (n.children[0]) n = n.children[0]; go(n); }
    else if (e.key === 'f') flip();
    else if (e.key === 'e') toggleEngine();
    else if (e.key === 'd') { prefs.db = !prefs.db; paintDb(); }
  };
  document.addEventListener('keydown', keyHandler);

  paintEngine();
  go(cur);
  if (preload) for (const san of preload) play(san, true);
}

// ======================================================================
// Rahmen
// ======================================================================
function renderStatus() {
  const btn = $('#account-btn');
  if (btn) {
    btn.textContent = store.user ? '👤 ' + (store.user.email || 'Konto').split('@')[0] : 'Anmelden';
    btn.title = store.user ? `Angemeldet als ${store.user.email}` : 'Konto erstellen oder anmelden – deine Repertoires auf allen Geräten';
    btn.classList.toggle('in', !!store.user);
  }
  const el = $('#storage');
  if (!el) return;
  if (app.storage === 'account') {
    const n = store.dirtyCount();
    el.className = 'status ' + (store.offline ? 'local' : 'cloud');
    el.textContent = store.offline ? '● Offline – wird später übertragen' : store.pushing || n ? '● Synchronisiere …' : '● Im Konto gespeichert';
    el.title = '';
    return;
  }
  el.className = 'status ' + app.storage;
  el.textContent = app.storage === 'cloud' ? '● In deinem Konto gespeichert' : app.storage === 'local' ? (IS_WEB ? '● In diesem Browser gespeichert' : '● Nur in diesem Browser gespeichert') : '● Lade …';
  el.title = app.storage === 'local' ? 'Tipp: Unter ⚙ Einstellungen kannst du ein Backup herunterladen.' : '';
}

async function boot() {
  document.body.append(h('div', { id: 'toasts' }));
  $('#settings-btn').addEventListener('click', openSettings);
  $('#account-btn')?.addEventListener('click', openAccount);
  $('#logo').addEventListener('click', () => setView('home'));
  renderStatus();
  $('#main').innerHTML = '<div class="loading"><div class="spinner"></div><p>Lade dein Repertoire …</p></div>';
  X.loadNames().catch(() => {});
  if (IS_WEB) {
    try { navigator.storage?.persist?.(); } catch (e) { /* egal */ }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  await store.init();
  renderStatus();
  setView('home');
}

boot();
