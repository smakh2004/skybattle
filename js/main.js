/* Sky Blitz - online air combat, played like the solo game (game-airplane-v2).
 *
 * Rive files:
 *   riv/world.riv   "World": ocean, clouds, smoke trails - drawn at screen size, the camera's turn
 *                   applied inside the shaders (camX, camY, planeX, planeY, angle, planeOn, k, smoke)
 *                   "Shots": the solo game's overlay - tracers, rockets, power-up badges, shield
 *                   bubbles, weapon panels, NEW WEAPON showcase and the HUD bar (overlay.luau)
 *   riv/planes.riv  "Plane": the Player plane (bank, pitch, fire, hit, burning, dead, pods, podFire,
 *                   body colours pc1..pc13: every player gets their own colours on each spawn)
 *
 * All game state lives here; Rive draws it. Other players come from net.js (Firebase, or the windows
 * of this browser when there is no Firebase config). Everyone shares one arena, any number of
 * players; only the planes near you are loaded into Rive.
 *
 * Units: world positions and speeds are in plane-artboard units, the same for every screen. On
 * screen a unit is `view.k` css px (the game's screen scale x the camera zoom).
 */
// the build version from main.js?v=N (index.html), passed on to every file this page loads, so
// an update reaches players at once instead of after the browser's cache runs out
const V = new URL(import.meta.url).searchParams.get('v') || '0';
const { createNet } = await import(`./net.js?v=${V}`);
const { createSound } = await import(`./sound.js?v=${V}`);
const sfx = createSound(V); // the solo game's sounds and music

const R = window.rive;

// --- tuning (the solo game's numbers, in world units: its px/s at k = 1.5, / 1.5) ---------------
const FLIGHT = {
  cruise: 153,
  boost: 253,
  brake: 93,
  accel: 2.2, // how fast speed follows the throttle (1/s)
  turn: 2.4, // rad/s at full stick
  turnEase: 7, // how fast the turn follows the stick (1/s)
  bankEase: 6,
};
const MAX_HP = 100;
const LOW_HP = 20; // at or below this the plane is on fire (game.luau LOW_HP)
const HIT = [42, 45]; // the plane's outline as an ellipse: half wingspan, half length (artboard units)
// guns (game.luau fire / fireGun / firePods): a pair every 0.25-0.32 s, one gun, the other a moment
// later; the pods (Wing Guns) fire one bullet each with every pair
const GUN = { muzzle: 633, spread: 0.01, dmg: 9, muzzles: [[-4.0, -27], [3.8, -27]] };
const POD = { ammo: 120, dmg: 6, muzzles: [[-14.2, -27.2], [14.0, -27.2]] };
// rockets (game.luau MISSILE_*, ROCKET_*), world units
const ROCKET = { ammo: 12, cooldown: 0.22, speed: [173, 767], turn: 7, dmg: 40, splash: 12, splashR: 70, side: 28, range: 1300 };
const SHIELD_HITS = 8; // the Shield power-up blocks this many hits
const REPAIR_HP = 35;
const OIL = { max: 100, drain: 1.25, refill: 55, below: 60, urgent: 30 };
const REPAIR = { below: 70, urgent: 40 };
const PICKUP = { first: 8, min: 16, max: 24, reach: 52, ahead: 470, side: 200, gone: 1100 };
const KIND = { guns: 1, rockets: 2, repair: 3, oil: 4, shield: 5 }; // the overlay's badge numbers
const COLLECT_TIME = 0.75;

const PLANE_ARTBOARD = 320; // planes.riv's artboard size (units)
// The Player plane's body colours (planes.riv pc1..pc13): each player's plane is painted with them
// turned to its own hue. HUES: the palettes handed out on spawn (degrees from the red).
const BODY = ['E33B30', 'B73039', 'F16153', 'E94841', '6F4241', '7B514B', 'CB342C', 'F85755', '953528',
  'FF593C', '78534A', 'F15D49', '855752'];
const HUES = [0, 205, 120, 45, 275, 175, 320, 90, 235, 20, 150, 300];

// Quality: 2 high, 1 medium, 0 low. It starts high (or where this computer settled last time) and
// steps down by itself when frames take too long. Soft layers never render above 1 px per css px.
const QUALITY = [
  { world: 0.6, planes: 1, detail: 0, smoke: 0.4 }, // low
  { world: 0.8, planes: 1.25, detail: 0.5, smoke: 0.7 }, // medium
  { world: 1, planes: 1.5, detail: 1, smoke: 1 }, // high
];
let qLevel = 2;
try {
  const saved = localStorage.getItem('skyblitz.quality');
  if (saved !== null && +saved >= 0 && +saved <= 2) qLevel = +saved;
} catch {}
const Q = () => QUALITY[qLevel];
const worldDpr = () => Math.min(devicePixelRatio || 1, 1) * Q().world;
const planeDpr = () => Math.min(devicePixelRatio || 1, Q().planes);
const BULLET_LIFE = 1.4; // s
const SPAWN_R = () => 700 + 120 * Math.sqrt(remotes.size + 1); // where planes (re)spawn
const BOARD_ROWS = 8; // the scoreboard shows the top 8 (and you, if you are lower)
const RESPAWN = 3; // s after going down
const SPAWN_SHIELD = 2.5; // s of invulnerability after (re)spawning
const SCORE = { hit: 10, kill: 100 };
// OVERDRIVE (the solo game's beast mode, beast.luau): kills - more in a quick combo - and hits fill the
// meter (the glowing line along the bottom); full, OVERDRIVE runs for OD.time s: the guns fire twice
// as fast in a spread, the aim cone widens, kills score double. (Fills faster than the solo game's:
// players are fewer than its waves of bots.)
const OD = { time: 8, comboGap: 4, kill: 0.3, perCombo: 0.05, hit: 0.012, drain: 0.01, spread: 0.06, cone: 0.12 };
const od = { meter: 0, t: 0, bt: 99, combo: 0, comboT: 0 };
function odReset() { od.meter = od.t = od.combo = od.comboT = 0; od.bt = 99; }
function odKill() {
  od.combo += 1;
  od.comboT = OD.comboGap;
  if (od.t <= 0) od.meter = Math.min(1, od.meter + OD.kill + OD.perCombo * Math.min(od.combo, 8));
  return od.t > 0 ? 2 : 1;
}
function odTick(dt) {
  od.bt = Math.min(99, od.bt + dt);
  if (od.comboT > 0) { od.comboT -= dt; if (od.comboT <= 0) od.combo = 0; }
  if (od.t > 0) { od.t = Math.max(0, od.t - dt); od.meter = od.t / OD.time; return; }
  if (od.meter >= 1) {
    od.t = OD.time;
    od.bt = 0;
    sfx.play('shield_up');
    sfx.play('ui_start');
    showBanner('BEAST MODE', 'OVERDRIVE');
    return;
  }
  od.meter = Math.max(0, od.meter - OD.drain * dt);
}
// the camera at OVERDRIVE's start: in close on the plane, then back out (BEAST.camZoom)
function odZoom() {
  const bt = od.bt, Z = 1.32;
  if (bt >= 1.6) return 1;
  if (bt < 0.45) { const u = bt / 0.45; return 1 + (Z - 1) * (1 - (1 - u) ** 3); }
  if (bt < 0.8) return Z;
  const u = (bt - 0.8) / 0.8;
  return Z + (1 - Z) * (u * u * (3 - 2 * u));
}
const SEND_HZ = 12;
// a shot-down plane is blown off the screen like the solo game's enemies (game.luau killEnemy /
// DEATH): near the middle it goes down and out the bottom edge, veering to a side; near a side, off
// that side - faster and faster - and it is gone the moment it leaves the screen.
// shot down: the plane flies on the way it was heading, speeding up (accel, world units/s²) as it
// falls, and is gone once off the screen (or after life s)
const DEATH = { accel: 520, life: 2.4 };
// the camera looks ahead of the plane (so the plane sits low on the screen), follows it, and turns
// with it a little late. lead: s of travel ahead; ease: follow (1/s); turn: angle catch-up (1/s);
// zoom: how far out (1 = the game's own scale, smaller = further away)
const CAMERA = { lead: 1.0, ease: 3.2, turn: 2.0, zoom: 0.62 };
// V: the wide view - the camera pulls out (see more of the sky) for a few seconds, then comes back
const WIDE = { zoom: 0.6, hold: 4, ease: 3, cooldown: 6 };
let wideT = 0; // s of wide view left
let wideCd = 0; // s until V works again
let zoomMul = 1; // the camera's pull-out now (1 normal)

// --- dom ------------------------------------------------------------------------------------
const $ = (s) => document.querySelector(s);
const stage = $('#stage');
const worldCanvas = $('#world');
const shotsCanvas = $('#shots');
const planesLayer = $('#planes');
const tagsLayer = $('#tags');
const nameInput = $('#nameInput');
const menuStatus = $('#menuStatus');
const banner = $('#banner');
const feed = $('#feed');

// --- helpers --------------------------------------------------------------------------------
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const NAME_MAX = 12; // letters in a name (it fits the menu's button)
// the room for a name on the menu's button (MainMenu units: its text at 22 px, letter spacing 2.2)
const NAME_ROOM = 192;
let nameCtx = null;
function nameWidth(str) {
  nameCtx = nameCtx || document.createElement('canvas').getContext('2d');
  nameCtx.font = '22px "Russo One", sans-serif';
  nameCtx.letterSpacing = '2.2px';
  return nameCtx.measureText(str).width;
}
const cleanName = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 _\-.]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
const backOut = (t) => { const c1 = 1.70158, u = t - 1; return 1 + (c1 + 1) * u * u * u + c1 * u * u; };

// the body colours turned by `deg` degrees of hue: [[r, g, b] x 13]
const paletteCache = new Map();
function palette(deg) {
  if (paletteCache.has(deg)) return paletteCache.get(deg);
  const out = BODY.map((hex) => {
    let r = parseInt(hex.slice(0, 2), 16) / 255, g = parseInt(hex.slice(2, 4), 16) / 255, b = parseInt(hex.slice(4, 6), 16) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360 + deg) % 360;
    const s = mx ? d / mx : 0, v = mx;
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    const [rr, gg, bb] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [Math.round((rr + m) * 255), Math.round((gg + m) * 255), Math.round((bb + m) * 255)];
  });
  paletteCache.set(deg, out);
  return out;
}

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
    const f = new R.RiveFile({ src: `riv/planes.riv?v=${V}` });
    await f.init();
    planesFile = f;
    return { riveFile: f };
  } catch (e) {
    console.warn('shared planes.riv failed, loading per plane', e);
    return { src: `riv/planes.riv?v=${V}` };
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
    this.hue = null;
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
  /** Paint the body in hue `deg`. */
  colors(deg) {
    if (!this.vm || this.hue === deg) return;
    this.hue = deg;
    palette(deg).forEach(([r, g, b], i) => {
      const c = this.vm.color(`pc${i + 1}`);
      if (c) c.argb(255, r, g, b);
    });
  }
  /** Place on screen (css px, centre) and turn it (radians, screen). */
  place(x, y, rot, scale = 1) {
    const h = this.size / 2;
    this.canvas.style.transform = `translate(${x - h}px, ${y - h}px) rotate(${rot}rad) scale(${scale})`;
  }
  /** The game draws planes at k x their artboard. The artboard is 320 units: the plane in the
   * middle with room around it for its smoke and explosion, so they are never cut off. */
  resize(k) {
    this.setSize(Math.round(PLANE_ARTBOARD * k));
  }
  setSize(px) {
    this.size = px;
    this.canvas.style.width = this.canvas.style.height = px + 'px';
    if (this.r) this.r.resizeDrawingSurfaceToCanvas(planeDpr());
  }
  /** Stop / restart drawing (a hidden plane costs nothing). */
  active(on) {
    if (!this.r || this.on === on) return;
    this.on = on;
    if (on) this.r.startRendering(); else this.r.stopRendering();
  }
  pose(p) {
    this.num('bank', +p.bank.toFixed(3));
    this.num('pitch', +p.pitch.toFixed(3));
    this.num('pods', +p.podScale.toFixed(3));
    this.bool('burning', p.burning);
    this.bool('dead', p.dead);
    this.colors(p.hue);
  }
  dispose() {
    try { this.r && this.r.cleanup(); } catch {}
    this.canvas.remove();
  }
}

