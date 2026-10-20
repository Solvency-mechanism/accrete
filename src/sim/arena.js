// The arena as world state (docs/specs/M3-data-spine.md, "3c Layout and arena", item 2). A world holds its own bounds
// as plain data, `w.arena`: a width, a height and one explicit inset policy for each kind of thing the simulation keeps
// inside them. Every shipped form plays in the 1280 x 720 ARENA. Layout positions (pockets, ore, gates, enemy slots,
// the stream and the current) stay code constants until 3d, which owns per-form geometry and layout scaling.
//
// The policies differ on purpose; one universal margin would change behaviour (docs/specs/M2-contact-and-arena-truth.md,
// "Input and arena"). `bounds` returns the centre interval each allows, and the caller keeps its own comparisons:
//   body      the player and enemies, centre in [r + 14, (extent - 14) - r] on both axes. confine (src/sim/simulation.js)
//             stops a body on it (<=, >=) and removes velocity into the wall; observing enemies steer off it.
//   ore       centre in [r + 95, (extent - 95) - r]. Outside it (strict <, >) ore reverses that velocity component,
//             then is clamped (src/sim/environment.js).
//   pickup    centre in [40, extent - 40]. Outside it (strict) a pickup reverses its drift and that velocity component,
//             scaled by 0.35, then is clamped.
//   scatter   centre in [45, extent - 45]: where a fragment lands as it is spawned (spawnBudget), clamped.
//   released  centre x in [55, width - 55]: a companion a capture releases, clamped on x only; y is not bounded.
// Companions in orbit are not bounded at all: their orbit stays unclamped.
//
// Each bound keeps the grouping the M2 code computed, `radius + inset` and `(extent - inset) - radius`, so every bound
// is the same double as before (1185 - r is (1280 - 95) - r exactly, and 95 + r is r + 95). Dependency-free, no DOM.

import { deepFreeze } from './descriptor.js';

/** The policy names, in the order an arena lists them. */
export const ARENA_POLICIES = Object.freeze(['body', 'ore', 'pickup', 'scatter', 'released']);
/** How a policy's inset is measured: from the body's surface (its radius is added) or from its centre. */
export const ARENA_MEASURES = Object.freeze(['surface', 'centre']);
/** The axes a policy bounds. */
export const ARENA_AXES = Object.freeze(['xy', 'x']);

/** The shipped arena: every current form's bounds. Frozen; a world holds its own copy (createArena). */
export const ARENA = deepFreeze({
  width: 1280, height: 720,
  insets: {
    body: { inset: 14, measure: 'surface', axes: 'xy' },
    ore: { inset: 95, measure: 'surface', axes: 'xy' },
    pickup: { inset: 40, measure: 'centre', axes: 'xy' },
    scatter: { inset: 45, measure: 'centre', axes: 'xy' },
    released: { inset: 55, measure: 'centre', axes: 'x' },
  },
});

const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const sameKeys = (o, keys) => Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));
const extent = v => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * A world's arena: a fresh, mutable, plain copy of `spec` (default ARENA) holding exactly a positive finite width and
 * height and the ARENA_POLICIES, each a finite nonnegative `inset`, a `measure` from ARENA_MEASURES and `axes` from
 * ARENA_AXES. Throws a RangeError on anything else, so a malformed arena never reaches the simulation. createWorld
 * gives every world one; the checkpoint restore (src/sim/checkpoint.js) rebuilds the saved one through it.
 */
export function createArena(spec = ARENA) {
  const refuse = why => { throw new RangeError(`Not an arena: ${why}`); };
  if (!plain(spec) || !sameKeys(spec, ['width', 'height', 'insets'])) refuse('an arena holds exactly width, height and insets');
  if (!extent(spec.width) || !extent(spec.height)) refuse(`width and height must be positive finite numbers, not ${spec.width} x ${spec.height}`);
  if (!plain(spec.insets) || !sameKeys(spec.insets, ARENA_POLICIES)) refuse(`insets must hold exactly the policies ${ARENA_POLICIES.join(', ')}`);
  const insets = {};
  for (const name of ARENA_POLICIES) {
    const p = spec.insets[name];
    if (!plain(p) || !sameKeys(p, ['inset', 'measure', 'axes'])) refuse(`the ${name} policy holds exactly inset, measure and axes`);
    if (typeof p.inset !== 'number' || !Number.isFinite(p.inset) || p.inset < 0) refuse(`the ${name} inset must be a finite nonnegative number, not ${p.inset}`);
    if (!ARENA_MEASURES.includes(p.measure)) refuse(`the ${name} measure must be one of ${ARENA_MEASURES.join(', ')}, not ${JSON.stringify(p.measure)}`);
    if (!ARENA_AXES.includes(p.axes)) refuse(`the ${name} axes must be one of ${ARENA_AXES.join(', ')}, not ${JSON.stringify(p.axes)}`);
    insets[name] = { inset: p.inset, measure: p.measure, axes: p.axes };
  }
  return { width: spec.width, height: spec.height, insets };
}

/**
 * The centre interval arena policy `policy` allows a body of radius `radius` (read only by 'surface' policies), as
 * { minX, maxX, minY, maxY }. A 'surface' policy gives `radius + inset` and `(extent - inset) - radius`; a 'centre'
 * policy `inset` and `extent - inset`. An axis the policy does not bound is (-Infinity, Infinity). Callers compare
 * and clamp against these with their own operators (see the header). Throws a RangeError on an unknown policy.
 */
export function bounds(arena, policy, radius = 0) {
  if (!Object.hasOwn(arena.insets, policy)) throw new RangeError(`Unknown arena policy ${JSON.stringify(policy)}: one of ${ARENA_POLICIES.join(', ')}`);
  const p = arena.insets[policy], { inset } = p, surface = p.measure === 'surface';
  const minX = surface ? radius + inset : inset, maxX = surface ? (arena.width - inset) - radius : arena.width - inset;
  if (p.axes === 'x') return { minX, maxX, minY: -Infinity, maxY: Infinity };
  return { minX, maxX, minY: minX, maxY: surface ? (arena.height - inset) - radius : arena.height - inset };
}
