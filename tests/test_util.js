const assert = require("node:assert/strict");
const IVI = require("../util.js");
const T = 1_000_000;

// parseName
assert.deepEqual(IVI.parseName("03 - Banda X - Musica Y.mp3"), { artist: "Banda X", title: "Musica Y" });
assert.deepEqual(IVI.parseName("so_titulo.flac"), { artist: "Artista desconhecido", title: "so titulo" });

// haversine: ~111.2 km per degree of latitude
assert.ok(Math.abs(IVI.haversine(0, 0, 1, 0) - 111195) < 300);

// lock: fail-safe behaviour
const base = { mode: "auto", now: T, lastFix: T - 500, gpsSpeed: 0, acc: 10 };
assert.equal(IVI.evaluate(base).locked, false, "parked with good fix -> unlocked");
assert.equal(IVI.evaluate({ ...base, gpsSpeed: 30 }).locked, true, "moving -> locked");
assert.equal(IVI.evaluate({ ...base, gpsSpeed: 7.9 }).locked, false, "just under threshold");
assert.equal(IVI.evaluate({ ...base, gpsSpeed: 8 }).locked, true, "at threshold -> locked");
assert.equal(IVI.evaluate({ ...base, lastFix: 0 }).locked, true, "never had a fix -> locked");
assert.equal(IVI.evaluate({ ...base, lastFix: T - 6000 }).locked, true, "stale fix -> locked");
assert.equal(IVI.evaluate({ ...base, gpsSpeed: null }).locked, true, "speed unknown -> locked");
assert.equal(IVI.evaluate({ ...base, acc: 500 }).locked, true, "poor accuracy -> locked");
assert.equal(IVI.evaluate({ ...base, mode: "off", lastFix: 0 }).locked, false, "bench override");
console.log("all util tests passed");
