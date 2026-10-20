// Identity strategies (docs/specs/M3-data-spine.md, 3a.3): the Warden, the Harvester and Unbound as strategy objects.
// The simulation calls their hooks where it used to branch on an identity's name, at the same points and in the same
// order: setup (the starting mantle), candidates (capture offers at encounter setup), the command, movement while
// bursting, companions (which strike, intercept and collect), contact modifiers (the brace and the harvesting
// impact), environment interactions (ore) and the evolution summary. Predicates are pure: they read their arguments
// and never change the world, draw from a stream or emit. An entry holds gameplay and its name; since 3c-move its
// presentation is keyed by the same id outside the simulation: the look in src/render/looks.js, the HUD copy, preview
// captions and motif in src/app/presentation.js. An identity's other copy (description, tradeoff, successors, beyond
// line and menu card) is in the string table (src/app/strings.js) under `identity.<id>.`, and the simulation emits
// those keys (M3b). Imports only the campaign descriptor and the descriptor helpers.

import { formOf, formPosition } from './campaign.js';
import { deepFreeze as freeze } from './descriptor.js';
const angleDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const normal = (x, y) => { const d = Math.hypot(x, y) || 1; return { x: x / d, y: y / d }; };

/** A Warden companion (mantle member or capture candidate) of `role`, owned by `owner`, at a given tier and radius. */
export function companion(id, role, owner, tier, radius) {
  return { id, generation: 1, alive: true, x: owner.x, y: owner.y, vx: 0, vy: 0, radius,
    tier, role, ownerId: owner.id, baseStats: { reach: role === 'collector' ? 28 : 13, block: role === 'interceptor' ? 1 : 0 },
    stats: { reach: role === 'collector' ? 28 : 13, block: role === 'interceptor' ? 1 : 0 }, cooldown: 0 };
}

const none = () => false;
const ordinaryOre = () => 9;
const ordinaryHull = () => ({ toughness: 1, sweep: 0 });
/** No identity hook changes anything by default. */
const BASE = {
  command: null, captures: false, companions: false,
  setup() {}, candidates() {},
  bursting: none, braced: none, harvesting: none, moonsBreakOre: none, oreImpact: ordinaryOre,
  /**
   * Deep fields: the ship's hull in an impact (src/sim/simulation.js collideSolids), as a multiplier on the field's hull
   * toughness, and the share of what it breaks off a lighter body that it sweeps up, beyond the field's own.
   */
  hull: ordinaryHull,
};

const warden = {
  ...BASE,
  id: 'warden', name: 'Orbital Warden',
  captures: true, companions: true,
  /** createWorld: the two-body mantle the run starts with, and its owner's reach modifier. */
  setup(w, p, form) {
    p.companions = [companion('mantle-a', 'interceptor', p, form.mantle.tier, form.mantle.radius), companion('mantle-b', 'collector', p, form.mantle.tier, form.mantle.radius)];
    w._capture.reapply(p, { reach: form.moonReach });
  },
  /** Encounter setup in a form that offers captures: a gatherer and a sentinel candidate, named by a string-table key. */
  candidates(w, p, offer) {
    for (const [i, role] of ['collector', 'interceptor'].entries()) {
      const c = companion(`candidate-${w.encounterIndex}-${i}`, role, p, offer.tier, offer.radius);
      c.x = 360 + i * 560; c.y = i ? 595 : 100; c.ownerId = null; c.name = `candidate.${role}`;
      w.candidates.push(c);
    }
  },
  /** SPACE toggles the formation: 0.65 s exposed, then ready; a form with a pulse also moves loose matter. */
  command(w, p, c, form, { event, effect }) {
    for (const member of p.companions) { member.orbitFromRadius = member.orbitRadius; member.orbitTransitionElapsed = 0; }
    p.formation = p.formation === 'tight' ? 'wide' : 'tight'; p.transitioning = true;
    c.state = 'transition'; c.timer = .65; c.cooldown = .95; w.stats.transitions++;
    event(w, 'formation-change', { formation: p.formation, vulnerableFor: .65 });
    if (form.pulse) {
      let moved = 0;
      for (const pickup of w.pickups) {
        const d = distance(p, pickup); if (d > form.pulse.radius || d < 1) continue;
        const v = normal(pickup.x - p.x, pickup.y - p.y), direction = p.formation === 'tight' ? -1 : 1;
        pickup.vx += v.x * form.pulse.impulse * direction; pickup.vy += v.y * form.pulse.impulse * direction; moved++;
      }
      w.stats.pulses++; event(w, 'gravity-pulse', { moved, created: 0 }); effect(w, 'pulse', p.x, p.y, { radius: form.pulse.radius, life: .65 });
    }
  },
  /** Wide moons outside a formation change strike ore. */
  moonsBreakOre: p => p.formation === 'wide' && p.command.state !== 'transition',
  /** What an evolution keeps, as a string-table message: the formation and the moon roles, in orbit order. */
  retained: p => ({ key: 'identity.warden.retained', params: { formation: p.formation, roles: p.companions.map(c => c.role) } }),
};

const harvester = {
  ...BASE,
  id: 'harvester', name: 'Impact Harvester',
  /** SPACE commits a burst along the aim, then recovers. */
  command(w, p, c, form, { event, effect }) {
    c.state = 'commit'; c.timer = form.burst.duration; c.cooldown = 1.65; c.angle = p.angle;
    event(w, 'burst', { angle: c.angle, form: formPosition(w) }); effect(w, 'burst', p.x, p.y, { angle: c.angle });
  },
  /** A committed burst cannot steer: the simulation drives it along its angle at the form's burst speed. */
  bursting: c => c.state === 'commit',
  /** A burst facing the incoming body, in a form with a brace, takes 40% of the hit (rounded up). */
  braced: (p, form, facing) => form.brace && p.command.state === 'commit' && Math.abs(angleDelta(facing, p.command.angle)) < .62,
  /** A committed burst's impact is a harvest: larger, and part of the loss transfers. */
  harvesting: p => p.command.state === 'commit',
  /** A committed burst is armoured (more so with a brace) and sweeps up half of what it breaks off. */
  hull: (p, form) => p.command.state === 'commit' ? { toughness: form.brace ? 3.5 : 3, sweep: .5 } : ordinaryHull(),
  oreImpact: (p, form) => p.command.state === 'commit' ? form.oreBurst : 9,
  retained: () => 'identity.harvester.retained',
};

const unbound = {
  ...BASE,
  id: 'unbound', name: 'Unbound',
  retained: () => 'identity.unbound.retained',
};

/** The identities, in menu order. */
export const IDENTITIES = freeze({ warden, harvester, unbound });
/** The identity the menu starts on, and the renderer's fallback for a world without one. */
export const DEFAULT_IDENTITY = 'warden';

/** The strategy of world `w`'s identity. */
export const identityOf = w => IDENTITIES[w.identity];
/** Whether `w` can claim moons now: its identity captures and its form offers candidates. */
export const capturesAvailable = w => !!(Object.hasOwn(IDENTITIES, w.identity) && IDENTITIES[w.identity].captures && formOf(w)?.capture);
