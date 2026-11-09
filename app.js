/* IVI for Android (PWA). Runs entirely on the device: Chrome APIs replace the Python back-end.
     mpv/PipeWire -> <audio> + Media Session   GPS/CAN speed -> Geolocation
     StateHub     -> set()                     library       -> IndexedDB (persists offline)
   Phone calls and Bluetooth audio routing are handled natively by Android. */
"use strict";
const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode etc. */ } },
};

/* ---------------- state ---------------- */
const S = {
  media: { playing: false, title: "Nada tocando", artist: "", position: 0, duration: 0, index: -1 },
  library: { tracks: [] }, vehicle: { speed_kmh: 0, valid: false }, restrictions: { locked: true },
  system: { volume: store.get("volume", 80), battery: null, charging: false, online: navigator.onLine, wake: false },
  gps: { fix: false, acc: null }, settings: { mode: store.get("mode", "auto") },
};
function set(topic, data) {
  const cur = S[topic]; let changed = false;
  for (const k in data) if (cur[k] !== data[k]) { cur[k] = data[k]; changed = true; }
  if (changed) render(topic);
}

/* ---------------- library (IndexedDB: one store, blobs are disk-backed) ---------------- */
const rq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
let dbp;
const db = () => (dbp ??= new Promise((res, rej) => {
  const r = indexedDB.open("ivi", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("tracks", { keyPath: "id", autoIncrement: true });
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
}));
const tracksStore = async (mode = "readonly") => (await db()).transaction("tracks", mode).objectStore("tracks");
let lib = [];
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
function publishLibrary() {
  S.library.tracks = lib.map((t, i) => ({ id: i, title: t.title, artist: t.artist }));
  render("library"); set("media", { index: lib.findIndex((t) => t.id === curId) });
}
async function loadLibrary() { try { lib = (await rq((await tracksStore()).getAll())).sort(byName); } catch { lib = []; } publishLibrary(); }
async function addFiles(files) {
  let n = 0;
  for (const f of files) {
    if (lib.some((t) => t.name === f.name && t.size === f.size)) continue;       // skip duplicates
    const { artist, title } = IVI.parseName(f.name);
    const rec = { name: f.name, size: f.size, title, artist, blob: f };
    try { rec.id = await rq((await tracksStore("readwrite")).add(rec)); lib.push(rec); n++; }
    catch { toast("Sem espaço para salvar " + f.name); break; }
  }
  lib.sort(byName); publishLibrary(); toast(n ? `${n} música(s) adicionada(s)` : "Nada novo para adicionar");
}

/* ---------------- player ---------------- */
const audio = new Audio(); audio.preload = "auto";
let url = null, curId = null;
audio.volume = S.system.volume / 100;
audio.onplay = () => { set("media", { playing: true }); setSession("playing"); };
audio.onpause = () => { set("media", { playing: false }); setSession("paused"); };
audio.ontimeupdate = () => set("media", { position: Math.floor(audio.currentTime) });
audio.ondurationchange = () => isFinite(audio.duration) && set("media", { duration: Math.floor(audio.duration) });
audio.onended = () => next();
audio.onerror = () => toast("Não foi possível tocar este arquivo");

async function playIndex(i) {
  const t = lib[i]; if (!t) return;
  curId = t.id; if (url) URL.revokeObjectURL(url);
  url = URL.createObjectURL(t.blob); audio.src = url;
  set("media", { title: t.title, artist: t.artist, position: 0, duration: 0, index: i });
  setSession(null, t);
  try { await audio.play(); } catch { toast("Toque em ▶ para iniciar"); }
}
const toggle = () => (audio.src ? (audio.paused ? audio.play() : audio.pause()) : playIndex(0));
const next = () => lib.length && playIndex((S.media.index + 1) % lib.length);
const prev = () => lib.length && (audio.currentTime > 3 ? (audio.currentTime = 0) : playIndex((S.media.index - 1 + lib.length) % lib.length));

/* Media Session: lock-screen / notification / steering-wheel (Bluetooth AVRCP) buttons.
   These stay available while driving, like the "safe" commands of the Pi version. */
function setSession(state, t) {
  if (!("mediaSession" in navigator)) return;
  if (t) navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: "IVI" });
  if (state) navigator.mediaSession.playbackState = state;
}
if ("mediaSession" in navigator) {
  for (const [a, h] of [["play", () => audio.play()], ["pause", () => audio.pause()], ["previoustrack", prev], ["nexttrack", next]])
    try { navigator.mediaSession.setActionHandler(a, h); } catch { /* unsupported action */ }
}

