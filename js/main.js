/* Sky Blitz - online air combat.
 *
 * Rive files:
 *   riv/world.riv   "World": ocean + clouds (camX, camY, planeX, planeY, heading, planeOn, k)
 *                   "Shots": the bullets, drawn with the game's own code (data, k)
 *   riv/planes.riv  "Plane": the three planes (plane, bank, pitch, fire, hit, burning, dead)
 *
 * All game state lives here; Rive draws it. Other players come from net.js (Firebase, or the tabs
 * of this browser when there is no Firebase config). Everyone shares one arena, any number of
 * players; the arena grows as more join, and only the planes near you are loaded into Rive.
 *
 * Units: world positions and speeds are in plane-artboard units, the same for every screen.
 * On screen a unit is `view.k` css px (the game's screen scale x the camera zoom).
 */
import { createNet } from './net.js';

const R = window.rive;

// --- tuning ---------------------------------------------------------------------------------
// flight, in world units (the game's 230 px/s at its tuning scale k = 1.5 -> 153 u/s)
const FLIGHT = {
  cruise: 153,
  boost: 253,
  brake: 93,
  accel: 2.2, // how fast speed follows the throttle (1/s)
  turn: 2.4, // rad/s at full stick
  turnEase: 7, // how fast the turn follows the stick (1/s)
  bankEase: 6,
};

// The three planes. Guns as in game-airplane-v2 (game.luau fire / enemyFire): muzzles are the
// barrel tips in artboard units from the plane's centre (-y = nose); bullet speeds in units/s.
// hit: the plane's outline as an ellipse, [half wingspan, half length] in artboard units
// (measured from the planes' art), turned with the plane, so wingtips count and empty air doesn't.
const PLANES = {
  1: {
    name: 'RED FALCON', hp: 100, speed: 1, hit: [42, 45], dmg: 9,
    pattern: 'pairs', muzzle: 633, spread: 0.01, muzzles: [[-4.0, -27], [3.8, -27]],
  },
  2: {
    name: 'BLUE HORNET', hp: 85, speed: 1.08, hit: [37, 32], dmg: 6,
    pattern: 'volley', gap: 0.14, muzzle: 728, spread: 0.03, muzzles: [[-8.8, -33.3], [9.1, -33.3]],
  },
  3: {
    name: 'GOLD BOMBER', hp: 150, speed: 0.88, hit: [55, 47], dmg: 16,
    pattern: 'volley', gap: 0.25, muzzle: 567, spread: 0.03, muzzles: [[-13.2, -32.4], [13.2, -32.4]],
  },
};
const STAT_MAX = { hp: 150, speed: 1.08, fire: 85 }; // for the menu's meters

const BULLET_LIFE = 1.4; // s
// the arena's radius in world units (past it the plane is turned back toward the battle); it grows
// with the number of players so a crowd still has room
const arenaRadius = () => 1200 + 160 * Math.sqrt(remotes.size + 1);
const BOARD_ROWS = 8; // the scoreboard shows the top 8 (and you, if you are lower)
const RESPAWN = 3; // s after being shot down
const SHIELD = 2.5; // s of invulnerability after (re)spawning
const SCORE = { hit: 10, kill: 100 };
const SEND_HZ = 12;
// the camera looks ahead of the plane, follows it, and turns with it a little late
// lead: s of travel ahead; ease: position follow (1/s); turn: angle catch-up (1/s)
// zoom: how far out the camera sits (1 = the game's own scale, smaller = further away)
const CAMERA = { lead: 0.75, ease: 3.2, turn: 2.0, zoom: 0.62 };

// --- dom ------------------------------------------------------------------------------------
const $ = (s) => document.querySelector(s);
const stage = $('#stage');
const scene = $('#scene');
const worldCanvas = $('#world');
const shotsCanvas = $('#shots');
const planesLayer = $('#planes');
const tagsLayer = $('#tags');
const nameInput = $('#nameInput');
const joinBtn = $('#joinBtn');
const menuStatus = $('#menuStatus');
const banner = $('#banner');
const feed = $('#feed');

// --- rive helpers ---------------------------------------------------------------------------
function loadRive(opts) {
  return new Promise((resolve, reject) => {
    const r = new R.Rive({
      autoplay: true,
      autoBind: true,
      stateMachine: 'State Machine',
      ...opts,
      onLoad: () => {
        try { r.resizeDrawingSurfaceToCanvas(); } catch (e) { console.warn('resize', e); }
        resolve(r);
      },
      onLoadError: (e) => reject(e),
    });
  });
}

// planes.riv is loaded once and shared by every plane instance
let planesFile = null;
async function planesSource() {
  if (planesFile) return { riveFile: planesFile };
  try {
    const f = new R.RiveFile({ src: 'riv/planes.riv' });
    await f.init();
    planesFile = f;
    return { riveFile: f };
  } catch (e) {
    console.warn('shared planes.riv failed, loading per plane', e);
    return { src: 'riv/planes.riv' };
  }
}

