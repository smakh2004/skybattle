// Multiplayer transport: one shared arena, any number of players. Two backends, same interface:
//
//   FirebaseNet  anonymous sign-in + Realtime Database (when firebase-config.js has a config)
//   LocalNet     BroadcastChannel between the tabs / windows of this browser (no config: testing)
//
// Interface
//   await net.join({ name, plane })   -> { id, label }
//   net.send(state)                   publish my state (call ~12 times a second)
//   net.onPlayers = (map) => {}       everyone else in the arena: { id: state }, on every change
//   net.hit(targetId, dmg, crash)     my bullet hit targetId (crash: our planes collided)
//   net.onHit = ({ by, dmg, crash }) => {}   a hit on me
//   net.kill(byId, byName, myName, cause)    I went down: cause 'shot' (by byId), 'crash' (into
//                                     byId) or 'oil' (out of oil, byId is me)
//   net.onKill = ({ by, to, byName, toName, cause }) => {}   anyone going down
//   net.leave()
//
// Player state (short keys, sent often):
//   n name, p plane, x y position, h heading, v speed, b bank, q pitch, f shots fired (counter),
//   d dead, u burning, i shielded, a health %, s score, t time (ms)

const V = new URL(import.meta.url).searchParams.get('v') || '0';
const { firebaseConfig } = await import(`./firebase-config.js?v=${V}`);

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';
const ARENA = 'arena'; // the database path everyone shares

export async function createNet() {
  // ?local keeps a page offline (the tabs of this browser only), e.g. for testing next to a live game
  const local = typeof location !== 'undefined' && new URLSearchParams(location.search).has('local');
  if (firebaseConfig && !local) return new FirebaseNet(firebaseConfig);
  return new LocalNet();
}

// --- Firebase -------------------------------------------------------------------------------
class FirebaseNet {
  constructor(config) {
    this.config = config;
    this.mode = 'online';
    this.onPlayers = () => {};
    this.onHit = () => {};
    this.onKill = () => {};
    this.offs = [];
  }

  // Loading Firebase and signing in take a moment: done while the menu is up, so PLAY is quick.
  prepare() {
    if (!this.ready) {
      this.ready = (async () => {
        const [{ initializeApp }, auth, db] = await Promise.all([
          import(FB + 'firebase-app.js'),
          import(FB + 'firebase-auth.js'),
          import(FB + 'firebase-database.js'),
        ]);
        this.db = db;
        const app = this.app || (this.app = initializeApp(this.config));
        // the sign-in lives in this tab's sessionStorage: each tab / window is its own player
        // (with the default, every window of a browser would share one id and hide each other)
        this.auth = this.auth || auth.initializeAuth(app, { persistence: auth.browserSessionPersistence });
        const cred = await auth.signInAnonymously(this.auth);
        this.database = db.getDatabase(app);
        return cred.user.uid;
      })();
      this.ready.catch(() => { this.ready = null; });
    }
    return this.ready;
  }

  // The menu: everyone's planes, without joining (shown flying behind the menu).
  async watch() {
    const uid = await this.prepare();
    if (this.watchOff || this.meRef) return;
    const { ref, onValue } = this.db;
    this.watchOff = onValue(ref(this.database, `${ARENA}/players`), (snap) => {
      const all = snap.val() || {};
      delete all[uid];
      this.onPlayers(all);
    });
  }

  unwatch() {
    if (this.watchOff) { try { this.watchOff(); } catch {} this.watchOff = null; }
  }

  async join({ name, plane }) {
    const uid = (this.uid = await this.prepare());
    this.unwatch();
    const db = this.db;
    const d = this.database;
    const { ref, set, onDisconnect, onValue, onChildAdded, remove, query, limitToLast } = db;

    // leaving (closing the tab, losing the connection) removes the plane
    this.meRef = ref(d, `${ARENA}/players/${uid}`);
    await onDisconnect(this.meRef).remove();
    await onDisconnect(ref(d, `${ARENA}/inbox/${uid}`)).remove();
    await set(this.meRef, { n: name, p: plane, x: 0, y: 0, h: 0, v: 0, b: 0, q: 0, f: 0, d: false, u: false, i: true, a: 100, s: 0, t: Date.now() });

    // everyone
    this.offs.push(onValue(ref(d, `${ARENA}/players`), (snap) => {
      const all = snap.val() || {};
      delete all[uid];
      this.onPlayers(all);
    }));
    // hits on me (my inbox; each is deleted once read)
    this.offs.push(onChildAdded(ref(d, `${ARENA}/inbox/${uid}`), (snap) => {
      const v = snap.val();
      remove(snap.ref);
      if (v) this.onHit(v);
    }));
    // shot-down announcements (only new ones)
    const since = Date.now() - 2000;
    this.offs.push(onChildAdded(query(ref(d, `${ARENA}/kills`), limitToLast(10)), (snap) => {
      const v = snap.val();
      if (v && v.t > since) this.onKill(v);
    }));
    return { id: uid, label: 'ONLINE' };
  }

