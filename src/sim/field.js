// Fields (docs/specs/DF-deep-field.md): the space an encounter is played in and the physics that governs it. A world
// names its field by id, `w.field`, and holds the gravitating bodies of its current encounter, `w.wells`, as plain data.
//
//   classic  The shipped 1280 x 720 arena, no wells, velocity-tracking steering. Every classic world is bit-identical
//            to the build before fields existed: the golden replays pin it, and nothing below runs for it.
//   deep     An open star system with no walls. Each encounter is a system of stars, black holes, gas giants, rocky
//            planets and moons that pull on each other (n-body, merging when their cores meet) and on everything else.
//            Every body has momentum: the player flies a ship that turns and spools its thrust, opponents thrust and
//            drift, and ore, matter, gates, moons and the comet coast under gravity. A weak tide beyond the system's
//            reach eases anything that drifts too far back toward its centre; nothing is confined.
//
// Each kind of body interacts in its own way (BODY_KINDS): stars, black holes and gas giants have event horizons, inside
// which nothing moves outward and every ship spirals in to be swallowed whole; stars consume matter and blow light
// matter outward; a gas giant's atmosphere aerobrakes anything inside it and its core accretes matter; rocky planets and moons are
// solid, and ore that strikes them shatters into matter that orbits with them. Matter a body swallows is held by it
// (w.stats.accreted, less w.stats.released) until the body flares it back out into orbit, so matter is conserved and an
// encounter's matter can never all be lost to the bodies.
//
// A field descriptor is plain data, frozen. Dependency-free, no DOM.

import { deepFreeze } from './descriptor.js';
import { ARENA } from './arena.js';
import { encounterOf, formOf } from './campaign.js';
import { buildRegions, regionDrift, placeRegion, haloFor, zonesFor, ringRegion } from './regions.js';

const TAU = Math.PI * 2;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const angleDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

/** The field ids, in menu order. */
export const FIELD_IDS = Object.freeze(['deep', 'classic']);
/** The field a world gets when none is named: the simulation API keeps the classic arena, so every pinned replay holds. */
export const DEFAULT_FIELD = 'classic';

/**
 * How each kind of body behaves. `grip` is the most it pulls the player's ship (units/s²): a ship whose drive is
 * weaker cannot climb away from it once inside its point of no return (escapeRadius). `softening` (a fraction of the core) shapes how steep its pull is near the surface;
 * `restitution` is how a solid body rebounds off it; `accretes` lists what it swallows on contact (matter, ore,
 * enemies), and everything else rebounds; `atmosphere` (a multiple of the core) and `drag` (per second, relative to
 * the body) aerobrake anything inside it; `radiation` pushes matter outward within `radiationReach` cores, as a
 * fraction of the body's pull; `shatters` lets ore striking it faster than `shatterSpeed` break apart; `strike` sets
 * the player's damage on contact: `base` plus one per `per` units/s beyond `speed`, at most `cap`, `burns` when it settles again
 * every impact interval while the contact lasts (no separation needed, so nothing rests on it unharmed), and `eject` a
 * minimum outward speed after the contact. `horizon` (cores, 0 for none) is the event horizon: inside it nothing moves
 * outward relative to the body, motion across it bleeds away at `horizonDrag` per second, and the body's full pull
 * applies to a ship, so whatever crosses it spirals in and is swallowed. `flare` (accreting kinds) returns what the body has swallowed to play: once it
 * holds `at` matter and `cooldown` seconds have passed since its last flare, it throws all of it out `launch` cores
 * from its centre on orbits about itself, around its whole surface or, for a `jet`, along both ends of one axis.
 */
export const BODY_KINDS = deepFreeze({
  star: { grip: 360, softening: 1, restitution: .5, accretes: ['matter', 'ore', 'player', 'enemy'], horizon: 1.4, horizonDrag: 1.5, atmosphere: 0, drag: 0, radiation: .4, radiationReach: 4,
    shatters: false, shatterSpeed: 0, strike: { base: 6, speed: 260, per: 25, cap: 18, eject: 0, burns: true },
    flare: { at: 6, cooldown: 5, launch: 5, jet: false } },
  'black-hole': { grip: 480, softening: .35, restitution: 1, accretes: ['matter', 'ore', 'player', 'enemy'], horizon: 3, horizonDrag: 2, atmosphere: 0, drag: 0, radiation: 0, radiationReach: 0,
    shatters: false, shatterSpeed: 0, strike: { base: 30, speed: Infinity, per: 1, cap: 30, eject: 300 },
    flare: { at: 8, cooldown: 4, launch: 20, jet: true } },
  giant: { grip: 240, softening: 1, restitution: .3, accretes: ['matter', 'player', 'enemy'], horizon: 1.3, horizonDrag: 1.2, atmosphere: 1.8, drag: 1.6, radiation: 0, radiationReach: 0,
    shatters: true, shatterSpeed: 90, strike: { base: 0, speed: 260, per: 25, cap: 14, eject: 0 },
    flare: { at: 5, cooldown: 6, launch: 3.5, jet: false } },
  rocky: { grip: 180, softening: 1, restitution: .45, accretes: [], horizon: 0, horizonDrag: 0, atmosphere: 0, drag: 0, radiation: 0, radiationReach: 0,
    shatters: true, shatterSpeed: 90, strike: { base: 0, speed: 260, per: 25, cap: 14, eject: 0 }, flare: null },
  moon: { grip: 100, softening: 1, restitution: .45, accretes: [], horizon: 0, horizonDrag: 0, atmosphere: 0, drag: 0, radiation: 0, radiationReach: 0,
    shatters: true, shatterSpeed: 90, strike: { base: 0, speed: 260, per: 25, cap: 14, eject: 0 }, flare: null },
});

/**
 * Body presets: gravitational parameter (acceleration at distance d is mass / (d^2 + (softening * core)^2)) and core.
 * Every mass carries MASS_SCALE: scaling all of them alike keeps each orbit's shape and stability and makes everything
 * move faster (by its square root), so the system is quicker and its slingshots harder without being retuned.
 */
const MASS_SCALE = 1.6;
const bodyPreset = (kind, mass, core) => ({ kind, mass: mass * MASS_SCALE, core });
const BODY = {
  star: bodyPreset('star', 3.2e8, 380),
  twin: bodyPreset('star', 1.6e8, 300),
  dwarfStar: bodyPreset('star', 6e7, 200),
  hole: bodyPreset('black-hole', 4e8, 70),
  giant: bodyPreset('giant', 3e7, 170),
  rocky: bodyPreset('rocky', 8e6, 90),
  small: bodyPreset('rocky', 1.2e6, 55),
  moon: bodyPreset('moon', 4e5, 32),
};