// --- state ----------------------------------------------------------------------------------
const view = { sw: innerWidth, sh: innerHeight, unit: 1, k: 1, baseK: 1 };
const cam = { x: 0, y: 0, angle: 0 };
let phase = 'menu'; // 'menu' | 'joining' | 'play'
let net = null;
let session = null; // { id, label }
let joinedAt = 0;
let sendT = 0;

const me = {
  id: 'me',
  name: '',
  hue: 0,
  x: 0, y: 0,
  heading: 0, // rad, 0 = nose up (north), clockwise
  speed: FLIGHT.cruise,
  turn: 0,
  bank: 0,
  pitch: 0,
  hp: MAX_HP,
  oil: OIL.max,
  burning: false,
  dead: false,
  deadT: 0,
  spawnShield: 0, // s of invulnerability left after spawning
  score: 0,
  shots: 0, // gun shots fired (sent, so the others can draw my bullets)
  podShots: 0, // pod volleys fired
  rockets: 0, // rockets fired
  rocketTarget: '',
  gunT: 0,
  pending: [], // the second gun of a pair, fired a moment later: [{ t, gun }]
  // power-ups (game.luau: podActive / podAmmo, rktActive / rktAmmo, shieldHits)
  podAmmo: 0,
  podT: 0,
  podScale: 0,
  rktAmmo: 0,
  rktCd: 0,
  rktSide: 1,
  shieldHits: 0,
  shieldT: 0,
  shieldFlash: 0,
  abOrder: [],
  view: null,
};
const remotes = new Map(); // id -> remote player
const bullets = []; // { owner, mine, pod, dmg, x, y, vx, vy, dx, dy, muzzle, t }
const sparks = []; // where bullets struck a plane: { x, y, t }
const SPARK_LIFE = 0.25;
const missiles = []; // { owner, mine, tgt, x, y, vx, vy, tx, ty, age, trav, smokeT, dead }
const rings = []; // blast shockwaves { x, y, t, max, r }
const pickups = []; // my power-up badges { id, kind, x, y, t }
const collects = []; // badges being collected { id, kind, x, y, t }
let pickupT = PICKUP.first;
let lastPickup = null;
let pickupId = 1;
let introSeq = 0;
let introKind = 1;
let introUntil = 0; // while the showcase plays my plane is drawn over it (as in the solo game)

// Smoke trails: burning planes (and rockets) leave puffs in the sky, so the smoke stays where it was
// left and draws the path. FIRE: the plane's flames (wings, body) in artboard units from its centre.
const FIRE = [[29.3, -1.5], [-28.7, -12.6], [0.3, 24]];
const SMOKE = { every: 0.03, life: [2.4, 3.2], r0: 4, r1: [18, 28], alpha: 0.42, max: 600, fall: 1.0 };
const smoke = []; // { x, y, vx, vy, t, life, r0, r1, a, light }

// --- input ----------------------------------------------------------------------------------
const keys = new Set();
const input = { x: 0, y: 0, fire: false }; // x: turn -1..1, y: throttle -1 (boost) .. 1 (brake)
const touch = { x: 0, y: 0, fire: false, stickId: null };

addEventListener('keydown', (e) => {
  if (phase !== 'play') return;
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === 'Escape') leaveGame();
  if (e.code === 'KeyQ') fireRocket();
  if (e.code === 'KeyV' && wideCd <= 0 && !me.dead) { wideT = WIDE.hold; wideCd = WIDE.hold + WIDE.cooldown; }
  if (e.code === 'KeyM') { SETTINGS.sound = !SETTINGS.sound; saveSettings(); }
  if (e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

// mouse: hold anywhere on the sea to fire
worldCanvas.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && phase === 'play') touch.fire = true; });
addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse') touch.fire = false; });

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
$('#rocketBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); fireRocket(); });
$('#exitBtn').addEventListener('click', () => leaveGame());

let padsOn = false; // (polled only once a gamepad is plugged in)
addEventListener('gamepadconnected', () => { padsOn = true; });
function readInput() {
  let x = 0, y = 0;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
  if (keys.has('KeyW') || keys.has('ArrowUp')) y -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) y += 1;
  let fire = keys.has('Space') || touch.fire;
  if (touch.stickId !== null) { x = touch.x; y = touch.y; }
  const pads = padsOn && navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) {
    if (!p) continue;
    const ax = p.axes[0] || 0, ay = p.axes[1] || 0;
    if (Math.abs(ax) > 0.15) x = ax;
    if (Math.abs(ay) > 0.15) y = ay;
    if ((p.buttons[0] && p.buttons[0].pressed) || (p.buttons[7] && p.buttons[7].value > 0.3)) fire = true;
    if (p.buttons[2] && p.buttons[2].pressed && !p._rk) fireRocket();
    p._rk = p.buttons[2] && p.buttons[2].pressed;
  }
  input.x = clamp(x, -1, 1);
  input.y = clamp(y, -1, 1);
  input.fire = fire;
}

// --- screen mapping ---------------------------------------------------------------------------
// world -> screen: around the camera, turned by its angle
function toScreen(x, y) {
  const dx = (x - cam.x) * view.k, dy = (y - cam.y) * view.k;
  const c = Math.cos(cam.angle), s = Math.sin(cam.angle);
  return [view.sw / 2 + c * dx + s * dy, view.sh / 2 - s * dx + c * dy];
}
// a world direction -> screen direction
function dirToScreen(dx, dy) {
  const c = Math.cos(cam.angle), s = Math.sin(cam.angle);
  return [c * dx + s * dy, -s * dx + c * dy];
}
// world -> the world shader's frame: around the screen centre, not turned (it turns it itself)
const toWorldFrame = (x, y) => [view.sw / 2 + (x - cam.x) * view.k, view.sh / 2 + (y - cam.y) * view.k];
const onScreen = (sx, sy, m) => sx > -m && sy > -m && sx < view.sw + m && sy < view.sh + m;
// how loud something at (x, y) sounds: full near the camera, silent a screen and a half away
const near = (x, y) => clamp(1 - Math.hypot(x - cam.x, y - cam.y) / ((Math.hypot(view.sw, view.sh) * 0.75) / view.k), 0, 1);

let bannerT = 0;
// An announcement on the solo game's wave banner (drawn by the overlay): a small kicker line over a
// big title, with its animated `show`.
let bannerSeq = 0;
function showBanner(kicker, title) {
  if (!svm) return;
  const k = svm.string('bannerKick'), t = svm.string('bannerTitle');
  if (k) k.value = String(kicker).toUpperCase();
  if (t) t.value = String(title).toUpperCase();
  setShots('bannerSeq', ++bannerSeq);
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
  const r = Math.sqrt(Math.random()) * SPAWN_R();
  p.x = Math.cos(a) * r;
  p.y = Math.sin(a) * r;
  p.heading = Math.atan2(-p.x, p.y) + rand(-0.5, 0.5); // roughly toward the middle
  p.speed = FLIGHT.cruise;
  p.turn = p.bank = p.pitch = 0;
  p.hp = MAX_HP;
  p.oil = OIL.max;
  p.dead = false;
  p.gone = false;
  p.burning = false;
  p.spawnShield = SPAWN_SHIELD;
  p.lastBy = null;
  p.pending.length = 0;
  // a fresh plane: new colours, no power-ups (as a new game in the solo game)
  let hue = p.hue;
  while (hue === p.hue) hue = HUES[Math.floor(Math.random() * HUES.length)];
  p.hue = hue;
  p.podAmmo = 0; p.podT = 0; p.podScale = 0;
  p.rktAmmo = 0;
  p.shieldHits = 0; p.shieldT = 0; p.shieldFlash = 0;
  p.abOrder = [];
  pickups.length = 0;
  pickupT = PICKUP.first;
}

function goDown(cause, byId, byName) {
  if (me.dead) return;
  me.dead = true;
  me.burning = true;
  me.deadT = 0;
  me.hp = 0;
  me.deathCause = cause;
  odReset();
  net && net.kill(byId || session.id, byName || me.name, me.name, cause);
  if (cause === 'oil') sfx.play('sputter');
  if (cause === 'crash') {
    // a collision: my plane blows up right here and is gone
    crashBurst(me.x, me.y);
    me.gone = true;
  } else {
    sfx.play('explode_big');
    setTimeout(() => sfx.play('splash'), 950); // it hits the water
  }
  if (cause === 'oil') showBanner('THE ENGINE STOPPED', 'OUT OF OIL');
  else if (cause === 'crash') showBanner(`WITH ${byName}`, 'COLLISION');
  else showBanner(`BY ${byName}`, 'SHOT DOWN');
  net && net.send(myState());
}

function fly(p, dt, ctl) {
  if (p.dead) {
    // shot down: it flies on the way it was heading, speeding up as it falls (the lose timeline
    // shrinks it), and is gone once off the screen; the camera stays where it went down
    p.speed += DEATH.accel * dt;
    p.turn += (0 - p.turn) * ease(4, dt);
    p.deadT += dt;
    if (p === me && !p.gone) {
      const [sx, sy] = toScreen(p.x, p.y);
      if (!onScreen(sx, sy, 160 * view.k / CAMERA.zoom) || p.deadT > DEATH.life) p.gone = true;
    }
    if (p.deadT > RESPAWN) {
      spawn(p);
      cam.x = p.x; cam.y = p.y; cam.angle = p.heading;
      showBanner('BACK IN THE AIR', 'FIGHT');
    }
  } else {
    const target = ctl.y < 0 ? FLIGHT.cruise + (FLIGHT.boost - FLIGHT.cruise) * -ctl.y
      : FLIGHT.cruise - (FLIGHT.cruise - FLIGHT.brake) * ctl.y;
    p.speed += (target - p.speed) * ease(FLIGHT.accel, dt);
    p.turn += (ctl.x - p.turn) * ease(FLIGHT.turnEase, dt);
    // oil drains while flying; when it runs out the engine stops (game.luau OIL)
    const oilWas = p.oil;
    p.oil = Math.max(0, p.oil - OIL.drain * dt);
    if (oilWas > 25 && p.oil <= 25) sfx.play('warning');
    if (p.oil <= 0) goDown('oil');
  }
  p.heading = wrap(p.heading + p.turn * FLIGHT.turn * dt);
  p.x += Math.sin(p.heading) * p.speed * dt;
  p.y -= Math.cos(p.heading) * p.speed * dt;
  p.bank += (p.turn - p.bank) * ease(FLIGHT.bankEase, dt);
  p.pitch += ((p.dead ? 0 : ctl.y) - p.pitch) * ease(4, dt);
  p.spawnShield = Math.max(0, p.spawnShield - dt);
  p.burning = p.dead || p.hp <= LOW_HP;
  // pods: pop out with a little overshoot, fold away when the ammo is gone (game.luau updatePower)
  const podOn = p.podAmmo > 0;
  p.podT = podOn ? Math.min(1, p.podT + dt * 3) : Math.max(0, p.podT - dt * 4);
  p.podScale = podOn ? backOut(p.podT) : p.podT * p.podT;
  p.shieldT = p.shieldHits > 0 ? Math.min(1, p.shieldT + dt * 4) : Math.max(0, p.shieldT - dt * 4);
  p.shieldFlash = Math.max(0, p.shieldFlash - dt * 3);
  p.rktCd = Math.max(0, p.rktCd - dt);
  guns(p, dt, ctl.fire && !p.dead);
}