/** One plane on screen: its own canvas and planes.riv instance. */
class PlaneView {
  constructor(canvas) {
    this.canvas = canvas;
    this.size = 150;
    this.r = null;
    this.vm = null;
    this.last = {};
  }
  async load() {
    this.r = await loadRive({
      ...(await planesSource()),
      canvas: this.canvas,
      artboard: 'Plane',
      useOffscreenRenderer: true, // many planes share one GL context
      layout: new R.Layout({ fit: R.Fit.Contain, alignment: R.Alignment.Center }),
    });
    this.vm = this.r.viewModelInstance;
    if (!this.vm) console.warn('planes.riv: no view model bound');
    return this;
  }
  num(name, v) {
    if (!this.vm || this.last[name] === v) return;
    const p = this.vm.number(name);
    if (p) p.value = v;
    this.last[name] = v;
  }
  bool(name, v) {
    if (!this.vm || this.last[name] === v) return;
    const p = this.vm.boolean(name);
    if (p) p.value = v;
    this.last[name] = v;
  }
  fire(name) {
    const t = this.vm && this.vm.trigger(name);
    if (t) t.trigger();
  }
  /** Place on screen (scene px, centre) and turn to the heading. */
  place(x, y, heading) {
    const h = this.size / 2;
    this.canvas.style.transform = `translate(${x - h}px, ${y - h}px) rotate(${heading}rad)`;
  }
  /** The game draws planes at k x their artboard: the 160 artboard is 160k css px. */
  resize(k) {
    this.setSize(Math.round(160 * k));
  }
  setSize(px) {
    this.size = px;
    this.canvas.style.width = this.canvas.style.height = px + 'px';
    if (this.r) this.r.resizeDrawingSurfaceToCanvas();
  }
  pose(p) {
    this.num('plane', p.plane);
    this.num('bank', +p.bank.toFixed(3));
    this.num('pitch', +p.pitch.toFixed(3));
    this.bool('burning', p.burning);
    this.bool('dead', p.dead);
  }
  dispose() {
    try { this.r && this.r.cleanup(); } catch {}
    this.canvas.remove();
  }
}

// --- state ----------------------------------------------------------------------------------
const view = { w: innerWidth, h: innerHeight, sw: innerWidth, sh: innerHeight, unit: 1, k: 1 };
const cam = { x: 0, y: 0, angle: 0 };
let phase = 'menu'; // 'menu' | 'joining' | 'play'
let net = null;
let session = null; // { id, label }
let joinedAt = 0;
let sendT = 0;

const me = {
  id: 'me',
  name: '',
  plane: 1,
  x: 0, y: 0,
  heading: 0, // rad, 0 = nose up (north), clockwise
  speed: FLIGHT.cruise,
  turn: 0,
  bank: 0,
  pitch: 0,
  hp: 100,
  burning: false,
  dead: false,
  deadT: 0,
  shield: 0,
  lastBy: null,
  score: 0,
  shots: 0, // guns fired (sent, so the others can draw my bullets)
  gunT: 0,
  pending: [], // the second gun of a pair, fired a moment later: [{ t, gun }]
  view: null,
};
const remotes = new Map(); // id -> remote player
const bullets = [];
const sparks = []; // where bullets struck a plane: { x, y, t }
const SPARK_LIFE = 0.25;

// --- input ----------------------------------------------------------------------------------
const keys = new Set();
const input = { x: 0, y: 0, fire: false }; // x: turn -1..1, y: throttle -1 (boost) .. 1 (brake)
const touch = { x: 0, y: 0, fire: false, stickId: null };

addEventListener('keydown', (e) => {
  if (phase !== 'play') return;
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === 'Escape') leaveGame();
  if (e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

// mouse: hold anywhere on the sea to fire
worldCanvas.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && phase === 'play') touch.fire = true; });
addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse') touch.fire = false; });

// touch stick
const stick = $('#stick');
const knob = $('#knob');
function stickMove(e) {
  const r = stick.getBoundingClientRect();
  const max = r.width / 2;
  let dx = e.clientX - (r.left + max);
  let dy = e.clientY - (r.top + max);
  const d = Math.hypot(dx, dy);
  if (d > max) { dx *= max / d; dy *= max / d; }
  knob.style.transform = `translate(${dx}px, ${dy}px)`;
  touch.x = dx / max;
  touch.y = dy / max;
}
stick.addEventListener('pointerdown', (e) => {
  touch.stickId = e.pointerId;
  stick.setPointerCapture(e.pointerId);
  stickMove(e);
});
stick.addEventListener('pointermove', (e) => { if (e.pointerId === touch.stickId) stickMove(e); });
const stickEnd = (e) => {
  if (e.pointerId !== touch.stickId) return;
  touch.stickId = null;
  touch.x = touch.y = 0;
  knob.style.transform = '';
};
stick.addEventListener('pointerup', stickEnd);
stick.addEventListener('pointercancel', stickEnd);

const fireBtn = $('#fireBtn');
fireBtn.addEventListener('pointerdown', (e) => {
  fireBtn.setPointerCapture(e.pointerId);
  touch.fire = true;
  fireBtn.classList.add('held');
});
const fireEnd = () => { touch.fire = false; fireBtn.classList.remove('held'); };
fireBtn.addEventListener('pointerup', fireEnd);
fireBtn.addEventListener('pointercancel', fireEnd);
$('#exitBtn').addEventListener('click', () => leaveGame());