/**
 * System archetypes, keyed by layout name: the primaries at the centre (one, or a pair `separation` apart orbiting each
 * other), where the first planet orbits, and for the black hole a `companion`: a dwarf star that takes the outermost
 * planet's place, with a world of its own. Everything else is generated from the seed (GENERATOR, buildSystem).
 */
const ARCHETYPES = {
  'lone-star': { primaries: [BODY.star], separation: 0, first: 2600, companion: null, organics: true },
  binary: { primaries: [BODY.twin, BODY.twin], separation: 2000, first: 5200, companion: null, organics: true },
  'black-hole': { primaries: [BODY.hole], separation: 0, first: 2800, companion: BODY.dwarfStar, organics: false },
};
/** The archetype each shipped encounter plays in: the three in turn, once per form. */
const LAYOUTS = { 'long-wake': 'lone-star', 'open-face': 'binary', 'borrowed-orbit': 'black-hole',
  'crossed-intentions': 'lone-star', 'wake-thieves': 'binary', 'last-reserve': 'black-hole' };

/**
 * How a system is generated. Planets orbit out to `edge`, each a drawn `spacing` ratio beyond the last and `giantSpacing`
 * more around a giant, so neighbours stay outside each other's reach; what each is depends on how far out it is
 * (`bands`: the chance of a giant and of a small world; the rest are rocky), and no two giants are neighbours. Moons
 * (`moons`: drawn counts by kind) orbit at `moonOrbits` of their planet's Hill radius, where the primaries cannot strip
 * them. `dwarfs` (a drawn count) of dwarf planets orbit between `dwarfOrbits`, beyond the planets. Up to `belts` asteroid belts lie in the widest gaps between planets that are not giants. A rogue world falls
 * through `rogue` of the systems from `rogueFrom` out, on a fly-by. The Kuiper belt is a ring from `kuiper.inner` to
 * `kuiper.outer`, holding the matter the visiting comets are made of.
 */
const GENERATOR = {
  edge: 14000, spacing: [1.3, 1.5], giantSpacing: 1.55,
  bands: [{ until: 4500, giant: 0, small: .3 }, { until: 9500, giant: .55, small: .15 }, { until: Infinity, giant: .35, small: .35 }],
  moons: { giant: [1, 3], rocky: [0, 1], small: [0, 1] }, moonOrbits: [.2, .32, .46],
  dwarfs: [2, 4], dwarfOrbits: [14000, 16200], belts: 2, rogue: .5, rogueFrom: 22000, rogueSpeed: 1.12, clear: 700, hillClear: 1.6,
  kuiper: { inner: 14600, outer: 16800, reserve: 160 },
};

export const FIELDS = deepFreeze({
  classic: { id: 'classic', name: 'Classic arena', arena: ARENA, bounded: true, physics: null, systems: null },
  deep: {
    id: 'deep', name: 'Deep field',
    // A frame for the field map. Nothing is confined to it: the tide beyond `halo.radius` is the only edge.
    arena: { width: 36000, height: 36000, insets: ARENA.insets },
    centre: { x: 18000, y: 18000 },
    bounded: false,
    gateRadius: 80,
    durationScale: 3,                  // survival timers run longer in a space this large
    oreScale: 7,                       // seven times the ore, in the asteroid belts
    physics: {
      thrust: 1.1,                     // full thrust: form.speed * thrust / sqrt(relative mass)
      spool: .45,                      // seconds for the engine to reach about two thirds of full thrust, or fall back
      turnRate: 2.4,                   // the ship's heading turns toward the input at most this fast (radians per second)
      exhaust: 3.2,                    // thrust fades to nothing at form.speed * exhaust along the heading
      drag: 0,                         // none: orbits hold, and only thrust, atmospheres and impacts change momentum
      // The ship's drive grows with its form's size, (form radius / massReference) ^ driveExponent, and a Warden's held
      // moons add to it, so escaping a body is progression: against BODY_KINDS grip, a dwarf planet (drive 1) leaves rocky
      // bodies and giants but not a star, a planet (1.6) leaves a star but not a black hole, and a gas giant (2.55) leaves
      // anything. A Harvester's burst out-pushes every grip.
      driveExponent: 2.4, companionDrive: .06,
      enemyPull: .6,                   // no body pulls an enemy harder than this share of the enemy's thrust
      speedCap: 2600,
      substep: 1 / 240,                // the deep field steps at most this long at a time, so fast bodies cannot pass through each other
      safetyGravity: 2600,             // no body's pull exceeds this, however close
      halo: { radius: 17500, pull: .035 },  // beyond the radius, a pull toward the centre of `pull` per unit
      massReference: 23, playerMass: 30,
      // No health: every solid body is its mass. The player starts with `start` (scaled by form: referenceMass) and is
      // broken apart below `core` of its form's reference mass (coreMass).
      player: { start: 50, core: .25, hull: 1.2, nimble: 1.4, burdened: .7 },
      cometSolid: .5,                  // the share of each packet the comet sheds as a solid chunk (a meteor stream)
      // Impacts between solid bodies (src/sim/simulation.js collideSolids): above `threshold` closing speed, the impact
      // energy E = mu (v^2 - threshold^2) / 2 breaks mass off both bodies, each its share (the other's mass fraction) of E
      // over `binding` times its toughness (each body's share is the other's mass fraction). The heavier body sweeps up `sweep` of what the lighter loses; a loss of at
      // least `chunk` throws a solid chunk of `chunkShare` of it as ore, and the rest scatters as matter at up to `kick`
      // of the closing speed, loose for `loose` seconds (nothing collects or draws it in until it has flown clear). Bodies
      // rebound with `restitution`. No single loss takes more than `most` of the player's mass, so a ship at full mass
      // survives any one hit.
      // What a shear field grinds off is thrown out at `speed` (as an impact's closing speed) and stays loose `loose`
      // seconds, so it flies beyond the ship's draw before anything can collect it.
      shearThrow: { speed: 600, loose: 3 },
      impact: { threshold: 90, binding: 24000, sweep: .3, chunk: 8, chunkShare: .4, kick: .3, restitution: .35, interval: .35, dazed: .6, ore: .5, loose: 1, most: .7 },
      oreRestitution: .6, impactInterval: .5, oreImpactSpeed: 120, oreImpactScale: 260,
      knockback: 550,                  // settled loss times this over the enemy's mass, capped at 420 units/s
      enemy: { thrust: 300, engage: 1600, recoverDamping: .3, lead: 1, commitScale: 1.3, growth: 1.5, adapt: .05 },  // growth: an enemy accretes up to this times its starting mass; adapt: its starting mass grows by this share per trait the player has taken
      sensor: 3400,                    // what the field map and edge markers show beyond the view
      // Visitors (src/sim/simulation.js visitors): comets fall in from the Kuiper belt, made of its matter, every
      // `every` seconds (drawn), at a drawn speed, aimed at a point of the inner system or, one time in `atPlayer`, at the
      // ship; brittle (`toughness`), so a heavy, coherent ship that meets one sweeps up `sweep` of what breaks off it.
      // Each star throws out a solar storm every `every` seconds (drawn), warning for `warn` seconds first.
      comets: { every: [35, 65], speed: [850, 1300], mass: [18, 50], toughness: .35, sweep: .7, atPlayer: 3, aim: 6500 },
      solarStorms: { every: [28, 50], warn: 3, speed: 650, life: 16, r0: 350, grow: 150 },
      wellImpact: { enemy: { speed: 160, per: 9, cap: 40 }, ore: { speed: 140, per: 12, cap: 30 } },
      pickup: { drag: .12, reach: 140, capture: 2.5 },
      buoyRestitution: .6,             // gates, unclaimed moons and the comet against a solid body
      debrisSpeed: 70,                 // fragments fly apart at up to this, on top of their source's motion
    },
    systems: { archetypes: ARCHETYPES, layouts: LAYOUTS, fallback: 'lone-star', generator: GENERATOR },
  },
});

