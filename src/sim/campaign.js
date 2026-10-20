// The campaign descriptor (docs/specs/M3-data-spine.md, 3a.1). An ordered list of forms keyed by stable string ids,
// each carrying every per-form coefficient as a named field and listing its encounters in play order, with the
// encounter environment coefficients, the successor of every form and encounter, the threat capacity, the capture
// configuration and the kind registry the encounters draw from. The simulation, the app and the renderer read the
// world's descriptor (campaignOf) instead of branching on a form's ordinal position, so a new form or encounter is
// data here. A world keeps the form it is in as `formId` and the encounter it is in as `encounterIndex`, the position
// in play order.
//
// The form's ordinal position survives only behind formPosition(), for the formats that predate form ids: the
// schema-1 playtest log's start.form, the M0 state digest, the survey prompt ids and the `form` field of event
// payloads. contracts.js evolveGrowth stays ordinal inside, behind growthIntervals() (campaign order and thresholds).

import { ENEMY_KINDS } from './kinds.js';
import { deepFreeze, impurity } from './descriptor.js';

/**
 * Every per-form field, and what it was before M3a (as an expression of the form's position f).
 *   threshold, radius, speed          growth interval, body radius, top speed (src/data.js FORMS before M3a)
 *   encounterDuration                 the survival exit, in seconds (36 + 4f)
 *   pocketMatter                      matter split over the five pockets at setup (50 + 15f)
 *   enemyMass, enemyRadius            added to each kind's base mass and radius (6f, 2f)
 *   oreCount, oreMass                 ore bodies at setup, and mass added to each (4 + f, 2f)
 *   streamMatter, streamSpeed         the stream's finite reservoir and drift (24 + 6f, 82 + 8f)
 *   moonReach                         the Warden owner's reach modifier for its moons (3f)
 *   mantle {tier, radius}             the companions a run starts with (tier: f ? 1 : 0; radius: tier ? 10 : 7)
 *   evolvedTier                       companion tier on evolving into this form (f)
 *   moonRadius                        companion radius every step in this form, and on evolving into it (f 0: 7, 1: 10, else 12)
 *   capture {tier, radius} | null     capture candidates offered here, and their size (f >= 1; tier f, radius 10)
 *   pulse {radius, impulse} | null    the formation change also moves loose matter (f === 2: 250, 145)
 *   burst {duration, speed}           the committed burst (duration f === 2 ? .39 : .32; speed 545 + 30f)
 *   brace                             a well-aligned burst braces incoming damage (f >= 1)
 *   oreBurst                          ore damage requested by a committed burst (22 + 2f)
 * A form's presentation, its look and its sound, is not here: since 3c-move it is in src/render/looks.js and
 * src/app/presentation.js, keyed by form id, so the descriptor (and its checkpoint hash) holds gameplay only.
 */
export const FORM_FIELDS = Object.freeze(['id', 'name', 'next', 'threshold', 'radius', 'speed', 'encounterDuration', 'pocketMatter',
  'enemyMass', 'enemyRadius', 'oreCount', 'oreMass', 'streamMatter', 'streamSpeed', 'moonReach', 'mantle', 'evolvedTier', 'moonRadius',
  'capture', 'pulse', 'burst', 'brace', 'oreBurst', 'encounters']);

/**
 * Every per-encounter field. `kinds` are the enemy kinds in slot order. Encounter parity used to set the stream's
 * direction and lane and the current's x force, and position mod 3 its y force; `completesForm` (the second encounter
 * of a form, odd positions) gates growth and offers evolution; `next` is the encounter that follows in a campaign
 * run, null on the last one. An encounter's description is copy: it is in the string table (src/app/strings.js,
 * `encounter.<id>.description`) since M3b, not here.
 */
export const ENCOUNTER_FIELDS = Object.freeze(['id', 'name', 'kinds', 'stream', 'current', 'completesForm', 'next']);

/**
 * Checks the descriptor's shape and its successor chains, and returns it frozen all the way down, through containers
 * that were already frozen (Astra B3: no mutable child can sit under a cached descriptor hash). The descriptor must be
 * plain data: configurable behaviour is a named rule with plain data parameters (src/sim/kinds.js), never a function
 * (Astra B2). Throws a RangeError if not.
 */