function readInput() {
  let x = 0, y = 0;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
  if (keys.has('KeyW') || keys.has('ArrowUp')) y -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) y += 1;
  let fire = keys.has('Space') || touch.fire;
  if (touch.stickId !== null) { x = touch.x; y = touch.y; }
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) {
    if (!p) continue;
    const ax = p.axes[0] || 0, ay = p.axes[1] || 0;
    if (Math.abs(ax) > 0.15) x = ax;
    if (Math.abs(ay) > 0.15) y = ay;
    if ((p.buttons[0] && p.buttons[0].pressed) || (p.buttons[7] && p.buttons[7].value > 0.3)) fire = true;
  }
  input.x = Math.max(-1, Math.min(1, x));
  input.y = Math.max(-1, Math.min(1, y));
  input.fire = fire;
}

// --- helpers ----------------------------------------------------------------------------------
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cleanName = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 _\-.]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);

// world -> scene px (the rotating square); scene px -> screen px (after the camera's turn)
const toScene = (x, y) => [view.w / 2 + (x - cam.x) * view.k, view.h / 2 + (y - cam.y) * view.k];
function sceneToScreen(sx, sy) {
  const dx = sx - view.w / 2, dy = sy - view.h / 2;
  const c = Math.cos(-cam.angle), s = Math.sin(-cam.angle);
  return [view.sw / 2 + dx * c - dy * s, view.sh / 2 + dx * s + dy * c];
}

let bannerT = 0;
function showBanner(html, secs = 2.2) {
  banner.innerHTML = html;
  banner.classList.add('show');
  bannerT = secs;
}

function addFeed(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  feed.prepend(d);
  while (feed.children.length > 4) feed.lastChild.remove();
  setTimeout(() => { d.style.opacity = '0'; }, 5000);
  setTimeout(() => d.remove(), 5700);
}

// --- my plane --------------------------------------------------------------------------------
function spawn(p) {
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * arenaRadius() * 0.6;
  p.x = Math.cos(a) * r;
  p.y = Math.sin(a) * r;
  p.heading = Math.atan2(-p.x, p.y) + rand(-0.5, 0.5); // roughly toward the middle
  p.speed = FLIGHT.cruise * PLANES[p.plane].speed;
  p.turn = p.bank = p.pitch = 0;
  p.hp = PLANES[p.plane].hp;
  p.dead = false;
  p.burning = false;
  p.shield = SHIELD;
  p.lastBy = null;
  p.pending.length = 0;
}

function fly(p, dt, ctl) {
  const spec = PLANES[p.plane];
  if (p.dead) {
    // falling: slow down and stop turning; the lose timeline does the rest
    p.speed += (0 - p.speed) * ease(1.6, dt);
    p.turn += (0 - p.turn) * ease(2, dt);
    p.deadT += dt;
    if (p.deadT > RESPAWN) {
      spawn(p);
      cam.x = p.x; cam.y = p.y; cam.angle = p.heading;
      showBanner('BACK IN THE AIR', 1.2);
    }
  } else {
    const target = (ctl.y < 0 ? FLIGHT.cruise + (FLIGHT.boost - FLIGHT.cruise) * -ctl.y
      : FLIGHT.cruise - (FLIGHT.cruise - FLIGHT.brake) * ctl.y) * spec.speed;
    p.speed += (target - p.speed) * ease(FLIGHT.accel, dt);
    let steer = ctl.x;
    // outside the arena: the plane is turned back toward the battle
    const dist = Math.hypot(p.x, p.y);
    const arena = arenaRadius();
    if (dist > arena) {
      const want = wrap(Math.atan2(-p.x, p.y) - p.heading);
      const push = Math.min(1, (dist - arena) / 250);
      steer = Math.max(-1, Math.min(1, steer + Math.sign(want) * push * Math.min(1, Math.abs(want) * 2)));
    }
    p.turn += (steer - p.turn) * ease(FLIGHT.turnEase, dt);
  }
  p.heading = wrap(p.heading + p.turn * FLIGHT.turn * dt);
  p.x += Math.sin(p.heading) * p.speed * dt;
  p.y -= Math.cos(p.heading) * p.speed * dt;
  p.bank += (p.turn - p.bank) * ease(FLIGHT.bankEase, dt);
  p.pitch += ((p.dead ? 0 : ctl.y) - p.pitch) * ease(4, dt);
  p.shield = Math.max(0, p.shield - dt);
  guns(p, dt, ctl.fire && !p.dead);
}

/** Each plane fires its own way. Every gun fired counts in p.shots (the others replay them). */
function guns(p, dt, wantFire) {
  const g = PLANES[p.plane];
  p.gunT -= dt;
  for (let i = p.pending.length - 1; i >= 0; i--) {
    const q = p.pending[i];
    q.t -= dt;
    if (q.t <= 0) {
      if (!p.dead) { shoot(p, q.gun, true); p.shots += 1; }
      p.pending.splice(i, 1);
    }
  }
  if (!wantFire || p.gunT > 0) return;
  if (g.pattern === 'pairs') {
    // RED FALCON: one gun now, the other a random moment later; one `shoot` timeline per pair
    const interval = 0.11 * rand(2.3, 2.9);
    const first = p.shots % 2; // alternate, so the others can tell which gun fired
    shoot(p, first, true);
    p.shots += 1;
    p.pending.push({ t: interval * rand(0.35, 0.65), gun: 1 - first });
    p.view && p.view.fire('fire');
    p.gunT = interval;
  } else {
    // BLUE HORNET / GOLD BOMBER: both guns at once, every `gap` while the trigger is held
    shoot(p, 0, true);
    shoot(p, 1, true);
    p.shots += 1;
    p.view && p.view.fire('fire');
    p.gunT = g.gap;
  }
}