/** The field descriptor of world `w` (classic when it names none). */
export const fieldOf = w => FIELDS[w?.field] ?? FIELDS.classic;
/** True when `w` plays in a field with momentum physics. */
export const deep = w => !!fieldOf(w).physics;
/** Refuses a field id that is not one of FIELD_IDS. */
export function resolveField(id) {
  if (!Object.hasOwn(FIELDS, id)) throw new RangeError(`Unknown field ${JSON.stringify(id)}: one of ${FIELD_IDS.join(', ')}`);
  return FIELDS[id];
}

/** The player's relative mass in `w`'s field: 1 at the reference radius, growing with radius squared. */
export const relativeMass = (w, p) => (p.radius / fieldOf(w).physics.massReference) ** 2;
/** The player's momentum mass, against ore and enemy masses. */
export const playerMass = (w, p) => p.mass ?? fieldOf(w).physics.playerMass * relativeMass(w, p);

/**
 * The mass an impact breaks off two solid bodies of masses `ma` and `mb` (Infinity for a body that cannot be moved or
 * broken, such as a Warden's moon) and toughnesses `ta` and `tb`, closing at `vn`: [loss of a, loss of b], whole units.
 * Below the field's threshold an impact breaks nothing. Each body's share of the energy is the other's mass fraction,
 * so the lighter body loses the more.
 */
export function impactLoss(w, ma, mb, ta, tb, vn) {
  const { threshold, binding } = fieldOf(w).physics.impact;
  if (!(vn > threshold)) return [0, 0];
  const fixedA = !Number.isFinite(ma), fixedB = !Number.isFinite(mb);
  const mu = fixedA ? mb : fixedB ? ma : ma * mb / (ma + mb), energy = mu * (vn * vn - threshold * threshold) / 2;
  const shareA = fixedB ? 1 : fixedA ? 0 : mb / (ma + mb), shareB = 1 - shareA;
  const loss = (share, t, m) => Number.isFinite(t) && Number.isFinite(m) ? Math.floor(energy * share / (binding * t)) : 0;
  return [loss(shareA, ta, ma), loss(shareB, tb, mb)];
}
/** A body's behaviour entry. */
export const bodyKind = well => BODY_KINDS[well.kind];
const soft = well => well.core * BODY_KINDS[well.kind].softening;
/** The softening two bodies share, so the pull each has on the other is equal and opposite and momentum is conserved. */
const pairSoft = (a, b) => Math.sqrt((soft(a) ** 2 + soft(b) ** 2) / 2);

/** The pull of one body at (x, y), toward its centre: mass / (d^2 + soft^2), at most the safety cap or `cap`. */
export function wellAcceleration(w, well, x, y, cap = Infinity) {
  const dx = well.x - x, dy = well.y - y, d2 = dx * dx + dy * dy, d = Math.sqrt(d2);
  if (d < 1e-9) return { x: 0, y: 0 };
  const s = soft(well), a = Math.min(fieldOf(w).physics.safetyGravity, cap, well.mass / (d2 + s * s));
  return { x: dx / d * a, y: dy / d * a };
}

/** The tide beyond the system's reach at (x, y): toward the centre, growing with the distance past the halo radius. */
export function haloAcceleration(w, x, y) {
  const field = fieldOf(w), { radius, pull } = field.physics.halo, dx = field.centre.x - x, dy = field.centre.y - y, d = Math.hypot(dx, dy);
  if (d <= radius) return { x: 0, y: 0 };
  const a = (d - radius) * pull;
  return { x: dx / d * a, y: dy / d * a };
}

/**
 * Every body's pull plus the tide at `b`; zero in a classic field. `wells` defaults to the world's; `cap` limits each
 * body's pull: a number, or a function of the body.
 */
export function gravity(w, b, wells = w.wells, cap = Infinity) {
  if (!deep(w)) return { x: 0, y: 0 };
  const h = haloAcceleration(w, b.x, b.y);
  let x = h.x, y = h.y;
  for (const well of wells) { const a = wellAcceleration(w, well, b.x, b.y, typeof cap === 'function' ? cap(well, b) : cap); x += a.x; y += a.y; }
  return { x, y };
}

/**
 * The motion a body at `b` is moving relative to: the body whose (uncapped) pull there is strongest, so speed limits
 * read against what the ship is near (a fast-orbiting planet it sits on, the star across empty space), never against
 * the system's fixed frame. At rest when there are no bodies.
 */
export function localFrame(w, b, wells = w.wells) {
  let best = null, pull = 0;
  for (const well of wells) {
    if (well.alive === false) continue;
    const a = Math.hypot(...Object.values(wellAcceleration(w, well, b.x, b.y)));
    if (a > pull) { pull = a; best = well; }
  }
  return best ? { vx: best.vx, vy: best.vy } : { vx: 0, vy: 0 };
}

/** The player's drive multiplier: its form's, from the form's size, raised by each companion it holds. */
export function drive(w, p, form = formOf(w)) {
  const physics = fieldOf(w).physics;
  return (form.radius / physics.massReference) ** physics.driveExponent * (1 + physics.companionDrive * (p.companions?.length ?? 0));
}