/** The guns: a pair every 0.25-0.32 s (one gun, the other a moment later), and both pods with it. */
function guns(p, dt, wantFire) {
  p.gunT -= dt;
  for (let i = p.pending.length - 1; i >= 0; i--) {
    const q = p.pending[i];
    q.t -= dt;
    if (q.t <= 0) {
      if (!p.dead) { shoot(p, q.gun, true); p.shots += 1; sfx.play('gun'); }
      p.pending.splice(i, 1);
    }
  }
  if (!wantFire || p.gunT > 0) return;
  const interval = 0.11 * rand(2.3, 2.9) * (p === me && od.t > 0 ? 0.5 : 1);
  const first = p.shots % 2; // alternate, so the others can tell which gun fired
  shoot(p, first, true);
  p.shots += 1;
  sfx.play('gun');
  p.pending.push({ t: interval * rand(0.35, 0.65), gun: 1 - first });
  p.view && p.view.fire('fire');
  p.gunT = interval;
  firePods(p);
}

function firePods(p) {
  if (p.podAmmo <= 0 || p.podT < 0.6) return;
  podVolley(p, true);
  sfx.play('pod');
  p.podAmmo = Math.max(0, p.podAmmo - 2);
  p.podShots += 1;
  if (p.podAmmo <= 0) dropAbility('guns');
}

function podVolley(p, mine) {
  shoot(p, 0, mine, true);
  shoot(p, 1, mine, true);
  p.view && p.view.fire('podFire');
}

/** A bullet from plane p's gun (0 / 1), or its pod. `mine`: I fired it, so I check what it hits. */
// Gun targeting (the solo game's auto lock): the guns reach a cone ahead of the plane (wider with the
// wing guns); the best plane in it within AIM.range is the target - shots go to where it will be
// (its lead point) and curve onto it.
const AIM = { cone: (12 * Math.PI) / 180, podCone: (24 * Math.PI) / 180, range: 760, turn: 5.5 };
function aimTarget(p, pod) {
  const cone = (pod || p.podAmmo > 0 ? AIM.podCone : AIM.cone) + (p === me && od.t > 0 ? OD.cone : 0);
  let best = null, bestS = Infinity;
  for (const e of planesForHits(p.id)) {
    if (e.gone || e.fling) continue;
    const dx = e.x - p.x, dy = e.y - p.y;
    const d = Math.hypot(dx, dy);
    if (d > AIM.range || d < 1) continue;
    const ang = Math.abs(wrapAngle(Math.atan2(dx, -dy) - p.heading));
    if (ang > cone + Math.atan2(22, d)) continue;
    const sc = ang / cone + d / AIM.range;
    if (sc < bestS) { best = e; bestS = sc; }
  }
  return best;
}
// where a bullet from (gx, gy) meets e: its position a flight time ahead
function leadPoint(gx, gy, e) {
  const evx = Math.sin(e.heading) * (e.speed || 0), evy = -Math.cos(e.heading) * (e.speed || 0);
  let tx = e.x, ty = e.y;
  for (let i = 0; i < 2; i++) {
    const t = Math.hypot(tx - gx, ty - gy) / GUN.muzzle;
    tx = e.x + evx * t; ty = e.y + evy * t;
  }
  return [tx, ty];
}
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function shoot(p, gun, mine, pod = false) {
  const [mx, my] = (pod ? POD : GUN).muzzles[gun];
  const c = Math.cos(p.heading), sn = Math.sin(p.heading);
  const gx = p.x + mx * c - my * sn, gy = p.y + mx * sn + my * c;
  const tgt = aimTarget(p, pod);
  const hot = mine && od.t > 0; // (OVERDRIVE: a spread of shots, a wider cone)
  let a = p.heading + rand(-GUN.spread, GUN.spread) * (pod ? 2 : 1);
  if (tgt) {
    const [tx, ty] = leadPoint(gx, gy, tgt);
    const cone = (pod || p.podAmmo > 0 ? AIM.podCone : AIM.cone) + (hot ? OD.cone : 0);
    a = p.heading + clamp(wrapAngle(Math.atan2(tx - gx, -(ty - gy)) - p.heading), -cone, cone);
  }
  if (hot) a += rand(-OD.spread, OD.spread);
  bullets.push({
    tgt,
    owner: p.id,
    mine,
    pod,
    dmg: pod ? POD.dmg : GUN.dmg,
    x: gx,
    y: gy,
    vx: Math.sin(p.heading) * p.speed + Math.sin(a) * GUN.muzzle,
    vy: -Math.cos(p.heading) * p.speed - Math.cos(a) * GUN.muzzle,
    dx: Math.sin(a), dy: -Math.cos(a),
    muzzle: GUN.muzzle,
    t: 0,
  });
}

// --- abilities (game.luau claimSlot / takePickup) --------------------------------------------
function abilityOn(p, k) {
  return k === 'rockets' ? p.rktAmmo > 0 : k === 'shield' ? p.shieldHits > 0 : p.podAmmo > 0;
}
function dropAbility(k) {
  if (k === 'rockets') me.rktAmmo = 0;
  else if (k === 'shield') me.shieldHits = 0;
  else me.podAmmo = 0;
  me.abOrder = me.abOrder.filter((o) => o !== k);
}
// at most two abilities at once: taking a third ends the oldest
function claimSlot(k) {
  const order = me.abOrder.filter((o) => o !== k && abilityOn(me, o));
  if (order.length >= 2) dropAbility(order.shift());
  order.push(k);
  me.abOrder = order;
}

function takePickup(pk) {
  collects.push({ id: pk.id, kind: pk.kind, x: pk.x, y: pk.y, t: 0, bt: pk.t });
  const k = pk.kind;
  sfx.play(k === KIND.shield ? 'shield_up' : k === KIND.repair ? 'repair' : k === KIND.oil ? 'oil' : 'pickup');
  if (k === KIND.repair) { me.hp = Math.min(MAX_HP, me.hp + REPAIR_HP); return; }
  if (k === KIND.oil) { me.oil = Math.min(OIL.max, me.oil + OIL.refill); return; }
  const name = k === KIND.rockets ? 'rockets' : k === KIND.shield ? 'shield' : 'guns';
  const refill = abilityOn(me, name);
  claimSlot(name);
  if (name === 'rockets') me.rktAmmo = ROCKET.ammo;
  else if (name === 'shield') me.shieldHits = SHIELD_HITS;
  else me.podAmmo = POD.ammo;
  if (!refill) {
    introSeq += 1;
    introKind = name === 'rockets' ? 2 : name === 'shield' ? 3 : 1;
    introUntil = performance.now() + 900; // (the showcase lasts 0.9 s)
  }
}

// a badge now and then, never two at once, for what the plane needs (game.luau updatePower)
function updatePickups(dt) {
  const abilities = ['guns', 'rockets', 'shield'].filter((k) => abilityOn(me, k)).length;
  const room = abilities < 2;
  const due = {
    guns: room && (me.podAmmo <= 0 || me.podAmmo < POD.ammo * 0.5),
    rockets: room && (me.rktAmmo <= 0 || me.rktAmmo < ROCKET.ammo * 0.5),
    repair: me.hp <= REPAIR.below,
    oil: me.oil <= OIL.below,
    shield: room && me.shieldHits === 0,
  };
  if (!me.dead && pickups.length === 0 && Object.values(due).some(Boolean)) {
    if (me.oil <= OIL.urgent) pickupT = Math.min(pickupT, 3);
    pickupT -= dt;
    if (pickupT <= 0) {
      const list = Object.keys(due).filter((k) => due[k] && k !== lastPickup);
      let kind = list.length ? list[Math.floor(Math.random() * list.length)] : due.repair ? 'repair' : due.oil ? 'oil' : (lastPickup || 'guns');
      if (due.repair && me.hp <= REPAIR.urgent) kind = 'repair';
      if (due.oil && me.oil <= OIL.urgent) kind = 'oil';
      lastPickup = kind;
      // ahead of the plane, just past the top of the screen, as the solo game's badges come in
      const side = rand(-PICKUP.side, PICKUP.side);
      const fx = Math.sin(cam.angle), fy = -Math.cos(cam.angle);
      pickups.push({
        id: pickupId++, kind: KIND[kind],
        x: me.x + fx * PICKUP.ahead - fy * side,
        y: me.y + fy * PICKUP.ahead + fx * side,
        t: 0,
      });
      pickupT = rand(PICKUP.min, PICKUP.max);
    }
  }
  for (let i = pickups.length - 1; i >= 0; i--) {
    const pk = pickups[i];
    pk.t += dt;
    const d = Math.hypot(pk.x - me.x, pk.y - me.y);
    if (!me.dead && d < PICKUP.reach) {
      pickups.splice(i, 1);
      takePickup(pk);
    } else if (d > PICKUP.gone) {
      pickups.splice(i, 1);
    }
  }
  for (let i = collects.length - 1; i >= 0; i--) {
    collects[i].t += dt;
    if (collects[i].t > COLLECT_TIME) collects.splice(i, 1);
  }
}

// --- rockets (game.luau fireRocket / updateMissiles / explode) ----------------------------------
// Q: a rocket off the next wing at the nearest other plane in range (none in range: no launch)
function fireRocket() {
  if (phase !== 'play' || me.dead || me.rktAmmo <= 0 || me.rktCd > 0) return;
  let best = null, bestD = ROCKET.range;
  for (const r of remotes.values()) {
    if (!r.seen || r.dead) continue;
    const d = Math.hypot(r.x - me.x, r.y - me.y);
    if (d < bestD) { best = r; bestD = d; }
  }
  if (!best) { showBanner('ROCKETS', 'NO TARGET'); return; }
  launch(me, best.id, true);
  sfx.play('rocket');
  me.rockets += 1;
  me.rocketTarget = best.id;
  me.rktCd = ROCKET.cooldown;
  me.rktAmmo -= 1;
  if (me.rktAmmo <= 0) dropAbility('rockets');
}

function launch(p, targetId, mine) {
  const side = p.rktSide || 1;
  p.rktSide = -side;
  const c = Math.cos(p.heading), s = Math.sin(p.heading);
  // off the wing, pushed out sideways and a little ahead
  const lx = side * ROCKET.side, ly = 0;
  const vx = side * 173, vy = -80;
  const x = p.x + lx * c - ly * s, y = p.y + lx * s + ly * c;
  const tgt = targetId === (session && session.id) ? me : remotes.get(targetId) || null;
  missiles.push({
    owner: p.id, mine, tgt,
    x, y,
    vx: vx * c - vy * s + Math.sin(p.heading) * p.speed,
    vy: vx * s + vy * c - Math.cos(p.heading) * p.speed,
    tx: tgt ? tgt.x : x, ty: tgt ? tgt.y : y,
    age: 0, trav: 0, smokeT: 0, dead: false,
  });
}

function updateMissiles(dt) {
  for (const m of missiles) {
    m.age += dt;
    const tg = m.tgt;
    if (tg && tg.dead) m.tgt = null;
    if (m.tgt) { m.tx = m.tgt.x; m.ty = m.tgt.y; }
    const ramp = Math.min(1, m.age / 0.7);
    const speed = ROCKET.speed[0] + (ROCKET.speed[1] - ROCKET.speed[0]) * ramp * ramp;
    let heading = Math.atan2(m.vx, -m.vy);
    const want = Math.atan2(m.tx - m.x, m.y - m.ty);
    const diff = wrap(want - heading);
    const rate = ROCKET.turn * clamp(m.age / 0.3, 0.25, 1);
    heading += clamp(diff, -rate * dt, rate * dt);
    m.vx = Math.sin(heading) * speed;
    m.vy = -Math.cos(heading) * speed;
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    m.trav += speed * dt;
    // the light grey smoke trail
    m.smokeT -= dt;
    if (m.smokeT <= 0) {
      m.smokeT = 0.02;
      smoke.push({
        x: m.x - Math.sin(heading) * 30, y: m.y + Math.cos(heading) * 30,
        vx: rand(-6, 6), vy: rand(-6, 6), t: 0, life: rand(0.55, 0.95),
        r0: 2, r1: rand(7, 11), a: 0.55, light: true,
      });
    }
    if (m.tgt && touches(m.x - m.vx * dt, m.y - m.vy * dt, m.x, m.y, m.tgt)) explode(m, m.tgt);
    else if (!m.tgt && (m.x - m.tx) ** 2 + (m.y - m.ty) ** 2 < 18 * 18) explode(m, null);
    if (m.age > 5) m.dead = true;
  }
  for (let i = missiles.length - 1; i >= 0; i--) if (missiles[i].dead) missiles.splice(i, 1);
  for (let i = rings.length - 1; i >= 0; i--) {
    rings[i].t += dt;
    if (rings[i].t > rings[i].max) rings.splice(i, 1);
  }
}