/** A bullet from plane p's gun (0 / 1). `mine`: I fired it, so I check what it hits. */
function shoot(p, gun, mine) {
  const g = PLANES[p.plane];
  const [mx, my] = g.muzzles[gun];
  const c = Math.cos(p.heading), sn = Math.sin(p.heading);
  const a = p.heading + rand(-g.spread, g.spread);
  bullets.push({
    owner: p.id,
    mine,
    plane: p.plane,
    dmg: g.dmg,
    x: p.x + mx * c - my * sn,
    y: p.y + mx * sn + my * c,
    // the plane's own speed carries the shot, the barrel adds its muzzle speed
    vx: Math.sin(p.heading) * p.speed + Math.sin(a) * g.muzzle,
    vy: -Math.cos(p.heading) * p.speed - Math.cos(a) * g.muzzle,
    dx: Math.sin(a), dy: -Math.cos(a), // the tracer points along the barrel
    muzzle: g.muzzle,
    t: 0,
  });
}

function updateBullets(dt) {
  for (let i = sparks.length - 1; i >= 0; i--) {
    sparks[i].t += dt;
    if (sparks[i].t > SPARK_LIFE) sparks.splice(i, 1);
  }
  const live = phase === 'play';
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.t += dt;
    const px = b.x, py = b.y;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    let gone = b.t > BULLET_LIFE;
    if (!gone && live) {
      // every bullet stops where it touches a plane on this screen. Only my own bullets count:
      // the shooter decides hits and the target takes the damage; everyone else's bullets just
      // stop and spark here, so what each player sees matches.
      for (const p of planesForHits(b.owner)) {
        const at = touches(px, py, b.x, b.y, p);
        if (!at) continue;
        gone = true;
        sparks.push({ x: at[0], y: at[1], t: 0 });
        if (p.shielded || p.shield > 0) break; // the spawn shield: a spark, no damage
        if (b.mine && p !== me) {
          net && net.hit(p.id, b.dmg);
          me.score += SCORE.hit;
          p.view && p.view.fire('hit');
          p.hpShown = Math.max(0, p.hpShown - b.dmg);
        }
        break;
      }
    }
    if (gone) bullets.splice(i, 1);
  }
}

// the planes a bullet can touch: everyone alive except whoever fired it
function* planesForHits(owner) {
  if (owner !== me.id && !me.dead && phase === 'play') yield me;
  for (const r of remotes.values()) {
    if (r.id !== owner && r.seen && !r.dead) yield r;
  }
}

// Where the bullet's path this frame (a -> b) first enters plane p's outline, or null.
// The outline is an ellipse in the plane's own frame (x across the wings, y along the body).
function touches(ax, ay, bx, by, p) {
  const [hw, hl] = PLANES[p.plane].hit;
  const c = Math.cos(p.heading), s = Math.sin(p.heading);
  const steps = 4;
  for (let k = 1; k <= steps; k++) {
    const x = ax + ((bx - ax) * k) / steps;
    const y = ay + ((by - ay) * k) / steps;
    const dx = x - p.x, dy = y - p.y;
    const lx = dx * c + dy * s; // into the plane's frame (undo its heading)
    const ly = -dx * s + dy * c;
    if ((lx * lx) / (hw * hw) + (ly * ly) / (hl * hl) <= 1) return [x, y];
  }
  return null;
}

function updateCamera(dt) {
  const v = me.speed * CAMERA.lead;
  const tx = me.x + Math.sin(me.heading) * v;
  const ty = me.y - Math.cos(me.heading) * v;
  const k = ease(CAMERA.ease, dt);
  cam.x += (tx - cam.x) * k;
  cam.y += (ty - cam.y) * k;
  cam.angle += wrap(me.heading - cam.angle) * ease(CAMERA.turn, dt);
}

// --- network --------------------------------------------------------------------------------
function myState() {
  return {
    n: me.name, p: me.plane,
    x: Math.round(me.x), y: Math.round(me.y),
    h: +me.heading.toFixed(3), v: Math.round(me.speed),
    b: +me.bank.toFixed(2), q: +me.pitch.toFixed(2),
    f: me.shots, d: me.dead, u: me.burning, i: me.shield > 0,
    a: Math.round((100 * me.hp) / PLANES[me.plane].hp),
    s: me.score,
  };
}

