// Regions of space (docs/specs/DF-deep-field.md "Regions"): volumes of a deep field's star system that act on what
// passes through them. A region is a circle that orbits the system's centre on a fixed path, so where it is follows
// from the encounter's time alone (placeRegion) and a checkpoint or replay needs nothing more than its plain data.
//
//   dust   a cloud of fine matter: whatever sweeps through it accretes from its finite reserve, faster the faster it
//          sweeps (a body's cross-section times its speed through the cloud); a little drag toward the cloud's motion.
//   storm  a moving front that drives everything inside it along its heading and drags it toward its own speed, with
//          ambient accretion from its reserve. Storms run retrograde, against the system's orbits.
//   shear  a field that grinds whatever is inside it apart: mass breaks off as loose debris, faster at speed.
//   mire   a thick field that drags everything inside it toward its own slow motion.
//   halo   the matter in stable, decaying orbits about a large body, densest just above its surface. It moves with its
//          body. What sweeps through it gathers matter in proportion to how fast it cuts across the orbiting stream,
//          so a grazing slingshot deep in a halo gathers far more than a careful pass: risk and reward near the point
//          of no return. A body's flares refill its halo.
//   heat, radiation, tidal   zones a body carries (ZONES), strongest at its surface: a star's heat ablates a ship,
//          a black hole's radiation grinds it and feeds it radioactive matter, and inside a giant's or a black hole's
//          Roche limit tides pull a ship apart. Each is shielded by one of the ship's modifiers (`shield`).
//   cold   the frozen reaches of the outer system: slow drag, a faltering engine, cryo to gather.
//   nebula a vast, slow cloud of fine matter that hides what is inside it from the field map.
//   kuiper the icy ring about the system's centre whose reserve the visiting comets are made from.
//   solar storm  a front a star throws out, driving everything outward and grinding at it; it runs out after its life.
//
// Each region's particles have a composition with its own attributes (COMPOSITIONS): how fast they accrete, how much
// they add to the drag, whether they cohere (pull toward the region's centre) and whether they disrupt thrust. A
// region's effect is strongest at its centre and fades to nothing at its edge (weight). A region either orbits the
// centre (placeRegion), rides a body (`well`: halos and zones), is a ring about the centre (`shape: 'ring'`), or drifts
// in a straight line from where it was born (`path: 'drift'`, solar storms). Dependency-free, no DOM.

import { deepFreeze } from './descriptor.js';

const TAU = Math.PI * 2;

/**
 * What each kind of region does. `accretes` is its density: matter a body gathers per second is accretes x
 * composition rate x weight x (2 x radius) x (its speed through the region + `sweep`). `drag` (per second) eases a body
 * toward the region's own motion; `push` (units/s²) drives it along the region's heading; `shear` is the mass per
 * second it grinds off a body, times (1 + speed through the region / 400), scaled for the ship by its `shield` modifier
 * (src/sim/traits.js MODS); `veil` hides what is inside from the field map.
 */
export const REGION_KINDS = deepFreeze({
  dust: { name: 'dust cloud', accretes: .00006, sweep: 80, drag: .08, push: 0, shear: 0, shield: null },
  storm: { name: 'storm', accretes: .00005, sweep: 80, drag: .8, push: 120, shear: 0, shield: null },  // carries a body along at about 150 past its own speed
  shear: { name: 'shear field', accretes: 0, sweep: 0, drag: .1, push: 0, shear: 2.2, shield: 'shear' },
  mire: { name: 'mire', accretes: 0, sweep: 0, drag: 1.4, push: 0, shear: 0, shield: null },
  halo: { name: 'halo', accretes: .00018, sweep: 40, drag: 0, push: 0, shear: 0, shield: null },
  heat: { name: 'heat', accretes: 0, sweep: 0, drag: 0, push: 0, shear: 2.4, shield: 'heat' },
  radiation: { name: 'radiation', accretes: .00005, sweep: 80, drag: 0, push: 0, shear: 1.4, shield: 'ion' },
  tidal: { name: 'Roche limit', accretes: 0, sweep: 0, drag: 0, push: 0, shear: 3, shield: 'core' },
  cold: { name: 'cold reach', accretes: .00002, sweep: 80, drag: .25, push: 0, shear: 0, shield: null },
  nebula: { name: 'nebula', accretes: .00002, sweep: 80, drag: .04, push: 0, shear: 0, shield: null, veil: true },
  kuiper: { name: 'Kuiper belt', accretes: .00003, sweep: 80, drag: .05, push: 0, shear: 0, shield: null },
  'solar-storm': { name: 'solar storm', accretes: 0, sweep: 0, drag: .5, push: 260, shear: .8, shield: 'ion' },
});