/** The mass a form's ship is built at: the field's starting mass, scaled with the form's size as its relative mass is. */
export function referenceMass(w, form = formOf(w)) {
  const physics = fieldOf(w).physics;
  return Math.round(physics.player.start * (form.radius / physics.massReference) ** 2);
}

/**
 * The mass below which the player's ship is broken apart: the field's core share of its form's reference mass, scaled
 * by the player's `core` modifier (a dense, cohesive body holds together longer).
 */
export const coreMass = (w, form = formOf(w)) => Math.round(fieldOf(w).physics.player.core * referenceMass(w, form) * (w.player?.mods?.core ?? 1));

/**
 * F = ma: thrust is a force, so a ship heavier than its form's reference mass accelerates less, by the square root of
 * the ratio, never below the field's `burdened` (hoarding makes a ship sluggish, never helpless), and a lighter one
 * more, at most `nimble`. 1 for a body that carries no mass (a prediction).
 */
export function load(w, p, form = formOf(w)) {
  if (p.mass === undefined) return 1;
  const { nimble, burdened } = fieldOf(w).physics.player;
  return Math.max(burdened, Math.min(nimble, Math.sqrt(referenceMass(w, form) / Math.max(1, p.mass))));
}

/** The player's full thrust in its current form and mass, before the throttle, alignment and exhaust fade. */
export const fullThrust = (w, p, form = formOf(w)) => form.speed * fieldOf(w).physics.thrust / Math.sqrt(relativeMass(w, p)) * drive(w, p, form) * load(w, p, form) * (p.mods?.thrust ?? 1);

/**
 * The pull the player's ship feels: every body's, each at most its kind's grip. Far from a body nothing changes; close
 * in, whether a burn climbs away depends on the ship's drive against that grip. Matter, ore, gates and the comet feel
 * the full pull. `form` is accepted for the call sites' symmetry and does not change the pull.
 */
export const playerGravity = (w, p, wells = w.wells) => gravity(w, p, wells, (well, b) => inHorizon(well, b) ? Infinity : BODY_KINDS[well.kind].grip);
/**
 * The pull an enemy feels: each body's at most `enemyPull` of an enemy's thrust, so no opponent is stranded on a body
 * outside its horizon; inside, the full pull.
 */
export const enemyGravity = (w, e) => { const physics = fieldOf(w).physics; return gravity(w, e, w.wells, (well, b) => inHorizon(well, b) ? Infinity : physics.enemyPull * physics.enemy.thrust); };

/** The radius of `well`'s event horizon (0 for a body with none). */
export const horizonRadius = well => BODY_KINDS[well.kind].horizon * well.core;
/** Whether body `b` is inside `well`'s event horizon. */
export const inHorizon = (well, b) => BODY_KINDS[well.kind].horizon > 0 && Math.hypot(b.x - well.x, b.y - well.y) < horizonRadius(well);

/**
 * Event horizons: a body `b` inside one loses every outward part of its motion relative to the body, and its motion
 * across bleeds away at the body's `horizonDrag`, so it spirals in; nothing escapes. `from` is where `b` stood before
 * the motion just resolved (its thrust, a burst or a collision's push): a body that started inside a horizon and ended
 * farther out is put back at the distance it started from, so nothing within a step carries it out either. Returns the
 * body whose horizon holds `b`, or null.
 */
export function holdInHorizon(wells, b, dt, from = null) {
  for (const well of wells) {
    const was = from && BODY_KINDS[well.kind].horizon > 0 ? Math.hypot(from.x - well.x, from.y - well.y) : Infinity;
    if (!inHorizon(well, b) && !(was < horizonRadius(well))) continue;
    let dx = b.x - well.x, dy = b.y - well.y, d = Math.hypot(dx, dy) || 1;
    if (d > was) { b.x = well.x + dx / d * was; b.y = well.y + dy / d * was; dx = b.x - well.x; dy = b.y - well.y; d = was || 1; }
    const nx = dx / d, ny = dy / d;
    let rx = b.vx - well.vx, ry = b.vy - well.vy;
    const out = rx * nx + ry * ny;
    if (out > 0) { rx -= out * nx; ry -= out * ny; }
    const radial = rx * nx + ry * ny, k = Math.exp(-BODY_KINDS[well.kind].horizonDrag * dt);
    const tx = (rx - radial * nx) * k, ty = (ry - radial * ny) * k;
    b.vx = well.vx + radial * nx + tx; b.vy = well.vy + radial * ny + ty;
    return well;
  }
  return null;
}

/**
 * The point of no return about `well` for a ship of full thrust `thrust`: the distance within which the body pulls
 * harder than the ship can push, so a ship there cannot climb straight out; 0 when the ship out-pushes its grip.
 */
export function escapeRadius(w, well, thrust) {
  return BODY_KINDS[well.kind].grip > thrust ? influenceRadius(w, well, thrust) : 0;
}

/** Stars' radiation on matter at `b`: outward, a fraction of each star's pull within its reach. */
export function radiation(w, b, wells = w.wells) {
  let x = 0, y = 0;
  for (const well of wells) {
    const kind = BODY_KINDS[well.kind];
    if (!kind.radiation || Math.hypot(b.x - well.x, b.y - well.y) > kind.radiationReach * well.core) continue;
    const a = wellAcceleration(w, well, b.x, b.y); x -= a.x * kind.radiation; y -= a.y * kind.radiation;
  }
  return { x, y };
}

/** Atmospheric drag on `b`: relative to each gas giant whose atmosphere it is inside. Changes `b`'s velocity. */
export function aerobrake(wells, b, dt) {
  for (const well of wells) {
    const kind = BODY_KINDS[well.kind];
    if (!kind.atmosphere || Math.hypot(b.x - well.x, b.y - well.y) > kind.atmosphere * well.core + (b.radius ?? 0)) continue;
    const k = 1 - Math.exp(-kind.drag * dt);
    b.vx -= (b.vx - well.vx) * k; b.vy -= (b.vy - well.vy) * k;
  }
}

/**
 * Matter of `value` that `well` swallows: counted as accreted and held by the body until it flares (BODY_KINDS flare).
 * `shed` marks matter the player lost: the body keeps that share apart (`heldShed`) and flares it back out as shed, so
 * crashing into a body and taking its flare back never turns the player's own mass into growth.
 */
export function holdAccreted(w, well, value, shed = false) {
  w.stats.accreted += value; well.held = (well.held ?? 0) + value;
  if (shed) well.heldShed = (well.heldShed ?? 0) + value;
}

/** Caps a body's speed at the field's hard cap. */
export function capSpeed(w, b) {
  const cap = fieldOf(w).physics.speedCap, s = Math.hypot(b.vx, b.vy);
  if (s > cap) { b.vx *= cap / s; b.vy *= cap / s; }
}