function explode(m, hitP) {
  m.dead = true;
  sfx.play('blast', near(m.x, m.y));
  rings.push({ x: m.x, y: m.y, t: 0, max: 0.35, r: ROCKET.splashR * 1.3 });
  for (let i = 0; i < 6; i++) sparks.push({ x: m.x + rand(-14, 14), y: m.y + rand(-14, 14), t: rand(0, 0.08) });
  for (let i = 0; i < 8; i++) {
    smoke.push({ x: m.x + rand(-10, 10), y: m.y + rand(-10, 10), vx: rand(-20, 20), vy: rand(-20, 20), t: 0,
      life: rand(0.8, 1.3), r0: 6, r1: rand(18, 26), a: 0.5, light: true });
  }
  if (!m.mine || phase !== 'play') return;
  // only my own rockets deal damage (the shooter decides; the target takes it)
  for (const r of remotes.values()) {
    if (!r.seen || r.dead) continue;
    let dmg = 0;
    if (r === hitP) dmg = ROCKET.dmg;
    else if (Math.hypot(r.x - m.x, r.y - m.y) < ROCKET.splashR + 30) dmg = ROCKET.splash;
    if (dmg > 0) {
      net && net.hit(r.id, dmg);
      if (!r.shieldHits) me.score += SCORE.hit;
      r.view && r.view.fire('hit');
    }
  }
}

// --- bullets ----------------------------------------------------------------------------------
function updateBullets(dt) {
  for (let i = sparks.length - 1; i >= 0; i--) {
    sparks[i].t += dt;
    if (sparks[i].t > SPARK_LIFE) sparks.splice(i, 1);
  }
  const live = phase === 'play';
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.t += dt;
    // locked shots curve onto their target while it is still ahead of them
    const tg = b.tgt;
    if (tg) {
      if (tg.dead || tg.gone || tg.fling || (tg !== me && !remotes.has(tg.id))) b.tgt = null;
      else {
        const sp = Math.hypot(b.vx, b.vy);
        const cur = Math.atan2(b.vx, -b.vy);
        const want = Math.atan2(tg.x - b.x, -(tg.y - b.y));
        const off = wrapAngle(want - cur);
        if (Math.abs(off) > Math.PI / 2) b.tgt = null; // flew past it
        else {
          const na = cur + clamp(off, -AIM.turn * dt, AIM.turn * dt);
          b.vx = Math.sin(na) * sp; b.vy = -Math.cos(na) * sp;
          b.dx = Math.sin(na); b.dy = -Math.cos(na);
        }
      }
    }
    const px = b.x, py = b.y;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    let gone = b.t > BULLET_LIFE;
    if (!gone && live) {
      // every bullet stops where it touches a plane on this screen; only mine deal damage (the
      // shooter decides hits, the target takes the damage), so every screen agrees
      for (const p of planesForHits(b.owner)) {
        const at = touches(px, py, b.x, b.y, p);
        if (!at) continue;
        gone = true;
        sparks.push({ x: at[0], y: at[1], t: 0 });
        if (p.shielded || p.spawnShield > 0) break;
        if (b.mine && p !== me) {
          sfx.play('hit_enemy');
          net && net.hit(p.id, b.dmg);
          if (od.t <= 0) od.meter = Math.min(1, od.meter + OD.hit);
          if (!p.shieldHits) {
            me.score += SCORE.hit;
            p.view && p.view.fire('hit');
            p.hpShown = Math.max(0, p.hpShown - b.dmg);
          }
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

// Where the path a -> b first enters plane p's outline (an ellipse turned with it), or null.
function touches(ax, ay, bx, by, p) {
  const [hw, hl] = HIT;
  const c = Math.cos(p.heading), s = Math.sin(p.heading);
  for (let k = 1; k <= 4; k++) {
    const x = ax + ((bx - ax) * k) / 4;
    const y = ay + ((by - ay) * k) / 4;
    const dx = x - p.x, dy = y - p.y;
    const lx = dx * c + dy * s;
    const ly = -dx * s + dy * c;
    if ((lx * lx) / (hw * hw) + (ly * ly) / (hl * hl) <= 1) return [x, y];
  }
  return null;
}

// Two planes touching: both go down (a shield takes it instead). Each player checks their own
// plane and tells the other too, so both screens agree.
function checkCollisions() {
  if (phase !== 'play' || me.dead || me.spawnShield > 0) return;
  for (const r of remotes.values()) {
    if (!r.seen || r.dead || r.shielded) continue;
    if (!planesTouch(me, r)) continue;
    net && net.hit(r.id, 0, true);
    r.view && r.view.fire('hit');
    crashInto(r.id, r.name);
    break;
  }
}

function planesTouch(a, b) {
  if (Math.hypot(a.x - b.x, a.y - b.y) > 110) return false;
  return outlineInside(a, b) || outlineInside(b, a);
}

function outlineInside(a, b) {
  const [hw, hl] = HIT;
  const c = Math.cos(a.heading), s = Math.sin(a.heading);
  const bc = Math.cos(b.heading), bs = Math.sin(b.heading);
  for (let i = 0; i < 12; i++) {
    const t = (i / 12) * Math.PI * 2;
    const lx = Math.cos(t) * hw * 0.85, ly = Math.sin(t) * hl * 0.85;
    const x = a.x + lx * c - ly * s, y = a.y + lx * s + ly * c;
    const dx = x - b.x, dy = y - b.y;
    const bx = dx * bc + dy * bs, by = -dx * bs + dy * bc;
    if ((bx * bx) / (hw * hw) + (by * by) / (hl * hl) <= 0.85 * 0.85) return true;
  }
  return false;
}

function crashInto(id, name) {
  if (me.dead) return;
  if (me.shieldHits > 0) {
    // the shield takes the ram (one block), as in the solo game
    me.shieldHits -= 1;
    me.shieldFlash = 1;
    if (me.shieldHits <= 0) dropAbility('shield');
    me.spawnShield = 0.6; // (a moment to pull apart)
    return;
  }
  me.view && me.view.fire('hit');
  goDown('crash', id, name);
}

// --- smoke ------------------------------------------------------------------------------------
function updateSmoke(dt) {
  const emitters = [];
  if (phase === 'play') emitters.push(me);
  for (const r of remotes.values()) if (r.seen && !r.gone) emitters.push(r);
  for (const p of emitters) {
    // going down: my plane for a moment; another plane all the way off the screen (it burns as it goes)
    const falling = p.dead && (p === me ? p.deadT < SMOKE.fall : p.fling ? !p.gone : (performance.now() - (p.deadAt || 0)) / 1000 < SMOKE.fall);
    if (!(p.burning && !p.dead) && !falling) { p.smokeT = 0; continue; }
    p.smokeT = (p.smokeT || 0) - dt;
    while (p.smokeT <= 0) {
      p.smokeT += (SMOKE.every / Q().smoke) * (falling ? 1.6 : 1);
      const [fx, fy] = FIRE[Math.floor(Math.random() * FIRE.length)];
      const c = Math.cos(p.heading), sn = Math.sin(p.heading);
      smoke.push({
        x: p.x + fx * c - fy * sn + rand(-2, 2),
        y: p.y + fx * sn + fy * c + rand(-2, 2),
        vx: rand(-6, 6), vy: rand(-6, 6),
        t: 0,
        life: rand(SMOKE.life[0], SMOKE.life[1]) * (falling ? 0.8 : 1),
        r0: SMOKE.r0,
        r1: rand(SMOKE.r1[0], SMOKE.r1[1]) * (falling ? 1.4 : 1),
        a: SMOKE.alpha * (falling ? 0.8 : 1),
        light: false,
      });
    }
  }
  for (let i = smoke.length - 1; i >= 0; i--) {
    const pf = smoke[i];
    pf.t += dt;
    pf.x += pf.vx * dt;
    pf.y += pf.vy * dt;
    if (pf.t > pf.life) smoke.splice(i, 1);
  }
  const cap = Math.round(SMOKE.max * Q().smoke);
  if (smoke.length > cap) smoke.splice(0, smoke.length - cap);
}

// "x y radius alpha light;..." in World artboard units (screen space: the camera's turn applied)
function smokeData() {
  const u = view.unit;
  let out = '';
  for (const pf of smoke) {
    const f = pf.t / pf.life;
    const r = (pf.r0 + (pf.r1 - pf.r0) * Math.sqrt(f)) * view.k;
    const [x, y] = toScreen(pf.x, pf.y);
    if (!onScreen(x, y, r)) continue;
    const a = pf.a * Math.min(1, pf.t / 0.08) * (1 - f) * (1 - f * 0.4);
    out += `${(x * u).toFixed(1)} ${(y * u).toFixed(1)} ${(r * u).toFixed(1)} ${a.toFixed(3)} ${pf.light ? 1 : 0};`;
  }
  return out;
}

// --- the overlay's list (see overlay.luau) ----------------------------------------------------
function overlayData() {
  const u = view.unit;
  const k = view.k;
  const m = 80 * k;
  const f1 = (v) => (v * u).toFixed(1);
  let out = '';
  for (const bl of bullets) {
    const [x, y] = toScreen(bl.x, bl.y);
    if (!onScreen(x, y, m)) continue;
    const [dx, dy] = dirToScreen(bl.dx, bl.dy);
    out += `${bl.pod ? 10 : 1} ${f1(x)} ${f1(y)} ${dx.toFixed(3)} ${dy.toFixed(3)} ${f1(bl.muzzle * bl.t * k)};`;
  }
  for (const sp of sparks) {
    const [x, y] = toScreen(sp.x, sp.y);
    out += `4 ${f1(x)} ${f1(y)} 0 0 ${(sp.t / SPARK_LIFE).toFixed(2)};`;
  }
  for (const ms of missiles) {
    const [x, y] = toScreen(ms.x, ms.y);
    if (!onScreen(x, y, m)) continue;
    const sp = Math.max(1, Math.hypot(ms.vx, ms.vy));
    const [dx, dy] = dirToScreen(ms.vx / sp, ms.vy / sp);
    out += `5 ${f1(x)} ${f1(y)} ${dx.toFixed(3)} ${dy.toFixed(3)} ${f1(ms.trav * k)} ${ms.age.toFixed(2)};`;
  }
  for (const r of rings) {
    const [x, y] = toScreen(r.x, r.y);
    out += `6 ${f1(x)} ${f1(y)} ${(r.t / r.max).toFixed(3)} ${f1(r.r * k)};`;
  }
  for (const pk of pickups) {
    const [x, y] = toScreen(pk.x, pk.y);
    if (!onScreen(x, y, m)) continue;
    out += `7 ${pk.id} ${pk.kind} ${f1(x)} ${f1(y)} ${pk.t.toFixed(2)};`;
  }
  const [mx, my] = toScreen(me.x, me.y);
  for (const cl of collects) {
    const [x, y] = toScreen(cl.x, cl.y);
    out += `8 ${cl.id} ${cl.kind} ${f1(x)} ${f1(y)} ${cl.t.toFixed(3)} ${f1(mx)} ${f1(my)};`;
  }
  // shield bubbles: mine and everyone's who has one up
  const bubble = (p, hits, flash, alpha) => {
    if (alpha <= 0.01) return;
    const [x, y] = toScreen(p.x, p.y);
    if (!onScreen(x, y, m * 2)) return;
    const r = 62 * k * (0.85 + 0.15 * alpha) * (1 + 0.06 * flash);
    out += `9 ${f1(x)} ${f1(y - 4 * k)} ${f1(r)} ${(hits / SHIELD_HITS).toFixed(3)} ${flash.toFixed(3)} ${alpha.toFixed(3)};`;
  };
  if (phase === 'play' && !me.dead) bubble(me, me.shieldHits, me.shieldFlash, me.shieldT);
  for (const r of remotes.values()) if (r.seen && !r.dead) bubble(r, r.shieldHits || 0, 0, r.shieldT || 0);
  return out;
}

// --- network --------------------------------------------------------------------------------
function myState() {
  return {
    n: me.name, p: 1, c: me.hue,
    x: Math.round(me.x), y: Math.round(me.y),
    h: +me.heading.toFixed(3), v: Math.round(me.speed),
    b: +me.bank.toFixed(2), q: +me.pitch.toFixed(2),
    f: me.shots, pf: me.podShots, po: me.podAmmo > 0 ? 1 : 0,
    rk: me.rockets, rt: me.rocketTarget || '',
    sh: me.shieldHits,
    d: me.dead, dc: me.dead && me.deathCause === 'crash' ? 1 : 0, u: me.burning, i: me.spawnShield > 0,
    a: Math.round(me.hp),
    s: me.score,
  };
}

function onPlayers(all) {
  for (const [id, st] of Object.entries(all)) {
    if (!st || typeof st.x !== 'number') continue;
    let r = remotes.get(id);
    if (!r) {
      r = makeRemote(id, st);
      remotes.set(id, r);
      if (phase === 'play' && performance.now() - joinedAt > 2000) addFeed(`<b>${esc(cleanName(st.n))}</b> joined`);
    }
    const wasDead = r.dead;
    if (!wasDead && st.d) {
      r.deadAt = performance.now();
      if (st.dc) crashRemote(r); // a collision: it blows up where it is
      else startFling(r); // shot down: it flies on and falls away
    }
    if (wasDead && !st.d) { r.fling = null; r.gone = false; }
    r.net = st;
    r.name = cleanName(st.n) || 'PILOT';
    r.hue = typeof st.c === 'number' ? st.c : 0;
    r.dead = !!st.d;
    r.burning = !!st.u;
    r.shielded = !!st.i;
    r.score = st.s || 0;
    r.hpShown = st.a ?? 100;
    r.shieldHits = st.sh || 0;
    r.podsOut = !!st.po;
    if (!r.seen || (wasDead && !r.dead)) {
      r.x = st.x; r.y = st.y; r.heading = st.h || 0;
      r.shots = st.f || 0;
      r.podShots = st.pf || 0;
      r.rockets = st.rk || 0;
      r.seen = true;
      r.buf = [];
    }
    remember(r, st);
    // what they fired since the last update: replayed from where their plane is now
    const fired = Math.min(4, (st.f || 0) - r.shots);
    for (let i = 0; i < fired; i++) {
      const n = r.shots + i;
      shoot(r, n % 2, false);
      sfx.play('gun', 0.7 * near(r.x, r.y));
      if (n % 2 === 0) r.view && r.view.fire('fire');
    }
    r.shots = Math.max(r.shots, st.f || 0);
    const pods = Math.min(3, (st.pf || 0) - r.podShots);
    for (let i = 0; i < pods; i++) podVolley(r, false);
    r.podShots = Math.max(r.podShots, st.pf || 0);
    const rk = Math.min(3, (st.rk || 0) - r.rockets);
    for (let i = 0; i < rk; i++) { launch(r, st.rt, false); sfx.play('rocket', near(r.x, r.y)); }
    r.rockets = Math.max(r.rockets, st.rk || 0);
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
  return {
    id, name: '', hue: 0, x: st.x, y: st.y, heading: st.h || 0, speed: st.v || 0,
    bank: 0, pitch: 0, dead: false, burning: false, shielded: false, score: 0, hpShown: 100,
    shots: st.f || 0, podShots: st.pf || 0, rockets: st.rk || 0, rktSide: 1,
    podScale: 0, podT: 0, podsOut: false, shieldHits: 0, shieldT: 0,
    seen: false, net: st, view: null, loading: false, tag, arrow, nameShown: '',
  };
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
      v.resize(view.baseK);
      v.load().then(() => {
        r.loading = false;
        if (!remotes.has(r.id)) { v.dispose(); return; }
        r.view = v;
        v.resize(view.baseK);
      }).catch((e) => { r.loading = false; canvas.remove(); console.warn('remote plane', e); });
    } else if (d > near + 600 && r.view) {
      r.view.dispose();
      r.view = null;
    }
  }
}

// A collision: the plane blows up right there and is gone at once (no flight off the screen).
function crashBurst(x, y) {
  rings.push({ x, y, t: 0, max: 0.45, r: 120 });
  for (let i = 0; i < 12; i++) sparks.push({ x: x + rand(-26, 26), y: y + rand(-26, 26), t: rand(0, 0.1) });
  for (let i = 0; i < 14; i++) {
    smoke.push({ x: x + rand(-18, 18), y: y + rand(-18, 18), vx: rand(-30, 30), vy: rand(-30, 30), t: 0,
      life: rand(1.2, 2), r0: 8, r1: rand(26, 40), a: 0.55, light: false });
  }
  sfx.play('explode_big', near(x, y));
}

function crashRemote(r) {
  if (r.gone) return;
  crashBurst(r.x, r.y);
  r.fling = null;
  r.gone = true;
}

// The solo game's shot-down flight (killEnemy / the dying update), in screen pixels at its scale.
function startFling(r) {
  // it keeps going the way it was flying, faster and faster, falling (the dead timeline shrinks it)
  const dx = Math.sin(r.heading), dy = -Math.cos(r.heading);
  const v = Math.max(r.speed || 0, FLIGHT.cruise);
  r.fling = { dx, dy, v, t: 0 };
  sfx.play('explode', near(r.x, r.y));
  r.gone = false;
}

function updateFling(r, dt) {
  const f = r.fling;
  const K = view.k / CAMERA.zoom;
  f.t += dt;
  f.v += DEATH.accel * dt;
  r.x += f.dx * f.v * dt;
  r.y += f.dy * f.v * dt;
  const [sx, sy] = toScreen(r.x, r.y);
  if (!onScreen(sx, sy, 160 * K) || f.t > DEATH.life) r.gone = true;
}

// Other planes are shown a moment in the past (INTERP), moving between the positions they sent,
// so they glide smoothly however unevenly the updates arrive.
const INTERP = 0.12; // s
function updateRemotes(dt) {
  const nowWall = Date.now();
  for (const r of remotes.values()) {
    // their pods and shield ease in and out here too
    r.podT = r.podsOut ? Math.min(1, r.podT + dt * 3) : Math.max(0, r.podT - dt * 4);
    r.podScale = r.podsOut ? backOut(r.podT) : r.podT * r.podT;
    r.shieldT = r.shieldHits > 0 ? Math.min(1, r.shieldT + dt * 4) : Math.max(0, r.shieldT - dt * 4);
    if (r.fling) { if (!r.gone) updateFling(r, dt); continue; }
    const buf = r.buf;
    if (!buf || !buf.length) continue;
    const t = nowWall - r.lag - INTERP * 1000;
    let a = buf[0], b = null;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].t <= t) { a = buf[i]; b = buf[i + 1] || null; break; }
    }
    let x, y, h, bank, pitch;
    if (b) {
      const f = clamp((t - a.t) / Math.max(1, b.t - a.t), 0, 1);
      x = a.x + (b.x - a.x) * f;
      y = a.y + (b.y - a.y) * f;
      h = a.h + wrap(b.h - a.h) * f;
      bank = a.b + (b.b - a.b) * f;
      pitch = a.q + (b.q - a.q) * f;
    } else {
      const ahead = clamp((t - a.t) / 1000, 0, 0.25);
      x = a.x + Math.sin(a.h) * a.v * ahead;
      y = a.y - Math.cos(a.h) * a.v * ahead;
      h = a.h; bank = a.b; pitch = a.q;
    }
    const k = ease(25, dt);
    if (Math.hypot(x - r.x, y - r.y) > 300) { r.x = x; r.y = y; }
    r.x += (x - r.x) * k;
    r.y += (y - r.y) * k;
    r.heading = wrap(r.heading + wrap(h - r.heading) * k);
    r.bank += (bank - r.bank) * k;
    r.pitch += (pitch - r.pitch) * k;
    r.speed = a.v;
  }
}