/**
 * The zones each kind of body carries, out to `extent` cores from its centre, strongest at its surface: a star's heat,
 * a black hole's radiation (with a `reserve` of radioactive matter) and its Roche limit, a giant's Roche limit.
 */
const ZONE_KINDS = new Set(['heat', 'radiation', 'tidal']);
export const ZONES = deepFreeze({
  star: [{ kind: 'heat', extent: 4.5, composition: 'inert', reserve: 0 }],
  'black-hole': [{ kind: 'radiation', extent: 15, composition: 'ionised', reserve: 30 }, { kind: 'tidal', extent: 6, composition: 'inert', reserve: 0 }],
  giant: [{ kind: 'tidal', extent: 2.2, composition: 'inert', reserve: 0 }],
});

/**
 * The halo each kind of body carries: out to `extent` cores, holding `reserve` at the start, its matter of `element`
 * (src/sim/traits.js): a star's forged metals, a black hole's irradiated matter, a giant's water-ice rings, a rocky
 * body's rock. Others carry none.
 */
export const HALOS = deepFreeze({
  star: { extent: 3, reserve: 30, element: 'metal' }, 'black-hole': { extent: 9, reserve: 40, element: 'radioactive' },
  giant: { extent: 3.2, reserve: 25, element: 'water' }, rocky: { extent: 3, reserve: 12, element: 'rock' },
});

/**
 * Particle compositions. `rate` scales accretion; `drag` scales the region's drag (ice is slushy); `cohesion`
 * (units/s²) pulls a body toward the region's centre (metallic dust clings); `thrust` is the share of a ship's thrust
 * left at the region's centre (ionised storms make the engine falter). `element` is what its matter adds to a body's
 * composition (src/sim/traits.js ELEMENTS): frost is the cold volatiles of the outer system, tholin its rare organics.
 */
export const COMPOSITIONS = deepFreeze({
  silicate: { name: 'silicate', rate: 1, drag: 1, cohesion: 0, thrust: 1, element: 'rock' },
  ice: { name: 'ice', rate: 1.6, drag: 2.2, cohesion: 0, thrust: 1, element: 'water' },
  metallic: { name: 'metallic', rate: .7, drag: 1, cohesion: 90, thrust: 1, element: 'metal' },
  ionised: { name: 'ionised', rate: 1.2, drag: 1, cohesion: 0, thrust: .65, element: 'radioactive' },
  frost: { name: 'frost', rate: 1.3, drag: 1.6, cohesion: 0, thrust: .85, element: 'cryo' },  // the cold makes an engine falter
  tholin: { name: 'tholin', rate: .6, drag: 1.2, cohesion: 40, thrust: 1, element: 'organic' },
  inert: { name: 'inert', rate: 0, drag: 1, cohesion: 0, thrust: 1, element: null },
});

/** The element a body accretes from region `r`: its halo's or its composition's. */
export const elementOf = r => r.kind === 'halo' ? (HALOS[r.bodyKind]?.element ?? 'rock') : (COMPOSITIONS[r.composition]?.element ?? 'rock');

const compositionOf = r => COMPOSITIONS[r.composition] ?? COMPOSITIONS.inert;

/**
 * The regions of a system from its template entries `{ kind, composition, orbit, size, speed, reserve }` and integer
 * draws `pick(n)`: each orbits `centre` at `orbit` with `speed` times the circular speed about `mass` (softening
 * `softening`; negative is retrograde), from a drawn phase. `prefix` names them per encounter.
 */
export function buildRegions(entries = [], pick, { centre, mass, softening, prefix }) {
  return entries.map((e, i) => {
    const omega = e.speed * Math.sqrt(mass * e.orbit / (e.orbit * e.orbit + softening * softening)) / e.orbit;
    const region = { id: `region-${prefix}-${i}`, kind: e.kind, composition: e.composition, orbit: e.orbit, radius: e.size, omega,
      phase: e.phase ?? pick(3600) / 3600 * TAU, cx: centre.x, cy: centre.y, reserve: e.reserve ?? 0, x: 0, y: 0, vx: 0, vy: 0 };
    return Object.assign(region, placeRegion(region, 0));
  });
}