/**
 * Advances the bodies one step: each feels every other body's pull, softened by the pair (pairSoft, so the forces are
 * equal and opposite), and the tide (semi-implicit Euler, so orbits stay closed), then moves. Bodies whose cores meet merge into the more massive one, keeping its id and kind, with the
 * summed mass and momentum and a core of the summed volume (a black hole's horizon grows with its mass instead).
 * Returns the merges, as [{ into, absorbed }] ids. `wells` defaults to the world's, which it replaces after merges.
 */
export function stepWells(w, dt, wells = w.wells) {
  const n = wells.length, ax = new Array(n).fill(0), ay = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const h = haloAcceleration(w, wells[i].x, wells[i].y); ax[i] += h.x; ay[i] += h.y;
    for (let j = 0; j < n; j++) {
      if (i === j || !wells[j].alive) continue;
      const a = wells[i], b = wells[j], dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy, d = Math.sqrt(d2);
      if (d < 1e-9) continue;
      const s = pairSoft(a, b), pull = Math.min(fieldOf(w).physics.safetyGravity, b.mass / (d2 + s * s));
      ax[i] += dx / d * pull; ay[i] += dy / d * pull;
    }
  }
  for (let i = 0; i < n; i++) { const k = wells[i]; k.vx += ax[i] * dt; k.vy += ay[i] * dt; k.x += k.vx * dt; k.y += k.vy * dt; }
  const merges = [];
  for (let i = 0; i < wells.length; i++) for (let j = i + 1; j < wells.length; j++) {
    const a = wells[i], b = wells[j];
    if (!a.alive || !b.alive || Math.hypot(a.x - b.x, a.y - b.y) > a.core + b.core) continue;
    const [into, absorbed] = a.mass >= b.mass ? [a, b] : [b, a], mass = into.mass + absorbed.mass;
    into.x = (into.x * into.mass + absorbed.x * absorbed.mass) / mass; into.y = (into.y * into.mass + absorbed.y * absorbed.mass) / mass;
    into.vx = (into.vx * into.mass + absorbed.vx * absorbed.mass) / mass; into.vy = (into.vy * into.mass + absorbed.vy * absorbed.mass) / mass;
    into.core = into.kind === 'black-hole' ? into.core * mass / into.mass : Math.cbrt(into.core ** 3 + absorbed.core ** 3);
    into.mass = mass; into.held = (into.held ?? 0) + (absorbed.held ?? 0); absorbed.held = 0; absorbed.alive = false;
    if (absorbed.heldShed) { into.heldShed = (into.heldShed ?? 0) + absorbed.heldShed; absorbed.heldShed = 0; }
    merges.push({ into: into.id, absorbed: absorbed.id });
  }
  if (merges.length && wells === w.wells) w.wells = wells.filter(k => k.alive);
  return merges;
}

/**
 * Ship controls for the player. The heading turns toward the input direction at the field's turn rate; the throttle
 * spools toward full while there is input and back toward idle without it; thrust pushes along the heading, scaled by
 * how well the heading points where the input asks (so a ship facing away turns before it pushes) and fading as the
 * speed along the heading, relative to the dominant nearby body (localFrame), nears the form's exhaust speed. Gravity, the current and a trace of drag add. `scale` is
 * the thrust multiplier (0.72 while recovering).
 */
export function thrustPlayer(w, p, m, form, scale, flow, dt) {
  const physics = fieldOf(w).physics, g = playerGravity(w, p, w.wells, form), want = m.x || m.y ? Math.atan2(m.y, m.x) : null;
  const turn = physics.turnRate * (p.mods?.turn ?? 1);
  if (want !== null) p.heading += clamp(angleDelta(want, p.heading), -turn * dt, turn * dt);
  p.throttle += ((want !== null ? 1 : 0) - p.throttle) * (1 - Math.exp(-dt / physics.spool));
  const hx = Math.cos(p.heading), hy = Math.sin(p.heading), aligned = want === null ? 0 : Math.max(0, Math.cos(angleDelta(want, p.heading)));
  const thrust = fullThrust(w, p, form) * scale * p.throttle * aligned;
  const frame = localFrame(w, p), fade = clamp(1 - ((p.vx - frame.vx) * hx + (p.vy - frame.vy) * hy) / (form.speed * physics.exhaust), 0, 1);
  const ax = hx * thrust * fade + g.x + flow.x - p.vx * physics.drag, ay = hy * thrust * fade + g.y + flow.y - p.vy * physics.drag;
  p.vx += ax * dt; p.vy += ay * dt;
  aerobrake(w.wells, p, dt);
  capSpeed(w, p);
  return { x: ax, y: ay };
}

/**
 * Keeps body `b` (radius `b.radius`) out of one solid core: a body inside it moves to its surface and the part of its
 * velocity into the core, relative to the body's own motion, reflects with `restitution`; `eject` sets a minimum
 * outward speed. Returns the closing speed at the surface (0 when it was not closing), or -1 when it was clear.
 */
export function collideWell(well, b, restitution, eject = 0) {
  const dx = b.x - well.x, dy = b.y - well.y, d = Math.hypot(dx, dy), reach = well.core + (b.radius ?? 0);
  if (d >= reach) return -1;
  const nx = d > 1e-9 ? dx / d : 1, ny = d > 1e-9 ? dy / d : 0;
  b.x = well.x + nx * reach; b.y = well.y + ny * reach;
  const vn = (b.vx - well.vx) * nx + (b.vy - well.vy) * ny;
  if (vn < 0) { b.vx -= (1 + restitution) * vn * nx; b.vy -= (1 + restitution) * vn * ny; }
  const out = (b.vx - well.vx) * nx + (b.vy - well.vy) * ny;
  if (out < eject) { b.vx += (eject - out) * nx; b.vy += (eject - out) * ny; }
  return vn < 0 ? -vn : 0;
}

/** Whether body `b` touches any core: the first well it does, or null. */
export const touching = (wells, b) => wells.find(k => Math.hypot(b.x - k.x, b.y - k.y) <= k.core + (b.radius ?? 0)) ?? null;

/**
 * Contact with cores, through the world's ContactEpisodes. Every step each (body, well) pair's surface gap is tracked
 * on the persistent `impact` channel. A body of class `role` (player, enemy or ore) that a well accretes is passed to
 * `swallow(well)`; any other inside a core collides with the well kind's restitution and ejection, and
 * `settle(well, speed)` decides the strike, returning true when it settled damage. That consumes the pair's settlement:
 * another needs the impact interval and a separation beyond the hysteresis. A strike that settles nothing consumes
 * nothing.
 */
