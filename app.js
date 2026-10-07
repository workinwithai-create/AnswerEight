/* AnswerEight — second-verse desk. Audio clock only. */
const PRE_SHA = "d58301e4a494555f411a2afbc448b724136eee76";
const CDN = "https://cdn.jsdelivr.net/gh/workinwithai-create/PreEight@" + PRE_SHA + "/public/samples";
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12;
const SR = 48000;
const TAIL_SEC = 0.45;

const FILES = [
  ["kick", CDN + "/drums/kick.mp3", "kick"],
  ["snare", CDN + "/drums/snare.mp3", "snare"],
  ["hat", CDN + "/drums/hihat.mp3", "hi-hat"],
  ["pC3", CDN + "/piano/C3.mp3", "piano"],
  ["pA3", CDN + "/piano/A3.mp3", "piano"],
  ["pC4", CDN + "/piano/C4.mp3", "piano"],
  ["bE1", CDN + "/bass/E1.mp3", "upright bass"],
  ["bA1", CDN + "/bass/A1.mp3", "upright bass"],
  ["bC2", CDN + "/bass/C2.mp3", "upright bass"],
  ["gE2", CDN + "/guitar/E2.mp3", "nylon guitar"],
  ["gA2", CDN + "/guitar/A2.mp3", "nylon guitar"],
  ["gE3", CDN + "/guitar/E3.mp3", "nylon guitar"],
  ["vA3", CDN + "/violin/A3.mp3", "violin"],
  ["tC4", CDN + "/trumpet/C4.mp3", "trumpet"]
];

const RECIPES = [
  { id: "answer-line", name: "Answer line", blurb: "Nylon replies on the and. Violin holds the third." },
  { id: "walk-under", name: "Walk under", blurb: "Upright walks. Kit stays on 2 and 4." },
  { id: "dry-room", name: "Dry room", blurb: "Hats and kick out. Piano and violin only." },
  { id: "violin-doubt", name: "Violin doubt", blurb: "Relative third, long swell, no brass." },
  { id: "half-kit", name: "Half kit", blurb: "Snare on 3 only. Bass holds the root." },
  { id: "brass-aside", name: "Brass aside", blurb: "Trumpet asks once in bar 5, then leaves." }
];

const KEYS = ["C","C#","D","Eb","E","F","F#","G","Ab","A","Bb","B"];
const PC = { C:0,"C#":1,Db:1,D:2,"D#":3,Eb:3,E:4,F:5,"F#":6,Gb:6,G:7,"G#":8,Ab:8,A:9,"A#":10,Bb:10,B:11 };

const state = {
  bpm: 98,
  key: "A",
  chords: "Am F C G",
  bars: 8,
  recipe: "answer-line",
  mode: "B",
  mutes: { kit: false, piano: false, bass: false, nylon: false, violin: false, trumpet: false },
  playing: false
};

let ctx = null;
let master = null;
let chairGain = {};
let raw = {};
let buffers = {};
let missing = [];
let nextStepTime = 0;
let step = 0;
let timerId = null;
let sources = [];
let rafId = null;
let startedAt = 0;