  send(state) {
    if (this.meRef) this.db.set(this.meRef, { ...state, t: Date.now() });
  }

  hit(to, dmg, crash = false) {
    if (!this.meRef) return;
    const { push, ref } = this.db;
    push(ref(this.database, `${ARENA}/inbox/${to}`), { by: this.uid, dmg, crash, t: Date.now() });
  }

  kill(by, byName, toName, cause = 'shot') {
    if (!this.meRef) return;
    const { push, ref, remove } = this.db;
    const r = push(ref(this.database, `${ARENA}/kills`), { by, to: this.uid, byName, toName, cause, t: Date.now() });
    setTimeout(() => remove(r), 15000); // the feed only needs recent ones
  }

  async leave() {
    for (const off of this.offs) try { off(); } catch {}
    this.offs = [];
    if (!this.meRef) return;
    const { remove, onDisconnect } = this.db;
    try {
      await remove(this.meRef);
      await onDisconnect(this.meRef).cancel();
    } catch (e) { console.warn('leave', e); }
    this.meRef = null;
  }
}

// --- Local (tabs / windows of this browser) -------------------------------------------------
class LocalNet {
  prepare() { return Promise.resolve(this.id); }

  constructor() {
    this.mode = 'local';
    this.id = Math.random().toString(36).slice(2, 10);
    this.ch = new BroadcastChannel('sky-battle');
    this.peers = new Map(); // id -> { state, seen }
    this.joined = false;
    this.onPlayers = () => {};
    this.onHit = () => {};
    this.onKill = () => {};
    this.ch.onmessage = (e) => this.receive(e.data);
    this.timer = setInterval(() => this.sweep(), 1000);
    addEventListener('pagehide', () => this.leave());
  }

  receive(m) {
    if (!m || m.from === this.id) return;
    if (m.type === 'state') {
      this.peers.set(m.from, { state: m.state, seen: Date.now() });
      this.emit();
    } else if (m.type === 'leave') {
      this.peers.delete(m.from);
      this.emit();
    } else if (m.type === 'hit' && m.to === this.id) {
      this.onHit({ by: m.from, dmg: m.dmg, crash: !!m.crash });
    } else if (m.type === 'kill') {
      this.onKill(m.kill);
    }
  }

  sweep() {
    // keep my plane listed while this tab is in the background (its game loop is paused)
    if (this.last && Date.now() - this.last.t > 900) this.send(this.last);
    const now = Date.now();
    let changed = false;
    for (const [id, p] of this.peers) {
      if (now - p.seen > 3000) { this.peers.delete(id); changed = true; }
    }
    if (changed) this.emit();
  }

  watch() { this.watching = true; this.emit(); return Promise.resolve(); }
  unwatch() { this.watching = false; }

  emit() {
    if (!this.joined && !this.watching) return;
    const all = {};
    for (const [id, p] of this.peers) all[id] = p.state;
    this.onPlayers(all);
  }

  async join({ name, plane }) {
    this.joined = true;
    this.send({ n: name, p: plane, x: 0, y: 0, h: 0, v: 0, b: 0, q: 0, f: 0, d: false, u: false, i: true, a: 100, s: 0 });
    this.emit();
    return { id: this.id, label: 'OFFLINE TEST' };
  }

  send(state) {
    if (!this.joined) return;
    this.last = { ...state, t: Date.now() };
    this.ch.postMessage({ type: 'state', from: this.id, state: this.last });
  }

  hit(to, dmg, crash = false) {
    this.ch.postMessage({ type: 'hit', from: this.id, to, dmg, crash });
  }

  kill(by, byName, toName, cause = 'shot') {
    const kill = { by, to: this.id, byName, toName, cause, t: Date.now() };
    this.ch.postMessage({ type: 'kill', from: this.id, kill });
    this.onKill(kill);
  }

  async leave() {
    if (!this.joined) return;
    this.ch.postMessage({ type: 'leave', from: this.id });
    this.joined = false;
    this.last = null;
  }
}
