// Hashed split-stream RNG and integer layout tables (M0-a, docs/specs/M0-evidence-spine.md).
// Each named stream is a mulberry32 generator. Its 32-bit state starts at murmur3's fmix32 of
// seed ^ salt, and the salt is the FNV-1a hash of the stream's name, so adding a stream is one entry
// in STREAM_NAMES. A draw on one stream never shifts another. The whole state is a plain object of
// unsigned integers, so a checkpoint can copy it as JSON. Layout values come from integer draws and
// the fixed tables below, never from Math.cos, Math.sin or Math.sqrt of a draw.

export const STREAM_NAMES = Object.freeze(['layout', 'ai', 'spawn']);
const UINT32 = 4294967296;
function fnv1a(text) { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0; return h; }
const SALTS = Object.freeze(Object.fromEntries(STREAM_NAMES.map(name => [name, fnv1a(name)])));

/** murmur3's 32-bit finalizer: every input bit affects every output bit. */
export function fmix32(h) { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); return (h ^ h >>> 16) >>> 0; }
/** The starting state of every stream for `seed`: a plain, serializable object. */
export const seedStreams = seed => Object.fromEntries(STREAM_NAMES.map(name => [name, fmix32((seed >>> 0) ^ SALTS[name])]));
/** Advances one stream (mulberry32) and returns its next unsigned 32-bit output. */
export function nextUint32(state, name) {
  const s = state[name] = (state[name] + 0x6d2b79f5) >>> 0;
  let t = Math.imul(s ^ s >>> 15, s | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return (t ^ t >>> 14) >>> 0;
}
export const draw = (state, name) => nextUint32(state, name) / UINT32;                       // float in [0, 1)
export const drawInt = (state, name, n) => Math.floor(nextUint32(state, name) / UINT32 * n);  // integer in [0, n); exact for n < 2^21
export const offset = (state, name, half) => drawInt(state, name, 2 * half + 1) - half;     // integer in [-half, half]

const bind = state => ({ state, ...Object.fromEntries(STREAM_NAMES.map(name => [name, () => draw(state, name)])) });
/** Named streams for `seed`, each a function returning a float in [0, 1); `state` is their shared serializable state. */
export const createStreams = seed => bind(seedStreams(seed));
/** Streams resumed from a saved state, such as JSON read back from a checkpoint. The saved object is copied, not adopted. */
export function restoreStreams(saved) {
  const state = {};
  for (const name of STREAM_NAMES) {
    const value = saved?.[name];
    if (!Number.isInteger(value) || value < 0 || value >= UINT32) throw new TypeError(`Invalid ${name} stream state: ${value}`);
    state[name] = value;
  }
  return bind(state);
}

// Integer layout tables. UNIT is the fixed-point scale of both tables.
export const UNIT = 1024;
// round(UNIT * sin(k * PI / 32)) for k = 0..16; the other three quarters follow by symmetry.
const QUARTER = [0, 100, 200, 297, 392, 483, 569, 650, 724, 792, 851, 903, 946, 980, 1004, 1019, 1024];
const sine = i => { const k = i & 15, q = i >> 4 & 3, v = q & 1 ? QUARTER[16 - k] : QUARTER[k]; return q & 2 ? 0 - v : v; };
/** 64 unit directions, [cos, sin](i * TAU / 64) scaled by UNIT. */
export const DIRECTIONS = Object.freeze(Array.from({ length: 64 }, (_, i) => Object.freeze([sine(i + 16), sine(i)])));
/** 16 area-uniform radii, round(UNIT * sqrt((k + .5) / 16)): equal-area rings of the unit disc. */
export const RADII = Object.freeze([181, 314, 405, 479, 543, 600, 653, 701, 746, 789, 830, 868, 905, 941, 975, 1008]);
/** An area-uniform offset within `spread` of a point. Integer products over 2^20, so exact in every engine. */
export function scatter(state, name, spread) {
  const [ux, uy] = DIRECTIONS[drawInt(state, name, DIRECTIONS.length)], r = RADII[drawInt(state, name, RADII.length)] * spread;
  return { x: ux * r / (UNIT * UNIT), y: uy * r / (UNIT * UNIT) };
}