function $(id) { return document.getElementById(id); }

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem("answereight") || "{}");
    if (s.bpm) state.bpm = clamp(s.bpm, 60, 180);
    if (s.key) state.key = s.key;
    if (s.chords) state.chords = s.chords;
    if (s.bars) state.bars = clamp(s.bars, 4, 16);
    if (s.recipe) state.recipe = s.recipe;
    if (s.mutes) state.mutes = Object.assign(state.mutes, s.mutes);
  } catch (e) { /* ignore */ }
}
function saveState() {
  localStorage.setItem("answereight", JSON.stringify({
    bpm: state.bpm, key: state.key, chords: state.chords, bars: state.bars,
    recipe: state.recipe, mutes: state.mutes
  }));
}
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function parseChord(sym) {
  const m = String(sym).trim().match(/^([A-G](?:#|b)?)(m)?/);
  if (!m) return null;
  const root = PC[m[1]];
  if (root == null) return null;
  const minor = !!m[2];
  const third = (root + (minor ? 3 : 4)) % 12;
  const fifth = (root + 7) % 12;
  return { symbol: m[1] + (minor ? "m" : ""), root, third, fifth, minor };
}
function progression() {
  const parts = state.chords.split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < 4; i++) {
    out.push(parseChord(parts[i] || "C") || parseChord("C"));
  }
  return out;
}
function keyPc() { return PC[state.key] == null ? 9 : PC[state.key]; }
function transpose(midi) {
  /* Chords are written in the key the user typed. Key selector shifts the whole bed. */
  const written = progression()[0].root;
  const delta = (keyPc() - written + 12) % 12;
  const shifted = delta > 6 ? delta - 12 : delta;
  return midi + shifted;
}
function chordAtBar(bar) {
  return progression()[bar % 4];
}
function midiInOct(pc, oct) { return pc + 12 * (oct + 1); }

function pick(voice, midi) {
  const table = {
    piano: [["pC3", 48], ["pA3", 57], ["pC4", 60]],
    bass: [["bE1", 28], ["bA1", 33], ["bC2", 36]],
    nylon: [["gE2", 40], ["gA2", 45], ["gE3", 52]],
    violin: [["vA3", 57]],
    trumpet: [["tC4", 60]]
  };
  let best = table[voice][0];
  let bestAbs = 99;
  for (const row of table[voice]) {
    const d = Math.abs(midi - row[1]);
    if (d < bestAbs) { best = row; bestAbs = d; }
  }
  let target = midi;
  const delta = target - best[1];
  if (delta > 4) target = best[1] + 4;
  if (delta < -4) target = best[1] - 4;
  return { name: best[0], rate: Math.pow(2, (target - best[1]) / 12), midi: target };
}

function stepDur() { return 60 / state.bpm / 4; }
function loopSteps() { return state.bars * 16; }

function ensureGraph() {
  if (master) return;
  master = ctx.createDynamicsCompressor();
  master.threshold.value = -8;
  master.knee.value = 6;
  master.ratio.value = 4;
  master.attack.value = 0.003;
  master.release.value = 0.2;
  master.connect(ctx.destination);
  ["kit", "piano", "bass", "nylon", "violin", "trumpet"].forEach(function (id) {
    const g = ctx.createGain();
    g.gain.value = id === "kit" ? 0.85 : 0.7;
    g.connect(master);
    chairGain[id] = g;
  });
}

async function loadSamples() {
  missing = [];
  let n = 0;
  for (const row of FILES) {
    n++;
    $("status").textContent = "Seating chairs " + n + "/" + FILES.length;
    try {
      const res = await fetch(row[1]);
      if (!res.ok) throw new Error(res.status);
      const ab = await res.arrayBuffer();
      raw[row[0]] = ab;
      buffers[row[0]] = await ctx.decodeAudioData(ab.slice(0));
    } catch (e) {
      missing.push(row[2] + " (" + row[0] + ")");
    }
  }
  if (missing.length) {
    $("status").textContent = "Missing: " + missing.join(", ");
  } else {
    $("status").textContent = "Chairs seated · FluidR3 pinned " + PRE_SHA.slice(0, 7);
  }
}

function track(src) {
  sources.push(src);
  src.onended = function () {
    sources = sources.filter(function (s) { return s !== src; });
  };
}

function playHit(ac, when, voice, midi, gain, dur, chair, swell) {
  if (state.mutes[chair]) return;
  if (missing.length) return;
  const picked = pick(voice, midi);
  const buf = buffers[picked.name];
  if (!buf) return;
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = picked.rate;
  const g = ac.createGain();
  const peak = gain;
  const attack = swell ? Math.min(1.1, dur * 0.45) : 0.012;
  g.gain.setValueAtTime(0.0001, when);
  g.gain.linearRampToValueAtTime(peak, when + attack);
  const rel = Math.max(0.012, Math.min(0.08, dur * 0.2));
  g.gain.setValueAtTime(peak, when + Math.max(attack, dur - rel));
  g.gain.linearRampToValueAtTime(0.0001, when + dur);
  src.connect(g);
  g.connect(chairGain[chair] || master);
  src.start(when);
  src.stop(when + dur + 0.02);
  track(src);
}

function playDrum(ac, when, name, gain) {
  if (state.mutes.kit || missing.length) return;
  const buf = buffers[name];
  if (!buf) return;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.linearRampToValueAtTime(gain, when + 0.004);
  g.gain.linearRampToValueAtTime(0.0001, when + 0.18);
  src.connect(g);
  g.connect(chairGain.kit);
  src.start(when);
  src.stop(when + 0.22);
  track(src);
}

function scheduleStep(stepIndex, when, ac) {
  const bars = state.bars;
  const bar = Math.floor(stepIndex / 16) % bars;
  const s = stepIndex % 16;
  const rec = state.recipe;
  const mode = state.mode;
  const ch = chordAtBar(bar);
  const root = transpose(midiInOct(ch.root, 2));
  const third = transpose(midiInOct(ch.third, 3));
  const fifth = transpose(midiInOct(ch.fifth, 3));
  const bassRoot = transpose(midiInOct(ch.root, 1));
  const sd = stepDur();
  const answer = mode === "B";

  if (!answer) {
    if (s === 0 || s === 8) playDrum(ac, when, "kick", s === 0 ? 0.62 : 0.48);
    if (s === 4 || s === 12) playDrum(ac, when, "snare", 0.4);
    if (s % 2 === 0) playDrum(ac, when, "hat", 0.08);
    if (s === 0) {
      playHit(ac, when, "piano", fifth, 0.22, sd * 4, "piano", false);
      playHit(ac, when, "piano", third, 0.16, sd * 4, "piano", false);
      playHit(ac, when, "bass", bassRoot, 0.42, sd * 8, "bass", false);
      playHit(ac, when, "nylon", transpose(midiInOct(ch.root, 3)), 0.16, sd * 2, "nylon", false);
    }
    return;
  }

  const dry = rec === "dry-room";
  const half = rec === "half-kit";
  if (!dry) {
    if (s === 0) playDrum(ac, when, "kick", 0.5);
    if (half) {
      if (s === 8) playDrum(ac, when, "snare", 0.32);
    } else if (s === 4 || s === 12) {
      playDrum(ac, when, "snare", 0.28);
    }
    if (!half && s % 2 === 0) playDrum(ac, when, "hat", 0.05);
  }
  if (s === 0) {
    const swell = rec === "violin-doubt";
    playHit(ac, when, "piano", third, dry ? 0.2 : 0.14, sd * 14, "piano", swell);
    if (rec === "walk-under") {
      const walk = [ch.root, ch.third, ch.fifth, (ch.root + 10) % 12];
      playHit(ac, when, "bass", transpose(midiInOct(walk[bar % 4], 1)), 0.4, sd * 4, "bass", false);
    } else {
      playHit(ac, when, "bass", bassRoot, 0.36, sd * 12, "bass", false);
    }
  }
  if (rec === "walk-under" && (s === 4 || s === 8 || s === 12)) {
    const walk = [ch.root, ch.third, ch.fifth, (ch.root + 10) % 12];
    const pc = walk[Math.floor(s / 4) % 4];
    playHit(ac, when, "bass", transpose(midiInOct(pc, 1)), 0.34, sd * 3.5, "bass", false);
  }
  if ((rec === "answer-line" || rec === "violin-doubt") && (s === 2 || s === 6 || s === 10 || s === 14)) {
    playHit(ac, when, "nylon", transpose(midiInOct(s % 4 === 2 ? ch.third : ch.fifth, 3)), 0.18, sd * 2, "nylon", false);
  }
  if (s === 0 && rec !== "brass-aside") {
    const vMidi = transpose(midiInOct(ch.third, 4));
    playHit(ac, when, "violin", vMidi, 0.2, sd * 15, "violin", rec === "violin-doubt");
    /* crossfade retrigger so the one-shot does not die mid-bar */
    playHit(ac, when + sd * 6, "violin", vMidi, 0.16, sd * 9, "violin", false);
  }
  if (rec === "brass-aside" && bar === 4 && (s === 0 || s === 8)) {
    playHit(ac, when, "trumpet", transpose(midiInOct(ch.fifth, 4)), 0.22, sd * 6, "trumpet", false);
  }
}

function scheduler() {
  if (!state.playing || !ctx) return;
  const total = loopSteps();
  while (nextStepTime < ctx.currentTime + SCHEDULE_AHEAD) {
    scheduleStep(step, nextStepTime, ctx);
    nextStepTime += stepDur();
    step = (step + 1) % total;
  }
}

function stop() {
  state.playing = false;
  if (timerId) clearInterval(timerId);
  timerId = null;
  sources.slice().forEach(function (src) {
    try { src.stop(); } catch (e) { /* already ended */ }
  });
  sources = [];
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  $("playhead").textContent = "Stopped";
  paintBars(-1);
}

function paintPlayhead() {
  if (!state.playing || !ctx) return;
  const elapsed = ctx.currentTime - startedAt;
  const sd = stepDur();
  const idx = Math.floor(elapsed / sd);
  const bar = Math.floor(idx / 16) % state.bars;
  const six = idx % 16;
  $("playhead").textContent = (state.mode === "B" ? "Answer" : "Reprint") + " · bar " + (bar + 1) + " · step " + (six + 1);
  paintBars(bar);
  rafId = requestAnimationFrame(paintPlayhead);
}

async function startAudio() {
  if (!ctx) {
    ctx = new AudioContext();
    ensureGraph();
    await loadSamples();
  }
  if (ctx.state !== "running") await ctx.resume();
  $("tap").textContent = "Audio running";
}

async function play(mode) {
  await startAudio();
  if (missing.length) {
    $("status").textContent = "Missing: " + missing.join(", ");
    return;
  }
  stop();
  state.mode = mode;
  state.playing = true;
  nextStepTime = ctx.currentTime + 0.1;
  step = 0;
  startedAt = nextStepTime;
  timerId = setInterval(scheduler, LOOKAHEAD_MS);
  paintPlayhead();
}

function eventsFor(mode) {
  const savedMode = state.mode;
  state.mode = mode;
  const total = loopSteps();
  const sd = stepDur();
  const events = [];
  const fake = {
    createBufferSource: function () {
      return {
        buffer: null,
        playbackRate: { value: 1 },
        connect: function () {},
        start: function (when) { this._when = when; },
        stop: function () {}
      };
    },
    createGain: function () {
      return {
        gain: {
          setValueAtTime: function () {},
          linearRampToValueAtTime: function () {}
        },
        connect: function () {}
      };
    }
  };
  /* Collect by intercepting playHit/playDrum via a render list built below. */
  state.mode = savedMode;
  return { total: total, sd: sd };
}

function collectHits(mode) {
  const hits = [];
  const saved = state.mode;
  state.mode = mode;
  const origHit = playHit;
  const origDrum = playDrum;
  playHit = function (ac, when, voice, midi, gain, dur, chair, swell) {
    if (state.mutes[chair]) return;
    hits.push({ when: when, voice: voice, midi: midi, gain: gain, dur: dur, chair: chair, swell: !!swell, drum: false });
  };
  playDrum = function (ac, when, name, gain) {
    if (state.mutes.kit) return;
    hits.push({ when: when, voice: name, gain: gain, dur: 0.18, chair: "kit", drum: true });
  };
  const total = loopSteps();
  for (let i = 0; i < total; i++) scheduleStep(i, i * stepDur(), null);
  playHit = origHit;
  playDrum = origDrum;
  state.mode = saved;
  return hits;
}

function encodeWav24(interleaved, sampleRate) {
  const n = interleaved.length / 2;
  const buffer = new ArrayBuffer(44 + n * 2 * 3);
  const view = new DataView(buffer);
  function str(o, s) { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); }
  str(0, "RIFF");
  view.setUint32(4, 36 + n * 6, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 6, true);
  view.setUint16(32, 6, true);
  view.setUint16(34, 24, true);
  str(36, "data");
  view.setUint32(40, n * 6, true);
  let o = 44;
  for (let i = 0; i < interleaved.length; i++) {
    let x = Math.max(-1, Math.min(1, interleaved[i]));
    let v = Math.round(x * 8388607);
    if (v < 0) v += 16777216;
    view.setUint8(o, v & 255);
    view.setUint8(o + 1, (v >> 8) & 255);
    view.setUint8(o + 2, (v >> 16) & 255);
    o += 3;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function fileBase() {
  const recipe = state.recipe;
  return "answereight-" + recipe + "-" + state.bpm + "bpm-" + state.key.replace("#", "s");
}

async function renderWav(withTail) {
  await startAudio();
  if (missing.length) {
    $("status").textContent = "Missing: " + missing.join(", ");
    return;
  }
  const bars = state.bars;
  const length = Math.round(bars * 4 * 60 / state.bpm * SR);
  const tail = Math.round(TAIL_SEC * SR);
  const off = new OfflineAudioContext(2, length + tail, SR);
  const comp = off.createDynamicsCompressor();
  comp.threshold.value = -8;
  comp.ratio.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.18;
  const bus = off.createGain();
  bus.gain.value = 0.55;
  bus.connect(comp);
  comp.connect(off.destination);
  const localGain = {};
  ["kit", "piano", "bass", "nylon", "violin", "trumpet"].forEach(function (id) {
    const g = off.createGain();
    g.gain.value = 0.8;
    g.connect(bus);
    localGain[id] = g;
  });
  const decoded = {};
  for (const key of Object.keys(raw)) {
    decoded[key] = await off.decodeAudioData(raw[key].slice(0));
  }
  const hits = collectHits("B");
  hits.forEach(function (h) {
    const voice = h.drum ? h.voice : pick(h.voice, h.midi).name;
    const rate = h.drum ? 1 : pick(h.voice, h.midi).rate;
    const buf = decoded[voice];
    if (!buf) return;
    const src = off.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = off.createGain();
    const dur = h.dur;
    const peak = h.gain;
    const attack = h.swell ? Math.min(1.1, dur * 0.45) : 0.01;
    g.gain.setValueAtTime(0.0001, h.when);
    g.gain.linearRampToValueAtTime(peak, h.when + attack);
    const rel = 0.012;
    g.gain.setValueAtTime(peak, h.when + Math.max(attack, dur - rel));
    g.gain.linearRampToValueAtTime(0.0001, h.when + dur);
    src.connect(g);
    g.connect(localGain[h.chair]);
    src.start(h.when);
    src.stop(h.when + dur + 0.02);
  });
  const rendered = await off.startRendering();
  const left = rendered.getChannelData(0);
  const right = rendered.getChannelData(1);
  const loop = new Float32Array(length * 2);
  let peak = 0;
  for (let i = 0; i < length; i++) {
    let l = left[i] || 0;
    let r = right[i] || 0;
    if (i < tail) {
      l += left[length + i] || 0;
      r += right[length + i] || 0;
    }
    loop[i * 2] = l;
    loop[i * 2 + 1] = r;
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
  }
  const target = Math.pow(10, -1 / 20);
  const scale = peak > target ? target / peak : 1;
  for (let i = 0; i < loop.length; i++) loop[i] *= scale;
  const blob = encodeWav24(loop, SR);
  download(blob, fileBase() + ".wav");
  if (withTail) {
    const fullN = length + tail;
    const full = new Float32Array(fullN * 2);
    for (let i = 0; i < fullN; i++) {
      full[i * 2] = (left[i] || 0) * scale;
      full[i * 2 + 1] = (right[i] || 0) * scale;
    }
    download(encodeWav24(full, SR), fileBase() + "-with-tail.wav");
  }
  $("status").textContent = "Exported " + length + " samples @ " + SR + " Hz";
}

function vlq(n) {
  let v = n < 0 ? ((-n) << 1) | 1 : n << 1;
  const out = [];
  while (v > 127) {
    out.push((v & 127) | 128);
    v >>= 7;
  }
  out.push(v);
  return out;
}
function writeMidi() {
  const hits = collectHits("B");
  const tpq = 480;
  const uspq = Math.round(60000000 / state.bpm);
  const chairs = ["kit", "piano", "bass", "nylon", "violin", "trumpet"];
  function trackBytes(events) {
    const data = [];
    events.forEach(function (e) {
      vlq(e.delta).forEach(function (b) { data.push(b); });
      e.bytes.forEach(function (b) { data.push(b); });
    });
    const head = [0x4d, 0x54, 0x72, 0x6b, (data.length >> 24) & 255, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255];
    return head.concat(data);
  }
  const tempoTrack = trackBytes([
    { delta: 0, bytes: [0xFF, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08] },
    { delta: 0, bytes: [0xFF, 0x51, 0x03, (uspq >> 16) & 255, (uspq >> 8) & 255, uspq & 255] },
    { delta: state.bars * 4 * tpq, bytes: [0xFF, 0x2F, 0x00] }
  ]);
  const tracks = [tempoTrack];
  chairs.forEach(function (chair, idx) {
    const mine = hits.filter(function (h) { return h.chair === chair; }).sort(function (a, b) { return a.when - b.when; });
    const ev = [];
    let last = 0;
    const ch = idx;
    ev.push({ delta: 0, bytes: [0xC0 + ch, chair === "kit" ? 0 : 0] });
    mine.forEach(function (h) {
      const tick = Math.round(h.when / stepDur() * (tpq / 4));
      const note = h.drum ? (h.voice === "kick" ? 36 : h.voice === "snare" ? 38 : 42) : pick(h.voice, h.midi).midi;
      const on = Math.max(0, tick - last);
      ev.push({ delta: on, bytes: [0x90 + ch, note & 127, Math.round(clamp(h.gain, 0.05, 1) * 100)] });
      const offTick = tick + Math.max(1, Math.round(h.dur / stepDur() * (tpq / 4)));
      ev.push({ delta: offTick - tick, bytes: [0x80 + ch, note & 127, 0] });
      last = offTick;
    });
    ev.push({ delta: 0, bytes: [0xFF, 0x2F, 0x00] });
    tracks.push(trackBytes(ev));
  });
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, (tpq >> 8) & 255, tpq & 255];
  const all = header.concat.apply(header, tracks);
  download(new Blob([new Uint8Array(all)], { type: "audio/midi" }), fileBase() + ".mid");
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
}

function punch() {
  const prog = progression().map(function (c) { return c.symbol; }).join(" ");
  const rec = RECIPES.filter(function (r) { return r.id === state.recipe; })[0];
  return [
    "AnswerEight punch list",
    state.bpm + " BPM · key " + state.key + " · " + state.bars + " bars · " + rec.name,
    "",
    "The problem: verse two reprints verse one. Chorus two then has nothing to return to.",
    "The move: " + rec.blurb,
    "",
    "User chords: " + prog,
    "A is the reprint. B is the answer. Drop the WAV on verse two. Do not loop it into the chorus.",
    "Not Unravel (chorus print), TagFour (ending), FloorEight (breakdown), PreEight (pre-chorus)."
  ].join("\n");
}

function paintRecipes() {
  const el = $("recipes");
  el.innerHTML = "";
  RECIPES.forEach(function (r) {
    const b = document.createElement("button");
    b.className = "card" + (state.recipe === r.id ? " on" : "");
    b.innerHTML = "<b>" + r.name + "</b><span>" + r.blurb + "</span>";
    b.onclick = function () { state.recipe = r.id; saveState(); render(); };
    el.appendChild(b);
  });
}
function paintMutes() {
  const el = $("mutes");
  el.innerHTML = "";
  Object.keys(state.mutes).forEach(function (id) {
    const b = document.createElement("button");
    b.textContent = (state.mutes[id] ? "Muted " : "On ") + id;
    b.onclick = function () { state.mutes[id] = !state.mutes[id]; saveState(); paintMutes(); };
    el.appendChild(b);
  });
}
function paintBars(active) {
  const el = $("barsView");
  el.innerHTML = "";
  for (let i = 0; i < state.bars; i++) {
    const d = document.createElement("div");
    d.className = "bar " + (state.mode === "B" ? "b" : "a") + (active === i ? " active" : "");
    d.innerHTML = "<div>" + (i + 1) + "</div><b>" + chordAtBar(i).symbol + "</b>";
    el.appendChild(d);
  }
}
function render() {
  paintRecipes();
  paintMutes();
  paintBars(-1);
  $("punch").textContent = punch();
  $("bpm").value = state.bpm;
  $("chords").value = state.chords;
  $("bars").value = state.bars;
}

function bind() {
  KEYS.forEach(function (k) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = k;
    if (k === state.key) o.selected = true;
    $("key").appendChild(o);
  });
  $("tap").onclick = startAudio;
  $("playA").onclick = function () { play("A"); };
  $("playB").onclick = function () { play("B"); };
  $("stop").onclick = stop;
  $("bpm").onchange = function () {
    state.bpm = clamp(Number($("bpm").value) || 98, 60, 180);
    $("bpm").value = state.bpm;
    saveState();
    render();
  };
  $("key").onchange = function () { state.key = $("key").value; saveState(); render(); };
  $("chords").onchange = function () { state.chords = $("chords").value; saveState(); render(); };
  $("bars").onchange = function () {
    state.bars = clamp(Number($("bars").value) || 8, 4, 16);
    saveState();
    render();
  };
  $("wav").onclick = function () { renderWav(false); };
  $("wavTail").onclick = function () { renderWav(true); };
  $("mid").onclick = writeMidi;
  $("copy").onclick = function () { navigator.clipboard.writeText(punch()); };
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") stop();
  });
}

loadState();
bind();
render();