/* ---------------- vehicle speed from GPS + driver-distraction lock ---------------- */
let lastFix = 0, gpsSpeed = null, prevPos = null, warnedGps = false;
function onPos(p) {
  const c = p.coords; lastFix = Date.now();
  let v = c.speed;                                                      // m/s, may be null
  if (v == null && prevPos) {                                           // fallback: distance / time
    const dt = (p.timestamp - prevPos.t) / 1000;
    if (dt > 0.5 && dt < 10) v = IVI.haversine(prevPos.la, prevPos.lo, c.latitude, c.longitude) / dt;
  }
  prevPos = { la: c.latitude, lo: c.longitude, t: p.timestamp };
  gpsSpeed = v == null ? null : v * 3.6;
  set("gps", { fix: true, acc: Math.round(c.accuracy) }); recompute();
}
function onPosErr(e) {
  set("gps", { fix: false }); recompute();
  if (!warnedGps) { warnedGps = true; toast(e.code === 1 ? "Permita a localização para o bloqueio por velocidade" : "GPS indisponível"); }
}
function recompute() {
  const r = IVI.evaluate({ mode: S.settings.mode, now: Date.now(), lastFix, gpsSpeed, acc: S.gps.acc });
  set("vehicle", { speed_kmh: Math.round(r.speed * 10) / 10, valid: r.valid });
  set("restrictions", { locked: r.locked });
  if (S.settings.mode === "auto" && Date.now() - lastFix > IVI.GPS_STALE_MS) set("gps", { fix: false });
}
if ("geolocation" in navigator)
  navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 });
setInterval(recompute, 1000);

/* ---------------- device: battery, network, wake lock ---------------- */
navigator.getBattery?.().then((b) => {
  const u = () => set("system", { battery: Math.round(b.level * 100), charging: b.charging });
  u(); b.onlevelchange = u; b.onchargingchange = u;
});
addEventListener("online", () => set("system", { online: true }));
addEventListener("offline", () => set("system", { online: false }));
let wl = null;
async function setWake(on) {
  try {
    if (on && !wl) { wl = await navigator.wakeLock.request("screen"); wl.onrelease = () => { wl = null; set("system", { wake: false }); }; }
    else if (!on && wl) await wl.release();
    set("system", { wake: on }); store.set("wake", on);
  } catch { toast("Tela sempre ligada indisponível"); }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && store.get("wake", true) && !wl) setWake(true);
});

/* ---------------- commands (same pattern as the Python back-end) ---------------- */
const MODES = ["auto", "sim", "off"];
const MODE_LABEL = { auto: "GPS automático", sim: "Simulação", off: "Desligado (só estacionado)" };
const commands = {                                  // name: [handler, allowed while moving]
  "media.toggle": [toggle, true], "media.next": [next, true], "media.prev": [prev, true],
  "media.play_track": [(a) => playIndex(a.id), false],
  "system.volume": [(a) => {
    const v = Math.max(0, Math.min(100, S.system.volume + a.delta));
    audio.volume = v / 100; store.set("volume", v); set("system", { volume: v });
  }, true],
  "system.wake": [() => setWake(!S.system.wake), true],
  "lock.mode": [() => { const m = MODES[(MODES.indexOf(S.settings.mode) + 1) % MODES.length]; store.set("mode", m); set("settings", { mode: m }); recompute(); }, true],
  "lib.clear": [async () => {
    if (!confirm("Apagar todas as músicas salvas?")) return;
    audio.pause(); audio.removeAttribute("src"); curId = null;
    await rq((await tracksStore("readwrite")).clear()); lib = []; publishLibrary();
    set("media", { title: "Nada tocando", artist: "", position: 0, duration: 0, index: -1 });
  }, false],
};
async function cmd(name, args = {}) {
  const e = commands[name]; if (!e) return;
  if (!e[1] && S.restrictions.locked) return toast("Indisponível em movimento");
  try { await e[0](args); } catch (err) { console.error(err); toast("Falha ao executar"); }
}