/** Where region `r` is at encounter time `t`, and its velocity (a drifting region, also its radius). */
export function placeRegion(r, t) {
  if (r.path === 'drift') { const age = Math.max(0, t - r.born); return { x: r.x0 + r.vx * age, y: r.y0 + r.vy * age, vx: r.vx, vy: r.vy, radius: r.r0 + r.grow * age }; }
  if (r.shape === 'ring' || r.well) return { x: r.x, y: r.y, vx: r.vx, vy: r.vy };
  const a = r.phase + r.omega * t, c = Math.cos(a), s = Math.sin(a);
  return { x: r.cx + c * r.orbit, y: r.cy + s * r.orbit, vx: -s * r.orbit * r.omega, vy: c * r.orbit * r.omega };
}

/** The zones body `well` carries (ZONES), each riding it from its surface out to its extent. */
export function zonesFor(well) {
  return (ZONES[well.kind] ?? []).map(z => ({ id: `${z.kind}-${well.id}`, kind: z.kind, composition: z.composition, bodyKind: well.kind, well: well.id,
    inner: well.core, extent: z.extent, radius: well.core * z.extent, reserve: z.reserve, x: well.x, y: well.y, vx: well.vx, vy: well.vy }));
}

/** A ring about (cx, cy) from `inner` to `outer`, of `kind` and `composition`, holding `reserve` (the Kuiper belt). */
export function ringRegion(id, kind, composition, { x, y }, inner, outer, reserve) {
  return { id, kind, composition, shape: 'ring', x, y, vx: 0, vy: 0, inner, radius: outer, reserve };
}

/** A solar storm born at encounter time `born` at (x0, y0), drifting at (vx, vy) and growing from `r0` by `grow` per second for `life` seconds. */
export function solarStorm(id, { x0, y0, vx, vy, born, life, r0, grow }) {
  return { id, kind: 'solar-storm', composition: 'ionised', path: 'drift', x0, y0, vx, vy, born, life, r0, grow, reserve: 0, x: x0, y: y0, radius: r0 };
}

/** A halo region for body `well` (its id, core, mass and softening), from its kind's HALOS entry, or null. */
export function haloFor(well, soft) {
  const rule = HALOS[well.kind];
  if (!rule) return null;
  return { id: `halo-${well.id}`, kind: 'halo', composition: 'silicate', bodyKind: well.kind, well: well.id, inner: well.core, radius: well.core * rule.extent,
    mass: well.mass, soft, reserve: rule.reserve, x: well.x, y: well.y, vx: well.vx, vy: well.vy };
}

/**
 * Moves every region to where it is at encounter time `t`: an orbiting region along its path, a halo with its body
 * (`wells`), taking the body's current core and mass.
 */
export function moveRegions(regions, t, wells = []) {
  for (const r of regions) {
    if (r.shape === 'ring') continue;
    if (!r.well) { Object.assign(r, placeRegion(r, t)); continue; }
    const k = wells.find(x => x.id === r.well);
    if (!k) continue;
    if (r.kind === 'halo') Object.assign(r, { x: k.x, y: k.y, vx: k.vx, vy: k.vy, inner: k.core, radius: Math.max(r.radius, k.core * 1.5), mass: k.mass });
    else Object.assign(r, { x: k.x, y: k.y, vx: k.vx, vy: k.vy, inner: k.core, radius: k.core * r.extent });
  }
}

/**
 * After a merge: each region the absorbed body carried (its halo and zones) pools into the survivor's of the same kind,
 * or becomes the survivor's, so no matter is stranded. A zone the survivor's kind (`intoKind`) does not carry (a star's
 * heat on a black hole that swallowed it) is not inherited: its reserve pools into the survivor's halo instead, and it
 * is kept only when there is no halo to hold that reserve.
 */
export function mergeHalos(regions, into, absorbed, intoKind = null) {
  const dropped = new Set(), carries = kind => !intoKind || !ZONE_KINDS.has(kind) || (ZONES[intoKind] ?? []).some(z => z.kind === kind);
  for (const r of regions) {
    if (r.well !== absorbed) continue;
    const keep = regions.find(x => x.well === into && x.kind === (carries(r.kind) ? r.kind : 'halo'));
    if (keep) { keep.reserve += r.reserve; dropped.add(r); }
    else { r.well = into; r.id = `${r.kind}-${into}`; }
  }
  return dropped.size ? regions.filter(r => !dropped.has(r)) : regions;
}

/**
 * How strongly region `r` (placed at `at`, by default where it is) acts at body `b`: 1 at its centre, 0 at its edge; a
 * halo's or a zone's rises from 0 at its edge to 1 at its body's surface; a ring's peaks midway between its edges.
 */