function remember(r, st) {
  const now = Date.now();
  const t = typeof st.t === 'number' ? st.t : now;
  const d = now - t;
  r.lag = r.lag == null ? d : Math.min(d, r.lag + 5);
  if (!r.buf) r.buf = [];
  const last = r.buf[r.buf.length - 1];
  if (last && t <= last.t) return;
  r.buf.push({ t, x: st.x, y: st.y, h: st.h || 0, v: st.v || 0, b: st.b || 0, q: st.q || 0 });
  if (r.buf.length > 30) r.buf.shift();
}

function onHit({ by, dmg, crash }) {
  if (phase !== 'play' || me.dead || me.spawnShield > 0) return;
  const killer = remotes.get(by);
  if (crash) {
    crashInto(by, killer ? killer.name : 'PILOT');
    return;
  }
  // the shield takes the hit instead: one block used, a flash, no damage (game.luau damagePlayer)
  if (me.shieldHits > 0) {
    me.shieldHits -= 1;
    me.shieldFlash = 1;
    sfx.play('shield_hit');
    if (me.shieldHits <= 0) dropAbility('shield');
    return;
  }
  me.hp = Math.max(0, me.hp - (+dmg || 0));
  od.combo = 0; // (a hit breaks the combo)
  sfx.play('hit_player');
  me.view && me.view.fire('hit');
  if (me.hp <= 0) goDown('shot', by, killer ? killer.name : 'PILOT');
}

const crashSeen = new Map(); // pair -> time, so a collision is announced once
function onKill(k) {
  if (!session) return;
  const cause = k.cause || (k.crash ? 'crash' : 'shot');
  if (cause === 'oil') {
    addFeed(`<b>${esc(cleanName(k.toName))}</b> ran out of oil`);
    return;
  }
  if (cause === 'crash') {
    for (const id of [k.by, k.to]) {
      const r = remotes.get(id);
      if (r) crashRemote(r);
    }
    const pair = [k.by, k.to].sort().join('|');
    const now = performance.now();
    if (now - (crashSeen.get(pair) || -1e9) < 4000) return;
    crashSeen.set(pair, now);
    addFeed(`<b>${esc(cleanName(k.toName))}</b> and <b>${esc(cleanName(k.byName))}</b> collided`);
    return;
  }
  if (k.by === session.id) {
    const pts = SCORE.kill * odKill();
    me.score += pts;
    showBanner(`YOU SHOT DOWN ${cleanName(k.toName)}`, `+${pts}`);
  }
  addFeed(`<b>${esc(cleanName(k.byName))}</b> shot down ${esc(cleanName(k.toName))}`);
}

// --- HUD (the scoreboard; the bar itself is drawn by the overlay) -------------------------------
let boardT = 0;
let boardRect = null;
let lastBoard = '';
function updateBoard(dt) {
  $('#rocketBtn').classList.toggle('on', me.rktAmmo > 0 && !me.dead);
  boardT -= dt;
  if (boardT > 0) return;
  boardT = 0.25;
  const rows = [{ id: 'me', name: me.name, score: me.score, me: true }];
  for (const r of remotes.values()) if (r.seen) rows.push({ id: r.id, name: r.name, score: r.score });
  rows.sort((a, b) => b.score - a.score || (a.me ? -1 : 1));
  rows.forEach((r, i) => { r.rank = i + 1; });
  const count = `${rows.length} ONLINE`;
  if ($('#boardCount').textContent !== count) $('#boardCount').textContent = count;
  const shown = rows.slice(0, BOARD_ROWS);
  const mine = rows.find((r) => r.me);
  if (mine.rank > BOARD_ROWS) shown.push(mine);
  const html = shown.map((r) =>
    `<li class="${r.rank === 1 ? 'first' : ''} ${r.me ? 'me' : ''}"><span class="rank">${String(r.rank).padStart(2, '0')}</span><span class="div"></span>` +
    `<span class="name">${esc(r.name)}${r.me ? ' (YOU)' : ''}</span><span class="pts">${r.score}</span></li>`).join('');
  // (only when it changed: the curved table is redrawn from it)
  if (html !== lastBoard) { $('#boardList').innerHTML = html; lastBoard = html; boardRect = null; }
  if (!boardRect) boardRect = board.getBoundingClientRect();
  drawBoard();
}

