// Gameplay projection: the identity-free part of a world that a replay, a golden digest or a
// cross-identity comparison should agree on. Identity names, objective text, evolution preview
// copy and event annotations are excluded on purpose (src/sim/simulation.js:35, 49, 119-121, 150).
// Changing the projection changes every recorded hash, so bump PROJECTION_VERSION when you do.
// It lives in src/ so the app can hash a playtest session (src/sim/playtest-log.js); the harness
// re-exports it from tools/harness/projection.mjs. It must stay free of DOM and Node APIs.

export const PROJECTION_VERSION = 1;

const FNV_OFFSET = 0x811c9dc5, FNV_PRIME = 0x01000193;
const encoder = new TextEncoder();

/** 32-bit FNV-1a over the UTF-8 bytes of `text`. Pass a previous hash as `seed` to chain. */
export function fnv1a(text, seed = FNV_OFFSET) {
  let h = seed >>> 0;
  for (const byte of encoder.encode(text)) h = Math.imul(h ^ byte, FNV_PRIME) >>> 0;
  return h;
}

export const hex = h => (h >>> 0).toString(16).padStart(8, '0');

/** JSON with object keys sorted at every level, so equal projections always serialize equally. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const r2 = n => Math.round(n * 100) / 100;
const r3 = n => Math.round(n * 1000) / 1000;

export function project(w) {
  const p = w.player;
  return {
    v: PROJECTION_VERSION,
    phase: w.phase,
    // v1 names the player's integrity `mass`, as the player record did before M3b; renaming the key would move every hash.
    player: { x: r2(p.x), y: r2(p.y), vx: r2(p.vx), vy: r2(p.vy), mass: p.integrity, growth: p.growth },
    encounter: { index: w.encounterIndex, time: r3(w.encounterTime), collected: w.encounterCollected, quota: w.encounterQuota },
    enemies: w.enemies.map(e => ({ id: e.id, x: r2(e.x), y: r2(e.y), mass: e.mass, state: e.state })),
    pickups: { count: w.pickups.length, value: w.pickups.reduce((sum, q) => sum + q.value, 0) },
    slalom: { next: w.slalom?.next ?? 0, complete: !!w.slalom?.complete },
  };
}

/** Stable 8-hex-digit hash of the gameplay projection. */
export const projectionHash = w => hex(fnv1a(canonicalJson(project(w))));
