/* IVI for Android (PWA). Runs on-device; online map services provide optional route planning.
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
let map, currentMarker, routeLayer, currentPosition = null, routeController, followingLocation = true, routePending = false;
let lastGeocodeAt = 0, routeRequestId = 0;

function updateNavigationPosition(coords) {
  currentPosition = { lat: coords.latitude, lon: coords.longitude };
  if (!map || !window.L) return;
  const point = [currentPosition.lat, currentPosition.lon];
  if (currentMarker) currentMarker.setLatLng(point);
  else currentMarker = L.circleMarker(point, {
    radius: 9, color: "#ffffff", weight: 3, fillColor: "#1687ff", fillOpacity: 1,
  }).bindTooltip("Sua localização").addTo(map);
  if (followingLocation) map.setView(point, Math.max(map.getZoom(), 15), { animate: false });
}

function onPos(p) {
  const c = p.coords; lastFix = Date.now();
  updateNavigationPosition(c);
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
  if ($("#route-status")) $("#route-status").textContent = "Sem sinal GPS. Ative a localização do aparelho.";
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
  setWake(store.get("wake", true));
}, { once: true });

function showView(n) {
  document.body.classList.toggle("navigation-active", n === "navigation");
  document.querySelectorAll(".view").forEach((el) => el.classList.toggle("active", el.id === "view-" + n));
  document.querySelectorAll(".rail-btn").forEach((el) => el.classList.toggle("active", el.dataset.view === n));
  if (n === "navigation") {
    if (ensureMap()) setTimeout(() => map.invalidateSize(), 0);
    if (!currentPosition) $("#route-status").textContent = "Aguardando sinal GPS para traçar a rota.";
  }
}

function ensureMap() {
  if (map) return true;
  if (!window.L) {
    $("#route-status").textContent = "Mapa indisponível. Verifique a conexão e reabra a navegação.";
    return false;
  }
  map = L.map("map", { zoomControl: false, attributionControl: true, zoomSnap: .5 }).setView([-14.235, -51.925], 4);
  L.control.zoom({ position: "topright" }).addTo(map);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 20, subdomains: "abcd",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).on("tileerror", () => {
    $("#route-status").textContent = "Não foi possível carregar o mapa. Verifique a conexão.";
  }).addTo(map);
  if (currentPosition) updateNavigationPosition({ latitude: currentPosition.lat, longitude: currentPosition.lon });
  updateMapInteractions();
  return true;
}

function updateMapInteractions() {
  if (!map) return;
  const enabled = !S.restrictions.locked;
  [map.dragging, map.touchZoom, map.doubleClickZoom, map.scrollWheelZoom, map.boxZoom, map.keyboard]
    .forEach((interaction) => interaction?.[enabled ? "enable" : "disable"]());
}

function formatDuration(seconds) {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

function clearRoute() {
  if (routeLayer) routeLayer.remove();
  routeLayer = null;
  $("#route-summary").hidden = true;
  $("#clear-route-btn").disabled = true;
  $("#route-status").textContent = "Rota removida.";
}

async function traceRoute(destination) {
  if (S.restrictions.locked) {
    toast("Planejamento de rota indisponível em movimento");
    return;
  }
  if (!navigator.onLine) {
    $("#route-status").textContent = "Conecte-se à internet para buscar o destino e traçar a rota.";
    return;
  }
  if (!currentPosition || !S.gps.fix || Date.now() - lastFix > IVI.GPS_STALE_MS) {
    $("#route-status").textContent = "Aguardando uma posição GPS válida para traçar a rota.";
    return;
  }
  if (!ensureMap()) return;

  if (routeController) routeController.abort();
  routeController = new AbortController();
  const { signal } = routeController;
  const requestId = ++routeRequestId;
  const button = $("#route-btn");
  routePending = true;
  button.disabled = true;
  clearRoute();
  $("#route-status").textContent = "Buscando destino e calculando a rota…";
  try {
    const delay = Math.max(0, 1000 - (Date.now() - lastGeocodeAt));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    lastGeocodeAt = Date.now();
    const searchUrl = new URL("https://nominatim.openstreetmap.org/search");
    searchUrl.search = new URLSearchParams({ q: destination, format: "jsonv2", limit: "1", "accept-language": "pt-BR" });
    const searchResponse = await fetch(searchUrl, { signal, headers: { Accept: "application/json" } });
    if (!searchResponse.ok) throw new Error("Falha ao buscar o destino.");
    const places = await searchResponse.json();
    if (!places.length) {
      $("#route-status").textContent = "Destino não encontrado. Confira o endereço e tente novamente.";
      return;
    }

    const place = places[0];
    const lat = Number(place.lat), lon = Number(place.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("A busca retornou uma localização inválida.");
    const start = `${currentPosition.lon},${currentPosition.lat}`;
    const end = `${lon},${lat}`;
    const routeUrl = `https://router.project-osrm.org/route/v1/driving/${start};${end}?overview=full&geometries=geojson`;
    const routeResponse = await fetch(routeUrl, { signal, headers: { Accept: "application/json" } });
    if (!routeResponse.ok) throw new Error("Falha ao calcular a rota.");
    const result = await routeResponse.json();
    if (result.code !== "Ok" || !result.routes?.length) {
      $("#route-status").textContent = "Não foi encontrada uma rota de carro para esse destino.";
      return;
    }

    const route = result.routes[0];
    const geometry = route.geometry;
    if (geometry?.type !== "LineString" || !Array.isArray(geometry.coordinates) ||
        geometry.coordinates.length < 2 ||
        geometry.coordinates.some((point) => !Array.isArray(point) ||
          !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) {
      throw new Error("O serviço não retornou um trajeto pelas vias. Tente novamente.");
    }

    clearRoute();
    routeLayer = L.featureGroup([
      L.geoJSON(geometry, { style: { color: "#07131c", weight: 13, opacity: .95 } }),
      L.geoJSON(geometry, { style: { color: "#54d6ff", weight: 8, opacity: 1 } }),
      L.circleMarker([lat, lon], { radius: 8, color: "#ffffff", weight: 2, fillColor: "#ff5a5f", fillOpacity: 1 }),
    ]).addTo(map);
    const mapBounds = $("#map").getBoundingClientRect();
    const panelBounds = $(".navigation-panel").getBoundingClientRect();
    map.fitBounds(routeLayer.getBounds(), {
      paddingTopLeft: [Math.max(24, panelBounds.right - mapBounds.left + 16), Math.max(24, panelBounds.bottom - mapBounds.top + 16)],
      paddingBottomRight: [88, 88],
      maxZoom: 16,
    });
    followingLocation = true;
    $("#route-distance").textContent = route.distance >= 1000
      ? `${(route.distance / 1000).toFixed(1)} km` : `${Math.round(route.distance)} m`;
    $("#route-duration").textContent = formatDuration(route.duration);
    $("#route-summary").hidden = false;
    $("#clear-route-btn").disabled = S.restrictions.locked;
    $("#route-status").textContent = `Rota para ${place.name || destination}.`;
  } catch (error) {
    if (error.name === "AbortError" || requestId !== routeRequestId) return;
    console.error(error);
    $("#route-status").textContent = error.message || "Não foi possível traçar a rota. Tente novamente.";
  } finally {
    if (requestId === routeRequestId) {
      routePending = false;
      button.disabled = S.restrictions.locked;
    }
  }
}

$("#route-form").addEventListener("submit", (event) => {
  event.preventDefault();
  traceRoute($("#destination").value.trim());
});
$("#clear-route-btn").addEventListener("click", clearRoute);
$("#locate-btn").addEventListener("click", () => {
  followingLocation = true;
  if (!currentPosition) {
    $("#route-status").textContent = "Aguardando sinal GPS para encontrar sua localização.";
    return;
  }
  if (ensureMap()) map.setView([currentPosition.lat, currentPosition.lon], 16, { animate: false });
});
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
  $("#destination").disabled = L;
  $("#route-btn").disabled = L || routePending;
  $("#clear-route-btn").disabled = L || !routeLayer;
  updateMapInteractions();
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