// name tags above the other planes, and arrows at the screen's edge toward those off it
function updateTags() {
  const m = 26;
  for (const r of remotes.values()) {
    if (!r.seen || r.gone) { r.tag.style.display = 'none'; r.arrow.style.display = 'none'; continue; }
    const [x, y] = toScreen(r.x, r.y);
    const on = onScreen(x, y, 40);
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
      // on the screen's edge toward them, kept off the score table and the HUD bar
      const cx = view.sw / 2, cy = view.sh / 2;
      const a = Math.atan2(y - cy, x - cx);
      const s = Math.min((cx - m) / Math.abs(Math.cos(a) || 1e-6), (cy - m) / Math.abs(Math.sin(a) || 1e-6));
      let ax = cx + Math.cos(a) * s, ay = cy + Math.sin(a) * s;
      ay = Math.min(ay, view.sh - 90);
      const br = boardRect;
      if (br && ax > br.left - 16 && ay < br.bottom + 16) {
        if (Math.abs(Math.sin(a)) > 0.7) ax = Math.min(ax, br.left - 20); else ay = br.bottom + 22;
      }
      r.arrow.style.transform = `translate(${ax}px, ${ay}px) rotate(${a + Math.PI / 2}rad)`;
    }
  }
}

// shift: where on the screen the plane sits, right of the middle (px; the menu's spectating view)
function updateCamera(dt, p = me, shift = 0) {
  if (p.dead) return; // (it watches the plane fall away from where it went down)
  const v = (p.speed || 0) * CAMERA.lead;
  const c = Math.cos(cam.angle), sn = Math.sin(cam.angle);
  const tx = p.x + Math.sin(p.heading) * v - (c * shift) / view.k;
  const ty = p.y - Math.cos(p.heading) * v - (sn * shift) / view.k;
  const k = ease(CAMERA.ease, dt);
  cam.x += (tx - cam.x) * k;
  cam.y += (ty - cam.y) * k;
  cam.angle += wrap(p.heading - cam.angle) * ease(CAMERA.turn, dt);
}

// The menu shows a real player flying, live (the one with the best score; kept until they go),
// where the showcase plane would be; with nobody online, the showcase plane.
let spectId = null;
function spectTarget() {
  let r = spectId && remotes.get(spectId);
  if (r && r.seen && !r.gone) return r;
  if (r && r.dead) return r; // (watch them go down; another is picked once they are gone)
  r = null;
  for (const o of remotes.values()) if (o.seen && !o.dead && !o.gone && (!r || o.score > r.score)) r = o;
  spectId = r ? r.id : null;
  return r;
}

// --- Rive bindings ------------------------------------------------------------------------------
let world = null;
let wvm = null;
let shots = null;
let svm = null;
const wNum = {};
const sNum = {};
let wSmoke = null;
let sData = null;
function setWorld(name, v) {
  if (!wvm) return;
  const p = wNum[name] || (wNum[name] = wvm.number(name));
  if (p) p.value = v;
}
function setShots(name, v) {
  if (!svm) return;
  const p = sNum[name] || (sNum[name] = svm.number(name));
  if (p && p.value !== v) p.value = v;
}

function measure() {
  view.sw = innerWidth;
  view.sh = innerHeight;
  if (world) {
    world.resizeDrawingSurfaceToCanvas(worldDpr());
    const aw = world.artboardWidth;
    view.unit = aw > 0 ? aw / view.sw : 1;
  }
  const mobile = matchMedia('(pointer: coarse)').matches;
  const gameK = Math.min(3.2, Math.max(mobile ? 1.2 : 0.72, Math.min(view.sw, view.sh) / 400));
  view.baseK = gameK * CAMERA.zoom;
  view.k = view.baseK * zoomMul;
  if (shots) shots.resizeDrawingSurfaceToCanvas(Math.min(devicePixelRatio || 1, 1.5) * Q().world);
  me.view && me.view.resize(view.baseK);
  for (const r of remotes.values()) r.view && r.view.resize(view.baseK);
  if (menuPlane) menuPlane.setSize(Math.round($('#menuPlane').clientWidth || 300));
  bendMenu();
}
addEventListener('resize', () => { boardRect = null; measure(); });

// --- menu: the solo game's MainMenu (drawn by the overlay, bent like the game's) ---------------
// 01 the player's name, 02 PLAY, 03 CONTROLS (the controls list). W / S or the arrows select, ENTER
// confirms, as in the game; typing on the name button writes the name; the mouse and taps work too.
let menuPlane = null;
let menuSel = 1;
let menuPage = 0; // 0 the main page, 1 settings
// the settings, kept on this computer: sound on, SFX and MUSIC levels (0..1)
const SETTINGS = { sound: true, sfx: 1, music: 1 };
try { Object.assign(SETTINGS, JSON.parse(localStorage.getItem('skyblitz.settings') || '{}')); } catch {}
function saveSettings() {
  try { localStorage.setItem('skyblitz.settings', JSON.stringify(SETTINGS)); } catch {}
  sfx.setMuted(!SETTINGS.sound);
  sfx.levels(SETTINGS.sfx, SETTINGS.music);
}
const qualityName = () => ['LOW', 'MEDIUM', 'HIGH'][qLevel];
let qManual = false;
try { qManual = localStorage.getItem('skyblitz.qmanual') === '1'; } catch {}
let menuPress = 0;
let menuT = 0;
let menuFireT = 1;
const menuMotion = { phase: 'rest', t: 0.5, lean: 0, ox: 0, rate: 2, bank: 0, pitch: 0, burst: 0.6, gunT: 0 };
const menuEl = $('#menu');
const showcase = $('#menu .showcase');

function setSel(i, sound = true) {
  if (i !== menuSel && sound) sfx.play('ui_move');
  menuSel = i;
  if (menuSel === 1 && menuPage === 0) focusName();
  else if (document.activeElement === nameInput) nameInput.blur();
}
// a step up or down the page's buttons (they stop at the ends, as in the game: GFX.navStep)
function navStep(up) {
  const order = menuPage === 0 ? [1, 2, 3] : SETTINGS.sound ? [1, 4, 5, 2, 3] : [1, 2, 3];
  const i = Math.max(0, order.indexOf(menuSel));
  setSel(order[clamp(i + (up ? -1 : 1), 0, order.length - 1)]);
}
function openPage(page, sel) {
  menuPage = page;
  menuSel = sel;
  if (page === 1 && document.activeElement === nameInput) nameInput.blur();
}
// a slider: a step (keyboard) or a level from the pointer
function slide(row, v) {
  if (!SETTINGS.sound) return;
  const key = row === 4 ? 'sfx' : 'music';
  const nv = clamp(Math.round(v * 20) / 20, 0, 1);
  if (nv !== SETTINGS[key]) { SETTINGS[key] = nv; saveSettings(); sfx.play('ui_move'); }
}

// the buttons on screen, as the overlay drew them (css px)
function menuRows() {
  const p = svm && svm.string('menuHit');
  if (!p || !p.value) return [];
  return p.value.split(';').filter(Boolean).map((r) => r.split(' ').map((v) => +v / view.unit));
}

// the real text field sits, invisible, over the name button (phones open their keyboard for it)
function focusName() {
  const r = menuRows()[0];
  if (r) {
    Object.assign(nameInput.style, { left: r[0] + 'px', top: r[1] + 'px', width: r[2] - r[0] + 'px', height: r[3] - r[1] + 'px' });
  }
  if (phase === 'menu' && document.activeElement !== nameInput) nameInput.focus({ preventScroll: true });
}

function pressRow(i) {
  if (phase !== 'menu') return;
  menuPress += 1;
  if (menuPage === 1) {
    if (i === 1) { SETTINGS.sound = !SETTINGS.sound; saveSettings(); sfx.play('ui_press'); }
    else if (i === 2) {
      // QUALITY: HIGH -> MEDIUM -> LOW -> HIGH; picked by hand, the automatic step-down stops
      qLevel = (qLevel + 2) % 3;
      qManual = true;
      try { localStorage.setItem('skyblitz.quality', String(qLevel)); localStorage.setItem('skyblitz.qmanual', '1'); } catch {}
      setWorld('quality', Q().detail);
      measure();
      sfx.play('ui_press');
    } else if (i === 3) { sfx.play('ui_press'); openPage(0, 3); }
    return;
  }
  if (i === 1) { sfx.play('ui_press'); focusName(); }
  else if (i === 2) joinGame();
  else { sfx.play('ui_press'); openPage(1, 1); }
}

function rowAt(x, y) {
  const rows = menuRows();
  for (let i = 0; i < rows.length; i++) {
    const [x0, y0, x1, y1] = rows[i];
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return i + 1;
  }
  return 0;
}

// a slider row's level at screen x (the tracks run 88..198 of the row's 270 units)
function sliderAt(i, x) {
  const r = menuRows()[i - 1];
  if (!r) return null;
  const u = ((x - r[0]) / (r[2] - r[0])) * 270;
  return (u - 88) / (198 - 88);
}
let dragRow = 0;
menuEl.addEventListener('pointermove', (e) => {
  if (dragRow) { const v = sliderAt(dragRow, e.clientX); if (v !== null) slide(dragRow, v); return; }
  const i = rowAt(e.clientX, e.clientY);
  if (i && i !== menuSel) setSel(i);
});
menuEl.addEventListener('pointerdown', (e) => {
  const i = rowAt(e.clientX, e.clientY);
  if (!i) return;
  e.preventDefault();
  if (i !== menuSel) setSel(i);
  if (menuPage === 1 && i > 3) {
    dragRow = i;
    const v = sliderAt(i, e.clientX);
    if (v !== null) slide(i, v);
    return;
  }
  pressRow(i);
});
addEventListener('pointerup', () => { dragRow = 0; });
nameInput.addEventListener('input', () => {
  let v = nameInput.value.toUpperCase().replace(/[^A-Z0-9 _\-.]/g, '').slice(0, NAME_MAX);
  while (v.length > 1 && nameWidth(v) > NAME_ROOM) v = v.slice(0, -1); // (it has to fit the button)
  if (v !== nameInput.value) nameInput.value = v;
  setStatus('');
});
nameInput.addEventListener('focus', () => { if (menuSel !== 1) setSel(1); });

addEventListener('keydown', (e) => {
  if (phase !== 'menu') return;
  const typing = menuSel === 1 && menuPage === 0;
  if (e.code === 'Enter') {
    e.preventDefault();
    if (typing) setSel(2); // the name is in: on to PLAY
    else if (!(menuPage === 1 && menuSel > 3)) pressRow(menuSel);
    return;
  }
  if (e.code === 'Escape' && menuPage === 1) { sfx.play('ui_press'); openPage(0, 3); return; }
  if (e.code === 'ArrowDown' || (!typing && e.code === 'KeyS')) { e.preventDefault(); navStep(false); }
  else if (e.code === 'ArrowUp' || (!typing && e.code === 'KeyW')) { e.preventDefault(); navStep(true); }
  else if (menuPage === 1 && menuSel > 3 && (e.code === 'ArrowLeft' || e.code === 'KeyA' || e.code === 'ArrowRight' || e.code === 'KeyD')) {
    const dir = e.code === 'ArrowLeft' || e.code === 'KeyA' ? -1 : 1;
    slide(menuSel, SETTINGS[menuSel === 4 ? 'sfx' : 'music'] + dir * 0.1);
  }
});

function setStatus(text, err = false) {
  menuStatus.textContent = text;
  menuStatus.classList.toggle('err', err);
}