export function strikeWells(w, b, role, settle, swallow = () => {}) {
  const contacts = w._contacts, window = { now: w.time, interval: fieldOf(w).physics.impactInterval, separation: true };
  for (const well of w.wells) {
    const gap = Math.hypot(b.x - well.x, b.y - well.y) - well.core - b.radius, kind = BODY_KINDS[well.kind];
    contacts.track(b, well, 'impact', gap, w.time);
    if (gap >= 0) continue;
    if (kind.accretes.includes(role)) { swallow(well); return; }
    const speed = collideWell(well, b, kind.restitution, role === 'player' ? kind.strike.eject : 0), rule = kind.strike.burns ? { ...window, separation: false } : window;
    if (contacts.eligible(b, well, 'impact', rule) && settle(well, speed)) contacts.enter(b, well, 'impact', rule);
    if (b.alive === false) return;
  }
}

/**
 * The damage a strike at `speed` on `well` requests from the player; 0 when the body's rule leaves it harmless. The
 * player's traits scale it: a burning body's by `heat`, any other's by the inverse of `toughness`.
 */
export function playerStrikeDamage(w, well, speed) {
  const s = BODY_KINDS[well.kind].strike, over = speed > s.speed ? Math.ceil((speed - s.speed) / s.per) : 0;
  const requested = Math.min(s.cap, s.base + over), mods = w.player?.mods;
  if (!requested || !mods) return requested;
  return Math.max(1, Math.ceil(requested * (s.burns ? mods.heat : 1 / mods.toughness)));
}

/** The damage a strike at `speed` requests from an enemy or ore; 0 below threshold. */
export function wellImpactDamage(w, role, speed) {
  const rule = fieldOf(w).physics.wellImpact[role];
  return speed > rule.speed ? Math.min(rule.cap, Math.ceil((speed - rule.speed) / rule.per)) : 0;
}

/** Moves body `b` radially out of any core it sits within `margin` of (layout placement only, never a step). */
export function clearOfWells(w, b, margin = 60) {
  for (const well of w.wells) {
    const dx = b.x - well.x, dy = b.y - well.y, d = Math.hypot(dx, dy), reach = well.core + (b.radius ?? 0) + margin;
    if (d >= reach) continue;
    const nx = d > 1e-9 ? dx / d : 1, ny = d > 1e-9 ? dy / d : 0;
    b.x = well.x + nx * reach; b.y = well.y + ny * reach;
  }
}

/**
 * A mass-weighted collision between bodies a and b with masses ma and mb: positions separate along the centre line
 * in inverse proportion to mass, and the approaching part of the relative normal velocity exchanges with
 * `restitution`. Returns the closing speed before the exchange (0 when they were separating or not touching).
 */
export function collideBodies(a, ma, b, mb, restitution) {
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), reach = a.radius + b.radius;
  if (d >= reach) return 0;
  const nx = d > 1e-9 ? dx / d : 1, ny = d > 1e-9 ? dy / d : 0, depth = reach - d, total = ma + mb;
  a.x -= nx * depth * mb / total; a.y -= ny * depth * mb / total;
  b.x += nx * depth * ma / total; b.y += ny * depth * ma / total;
  const closing = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
  if (closing <= 0) return 0;
  const j = (1 + restitution) * closing / (1 / ma + 1 / mb);
  a.vx -= j / ma * nx; a.vy -= j / ma * ny; b.vx += j / mb * nx; b.vy += j / mb * ny;
  return closing;
}

/** The circular orbit about a host of `mass` (softening `s`) at (cx, cy) moving with (hvx, hvy): position and velocity. */
function orbit(cx, cy, hvx, hvy, mass, s, radius, angle, direction = 1) {
  const v = Math.sqrt(mass * radius / (radius * radius + s * s)) * direction;
  return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius, vx: hvx - Math.sin(angle) * v, vy: hvy + Math.cos(angle) * v };
}

/**
 * Builds `w`'s star system from its archetype (ARCHETYPES) and integer draws `pick(n)` in [0, n), by the GENERATOR's
 * rules: the bodies (as `w.wells`) and the places everything else starts, each an orbit `{ x, y, vx, vy }`: `player`,
 * `pockets` (five), `enemies` (one per slot of `slots`), `rocks` (`ore` of them, in the belts, on slightly eccentric
 * orbits), `gates` (three), `candidates` (two, co-orbiting the player), `comet` (falling inward from aphelion) and
 * `regions` (src/sim/regions.js: clouds, storms, fields, nebulae and cold reaches on orbits, the Kuiper ring, swarms
 * at each giant's Lagrange points, and every body's halo and zones). Classic fields have no system and draw nothing.
 */
