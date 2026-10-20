// Traits (docs/specs/DF-deep-field.md "Composition and traits"): deep fields only. Everything the player accretes has
// an element, tallied on the player (`elements`); as it grows through a form it reaches ranks, and every rank offers a
// choice of three traits from that form's tree. A trait changes how the body behaves through named modifiers (MODS),
// never by its id: the simulation reads `p.mods`. Some traits need others first (`requires`), and some need enough of
// an element accreted (`needs`): a body's diet opens its avenues. A trait whose needs are unmet shows as locked.
//
// The trait registry: each form's tree, keyed by form id, and the trees every form draws from ('any'). Plain data.
// Names and descriptions are copy, in the string table (src/app/strings.js `trait.<id>.name`, `trait.<id>.text`).
// Offers draw from a hash of the seed, form, rank and the traits taken (no RNG stream), so recorded logs and their
// stream states are unchanged. Dependency-free apart from the descriptor helpers.

import { deepFreeze } from './descriptor.js';

/** The elements of accreted matter, in display order. */
export const ELEMENTS = Object.freeze(['rock', 'metal', 'water', 'cryo', 'radioactive', 'organic']);

/**
 * The element of matter by its source; matter that carries its own `element` (region dust, halos, flares) keeps it.
 * Shed matter restores mass and adds no element.
 */
export const SOURCE_ELEMENTS = deepFreeze({ pocket: 'rock', impact: 'rock', harvest: 'rock', cache: 'metal', ore: 'metal', stream: 'cryo', comet: 'water', flare: 'radioactive', dust: 'rock' });

/**
 * The modifiers a trait can change, and their neutral values. Multipliers multiply; `reach`, `aura`, `auraReach` and
 * `life` add.
 *   thrust, turn     the engine's thrust and the ship's turn rate
 *   accretion        matter per second gathered from dust, storms and halos
 *   reach            added to the pickup collection reach (units)
 *   toughness        the hull in impacts and against cores that do not burn: more keeps more mass
 *   ram              what an impact breaks off the body the ship strikes
 *   core             the mass the body breaks apart below (lower holds together longer)
 *   heat             what a burning body (a star) takes off the ship
 *   shear            what a shear field grinds off
 *   drag             the drag of regions (slush, mires, storms)
 *   ion              how far an ionised region makes the engine falter (0: not at all)
 *   aura, auraReach  radiation: mass per second ground off opponents and ore within auraReach, as loose matter
 *   life             matter per second drawn in a star's habitable band (from its halo)
 */
export const MODS = deepFreeze({ thrust: 1, turn: 1, accretion: 1, reach: 0, toughness: 1, ram: 1, core: 1, heat: 1, shear: 1, drag: 1, ion: 1, aura: 0, auraReach: 0, life: 0 });
const ADDITIVE = new Set(['reach', 'aura', 'auraReach', 'life']);

/** The growth fractions of a form's threshold at which it reaches a rank. */
export const RANKS = Object.freeze([.25, .5, .75, 1]);
/** Options per offer, and locked traits shown alongside them. */
export const OFFER = Object.freeze({ options: 3, locked: 2, favour: 2 });
/** A habitable band: between `inner` and `outer` cores of a star. */
export const HABITABLE = Object.freeze({ inner: 4, outer: 10 });

/**
 * Every trait: `tree` (a form id, or 'any'), `requires` (traits taken first), `needs` (elements accreted), `mods`,
 * and `repeatable` (it can be taken again). A trait from an earlier form's tree stays on offer in later forms.
 */