export function defineCampaign(spec) {
  const fail = message => { throw new RangeError(`Campaign ${spec?.id ?? '?'}: ${message}`); };
  if (!spec || typeof spec.id !== 'string') fail('needs a string id');
  const impure = impurity(spec, 'campaign');
  if (impure) fail(`holds ${impure}: a descriptor is plain data, and configurable behaviour is a named rule with plain data parameters`);
  if (!Number.isSafeInteger(spec.threatCapacity) || spec.threatCapacity < 1) fail('threatCapacity must be a positive integer');
  const { capacity, maxTier, maxRange } = spec.capture ?? {};
  if (![capacity, maxTier].every(Number.isSafeInteger) || !Number.isFinite(maxRange)) fail('capture needs integer capacity and maxTier and a finite maxRange');
  if (![spec.evolutionRepair, spec.handoffRepair].every(Number.isSafeInteger)) fail('repairs must be integers');
  if (!spec.kinds || typeof spec.kinds !== 'object') fail('needs a kind registry');
  if (!Array.isArray(spec.forms) || !spec.forms.length) fail('needs at least one form');
  const formIds = new Set(), encounterIds = new Set(), all = [];
  spec.forms.forEach((form, i) => {
    for (const field of FORM_FIELDS) if (!Object.hasOwn(form, field)) fail(`form ${form.id ?? i} lacks ${field}`);
    for (const field of Object.keys(form)) if (!FORM_FIELDS.includes(field)) fail(`form ${form.id} has an undeclared field ${field}`);
    if (typeof form.id !== 'string' || !form.id || formIds.has(form.id)) fail(`form ${i} needs a unique string id`);
    formIds.add(form.id);
    const following = spec.forms[i + 1]?.id ?? null;
    if (form.next !== following) fail(`form ${form.id} names ${form.next} as its successor, but ${following} follows it`);
    for (const field of ['threshold', 'radius', 'speed', 'encounterDuration', 'pocketMatter', 'enemyMass', 'enemyRadius', 'oreCount', 'oreMass',
      'streamMatter', 'streamSpeed', 'moonReach', 'evolvedTier', 'moonRadius', 'oreBurst']) if (!Number.isFinite(form[field])) fail(`form ${form.id}: ${field} must be finite`);
    if (!Number.isSafeInteger(form.threshold) || form.threshold <= 0) fail(`form ${form.id}: threshold must be a positive integer`);
    if (!Array.isArray(form.encounters) || !form.encounters.length) fail(`form ${form.id} lists no encounters`);
    for (const e of form.encounters) {
      for (const field of ENCOUNTER_FIELDS) if (!Object.hasOwn(e, field)) fail(`encounter ${e.id ?? '?'} lacks ${field}`);
      for (const field of Object.keys(e)) if (!ENCOUNTER_FIELDS.includes(field)) fail(`encounter ${e.id} has an undeclared field ${field}`);
      if (typeof e.id !== 'string' || !e.id || encounterIds.has(e.id)) fail(`encounter ids must be unique strings (${e.id})`);
      for (const kind of e.kinds) if (!Object.hasOwn(spec.kinds, kind)) fail(`encounter ${e.id} uses kind ${kind}, which the registry lacks`);
      encounterIds.add(e.id); all.push(e);
    }
  });
  all.forEach((e, i) => { const following = all[i + 1]?.id ?? null; if (e.next !== following) fail(`encounter ${e.id} names ${e.next} as next, but ${following} follows it`); });
  return deepFreeze(spec);
}

/** The shipped campaign: three forms, two encounters each, three enemy kinds. */
export const CAMPAIGN = defineCampaign({
  id: 'expedition',
  threatCapacity: 1,                                  // committed attacks at once (simulation.js compared `< 1`; threatBudget.max is 1)
  capture: { capacity: 2, maxTier: 2, maxRange: 190 }, // the CaptureSystem configuration, apart from the threat capacity
  evolutionRepair: 24,                                // integrity repaired on evolving
  handoffRepair: 18,                                  // integrity repaired at the next encounter's handoff
  kinds: ENEMY_KINDS,
  forms: [
    { id: 'dwarf', name: 'Dwarf planet', next: 'planet',
      threshold: 80, radius: 23, speed: 285, encounterDuration: 36, pocketMatter: 50, enemyMass: 0, enemyRadius: 0,
      oreCount: 4, oreMass: 0, streamMatter: 24, streamSpeed: 82, moonReach: 0,
      mantle: { tier: 0, radius: 7 }, evolvedTier: 0, moonRadius: 7, capture: null,
      pulse: null, burst: { duration: .32, speed: 545 }, brace: false, oreBurst: 22,
      encounters: [
        { id: 'long-wake', name: 'The Long Wake', kinds: ['charger'],
          stream: { direction: 1, y: 240 }, current: { forceX: 620, forceY: -180 }, completesForm: false, next: 'open-face' },
        { id: 'open-face', name: 'The Open Face', kinds: ['guard'],
          stream: { direction: -1, y: 460 }, current: { forceX: -620, forceY: 0 }, completesForm: true, next: 'borrowed-orbit' },
      ] },
    { id: 'planet', name: 'Planet', next: 'gas-giant',
      threshold: 104, radius: 28, speed: 275, encounterDuration: 40, pocketMatter: 65, enemyMass: 6, enemyRadius: 2,
      oreCount: 5, oreMass: 2, streamMatter: 30, streamSpeed: 90, moonReach: 3,
      mantle: { tier: 1, radius: 10 }, evolvedTier: 1, moonRadius: 10, capture: { tier: 1, radius: 10 },
      pulse: null, burst: { duration: .32, speed: 575 }, brace: true, oreBurst: 24,
      encounters: [
        { id: 'borrowed-orbit', name: 'A Borrowed Orbit', kinds: ['scavenger'],
          stream: { direction: 1, y: 240 }, current: { forceX: 620, forceY: 180 }, completesForm: false, next: 'crossed-intentions' },
        { id: 'crossed-intentions', name: 'Crossed Intentions', kinds: ['charger', 'guard'],
          stream: { direction: -1, y: 460 }, current: { forceX: -620, forceY: -180 }, completesForm: true, next: 'wake-thieves' },
      ] },
    { id: 'gas-giant', name: 'Gas giant', next: null,
      threshold: 128, radius: 34, speed: 265, encounterDuration: 44, pocketMatter: 80, enemyMass: 12, enemyRadius: 4,
      oreCount: 6, oreMass: 4, streamMatter: 36, streamSpeed: 98, moonReach: 6,
      mantle: { tier: 1, radius: 10 }, evolvedTier: 2, moonRadius: 12, capture: { tier: 2, radius: 10 },
      pulse: { radius: 250, impulse: 145 }, burst: { duration: .39, speed: 605 }, brace: true, oreBurst: 26,
      encounters: [
        { id: 'wake-thieves', name: 'Wake Thieves', kinds: ['charger', 'scavenger'],
          stream: { direction: 1, y: 240 }, current: { forceX: 620, forceY: 0 }, completesForm: false, next: 'last-reserve' },
        { id: 'last-reserve', name: 'The Last Reserve', kinds: ['guard', 'scavenger'],
          stream: { direction: -1, y: 460 }, current: { forceX: -620, forceY: 180 }, completesForm: true, next: null },
      ] },
  ],
});