export function buildSystem(w, pick, { slots = 0, ore = 0 } = {}) {
  const field = fieldOf(w);
  if (!field.systems) { w.wells = []; return null; }
  const { archetypes, layouts, fallback, generator: g } = field.systems, id = encounterOf(w)?.id;
  const t = archetypes[Object.hasOwn(layouts, id) ? layouts[id] : fallback], { x: cx, y: cy } = field.centre;
  const angle = () => pick(3600) / 3600 * TAU, jitter = n => (pick(2001) - 1000) / 1000 * n, chance = p => pick(1000) < p * 1000;
  const between = ([lo, hi]) => lo + pick(1001) / 1000 * (hi - lo), count = ([lo, hi]) => lo + pick(hi - lo + 1);
  const wells = [];
  let serial = 0;
  const body = (preset, place) => { const k = { id: `well-${w.encounterIndex}-${serial++}`, generation: 1, alive: true, kind: preset.kind, mass: preset.mass, core: preset.core, held: 0, flareCooldown: 0, ...place }; wells.push(k); return k; };
  // Primaries: one at the centre, or a pair orbiting each other.
  const centralMass = t.primaries.reduce((n, b) => n + b.mass, 0), centralSoft = t.primaries[0].core * BODY_KINDS[t.primaries[0].kind].softening;
  const presetSoft = b => b.core * BODY_KINDS[b.kind].softening, pairOf = (a, b) => Math.sqrt((presetSoft(a) ** 2 + presetSoft(b) ** 2) / 2);
  if (t.primaries.length === 1) body(t.primaries[0], { x: cx, y: cy, vx: 0, vy: 0 });
  else {
    const a0 = angle(), half = t.separation / 2, [p, q] = t.primaries;
    const pull = q.mass / (t.separation ** 2 + pairOf(p, q) ** 2), v = Math.sqrt(pull * half);
    body(p, { x: cx + Math.cos(a0) * half, y: cy + Math.sin(a0) * half, vx: -Math.sin(a0) * v, vy: Math.cos(a0) * v });
    body(q, { x: cx - Math.cos(a0) * half, y: cy - Math.sin(a0) * half, vx: Math.sin(a0) * v, vy: -Math.cos(a0) * v });
  }
  // Planet orbits: each a drawn ratio beyond the last, wider around giants; what each is depends on its band.
  const orbits = [];
  for (let r = t.first, giantBefore = false; r <= g.edge;) {
    const band = g.bands.find(b => r < b.until), roll = pick(1000) / 1000;
    let preset = roll < band.small ? BODY.small : !giantBefore && roll > 1 - band.giant ? BODY.giant : BODY.rocky;
    if (preset === BODY.giant) { if (orbits.length && r * g.giantSpacing <= g.edge) r *= g.giantSpacing; else preset = BODY.rocky; }
    orbits.push({ preset, radius: r });
    giantBefore = preset === BODY.giant;
    r *= between(g.spacing) * (giantBefore ? g.giantSpacing : 1);
  }
  // A black hole's companion star takes the outermost planet's place, a giant's room beyond the planets inside it, so
  // the inner system keeps its worlds and the ship a gap to start in.
  if (t.companion && orbits.length > 2) Object.assign(orbits.at(-1), { preset: t.companion, radius: orbits.at(-2).radius * g.giantSpacing ** 2 });
  // Planets start a golden angle apart, so no two begin inside each other's reach; moons orbit inside their Hill radius.
  const planets = [], base = angle(), giants = [];
  for (const [i, slot] of orbits.entries()) {
    const a = base + i * 2.39996 + jitter(.25);
    const home = body(slot.preset, orbit(cx, cy, 0, 0, centralMass, pairOf(t.primaries[0], slot.preset), slot.radius, a));
    planets.push(home);
    if (slot.preset === BODY.giant) giants.push({ radius: slot.radius, angle: a });
    const hill = slot.hill = slot.radius * Math.cbrt(slot.preset.mass / (3 * centralMass));
    const moons = slot.preset === t.companion ? 1 : count(g.moons[slot.preset === BODY.giant ? 'giant' : slot.preset === BODY.small ? 'small' : 'rocky']);
    for (let m = 0; m < moons; m++) {
      const moon = slot.preset === t.companion ? BODY.rocky : BODY.moon;
      // A moon forms only where its orbit has room inside the Hill sphere, clear of its planet's surface.
      const radius = hill * g.moonOrbits[m];
      if (radius < slot.preset.core * 2.2 + moon.core) continue;
      body(moon, orbit(home.x, home.y, home.vx, home.vy, home.mass, pairOf(slot.preset, moon), radius, angle()));
    }
  }
  // Dwarf planets in the outer reaches, among the Kuiper belt's inner edge.
  for (let i = 0, n = count(g.dwarfs); i < n; i++) body(BODY.small, orbit(cx, cy, 0, 0, centralMass, pairOf(t.primaries[0], BODY.small), between(g.dwarfOrbits), angle()));
  // The barycentre frame: every body's momentum sums to zero and its centre of mass sits at the field's centre, so the
  // primaries do not recoil off across the field from the planets they hold. Everything placed below moves with it.
  const total = wells.reduce((n, k) => n + k.mass, 0), sum = f => wells.reduce((n, k) => n + k[f] * k.mass, 0) / total;
  const shift = { x: cx - sum('x'), y: cy - sum('y'), vx: -sum('vx'), vy: -sum('vy') };
  for (const k of wells) { k.x += shift.x; k.y += shift.y; k.vx += shift.vx; k.vy += shift.vy; }
  // A rogue world on a fly-by: outside the barycentre frame, falling in from far beyond the tide just faster than escape,
  // aimed to pass through the planets' orbits.
  if (chance(g.rogue)) {
    const from = angle(), miss = between([.4, .8]) * g.edge * (chance(.5) ? 1 : -1), r0 = g.rogueFrom;
    const sx = cx + Math.cos(from) * r0, sy = cy + Math.sin(from) * r0, ax = cx - Math.sin(from) * miss, ay = cy + Math.cos(from) * miss;
    const d = Math.hypot(ax - sx, ay - sy), speed = Math.sqrt(2 * centralMass / r0) * g.rogueSpeed;
    body(chance(.3) ? BODY.giant : BODY.rocky, { x: sx, y: sy, vx: (ax - sx) / d * speed, vy: (ay - sy) / d * speed, rogue: true });
  }
  w.wells = wells;
  // Orbits about the primaries, where the barycentre frame put them and moving as they move, so a start, a belt or a gate
  // placed on a circular orbit stays on one (the giants pull the primaries well off the field's centre).
  const primaries = wells.slice(0, t.primaries.length), pm = f => primaries.reduce((n, k) => n + k[f] * k.mass, 0) / centralMass;
  const about = (radius, a) => orbit(pm('x'), pm('y'), pm('vx'), pm('vy'), centralMass, centralSoft, radius, a);
  // Homes are already in the barycentre frame.
  const near = (home, distance, a) => orbit(home.x, home.y, home.vx, home.vy, home.mass, soft(home), home.core + distance, a);
  // Belts lie in the widest gaps whose planets are not giants.
  const gaps = orbits.slice(1).map((o, i) => ({ inner: orbits[i], outer: o })).filter(({ inner, outer }) => inner.preset !== BODY.giant && outer.preset !== BODY.giant)
    .sort((a, b) => b.outer.radius / b.inner.radius - a.outer.radius / a.inner.radius).slice(0, g.belts);
  const belts = gaps.map(({ inner, outer }) => Math.sqrt(inner.radius * outer.radius));
  if (!belts.length) belts.push((t.first + orbits[0].radius) / 2 || t.first * .7);
  // The ship starts in a gap between planets whose orbit keeps `hillClear` Hill radii from each neighbour's orbit (so
  // no passing planet captures an idle ship), nearest the second gap, or the gap with the most room when none does; at
  // an angle clear of every body by four cores (or its horizon) and `clear` beyond, never beside a star or in a horizon.
  const mid = i => Math.sqrt(orbits[i].radius * orbits[Math.min(i + 1, orbits.length - 1)].radius);
  const room = i => Math.min(...[orbits[i], orbits[Math.min(i + 1, orbits.length - 1)]].map(o => Math.abs(mid(i) - o.radius) / o.hill));
  const order = orbits.slice(0, -1).map((_, i) => i)
    .sort((a, b) => (room(b) >= g.hillClear) - (room(a) >= g.hillClear) || ((room(a) >= g.hillClear) ? Math.abs(a - 1) - Math.abs(b - 1) : room(b) - room(a)));
  const clearOf = o => wells.every(k => Math.hypot(o.x - k.x, o.y - k.y) > Math.max(4, BODY_KINDS[k.kind].horizon) * k.core + g.clear);
  let startRadius = mid(order[0] ?? 0), start = angle();
  search: for (const i of order) for (let k = 0; k < 8; k++) {
    if (clearOf(about(mid(i), start + k * .79))) { startRadius = mid(i); start += k * .79; break search; }
  }
  const lead = 0.12;
  // Regions on orbits, generated: the belts' clouds, a storm, shear fields, a mire, nebulae, the cold outer reaches,
  // frost, rare organics, and swarms 60 degrees ahead of and behind every giant (its Lagrange points).
  const r = (lo, hi) => between([lo, hi]) * g.edge;
  const nebula = ['silicate', 'ice', ...(t.organics ? ['tholin'] : [])];
  const entries = [
    ...belts.flatMap(b => [{ kind: 'dust', composition: 'silicate', orbit: b, size: 850, speed: 1, reserve: 35 }, { kind: 'dust', composition: 'metallic', orbit: b, size: 600, speed: 1, reserve: 25 }]),
    { kind: 'storm', composition: 'ionised', orbit: r(.3, .6), size: 1000, speed: -1.5, reserve: 35 },
    { kind: 'storm', composition: 'silicate', orbit: r(.25, .5), size: 800, speed: -1.2, reserve: 20 },
    { kind: 'shear', composition: 'inert', orbit: r(.3, .55), size: 520, speed: .7, reserve: 0 },
    { kind: 'shear', composition: 'inert', orbit: r(.55, .8), size: 460, speed: .8, reserve: 0 },
    { kind: 'mire', composition: 'inert', orbit: r(.45, .75), size: 800, speed: .9, reserve: 0 },
    ...[0, 1].map(() => ({ kind: 'nebula', composition: nebula[pick(nebula.length)], orbit: r(.35, .85), size: 2600 + pick(900), speed: .35, reserve: 40 })),
    ...[0, 1].map(() => ({ kind: 'cold', composition: 'frost', orbit: r(.8, 1), size: 1900, speed: .6, reserve: 20 })),
    { kind: 'dust', composition: 'frost', orbit: r(.7, .95), size: 950, speed: 1, reserve: 40 },
    ...(t.organics ? [{ kind: 'dust', composition: 'tholin', orbit: r(.6, .95), size: 500, speed: 1, reserve: 14 }] : []),
    ...giants.flatMap(gi => [-1, 1].map(side => ({ kind: 'dust', composition: pick(2) ? 'silicate' : 'metallic', orbit: gi.radius, size: 650, speed: 1, reserve: 18, phase: gi.angle + side * TAU / 6 }))),
  ];
  return {
    player: about(startRadius, start),
    pockets: Array.from({ length: 5 }, (_, i) => near(planets[i % planets.length], 220 + pick(160), angle())),
    enemies: Array.from({ length: slots }, (_, i) => near(planets[(i + 1) % planets.length], 480 + pick(200), angle())),
    rocks: Array.from({ length: ore }, (_, i) => {
      const belt = belts[i % belts.length], rr = belt + jitter(belt * .06), a = i / ore * TAU * belts.length + jitter(.15), o = about(rr, a), e = 1 + jitter(.12);
      return { ...o, vx: o.vx * e, vy: o.vy * e };
    }),
    gates: [1, 2, 3].map((k, i) => about(orbits[Math.min(k, orbits.length - 1)].radius * 1.12, start + (i + 1) * 1.45 + jitter(.1))),
    candidates: [-1, 1].map(side => about(startRadius + side * 160, start + side * lead)),
    comet: (() => { const o = about(g.edge * .95, angle()); return { ...o, vx: o.vx * .45, vy: o.vy * .45 }; })(),
    regions: [...buildRegions(entries, pick, { centre: field.centre, mass: centralMass, softening: centralSoft, prefix: w.encounterIndex }),
      ringRegion(`kuiper-${w.encounterIndex}`, 'kuiper', 'frost', field.centre, g.kuiper.inner, g.kuiper.outer, g.kuiper.reserve),
      ...wells.map(k => haloFor(k, soft(k))).filter(Boolean), ...wells.flatMap(k => zonesFor(k))],
  };
}

