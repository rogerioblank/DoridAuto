"use strict";
/* Pure helpers (no DOM) so the safety-critical lock logic can be unit-tested with Node. */
const IVI = {
  LOCK_KMH: 8,          // at/above this speed (or unknown speed) the browse UI is locked
  GPS_STALE_MS: 5000,   // no GPS fix for this long => speed unknown
  MAX_ACC_M: 100,       // worse accuracy than this => speed unknown

  /** "03 - Artist - Title.mp3" -> {artist,title} */
  parseName(name) {
    const s = name.replace(/\.[^.]+$/, "").replace(/_/g, " ").replace(/^\d{1,3}[\s.\-_]+/, "").trim();
    const p = s.split(" - ");
    return p.length >= 2 ? { artist: p[0].trim(), title: p.slice(1).join(" - ").trim() }
                         : { artist: "Artista desconhecido", title: s || name };
  },

  /** Great-circle distance in metres (fallback when the device reports no speed). */
  haversine(la1, lo1, la2, lo2) {
    const R = 6371000, r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
    const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  },

  mmss(s) { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; },

  /** Fail-safe lock: unknown speed == moving.  mode: auto (GPS) | sim | off (bench only). */
  evaluate({ mode, now, lastFix, gpsSpeed, acc }) {
    if (mode === "off") return { speed: 0, valid: true, locked: false };
    if (mode === "sim") {
      const speed = Math.max(0, 45 + 40 * Math.sin(now / 20000));
      return { speed, valid: true, locked: speed >= IVI.LOCK_KMH };
    }
    const valid = lastFix > 0 && now - lastFix < IVI.GPS_STALE_MS && gpsSpeed != null
                  && acc != null && acc <= IVI.MAX_ACC_M;
    const speed = valid ? gpsSpeed : 0;
    return { speed, valid, locked: !valid || speed >= IVI.LOCK_KMH };
  },
};
if (typeof module !== "undefined") module.exports = IVI;