export const TRAITS = deepFreeze({
  // Any form.
  ballast: { tree: 'any', requires: [], needs: {}, mods: { core: .85 } },
  streamlined: { tree: 'any', requires: [], needs: {}, mods: { thrust: 1.1, turn: 1.1 } },
  'wide-grasp': { tree: 'any', requires: [], needs: {}, mods: { reach: 8, accretion: 1.05 } },
  bulk: { tree: 'any', requires: [], needs: {}, mods: { toughness: 1.05, core: .96 }, repeatable: true },

  // Dwarf planet: what the small body is made of.
  'iron-crust': { tree: 'dwarf', requires: [], needs: { metal: 8 }, mods: { toughness: 1.3, ram: 1.25 } },
  'nickel-iron': { tree: 'dwarf', requires: ['iron-crust'], needs: { metal: 20 }, mods: { toughness: 1.35, ram: 1.4, core: .9, thrust: .94 } },
  'rubble-pile': { tree: 'dwarf', requires: [], needs: {}, mods: { accretion: 1.2, reach: 5, toughness: .85 } },
  'dust-skirt': { tree: 'dwarf', requires: ['rubble-pile'], needs: { rock: 25 }, mods: { accretion: 1.15, reach: 8 } },
  'ice-shell': { tree: 'dwarf', requires: [], needs: { water: 8 }, mods: { drag: .55, heat: 1.15 } },
  'cometary-jets': { tree: 'dwarf', requires: ['ice-shell'], needs: { cryo: 6 }, mods: { thrust: 1.25, turn: 1.15 } },
  'fast-rotator': { tree: 'dwarf', requires: [], needs: {}, mods: { turn: 1.4, thrust: 1.06 } },
  'hot-isotopes': { tree: 'dwarf', requires: [], needs: { radioactive: 5 }, mods: { aura: 1.6, auraReach: 70, heat: .9 } },

  // Planet: a world with a structure.
  tectonics: { tree: 'planet', requires: [], needs: { rock: 30 }, mods: { core: .8, toughness: 1.15 } },
  'iron-core': { tree: 'planet', requires: [], needs: { metal: 20 }, mods: { toughness: 1.2, ram: 1.2 } },
  magnetosphere: { tree: 'planet', requires: ['iron-core'], needs: {}, mods: { shear: .4, ion: .2, heat: .7 } },
  atmosphere: { tree: 'planet', requires: [], needs: { cryo: 10 }, mods: { heat: .7, toughness: 1.1 } },
  oceans: { tree: 'planet', requires: [], needs: { water: 25 }, mods: { heat: .75, accretion: 1.1, core: .9 } },
  'ring-system': { tree: 'planet', requires: [], needs: { cryo: 15 }, mods: { reach: 18, accretion: 1.1 } },
  'radiogenic-core': { tree: 'planet', requires: [], needs: { radioactive: 12 }, mods: { aura: 2.4, auraReach: 110, thrust: 1.08 } },
  'retrograde-spin': { tree: 'planet', requires: [], needs: {}, mods: { turn: 1.3, thrust: 1.12 } },
  biosphere: { tree: 'planet', requires: ['oceans', 'atmosphere'], needs: { organic: 8, water: 35 }, mods: { life: 1.2, accretion: 1.2, core: .85 } },

  // Gas giant: a world that shapes what is around it.
  'deep-gravity': { tree: 'gas-giant', requires: [], needs: {}, mods: { reach: 28 } },
  'metallic-hydrogen': { tree: 'gas-giant', requires: [], needs: { metal: 35 }, mods: { toughness: 1.5, core: .8, ram: 1.3 } },
  'ice-giant': { tree: 'gas-giant', requires: [], needs: { water: 30, cryo: 20 }, mods: { drag: .4, heat: .55, accretion: 1.15 } },
  'great-storm': { tree: 'gas-giant', requires: [], needs: {}, mods: { aura: 1.8, auraReach: 170, turn: 1.1 } },
  'brown-dwarf': { tree: 'gas-giant', requires: ['metallic-hydrogen'], needs: { radioactive: 25 }, mods: { aura: 3.5, auraReach: 220, heat: .35, thrust: 1.15 } },
  'shepherd-moons': { tree: 'gas-giant', requires: [], needs: { rock: 40 }, mods: { reach: 20, toughness: 1.15 } },
  'jet-streams': { tree: 'gas-giant', requires: [], needs: {}, mods: { thrust: 1.2 } },
  'aerial-life': { tree: 'gas-giant', requires: ['biosphere'], needs: { organic: 20 }, mods: { life: 2, accretion: 1.25 } },
});

/** No element accreted yet. */
export const noElements = () => Object.fromEntries(ELEMENTS.map(e => [e, 0]));

/** The modifiers of a list of trait ids (a trait taken twice counts twice). */
export function modsOf(traits = []) {
  const mods = { ...MODS };
  for (const id of traits) for (const [key, value] of Object.entries(TRAITS[id]?.mods ?? {})) mods[key] = ADDITIVE.has(key) ? mods[key] + value : mods[key] * value;
  return mods;
}

/** Whether `elements` meets trait `t`'s needs, and what is still missing: { met, missing: { element: n } }. */
export function needsOf(t, elements) {
  const missing = {};
  for (const [element, n] of Object.entries(t.needs)) if ((elements[element] ?? 0) < n) missing[element] = n - (elements[element] ?? 0);
  return { met: !Object.keys(missing).length, missing };
}

/** The trees a body in form `formId` draws from: 'any', its own and every earlier form's (`earlier`, form ids). */
const treesFor = (formId, earlier) => new Set(['any', formId, ...earlier]);

// A small deterministic generator from a string key: FNV-1a, then mulberry32.
function generator(seed, key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  let s = (h ^ (seed >>> 0)) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ s >>> 15, s | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * The offer at a rank: up to OFFER.options traits the body can take now (not taken unless repeatable, every required
 * trait taken, every need met), drawn by weight without replacement, a trait opened by the body's elements favoured;
 * and up to OFFER.locked traits whose requirements are taken but whose needs are not yet met, nearest first.
 * `key` names the rank (seed, form and rank count). Pure.
 */
export function offerFor({ seed, key, formId, earlier = [], traits = [], elements = noElements() }) {
  const trees = treesFor(formId, earlier), taken = new Set(traits);
  const open = [], locked = [];
  for (const [id, t] of Object.entries(TRAITS)) {
    if (!trees.has(t.tree) || (taken.has(id) && !t.repeatable) || !t.requires.every(r => taken.has(r))) continue;
    const { met, missing } = needsOf(t, elements);
    if (met) open.push({ id, weight: (t.tree === formId ? 2 : 1) * (Object.keys(t.needs).length ? OFFER.favour : 1) * (t.repeatable ? .35 : 1) });
    else locked.push({ id, short: Object.values(missing).reduce((a, b) => a + b, 0), missing });
  }
  const next = generator(seed, `${key}|${traits.join(',')}`), options = [];
  while (options.length < OFFER.options && open.length) {
    const total = open.reduce((a, o) => a + o.weight, 0);
    let r = next() * total, i = 0;
    while (i < open.length - 1 && (r -= open[i].weight) >= 0) i++;
    options.push(open.splice(i, 1)[0].id);
  }
  locked.sort((a, b) => a.short - b.short || (a.id < b.id ? -1 : 1));
  return { options, locked: locked.slice(0, OFFER.locked).map(l => ({ id: l.id, missing: l.missing })) };
}