/* ---------------- UI ---------------- */
document.addEventListener("click", (e) => {
  const c = e.target.closest("[data-cmd]");
  if (c && !c.disabled) return cmd(c.dataset.cmd, c.dataset.args ? JSON.parse(c.dataset.args) : {});
  const v = e.target.closest("[data-view]");
  if (v) showView(v.dataset.view);
});
$("#pick").addEventListener("change", (e) => {
  if (S.restrictions.locked) toast("Indisponível em movimento"); else addFiles([...e.target.files]);
  e.target.value = "";
});
document.addEventListener("click", () => {                        // first tap: fullscreen / wake lock / orientation
  if (!matchMedia("(display-mode: fullscreen), (display-mode: standalone)").matches)
    document.documentElement.requestFullscreen?.().catch(() => {});
  screen.orientation?.lock?.("landscape").catch(() => {});
  setWake(store.get("wake", true));
}, { once: true });

function showView(n) {
  document.querySelectorAll(".view").forEach((el) => el.classList.toggle("active", el.id === "view-" + n));
  document.querySelectorAll(".rail-btn").forEach((el) => el.classList.toggle("active", el.dataset.view === n));
}
let toastTimer;
function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2500); }
const txt = (id, v) => { const el = document.getElementById(id); if (el.textContent !== String(v)) el.textContent = v; };
function chip(id, label, kind) { const c = $("#" + id); c.textContent = label; c.className = "chip " + (kind === "ok" ? "" : kind); }

function render(topic) {
  ({ media: rMedia, library: rLibrary, vehicle: rVehicle, restrictions: rLock, system: rSystem, gps: rGps, settings: rLock })[topic]?.();
}
function rMedia() {
  const m = S.media, pct = m.duration ? Math.min(100, (m.position / m.duration) * 100) : 0;
  for (const p of ["np", "m"]) {
    txt(p + "-title", m.title); txt(p + "-artist", m.artist);
    $("#" + p + "-bar").style.width = pct + "%"; txt(p + "-play", m.playing ? "⏸" : "▶");
  }
  txt("m-pos", IVI.mmss(m.position)); txt("m-dur", IVI.mmss(m.duration));
  document.querySelectorAll(".track").forEach((b) => b.classList.toggle("cur", +b.dataset.id === m.index));
}
function rLibrary() {                                              // untrusted tag text -> textContent only
  const ul = $("#tracklist"); ul.replaceChildren();
  for (const t of S.library.tracks.slice(0, 500)) {
    const li = document.createElement("li"), b = document.createElement("button");
    b.className = "track"; b.dataset.cmd = "media.play_track"; b.dataset.id = t.id;
    b.dataset.args = JSON.stringify({ id: t.id }); b.textContent = `${t.title} — ${t.artist}`;
    li.append(b); ul.append(li);
  }
  txt("s-count", S.library.tracks.length); rMedia();
}
function rVehicle() { const v = S.vehicle; txt("v-speed", v.valid ? Math.round(v.speed_kmh) : "--"); }
function rLock() {
  const L = S.restrictions.locked;
  document.body.classList.toggle("locked", L);
  chip("chip-lock", L ? "Dirigindo" : "Parado", L ? "warn" : "ok");
  txt("s-mode", L ? "Ativo" : "Liberado");
  const mb = $("#mode-btn"); mb.textContent = "Modo: " + MODE_LABEL[S.settings.mode]; mb.classList.toggle("on", S.settings.mode !== "auto");
}
function rSystem() {
  const s = S.system;
  txt("vol", s.volume); txt("wake", s.wake ? "Ligada" : "Desligada"); $("#wake").classList.toggle("on", s.wake);
  chip("chip-net", s.online ? "Online" : "Offline", s.online ? "ok" : "off"); txt("s-net", s.online ? "Online" : "Offline");
  if (s.battery != null) {
    chip("chip-bat", s.battery + "%" + (s.charging ? "⚡" : ""), s.battery > 20 || s.charging ? "ok" : "warn");
    txt("v-bat", s.battery); txt("v-charge", s.charging ? "% (carregando)" : "%");
    $("#v-batbar").style.width = s.battery + "%";
  }
}
function rGps() {
  const g = S.gps; chip("chip-gps", "GPS", g.fix ? "ok" : "off");
  txt("s-gps", g.fix ? `Fixo (±${g.acc} m)` : "Sem sinal");
}
function tick() {
  const d = new Date(), t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  txt("clock", t); txt("bigclock", t);
  txt("date", d.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "short" }));
}
setInterval(tick, 1000); tick();
["media", "vehicle", "restrictions", "system", "gps"].forEach(render);
loadLibrary();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