export function weight(r, b, at = r) {
  const radius = at.radius ?? r.radius, dx = b.x - at.x, dy = b.y - at.y;
  // Outside the bounding square nothing acts, whatever the shape: the cheap test spares most pairs the square root.
  if (dx > radius || dx < -radius || dy > radius || dy < -radius) return 0;
  const d = Math.hypot(dx, dy);
  if (r.shape === 'ring') { const mid = (r.inner + radius) / 2, half = (radius - r.inner) / 2; return Math.abs(d - mid) < half ? 1 - ((d - mid) / half) ** 2 : 0; }
  if (r.well || r.kind === 'halo') return d < radius && d > r.inner ? ((radius - d) / (radius - r.inner)) ** 2 : 0;
  return d < radius ? 1 - (d / radius) ** 2 : 0;
}

/** The regions that act on body `b`, strongest first, with their weights: [{ region, weight }]. */
export function regionsAt(regions = [], b) {
  return regions.map(region => ({ region, weight: weight(region, b) })).filter(x => x.weight > 0).sort((a, b) => b.weight - a.weight);
}

/**
 * Every region's force on body `b` over `dt`: a storm's push along its heading, cohesion toward a clinging region's
 * centre, and drag toward the region's own motion. Changes `b`'s velocity. `at(r)` places a region elsewhere (a
 * prediction's future time); `drag` scales the drag and cohesion (a body's traits: an icy shell slips through slush).
 */
export function regionDrift(regions = [], b, dt, at = null, drag = 1) {
  for (const r of regions) {
    if (r.kind === 'halo') continue; // a halo exerts nothing: its body's gravity holds its matter
    const q = at ? at(r) : r, f = weight(r, b, q);
    if (!f) continue;
    const kind = REGION_KINDS[r.kind], comp = compositionOf(r), speed = Math.hypot(q.vx, q.vy);
    if (kind.push && speed > 1e-9) { b.vx += q.vx / speed * kind.push * f * dt; b.vy += q.vy / speed * kind.push * f * dt; }
    if (comp.cohesion) {
      const dx = q.x - b.x, dy = q.y - b.y, d = Math.hypot(dx, dy);
      if (d > 1e-9) { b.vx += dx / d * comp.cohesion * drag * f * dt; b.vy += dy / d * comp.cohesion * drag * f * dt; }
    }
    const k = 1 - Math.exp(-kind.drag * comp.drag * drag * f * dt);
    b.vx += (q.vx - b.vx) * k; b.vy += (q.vy - b.vy) * k;
  }
}

/**
 * The share of a ship's thrust left at body `b`: an ionised region's falter, the strongest that applies, scaled by
 * `ion` (a magnetosphere shields the engine).
 */
export function regionThrust(regions = [], b, ion = 1) {
  let thrust = 1;
  for (const r of regions) { const f = weight(r, b); if (f) thrust = Math.min(thrust, 1 - (1 - compositionOf(r).thrust) * f * ion); }
  return thrust;
}

/**
 * The matter per second region `r` adds to body `b` (radius `b.radius`) sweeping through it; 0 when it holds none. A
 * halo's matter circles its body at `stream`, the circular speed of the pull `b` feels there (the caller's: capped as
 * gravity is, and by the body's grip on a ship); without one, the uncapped circular speed.
 */
export function accretionRate(r, b, stream = null) {
  const kind = REGION_KINDS[r.kind], f = weight(r, b);
  if (!kind.accretes || !f || !(r.reserve > 0)) return 0;
  const through = Math.hypot(b.vx - r.vx, b.vy - r.vy);
  if (r.kind === 'halo') {
    // The halo's matter circles its body prograde at the local circular speed: what counts is the speed across it.
    const dx = b.x - r.x, dy = b.y - r.y, d = Math.hypot(dx, dy), v = stream ?? Math.sqrt(r.mass * d / (d * d + r.soft * r.soft));
    const across = Math.hypot(b.vx - (r.vx - dy / d * v), b.vy - (r.vy + dx / d * v));
    return kind.accretes * f * 2 * b.radius * (across + kind.sweep);
  }
  return kind.accretes * compositionOf(r).rate * f * 2 * b.radius * (through + kind.sweep);
}

/** The mass per second region `r` grinds off body `b`. */
export function shearRate(r, b) {
  const kind = REGION_KINDS[r.kind], f = weight(r, b);
  if (!kind.shear || !f) return 0;
  return kind.shear * f * (1 + Math.hypot(b.vx - r.vx, b.vy - r.vy) / 400);
}
