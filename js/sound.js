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

  // --- made here (no file): soft cinematic whooshes for BOOST and the wide view -----------------
  // Deep, rounded noise (low-passed, low Q) swelling in and out slowly, panned across, a low sub
  // swell under it and a light reverb tail - a film-trailer whoosh, nothing buzzy or sharp.
  let noiseBuf = null;
  let verb = null;
  function noise() {
    if (!noiseBuf) {
      // (pinkish: white noise smoothed a little - softer than white)
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < d.length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099;
        b1 = 0.963 * b1 + w * 0.2965;
        b2 = 0.57 * b2 + w * 1.0526;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.18;
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    return src;
  }
  function reverb() {
    if (!verb) {
      const len = Math.floor(ctx.sampleRate * 1.6);
      const ir = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let c = 0; c < 2; c++) {
        const d = ir.getChannelData(c);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      }
      verb = ctx.createConvolver();
      verb.buffer = ir;
      const wet = ctx.createGain();
      wet.gain.value = 0.5;
      verb.connect(wet).connect(master);
    }
    return verb;
  }
  // one whoosh: `len` s long, its filter sweeping f0 -> f1, peaking at `peak` a little past the middle
  function cine(len, f0, f1, peak, pan0, pan1, sub0, sub1) {
    const now = ctx.currentTime;
    const n = noise();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    lp.frequency.setValueAtTime(f0, now);
    lp.frequency.exponentialRampToValueAtTime(f1, now + len * 0.55);
    lp.frequency.exponentialRampToValueAtTime(Math.min(f0, f1) * 0.8, now + len);
    const g = ctx.createGain();
    const p = peak * sfxLevel;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(p, now + len * 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, now + len);
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    // a low sub swell under it
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(sub0, now);
    sub.frequency.exponentialRampToValueAtTime(sub1, now + len);
    const gs = ctx.createGain();
    gs.gain.setValueAtTime(0.0001, now);
    gs.gain.exponentialRampToValueAtTime(p * 0.5, now + len * 0.5);
    gs.gain.exponentialRampToValueAtTime(0.0001, now + len);
    let tail = g;
    if (pan) {
      pan.pan.setValueAtTime(pan0, now);
      pan.pan.linearRampToValueAtTime(pan1, now + len);
      g.connect(pan);
      tail = pan;
    }
    n.connect(lp).connect(g);
    sub.connect(gs).connect(tail === g ? g : pan);
    tail.connect(master);
    tail.connect(reverb());
    n.start(now);
    sub.start(now);
    n.stop(now + len + 0.05);
    sub.stop(now + len + 0.05);
  }
  // BOOST: a whoosh as it kicks in, then only a very soft airy wind while it is held
  let wind = null;
  function boost(on, amount = 1) {
    if (!ctx) return;
    const now = ctx.currentTime;
    if (on && !wind) {
      cine(1.1, 300, 1500, 1.4, -0.5, 0.5, 70, 45); // (the whoosh's level: ~3x)
      const n = noise();
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.5;
      lp.frequency.value = 500;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.16 * sfxLevel, now + 0.8);
      n.connect(lp).connect(g).connect(master);
      n.start();
      wind = { n, lp, g };
    }
    if (wind && on) wind.lp.frequency.setTargetAtTime(450 + 400 * amount, now, 0.3);
    if (!on && wind) {
      const w = wind;
      wind = null;
      w.g.gain.cancelScheduledValues(now);
      w.g.gain.setValueAtTime(Math.max(0.0001, w.g.gain.value), now);
      w.g.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
      w.n.stop(now + 0.65);
    }
  }
  // the wide view: a long soft whoosh as the camera pulls out; a lighter, shorter one coming back
  function whoosh(out = true) {
    if (!ctx) return;
    if (out) cine(1.3, 1400, 260, 1.3, 0.4, -0.4, 90, 40);
    else cine(0.9, 260, 1100, 0.85, -0.3, 0.3, 45, 70);
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