// Lookups, built once per descriptor.
const indexes = new WeakMap();
function indexOf(campaign) {
  let index = indexes.get(campaign);
  if (!index) {
    const encounters = Object.freeze(campaign.forms.flatMap(f => f.encounters));
    indexes.set(campaign, index = {
      forms: new Map(campaign.forms.map((descriptor, position) => [descriptor.id, { descriptor, position }])),
      encounters, encounterPositions: new Map(encounters.map((e, i) => [e.id, i])),
      intervals: Object.freeze(campaign.forms.map(f => f.threshold)),
    });
  }
  return index;
}

/** The descriptor a world runs on: the one it was created with, or the shipped campaign. */
export const campaignOf = w => w?.campaign ?? CAMPAIGN;
/** Every encounter of a campaign in play order (a world's `encounterIndex` is a position in this list). */
export const encounterList = (campaign = CAMPAIGN) => indexOf(campaign).encounters;
/** The form with id `id`, or undefined. */
export const formById = (campaign, id) => indexOf(campaign).forms.get(id)?.descriptor;
/** The form world `w` is in. */
export const formOf = w => formById(campaignOf(w), w.formId);
/** The form `w` evolves into, or null in the last form. */
export const nextFormOf = w => { const next = formOf(w)?.next; return next ? formById(campaignOf(w), next) : null; };
/** The encounter world `w` is in. */
export const encounterOf = w => indexOf(campaignOf(w)).encounters[w.encounterIndex];
/** The encounter that follows `w`'s in a campaign run, or null after the last. */
export const nextEncounterOf = w => { const next = encounterOf(w)?.next; return next ? indexOf(campaignOf(w)).encounters[indexOf(campaignOf(w)).encounterPositions.get(next)] : null; };
/** The play-order position of encounter `id`. */
export const encounterPosition = (campaign, id) => indexOf(campaign).encounterPositions.get(id);
/** The enemy kind entry for `type` in `w`'s campaign. */
export const kindOf = (w, type) => campaignOf(w).kinds[type];
/** Growth intervals in campaign order, for contracts.js evolveGrowth. */
export const growthIntervals = (campaign = CAMPAIGN) => indexOf(campaign).intervals;

/**
 * The campaign position of `w`'s form (0 for the first form). Only for formats that predate form ids: the schema-1
 * log's start.form, the M0 state digest, survey prompt ids and the `form` field of event payloads.
 */
export const formPosition = w => indexOf(campaignOf(w)).forms.get(w.formId)?.position;
/** The campaign position of form `id`. */
export const formIdPosition = (campaign, id) => indexOf(campaign).forms.get(id)?.position;

/** A form given as its id or, as schema-1 logs record it, its campaign position. Throws on anything else. */
export function resolveForm(campaign, form) {
  if (typeof form === 'string' && formById(campaign, form)) return formById(campaign, form);
  if (Number.isSafeInteger(form) && form >= 0 && form < campaign.forms.length) return campaign.forms[form];
  throw new RangeError(`Unknown form ${JSON.stringify(form)}: one of ${campaign.forms.map(f => f.id).join(', ')}, or a position 0-${campaign.forms.length - 1}`);
}

/** An encounter given as its play-order position (schema-1 `arrangement`) or its id. Returns the position; throws on anything else. */
export function resolveEncounter(campaign, encounter) {
  const list = encounterList(campaign);
  if (typeof encounter === 'string' && encounterPosition(campaign, encounter) !== undefined) return encounterPosition(campaign, encounter);
  if (Number.isSafeInteger(encounter) && encounter >= 0 && encounter < list.length) return encounter;
  throw new RangeError(`Unknown encounter ${JSON.stringify(encounter)}: one of ${list.map(e => e.id).join(', ')}, or a position 0-${list.length - 1}`);
}