function onPlayers(all) {
  const now = performance.now();
  for (const [id, st] of Object.entries(all)) {
    if (!st || typeof st.x !== 'number') continue;
    let r = remotes.get(id);
    if (!r) {
      r = makeRemote(id, st);
      remotes.set(id, r);
      // (the players already there when I join are not news)
      if (performance.now() - joinedAt > 2000) addFeed(`<b>${esc(cleanName(st.n))}</b> joined`);
    }
    const wasDead = r.dead;
    r.net = st;
    r.netT = now;
    r.name = cleanName(st.n) || 'PILOT';
    r.plane = PLANES[st.p] ? st.p : 1;
    r.dead = !!st.d;
    r.burning = !!st.u;
    r.shielded = !!st.i;
    r.score = st.s || 0;
    r.hpShown = st.a ?? 100;
    if (!r.seen || (wasDead && !r.dead)) {
      // first sight, or back from the dead: put it straight where it is
      r.x = st.x; r.y = st.y; r.heading = st.h || 0;
      r.shots = st.f || 0;
      r.seen = true;
    }
    // guns fired since the last update: replay them from where the plane is now
    const fired = Math.min(4, (st.f || 0) - r.shots);
    for (let i = 0; i < fired; i++) {
      const n = r.shots + i;
      if (PLANES[r.plane].pattern === 'pairs') {
        shoot(r, n % 2, false);
        if (n % 2 === 0) r.view && r.view.fire('fire');
      } else {
        shoot(r, 0, false);
        shoot(r, 1, false);
        r.view && r.view.fire('fire');
      }
    }
    r.shots = Math.max(r.shots, st.f || 0);
  }
  for (const [id, r] of remotes) {
    if (!(id in all)) {
      addFeed(`<b>${esc(r.name)}</b> left`);
      r.view && r.view.dispose();
      r.tag.remove();
      r.arrow.remove();
      remotes.delete(id);
    }
  }
}

function makeRemote(id, st) {
  const tag = document.createElement('div');
  tag.className = 'tag';
  tag.innerHTML = '<span class="nm"></span><span class="bar"><i></i></span>';
  tagsLayer.appendChild(tag);
  const arrow = document.createElement('div');
  arrow.className = 'arrow-off';
  arrow.style.display = 'none';
  tagsLayer.appendChild(arrow);
  const r = {
    id, name: '', plane: st.p || 1, x: st.x, y: st.y, heading: st.h || 0, speed: st.v || 0,
    bank: 0, pitch: 0, dead: false, burning: false, shielded: false, score: 0, hpShown: 100,
    shots: st.f || 0, seen: false, net: st, netT: performance.now(), view: null, loading: false,
    tag, arrow, nameShown: '',
  };
  return r;
}

// Only the planes near the camera get a Rive instance; far ones are just data (any number can play).
function cullViews() {
  const near = (Math.hypot(view.sw, view.sh) / 2) / view.k + 250;
  for (const r of remotes.values()) {
    const d = Math.hypot(r.x - cam.x, r.y - cam.y);
    if (d < near && !r.view && !r.loading && r.seen) {
      r.loading = true;
      const canvas = document.createElement('canvas');
      canvas.className = 'plane';
      planesLayer.appendChild(canvas);
      const v = new PlaneView(canvas);
      v.resize(view.k);
      v.load().then(() => {
        r.loading = false;
        if (!remotes.has(r.id)) { v.dispose(); return; }
        r.view = v;
        v.resize(view.k);
      }).catch((e) => { r.loading = false; canvas.remove(); console.warn('remote plane', e); });
    } else if (d > near + 600 && r.view) {
      r.view.dispose();
      r.view = null;
    }
  }
}

function updateRemotes(dt) {
  const now = performance.now();
  for (const r of remotes.values()) {
    const st = r.net;
    // dead reckoning from the last update, then ease toward it
    const age = Math.min(0.5, (now - r.netT) / 1000);
    const px = st.x + Math.sin(st.h) * (st.v || 0) * age;
    const py = st.y - Math.cos(st.h) * (st.v || 0) * age;
    if (Math.hypot(px - r.x, py - r.y) > 400) { r.x = px; r.y = py; }
    const k = ease(10, dt);
    r.x += (px - r.x) * k;
    r.y += (py - r.y) * k;
    r.heading = wrap(r.heading + wrap(st.h - r.heading) * k);
    r.speed = st.v || 0;
    r.bank += ((st.b || 0) - r.bank) * k;
    r.pitch += ((st.q || 0) - r.pitch) * k;
  }
}

function onHit({ by, dmg }) {
  if (phase !== 'play' || me.dead || me.shield > 0) return;
  me.hp = Math.max(0, me.hp - (+dmg || 0));
  me.lastBy = by;
  me.view && me.view.fire('hit');
  if (me.hp <= PLANES[me.plane].hp * 0.35) me.burning = true;
  if (me.hp <= 0) {
    me.dead = true;
    me.burning = true;
    me.deadT = 0;
    const killer = remotes.get(by);
    net.kill(by, killer ? killer.name : 'PILOT', me.name);
    showBanner(`SHOT DOWN<small>BY ${esc(killer ? killer.name : 'PILOT')}</small>`, RESPAWN);
    net.send(myState());
  }
}

function onKill(k) {
  if (!session) return;
  if (k.by === session.id) {
    me.score += SCORE.kill;
    showBanner(`+${SCORE.kill}<small>YOU SHOT DOWN ${esc(cleanName(k.toName))}</small>`, 1.8);
  }
  addFeed(`<b>${esc(cleanName(k.byName))}</b> shot down ${esc(cleanName(k.toName))}`);
}