// Curved panels, like the solo game's (GFX.menuBend, drawPanel): each column stretched up and down
// about the middle by 1 + curve (1 - u)^2, u running from the tall end.
// Done the way the game does it, for the same clean look: the panel is drawn flat into a sharp image
// (its real HTML and CSS, through an SVG snapshot, at the screen's full pixel density), then that
// image is drawn bent column by column with smooth filtering. The real panel stays on top,
// invisible, so typing and clicking work as before.
let bendStyle = null; // the page's CSS with the font inlined (an SVG snapshot cannot load files)
async function bendCss() {
  if (bendStyle) return bendStyle;
  const [css, font] = await Promise.all([
    fetch(`css/style.css?v=${V}`).then((r) => r.text()),
    fetch('fonts/RussoOne.ttf').then((r) => r.arrayBuffer()),
  ]);
  let bin = '';
  const bytes = new Uint8Array(font);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  // (the @media blocks are left out: inside the snapshot they would answer for the snapshot's own small
  // size and switch on the phone layout)
  let flat = '';
  for (let i = 0; i < css.length;) {
    const at = css.indexOf('@media', i);
    if (at < 0) { flat += css.slice(i); break; }
    flat += css.slice(i, at);
    let j = css.indexOf('{', at), depth = 1;
    for (j += 1; j < css.length && depth > 0; j++) depth += css[j] === '{' ? 1 : css[j] === '}' ? -1 : 0;
    i = j;
  }
  bendStyle = flat.replace(/url\("\.\.\/fonts\/RussoOne\.ttf"\)/g, `url("data:font/ttf;base64,${btoa(bin)}")`);
  return bendStyle;
}

class Bent {
  constructor(el, curve, tallLeft) {
    this.el = el;
    this.curve = curve;
    this.tallLeft = tallLeft;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'bent';
    el.parentElement.appendChild(this.canvas);
    this.busy = false;
    this.again = false;
    this.on = true;
    // redrawn when what it shows changes (its own style is ours to set, so that is not watched)
    new MutationObserver((list) => {
      if (list.some((m) => !(m.type === 'attributes' && m.target === el && m.attributeName === 'style'))) this.refresh();
    }).observe(el, { subtree: true, childList: true, characterData: true, attributes: true });
    el.addEventListener('input', () => this.refresh());
    el.addEventListener('focusin', () => this.refresh());
    el.addEventListener('focusout', () => this.refresh());
    new ResizeObserver(() => this.refresh()).observe(el);
  }

  enable(on) {
    if (this.on === on && this.drawn) return;
    this.on = on;
    this.drawn = true;
    this.el.style.opacity = on ? '0' : '';
    this.canvas.style.display = on ? '' : 'none';
    if (on) this.refresh();
  }

  refresh() {
    if (!this.on) return;
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    this.draw().catch((e) => { console.warn('bend', e); this.enable(false); }).finally(() => {
      this.busy = false;
      if (this.again) { this.again = false; this.refresh(); }
    });
  }

