// The solo game's sounds (game-airplane-v2: sfx_*.mp3 and music.mp3), with its volumes and the
// shortest gap between two plays of the same sound (game.luau's sound table). Web Audio, started on
// the first key press or tap (browsers keep sound off until the player does something).

const TABLE = {
  gun: [0.182, 0.03], pod: [0.126, 0.05], rocket: [0.385, 0.05], hit_enemy: [0.21, 0.035],
  hit_player: [0.49, 0.08], explode: [0.49, 0.06], explode_big: [0.665, 0.1], blast: [0.385, 0.05],
  splash: [0.42, 0.2], shield_hit: [0.385, 0.06], shield_up: [0.42, 0.1], pickup: [0.42, 0.1],
  repair: [0.42, 0.1], oil: [0.42, 0.1], ui_move: [0.35, 0.04], ui_select: [0.42, 0.06],
  ui_start: [0.49, 0.3], ui_press: [0.5, 0.05], warning: [0.245, 0.6], sputter: [0.525, 1],
};
const MUSIC_VOL = 0.32;

export function createSound(version) {
  let ctx = null;
  let master = null;
  const buffers = {};
  const last = {};
  let musicSrc = null;
  let musicGain = null;
  let wantMusic = false;
  let sfxLevel = 1;
  let musicLevel = 1;
  let muted = false;
  try { muted = localStorage.getItem('skyblitz.muted') === '1'; } catch {}

  function start() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(ctx.destination);
    for (const name of [...Object.keys(TABLE), 'music']) {
      const file = name === 'music' ? 'music.mp3' : `sfx_${name}.mp3`;
      fetch(`sounds/${file}?v=${version}`)
        .then((r) => r.arrayBuffer())
        .then((b) => ctx.decodeAudioData(b))
        .then((buf) => {
          buffers[name] = buf;
          if (name === 'music' && wantMusic) music(true);
        })
        .catch((e) => console.warn('sound', name, e));
    }
  }
  // sound starts with the first thing the player does
  for (const ev of ['keydown', 'pointerdown', 'touchstart']) addEventListener(ev, start, { passive: true });

  /** Play a sound; scale: its loudness for this play (0..1). */
  function play(name, scale = 1) {
    const t = TABLE[name];
    if (!ctx || !t || !buffers[name] || scale <= 0.01) return;
    const now = ctx.currentTime;
    if (now - (last[name] ?? -100) < t[1]) return;
    last[name] = now;
    const src = ctx.createBufferSource();
    src.buffer = buffers[name];
    const g = ctx.createGain();
    g.gain.value = t[0] * scale * sfxLevel;
    src.connect(g).connect(master);
    src.start();
  }

  /** The soundtrack, looping (on in the menu and in the air). */
  function music(on) {
    wantMusic = on;
    if (!ctx || !buffers.music) return;
    if (on && !musicSrc) {
      musicGain = ctx.createGain();
      musicGain.gain.value = MUSIC_VOL * musicLevel;
      musicSrc = ctx.createBufferSource();
      musicSrc.buffer = buffers.music;
      musicSrc.loop = true;
      musicSrc.connect(musicGain).connect(master);
      musicSrc.start();
    } else if (!on && musicSrc) {
      musicSrc.stop();
      musicSrc = null;
    }
  }

  // --- made here (no file): BOOST's roar and the wide view's whoosh --------------------------
  let noiseBuf = null;
  function noise() {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    return src;
  }
  // BOOST: a rushing jet roar (band-passed noise) over a deep engine hum, swelling in while it is held
  // and fading out after; `amount` 0..1 follows the speed (the roar brightens as it climbs)
  let roar = null;
  function boost(on, amount = 1) {
    if (!ctx) return;
    const now = ctx.currentTime;
    if (on && !roar) {
      const n = noise();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 0.8;
      bp.frequency.value = 500;
      const hum = ctx.createOscillator();
      hum.type = 'sawtooth';
      hum.frequency.value = 55;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 180;
      const gN = ctx.createGain(), gH = ctx.createGain(), out = ctx.createGain();
      gN.gain.value = 0.9;
      gH.gain.value = 0.35;
      out.gain.setValueAtTime(0, now);
      out.gain.linearRampToValueAtTime(0.32 * sfxLevel, now + 0.18);
      n.connect(bp).connect(gN).connect(out);
      hum.connect(lp).connect(gH).connect(out);
      out.connect(master);
      n.start();
      hum.start();
      roar = { n, hum, bp, out };
    }
    if (roar && on) {
      roar.bp.frequency.setTargetAtTime(500 + 1300 * amount, now, 0.12);
      roar.hum.frequency.setTargetAtTime(55 + 35 * amount, now, 0.15);
      roar.out.gain.setTargetAtTime(0.32 * sfxLevel, now, 0.08);
    }
    if (!on && roar) {
      const r = roar;
      roar = null;
      r.out.gain.cancelScheduledValues(now);
      r.out.gain.setValueAtTime(r.out.gain.value, now);
      r.out.gain.linearRampToValueAtTime(0, now + 0.35);
      r.n.stop(now + 0.4);
      r.hum.stop(now + 0.4);
    }
  }
  // the wide view: an airy whoosh sweeping down as the camera pulls out (`out` false: a lighter one
  // sweeping up as it comes back)
  function whoosh(out = true) {
    if (!ctx) return;
    const now = ctx.currentTime, len = out ? 0.75 : 0.5;
    const n = noise();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(out ? 2600 : 500, now);
    bp.frequency.exponentialRampToValueAtTime(out ? 320 : 2200, now + len);
    const tone = ctx.createOscillator();
    tone.type = 'sine';
    tone.frequency.setValueAtTime(out ? 520 : 180, now);
    tone.frequency.exponentialRampToValueAtTime(out ? 120 : 420, now + len);
    const g = ctx.createGain(), gt = ctx.createGain();
    const peak = (out ? 0.42 : 0.26) * sfxLevel;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(peak, now + len * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0008, now + len);
    gt.gain.value = 0.12;
    n.connect(bp).connect(g);
    tone.connect(gt).connect(g);
    g.connect(master);
    n.start(now);
    tone.start(now);
    n.stop(now + len + 0.05);
    tone.stop(now + len + 0.05);
  }

  /** The settings' SFX and MUSIC sliders (0..1). */
  function levels(sfx, mus) {
    sfxLevel = sfx;
    musicLevel = mus;
    if (musicGain) musicGain.gain.value = MUSIC_VOL * musicLevel;
  }

  function setMuted(m) {
    if (m !== muted) toggleMute();
  }

  function toggleMute() {
    muted = !muted;
    try { localStorage.setItem('skyblitz.muted', muted ? '1' : '0'); } catch {}
    if (master) master.gain.value = muted ? 0 : 1;
    return muted;
  }

  return { play, music, toggleMute, setMuted, levels, boost, whoosh, get muted() { return muted; } };
}