// --- HUD ------------------------------------------------------------------------------------
let boardT = 0;
function updateHud(dt) {
  $('#hpFill').style.width = `${(100 * me.hp) / PLANES[me.plane].hp}%`;
  $('#myScore').textContent = me.score;
  bannerT -= dt;
  if (bannerT <= 0) banner.classList.remove('show');
  boardT -= dt;
  if (boardT > 0) return;
  boardT = 0.25;
  const rows = [{ id: 'me', name: me.name, score: me.score, me: true }];
  for (const r of remotes.values()) if (r.seen) rows.push({ id: r.id, name: r.name, score: r.score });
  rows.sort((a, b) => b.score - a.score || (a.me ? -1 : 1));
  rows.forEach((r, i) => { r.rank = i + 1; });
  $('#boardCount').textContent = `${rows.length} ONLINE`;
  // the top ones, and me below them if I am further down
  const shown = rows.slice(0, BOARD_ROWS);
  const mine = rows.find((r) => r.me);
  if (mine.rank > BOARD_ROWS) shown.push(mine);
  $('#boardList').innerHTML = shown.map((r) =>
    `<li class="${r.rank === 1 ? 'first' : ''} ${r.me ? 'me' : ''}"><span class="rank">${r.rank === 1 ? '★' : r.rank}</span>` +
    `<span class="name">${esc(r.name)}${r.me ? ' (YOU)' : ''}</span><span class="pts">${r.score}</span></li>`).join('');
}

// name tags above the other planes, and arrows at the screen's edge toward those off it
function updateTags() {
  const m = 26;
  for (const r of remotes.values()) {
    if (!r.seen) { r.tag.style.display = 'none'; r.arrow.style.display = 'none'; continue; }
    const [sx, sy] = toScene(r.x, r.y);
    const [x, y] = sceneToScreen(sx, sy);
    const on = x > -40 && y > -40 && x < view.sw + 40 && y < view.sh + 40;
    if (on) {
      r.tag.style.display = '';
      r.arrow.style.display = 'none';
      r.tag.style.transform = `translate(${x}px, ${y - 46 * view.k}px) translate(-50%, -100%)`;
      if (r.nameShown !== r.name) { r.tag.querySelector('.nm').textContent = r.name; r.nameShown = r.name; }
      r.tag.querySelector('.bar i').style.width = `${r.hpShown}%`;
      r.tag.classList.toggle('dead', r.dead);
    } else {
      r.tag.style.display = 'none';
      r.arrow.style.display = r.dead ? 'none' : '';
      const cx = view.sw / 2, cy = view.sh / 2;
      const a = Math.atan2(y - cy, x - cx);
      const s = Math.min((cx - m) / Math.abs(Math.cos(a) || 1e-6), (cy - m) / Math.abs(Math.sin(a) || 1e-6));
      r.arrow.style.transform = `translate(${cx + Math.cos(a) * s}px, ${cy + Math.sin(a) * s}px) rotate(${a + Math.PI / 2}rad)`;
    }
  }
}

// --- bullets -> world.riv "Shots" ------------------------------------------------------------
function shotsData() {
  const u = view.unit;
  const m = 80 * view.k;
  let out = '';
  for (const bl of bullets) {
    const [x, y] = toScene(bl.x, bl.y);
    if (x < -m || y < -m || x > view.w + m || y > view.h + m) continue;
    out += `${bl.plane} ${(x * u).toFixed(1)} ${(y * u).toFixed(1)} ${bl.dx.toFixed(3)} ${bl.dy.toFixed(3)} ${(bl.muzzle * bl.t * view.k * u).toFixed(1)};`;
  }
  // impact sparks: kind 4, the last number is how far through its life (0..1)
  for (const sp of sparks) {
    const [x, y] = toScene(sp.x, sp.y);
    out += `4 ${(x * u).toFixed(1)} ${(y * u).toFixed(1)} 0 0 ${(sp.t / SPARK_LIFE).toFixed(2)};`;
  }
  return out;
}

// --- world binding --------------------------------------------------------------------------
let world = null;
let wvm = null;
let shots = null;
let svm = null;
const wNum = {};
function setWorld(name, v) {
  if (!wvm) return;
  const p = wNum[name] || (wNum[name] = wvm.number(name));
  if (p) p.value = v;
}

function measure() {
  // the scene is a square as big as the screen's diagonal, so turning it never shows a corner
  const sw = innerWidth, sh = innerHeight;
  const D = Math.ceil(Math.hypot(sw, sh));
  view.sw = sw; view.sh = sh;
  view.w = view.h = D;
  scene.style.width = scene.style.height = D + 'px';
  scene.style.left = (sw - D) / 2 + 'px';
  scene.style.top = (sh - D) / 2 + 'px';
  if (world) {
    world.resizeDrawingSurfaceToCanvas();
    const aw = world.artboardWidth;
    view.unit = aw > 0 ? aw / view.w : 1;
  }
  // the game's screen scale (GFX.scaleFor) x the camera zoom
  const mobile = matchMedia('(pointer: coarse)').matches;
  const gameK = Math.min(3.2, Math.max(mobile ? 1.2 : 0.72, Math.min(sw, sh) / 400));
  view.k = gameK * CAMERA.zoom;
  if (shots) shots.resizeDrawingSurfaceToCanvas();
  me.view && me.view.resize(view.k);
  for (const r of remotes.values()) r.view && r.view.resize(view.k);
  if (menuPlane) {
    const c = $('#menuPlane');
    menuPlane.setSize(Math.round(c.clientWidth || 300));
  }
}
addEventListener('resize', measure);