  async draw() {
    const el = this.el;
    const w = el.offsetWidth, h = el.offsetHeight;
    if (!w || !h) return;
    const css = await bendCss();
    // the panel, flat: a copy of its HTML (with what is typed in it) in an SVG image
    const clone = el.cloneNode(true);
    clone.style.opacity = '1';
    clone.style.margin = '0';
    clone.style.width = w + 'px';
    clone.style.height = h + 'px';
    const src = el.querySelectorAll('input'), dst = clone.querySelectorAll('input');
    src.forEach((inp, i) => {
      // (the caret, blinking, at the end of what is typed while the field has the focus)
      const caret = document.activeElement === inp && Math.floor(performance.now() / 530) % 2 === 0 ? '|' : '';
      if (inp.value) dst[i].setAttribute('value', inp.value + caret);
      else if (caret) dst[i].setAttribute('placeholder', '|' + (inp.placeholder || ''));
    });
    const xml = new XMLSerializer().serializeToString(clone);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><style><![CDATA[${css}]]></style>` +
      `<foreignObject x="0" y="0" width="${w}" height="${h}"><div xmlns="http://www.w3.org/1999/xhtml" ` +
      `style="font-family:'Russo One',sans-serif;color:#f2f6f8;width:${w}px;height:${h}px">${xml}</div></foreignObject></svg>`;
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const d = Math.min(devicePixelRatio || 1, 2);
    const flat = document.createElement('canvas');
    flat.width = Math.ceil(w * d);
    flat.height = Math.ceil(h * d);
    flat.getContext('2d').drawImage(img, 0, 0, flat.width, flat.height);
    // bent: one column at a time, stretched about the middle; the canvas covers the panel plus room
    // above and below for the taller end
    const smax = 1 + this.curve;
    const pad = Math.ceil((h * (smax - 1)) / 2) + 2;
    const cv = this.canvas;
    const W = flat.width, H = flat.height, P = Math.ceil(pad * d);
    if (cv.width !== W || cv.height !== H + 2 * P) { cv.width = W; cv.height = H + 2 * P; }
    cv.style.width = w + 'px';
    cv.style.height = h + 2 * pad + 'px';
    cv.style.left = el.offsetLeft + 'px';
    cv.style.top = el.offsetTop - pad + 'px';
    const g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    const yc = P + H / 2;
    for (let i = 0; i < W; i++) {
      const u = this.tallLeft ? i / (W - 1) : 1 - i / (W - 1);
      const s = 1 + this.curve * (1 - u) * (1 - u);
      g.drawImage(flat, i, 0, 1, H, i, yc - (H / 2) * s, 1, H * s);
    }
    if (this.el.style.opacity !== '0') this.el.style.opacity = '0';
    // a typed name keeps its caret blinking
    if (el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') {
      clearTimeout(this.blink);
      this.blink = setTimeout(() => this.refresh(), 530);
    }
  }
}

// The score table, curved: its outer (right) end the tallest, like a panel beside the plane
// (PANEL_CURVE 0.3). Drawn straight onto a canvas from where the page lays its parts out (the same
// look as the HTML table, which stays for layout) - cheap enough to redraw on every score change.
const board = $('.board');
const BOARD_CURVE = 0.3;
const boardCv = document.createElement('canvas');
boardCv.className = 'bent';
board.parentElement.appendChild(boardCv);
let boardBent = true;
let boardKey = '';
const boardFont = document.fonts ? document.fonts.load('13px "Russo One"').catch(() => {}) : Promise.resolve();
let boardFontOk = false;
boardFont.then(() => { boardFontOk = true; boardKey = ''; });
function bendMenu() {
  boardBent = !matchMedia('(max-width: 760px)').matches;
  board.style.opacity = boardBent ? '0' : '';
  boardCv.style.display = boardBent ? '' : 'none';
  boardKey = '';
  drawBoard();
}
let boardFlat = null;
function drawBoard() {
  if (!boardBent || !boardFontOk) return;
  const w = board.offsetWidth, h = board.offsetHeight;
  if (!w || !h) return;
  const key = lastBoard + '|' + $('#boardCount').textContent + '|' + w + 'x' + h;
  if (key === boardKey) return;
  boardKey = key;
  const d = Math.min(devicePixelRatio || 1, 2);
  const W = Math.ceil(w * d), H = Math.ceil(h * d);
  const flat = boardFlat || (boardFlat = document.createElement('canvas'));
  if (flat.width !== W || flat.height !== H) { flat.width = W; flat.height = H; }
  const g = flat.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, W, H);
  g.scale(d, d);
  const o = board.getBoundingClientRect();
  const at = (el) => { const r = el.getBoundingClientRect(); return { x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height }; };
  const text = (el, str, color, size, spacing, shadow, align = 'left') => {
    const r = at(el);
    g.font = `${size}px "Russo One", sans-serif`;
    g.letterSpacing = spacing + 'px';
    g.textBaseline = 'middle';
    g.textAlign = align;
    const x = align === 'right' ? r.x + r.w : r.x;
    let str2 = str;
    if (align === 'left') {
      // (cut with … to its box, like text-overflow: ellipsis)
      while (str2.length > 1 && g.measureText(str2).width > r.w + 1) str2 = str2.slice(0, -2) + '…';
    }
    if (shadow) { g.fillStyle = 'rgba(6, 12, 18, 0.7)'; g.fillText(str2, x + 1, r.y + r.h / 2 + 2); }
    g.fillStyle = color;
    g.fillText(str2, x, r.y + r.h / 2);
  };
  const plate = (r, inset, fill) => {
    const x0 = r.x + inset, y0 = r.y + inset, x1 = r.x + r.w - inset, y1 = r.y + r.h - inset, ww = x1 - x0;
    g.beginPath();
    g.moveTo(x0 + ww * 0.05, y0); g.lineTo(x1, y0); g.lineTo(x1 - ww * 0.05, y1); g.lineTo(x0, y1);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  };
  text($('.board-kicker'), 'PILOTS', '#ff4d6a', 13, 6, false);
  text($('#boardCount'), $('#boardCount').textContent, 'rgba(230, 238, 245, 0.75)', 10, 2, false);
  const rule = at($('.board-rule'));
  const rg = g.createLinearGradient(rule.x, 0, rule.x + rule.w, 0);
  rg.addColorStop(0, '#ff4d6a'); rg.addColorStop(0.6, '#ff4d6a'); rg.addColorStop(1, 'rgba(255, 77, 106, 0)');
  g.fillStyle = rg;
  g.fillRect(rule.x, rule.y, rule.w, rule.h);
  for (const li of $('#boardList').children) {
    const r = at(li);
    const first = li.classList.contains('first');
    if (first) { g.save(); g.shadowColor = 'rgba(255, 77, 106, 0.55)'; g.shadowBlur = 8 * d; }
    plate(r, 0, first ? 'rgba(255, 255, 255, 0.85)' : 'rgba(230, 238, 245, 0.55)');
    if (first) g.restore();
    let fill;
    if (first) { fill = g.createLinearGradient(r.x, 0, r.x + r.w, 0); fill.addColorStop(0, '#ff4d6a'); fill.addColorStop(1, '#ff6f86'); }
    else { fill = g.createLinearGradient(r.x, 0, r.x + r.w, 0); fill.addColorStop(0, 'rgba(11, 18, 26, 0.92)'); fill.addColorStop(1, 'rgba(11, 18, 26, 0.72)'); }
    plate(r, 1.5, fill);
    const [rank, div, name, pts] = li.children;
    text(rank, rank.textContent, `rgba(242, 246, 248, ${first ? 0.9 : 0.6})`, 10, 1, false);
    const dr = at(div);
    g.save();
    g.translate(dr.x + dr.w / 2, dr.y + dr.h / 2);
    g.transform(1, 0, Math.tan((-14 * Math.PI) / 180), 1, 0, 0);
    g.fillStyle = 'rgba(242, 246, 248, 0.5)';
    g.fillRect(-dr.w / 2, -dr.h / 2, dr.w, dr.h);
    g.restore();
    const meRow = li.classList.contains('me') && !first;
    text(name, name.textContent, meRow ? '#ff4d6a' : '#f2f6f8', 13, 1.2, true);
    text(pts, pts.textContent, '#f2f6f8', 13, 1.2, true, 'right');
  }
  // bent: one column at a time, stretched about the middle; the canvas covers the table plus room
  // above and below for the taller end
  const pad = Math.ceil((h * BOARD_CURVE) / 2) + 2, P = Math.ceil(pad * d);
  const cv = boardCv;
  if (cv.width !== W || cv.height !== H + 2 * P) { cv.width = W; cv.height = H + 2 * P; }
  cv.style.width = w + 'px';
  cv.style.height = h + 2 * pad + 'px';
  cv.style.left = board.offsetLeft + 'px';
  cv.style.top = board.offsetTop - pad + 'px';
  const c = cv.getContext('2d');
  c.clearRect(0, 0, cv.width, cv.height);
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  const yc = P + H / 2;
  for (let i = 0; i < W; i++) {
    const u = 1 - i / (W - 1);
    const sc = 1 + BOARD_CURVE * (1 - u) * (1 - u);
    c.drawImage(flat, i, 0, 1, H, i, yc - (H / 2) * sc, 1, H * sc);
  }
}

async function joinGame() {
  if (phase !== 'menu') return;
  const name = cleanName(nameInput.value);
  if (name.length < 2) {
    setStatus(`TYPE YOUR NAME (2-${NAME_MAX} LETTERS)`, true);
    setSel(1);
    return;
  }
  menuPress += 1;
  sfx.play('ui_start');
  try { localStorage.setItem('skyblitz.name', name); } catch {}
  phase = 'joining';
  stage.dataset.phase = 'joining';
  try {
    net = net || await createNet();
    net.onPlayers = onPlayers;
    net.onHit = onHit;
    net.onKill = onKill;
    me.name = name;
    session = await net.join({ name, plane: 1 });
  } catch (e) {
    console.error('join failed', e);
    setStatus('COULD NOT JOIN: ' + (e && e.message ? e.message : e), true);
    phase = 'menu';
    stage.dataset.phase = 'menu';
    return;
  }
  setStatus('');
  if (document.activeElement === nameInput) nameInput.blur();
  me.score = 0;
  me.shots = me.podShots = me.rockets = 0;
  me.gunT = 0;
  bullets.length = 0;
  missiles.length = 0;
  spawn(me);
  odReset();
  cam.x = me.x; cam.y = me.y; cam.angle = me.heading;
  phase = 'play';
  joinedAt = performance.now();
  stage.dataset.phase = 'play';
  boardT = 0;
  setTimeout(() => { if (phase === 'play') showBanner('SHOOT THEM DOWN', 'SKY ARENA'); }, 450);
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
  spectId = null;
  bullets.length = 0;
  net && net.watch().catch(() => {}); // (the arena behind the menu again)
  sparks.length = 0;
  smoke.length = 0;
  missiles.length = 0;
  rings.length = 0;
  pickups.length = 0;
  collects.length = 0;
  feed.innerHTML = '';
  banner.classList.remove('show');
  openPage(0, 2);
}

// --- quality monitor ---------------------------------------------------------------------------
const perf = { n: 0, slow: 0 };
function watchFrames(dtMs) {
  if (document.hidden || dtMs > 250) return;
  perf.n += 1;
  if (dtMs > 22) perf.slow += 1;
  if (perf.n < 120) return;
  const slow = perf.slow / perf.n > 0.5;
  perf.n = perf.slow = 0;
  if (slow && qLevel > 0 && !qManual) {
    qLevel -= 1;
    try { localStorage.setItem('skyblitz.quality', String(qLevel)); } catch {}
    console.info('quality ->', ['low', 'medium', 'high'][qLevel]);
    setWorld('quality', Q().detail);
    measure();
  }
}

// --- main loop ------------------------------------------------------------------------------
let lastT = 0;
let lastOverlay = '';
let lastSmoke = '';
function frame(t) {
  const dt = Math.min(0.05, lastT ? (t - lastT) / 1000 : 0);
  if (lastT) watchFrames(t - lastT);
  lastT = t;
  menuPlane && menuPlane.active(phase !== 'play' && showcase.style.display !== 'none');
  me.view && me.view.active(phase === 'play');

  if (phase === 'play') {
    readInput();
    fly(me, dt, input);
    updateRemotes(dt);
    cullViews();
    checkCollisions();
    updatePickups(dt);
    updateMissiles(dt);
    updateBullets(dt);
    updateCamera(dt);
    // the wide view: out for WIDE.hold seconds, then back in
    wideT = Math.max(0, wideT - dt);
    wideCd = Math.max(0, wideCd - dt);
    const zWant = wideT > 0 ? WIDE.zoom : 1;
    zoomMul += (zWant - zoomMul) * ease(WIDE.ease, dt);
    if (!me.dead) odTick(dt);
    view.k = view.baseK * zoomMul * odZoom();
    sendT -= dt;
    if (sendT <= 0 && net) {
      sendT = 1 / SEND_HZ;
      net.send(myState());
    }
    updateBoard(dt);
  } else {
    // the menu: a real player flying, live (or, with nobody online, the camera drifts over the sea
    // and the showcase plane sways and fires now and then)
    menuT += dt;
    updateRemotes(dt);
    cullViews();
    const sp = phase === 'menu' ? spectTarget() : null;
    showcase.style.display = sp ? 'none' : '';
    if (sp) {
      updateCamera(dt, sp, view.sw * 0.17);
    } else {
      cam.x += 18 * dt;
      cam.y -= 40 * dt;
      cam.angle += wrap(0 - cam.angle) * ease(1, dt);
    }
    updateBullets(dt);
    updateMissiles(dt);
    if (menuPlane && !sp) {
      const m = menuMotion;
      m.t -= dt;
      if (m.t <= 0) {
        if (m.phase === 'rest') {
          const pick = Math.floor(Math.random() * 4);
          const amount = rand(0.6, 1);
          m.lean = pick === 0 ? -amount : pick === 1 ? amount : 0;
          m.ox = pick === 2 ? -amount : pick === 3 ? amount : 0;
          m.rate = rand(1.8, 3.2);
          m.t = rand(1.1, 2);
          m.phase = 'move';
        } else {
          m.lean = m.ox = 0;
          m.rate = rand(1.8, 3);
          m.t = rand(1.6, 2.6);
          m.phase = 'rest';
        }
      }
      const step = (v, to) => (v < to ? Math.min(to, v + m.rate * dt) : Math.max(to, v - m.rate * dt));
      m.bank = step(m.bank, m.lean);
      m.pitch = step(m.pitch, m.ox);
      menuPlane.num('bank', +m.bank.toFixed(3));
      menuPlane.num('pitch', +m.pitch.toFixed(3));
      menuPlane.bool('burning', false);
      menuPlane.bool('dead', false);
      menuPlane.colors(0);
      // now and then a short burst of fire
      menuFireT -= dt;
      if (menuFireT <= 0) {
        if (menuFireT > -m.burst) {
          m.gunT -= dt;
          if (m.gunT <= 0) { m.gunT = 0.11 * rand(2.3, 2.9); menuPlane.fire('fire'); }
        } else {
          menuFireT = rand(1.3, 3.4);
          m.burst = rand(0.35, 1.1);
        }
      }
    }
  }
  updateSmoke(dt);

  // planes -> their Rive instances (screen space: turned by the camera)
  if (me.view) {
    const [sx, sy] = toScreen(me.x, me.y);
    me.view.place(sx, sy, me.heading - cam.angle, view.k / view.baseK);
    me.view.canvas.style.display = me.gone ? 'none' : '';
    me.view.pose(me);
    me.view.canvas.classList.toggle('blink', me.spawnShield > 0 && !me.dead);
    me.view.canvas.classList.toggle('top', performance.now() < introUntil || collects.length > 0);
  }
  for (const r of remotes.values()) {
    if (!r.view) continue;
    r.view.canvas.style.display = r.gone ? 'none' : '';
    if (r.gone) continue;
    const [sx, sy] = toScreen(r.x, r.y);
    r.view.place(sx, sy, r.heading - cam.angle, view.k / view.baseK);
    r.view.pose(r);
    r.view.canvas.classList.toggle('blink', r.shielded && !r.dead);
  }

  // the world: the sea and clouds slide with the camera and turn with it (in the shaders)
  const [wx, wy] = toWorldFrame(me.x, me.y);
  setWorld('camX', cam.x * view.k * view.unit);
  setWorld('camY', cam.y * view.k * view.unit);
  setWorld('planeX', wx * view.unit);
  setWorld('planeY', wy * view.unit);
  setWorld('angle', cam.angle);
  setWorld('planeOn', phase === 'play' && !me.dead ? 1 : 0);
  setWorld('k', view.k * view.unit);
  if (wvm) {
    const sm = smokeData();
    if (sm !== lastSmoke) {
      const p = wSmoke || (wSmoke = wvm.string('smoke'));
      if (p) p.value = sm;
      lastSmoke = sm;
    }
  }
  if (phase === 'play') updateTags();

  // the overlay: everything over the planes, and the HUD
  if (svm) {
    const d = overlayData();
    if (d !== lastOverlay) {
      const p = sData || (sData = svm.string('data'));
      if (p) p.value = d;
      lastOverlay = d;
    }
    const u = view.unit;
    const [mx, my] = toScreen(me.x, me.y);
    setShots('k', view.k * u);
    setShots('hudK', view.baseK / CAMERA.zoom * u);
    setShots('hud', phase === 'play' ? 1 : 0);
    setShots('hp', Math.round(me.hp));
    setShots('score', me.score);
    setShots('oil', Math.round(me.oil * 10) / 10);
    setShots('meX', Math.round(mx * u));
    setShots('meY', Math.round(my * u));
    setShots('podAmmo', phase === 'play' ? me.podAmmo : 0);
    setShots('rktAmmo', phase === 'play' ? me.rktAmmo : 0);
    setShots('shieldHits', phase === 'play' ? me.shieldHits : 0);
    setShots('introKind', introKind);
    setShots('introSeq', introSeq);
    setShots('ax', +(me.bank * 0.7).toFixed(2));
    setShots('menu', phase === 'menu' ? 1 : 0); // (it slides away while connecting)
    setShots('menuSel', menuSel);
    setShots('menuPress', menuPress);
    const wideOn = wideT > 0 && od.t <= 0;
    setShots('odMeter', +(wideOn ? wideT / WIDE.hold : od.meter).toFixed(3));
    setShots('odT', +od.t.toFixed(3));
    setShots('odBt', +od.bt.toFixed(3));
    setShots('odWide', wideOn ? 1 : 0);
    setShots('menuPage', menuPage);
    setShots('soundOn', SETTINGS.sound ? 1 : 0);
    setShots('sfxVol', SETTINGS.sfx);
    setShots('musicVol', SETTINGS.music);
    const qp = svm.string('qualityText');
    if (qp && qp.value !== qualityName()) qp.value = qualityName();
    setShots('mobile', matchMedia('(pointer: coarse)').matches ? 1 : 0);
    const typed = cleanName(nameInput.value);
    const caret = menuSel === 1 && menuPage === 0 && phase !== 'play' && Math.floor(t / 530) % 2 === 0 ? '|' : '';
    const nameText = (typed || (caret ? '' : 'YOUR NAME')) + caret;
    const np = svm.string('nameText');
    if (np && np.value !== nameText) np.value = nameText;
    setShots('ay', +(-me.pitch * 0.5).toFixed(2));
  }
  requestAnimationFrame(frame);
}

// --- boot -----------------------------------------------------------------------------------
async function boot() {
  try {
    nameInput.value = cleanName(localStorage.getItem('skyblitz.name') || '');
  } catch {}
  menuSel = nameInput.value ? 2 : 1;
  try {
    const [w, s, mine, showcase] = await Promise.all([
      loadRive({
        src: `riv/world.riv?v=${V}`,
        canvas: worldCanvas,
        artboard: 'World',
        enableGPUCanvas: true, // world.luau draws the ocean and clouds with WGSL shaders
        layout: new R.Layout({ fit: R.Fit.Layout }),
      }),
      loadRive({
        src: `riv/world.riv?v=${V}`,
        canvas: shotsCanvas,
        artboard: 'Shots',
        enableGPUCanvas: true, // the overlay's GPU liquids and shield bubble
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
    setWorld('quality', Q().detail);
    measure();
    if (menuSel === 1) setTimeout(focusName, 300);
    sfx.music(true);
    saveSettings();
    $('#loading').classList.add('done');
    requestAnimationFrame(frame);
    createNet().then((n) => {
      net = net || n;
      net.prepare().catch((e) => console.warn('connect', e)); // ahead of PLAY
      net.onPlayers = onPlayers;
      net.onHit = onHit;
      net.onKill = onKill;
      net.watch().catch((e) => console.warn('watch', e)); // the live arena behind the menu
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
  window.__sky = {
    me, remotes, cam, bullets, missiles, pickups, view,
    get phase() { return phase; }, get session() { return session; }, get net() { return net; },
    get quality() { return qLevel; },
    give(kind) { takePickup({ id: pickupId++, kind: KIND[kind], x: me.x, y: me.y, t: 0 }); },
    fireRocket,
    die() { goDown('shot', 'test', 'TEST'); },
    get menuSel() { return menuSel; },
    od,
  };
}