/**
 * Where the player would coast over the next `seconds` with no thrust, sampled every `step` seconds, for the
 * renderer's trajectory guide: the bodies move under each other's pull as they will, and the player feels them, the
 * tide, drag, atmospheres and the regions of space where they will be, stopping at the first core or event horizon it
 * would touch (a horizon is as final as a core). Pure: reads the world, never changes it.
 * Returns { path, struck } with `struck` the well whose core ends the path, or null.
 */
export function predictCoast(w, seconds = 3, step = 1 / 30) {
  if (!deep(w)) return { path: [], struck: null };
  const physics = fieldOf(w).physics, p = w.player, wells = w.wells.map(k => ({ ...k }));
  const b = { x: p.x, y: p.y, vx: p.vx, vy: p.vy, radius: p.radius }, path = [], regions = w.regions ?? [], t0 = w.encounterTime ?? 0;
  for (let t = 0; t < seconds; t += step) {
    stepWells(w, step, wells);
    const g = playerGravity(w, b, wells.filter(k => k.alive));
    b.vx += (g.x - b.vx * physics.drag) * step; b.vy += (g.y - b.vy * physics.drag) * step;
    aerobrake(wells, b, step);
    regionDrift(regions, b, step, r => placeRegion(r, t0 + t + step), p.mods?.drag ?? 1);
    b.x += b.vx * step; b.y += b.vy * step;
    path.push({ x: b.x, y: b.y });
    const struck = touching(wells.filter(k => k.alive), b) ?? wells.find(k => k.alive && inHorizon(k, b));
    if (struck) return { path, struck: w.wells.find(k => k.id === struck.id) ?? struck };
  }
  return { path, struck: null };
}

/** How many bodies pull on (x, y) with at least `threshold` units/s², and the summed pull, for the guide's emphasis. */
export function influence(w, x, y, threshold = 12) {
  let count = 0, total = 0;
  for (const well of w.wells) { const a = Math.hypot(...Object.values(wellAcceleration(w, well, x, y))); total += a; if (a >= threshold) count++; }
  return { count, total };
}

/** The distance from a body's centre at which its pull equals `acceleration` (for the renderer's contours). */
export function influenceRadius(w, well, acceleration) {
  const s = soft(well);
  return Math.sqrt(Math.max(0, well.mass / acceleration - s * s));
}