// --- menu ------------------------------------------------------------------------------------
let menuPlane = null;
let menuSel = 2; // the selected row: 0 name, 1 plane, 2 join
let menuT = 0;
let menuFireT = 1;
const rowsEl = [...document.querySelectorAll('.row')];
const chevron = document.createElement('div');
chevron.className = 'chevron';
chevron.textContent = '›';
$('.rows').appendChild(chevron);

function selectRow(i) {
  menuSel = (i + rowsEl.length) % rowsEl.length;
  rowsEl.forEach((r, k) => r.classList.toggle('sel', k === menuSel));
  chevron.style.transform = `translateY(${rowsEl[menuSel].offsetTop}px)`;
  if (menuSel === 0) nameInput.focus();
  else if (document.activeElement === nameInput) nameInput.blur();
}

function setMenuPlane(n) {
  me.plane = ((n - 1 + 3) % 3) + 1;
  const spec = PLANES[me.plane];
  $('#planeName').textContent = spec.name;
  const fire = spec.dmg * (spec.pattern === 'pairs' ? 2 / 0.29 : 2 / spec.gap) / 2;
  const meter = (label, v) => `<span>${label}</span><span class="meter"><i style="width:${Math.round(Math.min(1, v) * 100)}%"></i></span>`;
  $('#planeStats').innerHTML = meter('SPEED', spec.speed / STAT_MAX.speed) + meter('ARMOR', spec.hp / STAT_MAX.hp) +
    meter('FIREPOWER', fire / STAT_MAX.fire);
  try { localStorage.setItem('skyblitz.plane', String(me.plane)); } catch {}
}

rowsEl.forEach((r, i) => r.addEventListener('pointerenter', () => { if (phase === 'menu') selectRow(i); }));
nameInput.addEventListener('focus', () => selectRow(0));
nameInput.addEventListener('input', () => {
  const v = nameInput.value.toUpperCase().replace(/[^A-Z0-9 _\-.]/g, '');
  if (v !== nameInput.value) nameInput.value = v;
  setStatus('');
});
$('#prevPlane').addEventListener('click', (e) => { e.stopPropagation(); setMenuPlane(me.plane - 1); });
$('#nextPlane').addEventListener('click', (e) => { e.stopPropagation(); setMenuPlane(me.plane + 1); });
joinBtn.addEventListener('click', () => joinGame());

addEventListener('keydown', (e) => {
  if (phase !== 'menu') return;
  const typing = document.activeElement === nameInput;
  if (e.code === 'Enter') { e.preventDefault(); joinGame(); return; }
  if (e.code === 'ArrowDown' || (!typing && e.code === 'KeyS')) { e.preventDefault(); selectRow(menuSel + 1); }
  else if (e.code === 'ArrowUp' || (!typing && e.code === 'KeyW')) { e.preventDefault(); selectRow(menuSel - 1); }
  else if (!typing && (e.code === 'ArrowLeft' || e.code === 'KeyA')) setMenuPlane(me.plane - 1);
  else if (!typing && (e.code === 'ArrowRight' || e.code === 'KeyD')) setMenuPlane(me.plane + 1);
});

function setStatus(text, err = false) {
  menuStatus.textContent = text;
  menuStatus.classList.toggle('err', err);
}

async function joinGame() {
  if (phase !== 'menu') return;
  const name = cleanName(nameInput.value);
  if (name.length < 2) {
    setStatus('TYPE YOUR NAME (2-16 LETTERS)', true);
    selectRow(0);
    return;
  }
  try { localStorage.setItem('skyblitz.name', name); } catch {}
  phase = 'joining';
  joinBtn.disabled = true;
  setStatus('JOINING…');
  try {
    net = net || await createNet();
    net.onPlayers = onPlayers;
    net.onHit = onHit;
    net.onKill = onKill;
    me.name = name;
    session = await net.join({ name, plane: me.plane });
  } catch (e) {
    console.error('join failed', e);
    setStatus('COULD NOT JOIN: ' + (e && e.message ? e.message : e), true);
    phase = 'menu';
    joinBtn.disabled = false;
    return;
  }
  joinBtn.disabled = false;
  setStatus('');
  me.score = 0;
  me.shots = 0;
  me.gunT = 0;
  bullets.length = 0;
  spawn(me);
  cam.x = me.x; cam.y = me.y; cam.angle = me.heading;
  $('#roomLabel').textContent = `SKY ARENA · ${session.label}`;
  phase = 'play';
  joinedAt = performance.now();
  stage.dataset.phase = 'play';
  boardT = 0;
  showBanner(`SKY ARENA<small>SHOOT THEM DOWN</small>`, 2);
  net.send(myState());
}

async function leaveGame() {
  if (phase !== 'play') return;
  phase = 'menu';
  stage.dataset.phase = 'menu';
  keys.clear();
  touch.fire = false;
  try { await net.leave(); } catch (e) { console.warn(e); }
  session = null;
  for (const r of remotes.values()) { r.view && r.view.dispose(); r.tag.remove(); r.arrow.remove(); }
  remotes.clear();
  bullets.length = 0;
  sparks.length = 0;
  feed.innerHTML = '';
  banner.classList.remove('show');
  selectRow(2);
}

// --- main loop ------------------------------------------------------------------------------
let lastT = 0;
function frame(t) {
  const dt = Math.min(0.05, lastT ? (t - lastT) / 1000 : 0);
  lastT = t;

  if (phase === 'play') {
    readInput();
    fly(me, dt, input);
    updateRemotes(dt);
    cullViews();
    updateBullets(dt);
    updateCamera(dt);
    sendT -= dt;
    if (sendT <= 0 && net) {
      sendT = 1 / SEND_HZ;
      net.send(myState());
    }
    updateHud(dt);
  } else {
    // the menu: the camera drifts over the sea; the showcase plane sways and fires now and then
    menuT += dt;
    cam.x += 18 * dt;
    cam.y -= 40 * dt;
    cam.angle += wrap(0 - cam.angle) * ease(1, dt);
    updateBullets(dt);
    if (menuPlane) {
      menuPlane.num('plane', me.plane);
      menuPlane.num('bank', +(Math.sin(menuT * 0.7) * 0.45).toFixed(3));
      menuPlane.num('pitch', 0);
      menuPlane.bool('burning', false);
      menuPlane.bool('dead', false);
      menuFireT -= dt;
      if (menuFireT <= 0) { menuFireT = rand(1.4, 2.6); menuPlane.fire('fire'); }
    }
  }

  // planes -> their Rive instances
  if (me.view) {
    const [sx, sy] = toScene(me.x, me.y);
    me.view.place(sx, sy, me.heading);
    me.view.pose(me);
    me.view.canvas.classList.toggle('blink', me.shield > 0 && !me.dead);
  }
  for (const r of remotes.values()) {
    if (!r.view) continue;
    const [sx, sy] = toScene(r.x, r.y);
    r.view.place(sx, sy, r.heading);
    r.view.pose(r);
    r.view.canvas.classList.toggle('blink', r.shielded && !r.dead);
  }

  // world follows the camera; the wake follows my plane
  const [px, py] = toScene(me.x, me.y);
  setWorld('camX', cam.x * view.k * view.unit);
  setWorld('camY', cam.y * view.k * view.unit);
  setWorld('planeX', px * view.unit);
  setWorld('planeY', py * view.unit);
  setWorld('heading', me.heading);
  setWorld('planeOn', phase === 'play' && !me.dead ? 1 : 0);
  setWorld('k', view.k * view.unit);

  scene.style.transform = `rotate(${-cam.angle}rad)`;
  if (phase === 'play') updateTags();
  if (svm) {
    const d = svm.string('data');
    if (d) d.value = shotsData();
    const kk = svm.number('k');
    if (kk) kk.value = view.k * view.unit;
  }
  requestAnimationFrame(frame);
}

// --- boot -----------------------------------------------------------------------------------
async function boot() {
  try {
    nameInput.value = cleanName(localStorage.getItem('skyblitz.name') || '');
  } catch {}
  let savedPlane = 1;
  try { savedPlane = +localStorage.getItem('skyblitz.plane') || 1; } catch {}
  setMenuPlane(savedPlane);
  selectRow(nameInput.value ? 2 : 0);
  try {
    const [w, s, mine, showcase] = await Promise.all([
      loadRive({
        src: 'riv/world.riv',
        canvas: worldCanvas,
        artboard: 'World',
        enableGPUCanvas: true, // world.luau draws the ocean and clouds with WGSL shaders
        layout: new R.Layout({ fit: R.Fit.Layout }),
      }),
      loadRive({
        src: 'riv/world.riv',
        canvas: shotsCanvas,
        artboard: 'Shots',
        layout: new R.Layout({ fit: R.Fit.Layout }),
      }),
      new PlaneView($('#me')).load(),
      new PlaneView($('#menuPlane')).load(),
    ]);
    world = w;
    wvm = w.viewModelInstance;
    shots = s;
    svm = s.viewModelInstance;
    me.view = mine;
    menuPlane = showcase;
    if (!wvm || !svm) console.warn('world.riv: view model not bound');
    measure();
    selectRow(menuSel);
    $('#loading').classList.add('done');
    requestAnimationFrame(frame);
    // connect early (Firebase loads in the background) so joining is quick
    createNet().then((n) => {
      net = net || n;
      if (net.mode === 'local') setStatus('OFFLINE TEST MODE · OPEN MORE WINDOWS TO PLAY TOGETHER');
    }).catch((e) => console.warn('net', e));
  } catch (e) {
    console.error('boot failed', e && (e.stack || e.message || e));
    $('#loading').textContent = 'Could not load the Rive files. Serve this folder over http (see README).';
  }
}
boot();

// ?debug exposes the game state to the console (and to automated tests)
if (new URLSearchParams(location.search).has('debug')) {
  window.__sky = { me, remotes, cam, bullets, view, get phase() { return phase; }, get session() { return session; }, get net() { return net; } };
}
