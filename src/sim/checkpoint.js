// The checkpoint serializer (docs/specs/M3-data-spine.md 3b.2; docs/expansion-plan.md 7.6). One serializer, two scopes,
// one format:
//   - boundary: taken when an encounter starts, after setupEncounter has completed (in createWorld, or in
//     nextEncounter, including the handoff after an evolution) and before the encounter's first step. It serves
//     re-forms, Calm retries, suspend and stage slices. Every other moment is refused (boundaryRefusal).
//   - live: taken at any step boundary of a run in play, between two stepWorld calls or between the actions (capture,
//     evolve, next) taken there. The simulation is synchronous, so outside a call every moment is a step boundary. A
//     live checkpoint is taken in the `playing` phase, mid-encounter included, and in the two phases a playing step
//     hands the run to an action in: `evolution` (the pending evolution, waiting for evolve) and `encounter-clear`
//     (waiting for next). A won or lost run has no continuation and is refused, as is any other phase (liveRefusal).
// Both scopes write the same complete continuation state; the scope only says which moments are accepted.
//
// A checkpoint is plain JSON holding the complete continuation state: every enumerable field of the world, entity
// arrays in order, both class-held registries (ContactEpisodes and CaptureSystem export their own records), the event,
// milestone and effect buffers and the RNG stream states, with full numeric precision. JSON cannot carry -0, NaN, the
// infinities or undefined, so those numbers and values are written as one-key objects {"~": "-0"} and read back
// exactly. It is never built from the rounded digest view, and never with structuredClone.
//
// Restore performs no gameplay setup, RNG draw, event emission, repair or settlement. It runs in two passes: the
// first creates every entity and record as plain data; the second links what refers to an entity (the capture
// system's ledger books, ownership edges and outstanding requests, keyed by typed id and generation), aliases each
// milestone to its event, as the simulation buffers one object in both, and points each encounter-start payload's
// kind list back at the descriptor it came from. Capture tokens are reissued (CaptureSystem.importState): restore
// returns a requestMap from each outstanding request's old id to its new token. The RNG state is copied and its
// named streams rebound without drawing (src/sim/rng.js restoreStreams).
//
// A checkpoint carries its schema version, the build it was taken with and the campaign descriptor's hash; a
// mismatch in any refuses to load. The build is the source commit scripts/build-single.mjs stamps into a single-file
// build, or 'dev' for an unstamped tree, so two dev trees cannot tell each other apart. Renderer caches, app dialogs,
// input, the step accumulator and the recording cursor are not gameplay state and are not here; neither are the app's
// time-scale requests, which the app holds, not the world. Dependency-free, no DOM or Node APIs.

import { ContactEpisodes, CaptureSystem } from './contracts.js';
import { STREAM_NAMES, restoreStreams } from './rng.js';
import { CAMPAIGN, campaignOf, encounterList, formById } from './campaign.js';
import { isDeeplyFrozen } from './descriptor.js';
import { IDENTITIES } from './identities.js';
import { bindCampaign } from './simulation.js';
import { createArena } from './arena.js';
import { FIELDS, BODY_KINDS } from './field.js';
import { REGION_KINDS } from './regions.js';
import { TRAITS, ELEMENTS, modsOf } from './traits.js';

export const CHECKPOINT_KIND = 'asterwake-checkpoint';
/**
 * Bump when the checkpoint format, WORLD_FIELDS or the shape of a field's value changes: every older checkpoint then
 * refuses to load. 2 (M3b strings): the objective, capture candidates' names and the pending evolution hold
 * string-table keys and ids (src/app/strings.js) instead of copy. 3 (M3b integrity): the player holds integrity and
 * maxIntegrity instead of mass, hp and maxHp. 4 (M3c arena): the world holds its arena, `arena` (src/sim/arena.js),
 * where the simulation kept module constants. 5 (deep field): the world names its field, `field`, and holds its
 * encounter's gravity wells, `wells` (src/sim/field.js); a classic world holds 'classic' and no wells. 6 (deep-field
 * regions): a deep world also holds its regions of space, `regions` (src/sim/regions.js), and a classic world none.
 */
export const CHECKPOINT_SCHEMA = 6;
export const BOUNDARY_SCOPE = 'boundary';
export const LIVE_SCOPE = 'live';
/** The scopes a checkpoint can name; both write the same state, so adding the live scope changed no format. */
export const SCOPES = Object.freeze([BOUNDARY_SCOPE, LIVE_SCOPE]);
/** The phases a live checkpoint is taken in: play, and the two a playing step hands the run to an action in. */
export const LIVE_PHASES = Object.freeze(['playing', 'evolution', 'encounter-clear']);

/**
 * Every enumerable field of a world: createWorld's own, then those setupEncounter adds. Schema 4 added `arena` and
 * schema 5 `field` and `wells`; the set
 * was otherwise the same since schema 1. Export and restore both refuse a world with any other set, so a field added
 * to the world cannot be dropped silently: add it here and bump CHECKPOINT_SCHEMA. `campaign` and the derived `form`
 * are not fields: restore binds the descriptor it is given.
 */
export const WORLD_FIELDS = Object.freeze(['seed', 'rng', 'identity', 'formId', 'practice', 'time', 'phase', 'arena', 'field', 'wells', 'player', 'enemies', 'pickups',
  'effects', 'events', 'milestones', 'candidates', 'encounterIndex', 'encounterName', 'objective', 'encounterTime', 'encounterCollected',
  'encounterQuota', 'pendingEvolution', 'threatBudget', 'stats', '_contacts', '_graceSuppressed', '_capture', '_commandHeld', '_id',
  '_eventSequence', '_telemetry', '_measuredAt', 'encounterDuration', 'rocks', 'stream', 'current', 'gates', 'slalom']);

/** A checkpoint that cannot be taken or loaded. */
export class CheckpointError extends Error {
  constructor(message) { super(message); this.name = 'CheckpointError'; }
}

/** The build a checkpoint is keyed to: the commit stamped into a single-file build, or 'dev'. */
export const buildId = () => String(globalThis.ASTERWAKE_BUILD_SHA || 'dev');

/**
 * 64-bit FNV-1a over the UTF-8 bytes of `text`, as 16 lowercase hex digits: the algorithm of the golden digests
 * (tools/replay/digest.mjs), repeated here because src/ cannot import tools/.
 */
const encoder = new TextEncoder();
export function fnv1a64(text) {
  let hi = 0xcbf29ce4, lo = 0x84222325;
  for (const byte of encoder.encode(text)) {
    lo ^= byte;
    const low = (lo >>> 0) * 0x1b3, carry = Math.floor(low / 4294967296);
    hi = (Math.imul(hi, 0x1b3) + carry + Math.imul(lo, 256)) >>> 0;
    lo = low >>> 0;
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

/**
 * Canonical text of a campaign descriptor: keys sorted, numbers exact (-0 kept), so a change to any coefficient,
 * encounter, kind or rule changes the hash. Rules are named with their plain data parameters (src/sim/kinds.js
 * TARGET_RULES and CHANNEL_RULES), so they are hashed as data. A function is refused (Astra B2): its source text cannot
 * identify the state its closure captured, so two campaigns that behave differently could share a hash.
 *
 * What it covers, since 3c-move moved presentation out of the descriptor: gameplay only. That is the campaign's id,
 * threat capacity, capture configuration and repairs; every form's coefficients, successor and encounters (each
 * encounter's kinds, stream, current, completesForm and successor); every kind's gameplay entry (bases, speeds,
 * timings, hover band, hit, theft, rear arc, statistics flags, windows, derived persistent channels, targeting and
 * channel rules); and the names of forms, encounters and kinds, which the simulation records (an encounter's name is
 * world state, `encounterName`). It does not cover presentation (src/render/looks.js, src/app/presentation.js, the
 * string table), which cannot change a continuation, nor code outside the descriptor (the identity strategies, the
 * simulation itself), which the checkpoint's build identifies.
 */
function descriptorText(value, ancestors = new Set()) {
  switch (typeof value) {
    case 'undefined': return 'undefined';
    case 'number': return Object.is(value, -0) ? '-0' : String(value);
    case 'string': return JSON.stringify(value);
    case 'boolean': return String(value);
    case 'function': throw new TypeError('A campaign descriptor holds a function; configurable behaviour is a named rule with plain data parameters');
    case 'object': break;
    default: throw new TypeError(`A campaign descriptor holds a ${typeof value}`);
  }
  if (value === null) return 'null';
  if (ancestors.has(value)) throw new TypeError('A campaign descriptor must not contain itself');
  ancestors.add(value);
  const text = Array.isArray(value) ? `[${value.map(v => descriptorText(v, ancestors)).join(',')}]`
    : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${descriptorText(value[k], ancestors)}`).join(',')}}`;
  ancestors.delete(value);
  return text;
}
const descriptorHashes = new WeakMap();
/**
 * The hash a checkpoint is keyed to for `campaign`: 'fnv1a64:' and 16 hex digits of its canonical text. Throws a
 * TypeError on a descriptor holding a function. The hash is cached only for a descriptor frozen all the way down (as
 * defineCampaign returns it); any other is hashed afresh on every call, so a mutated child changes its hash (Astra B3).
 */
export function descriptorHash(campaign = CAMPAIGN) {
  let hash = descriptorHashes.get(campaign);
  if (!hash) {
    hash = `fnv1a64:${fnv1a64(descriptorText(campaign))}`;
    if (isDeeplyFrozen(campaign)) descriptorHashes.set(campaign, hash);
  }
  return hash;
}
/** descriptorHash for a checkpoint: a descriptor that cannot be hashed cannot take or load one. */
function checkpointDescriptor(campaign) {
  try { return descriptorHash(campaign); } catch (error) { throw new CheckpointError(`The campaign descriptor cannot be identified: ${error.message}.`); }
}

// The value codec. Plain objects, arrays, strings, booleans, null and finite numbers are JSON as they are; -0, NaN,
// the infinities and undefined become {"~": text}. Anything else (a Map, a Set, a class instance, a function, a
// sparse array) is refused with its path: a class that holds state exports it itself. JSON writes an object reached
// twice as two copies, so `seen` refuses a mutable object reached twice: a checkpoint keeps only the aliasing it
// declares and restores (milestones and their events; encounter-start kind lists and their descriptor).
const TAG = '~';
const SPECIAL = Object.freeze({ undefined, '-0': -0, NaN, Infinity, '-Infinity': -Infinity });
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));

function encode(value, path, seen) {
  if (value === undefined) return { [TAG]: 'undefined' };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? value : { [TAG]: Object.is(value, -0) ? '-0' : String(value) };
  if (typeof value === 'object' && !Object.isFrozen(value)) {
    if (seen.has(value)) throw new CheckpointError(`${path} is the same object as ${seen.get(value)}; a checkpoint keeps only the aliasing it declares`);
    seen.set(value, path);
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new CheckpointError(`${path}: an array subclass is not plain data`);
    const out = [];
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) throw new CheckpointError(`${path}[${i}]: a sparse array is not plain data`);
      out.push(encode(value[i], `${path}[${i}]`, seen));
    }
    return out;
  }
  if (!plain(value)) throw new CheckpointError(`${path}: ${typeof value === 'object' ? value.constructor?.name ?? 'this object' : `a ${typeof value}`} is not plain data`);
  const out = {};
  for (const key of Object.keys(value)) {
    if (key === TAG || key === '__proto__') throw new CheckpointError(`${path}: the key ${key} is reserved`);
    out[key] = encode(value[key], `${path}.${key}`, seen);
  }
  return out;
}

function decode(value, path) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new CheckpointError(`${path}: a non-finite number must be tagged`); return value; }
  if (Array.isArray(value)) return value.map((v, i) => decode(v, `${path}[${i}]`));
  if (!plain(value)) throw new CheckpointError(`${path}: not JSON data`);
  const keys = Object.keys(value);
  if (keys.includes(TAG)) {
    if (keys.length !== 1 || !Object.hasOwn(SPECIAL, value[TAG])) throw new CheckpointError(`${path}: unknown tagged value ${JSON.stringify(value)}`);
    return SPECIAL[value[TAG]];
  }
  const out = {};
  for (const key of keys) {
    if (key === '__proto__') throw new CheckpointError(`${path}: the key __proto__ is reserved`);
    out[key] = decode(value[key], `${path}.${key}`);
  }
  return out;
}

/**
 * Why world `w` is not at an encounter boundary, or null when it is. At a boundary the world is in the `playing`
 * phase, its encounter has not been stepped (encounterTime is exactly 0; every step adds its dt), and its newest event
 * is that encounter's `encounter-start`, or the `choice` createWorld emits right after it. A step, a clear, an
 * evolution, a win, a loss and a capture commit (which always emits) all move the world off its boundary. A capture
 * request issued before the first step emits nothing: it only adds a request record, which the checkpoint carries.
 */
export function boundaryRefusal(w) {
  if (w?.phase !== 'playing') return `the world is in the ${JSON.stringify(w?.phase)} phase; a boundary checkpoint is taken as an encounter starts`;
  if (w.encounterTime !== 0) return `its encounter has run for ${w.encounterTime} s; a boundary checkpoint is taken before the first step (mid-encounter is the live scope)`;
  const last = w.events?.at(-1), before = w.events?.at(-2);
  const start = last?.type === 'encounter-start' ? last : last?.type === 'choice' && before?.type === 'encounter-start' && before.seq === last.seq - 1 ? before : null;
  if (!last || last.seq !== w._eventSequence || start?.encounter !== w.encounterIndex)
    return `the world has changed since its encounter was set up (its newest event is ${last ? `${last.type} #${last.seq}` : 'missing'})`;
  return null;
}

/**
 * Why world `w` is not at a live step boundary, or null when it is. A live checkpoint is taken in a LIVE_PHASES phase,
 * and a pending evolution is held exactly while the run waits in the `evolution` phase (previewEvolution sets both;
 * evolveWorld clears both). Every other check is the format's own: the fields, the plain data, the registries.
 */
export function liveRefusal(w) {
  if (!LIVE_PHASES.includes(w?.phase)) return `the world is in the ${JSON.stringify(w?.phase)} phase; a live checkpoint is taken at a step boundary `
    + `of a run in play (${LIVE_PHASES.map(p => JSON.stringify(p)).join(', ')}), and a won or lost run has no continuation`;
  if ((w.phase === 'evolution') !== (w.pendingEvolution != null))
    return `the world ${w.pendingEvolution != null ? 'holds a pending evolution outside' : 'holds no pending evolution in'} the "evolution" phase`;
  return null;
}

/** Why world `w` cannot be checkpointed in `scope`, or null when it can. */
export function scopeRefusal(w, scope) {
  if (scope === BOUNDARY_SCOPE) return boundaryRefusal(w);
  if (scope === LIVE_SCOPE) return liveRefusal(w);
  return `there is no checkpoint scope ${JSON.stringify(scope)} (${SCOPES.join(', ')})`;
}

/** The fields only a deep world holds (schema 6): its regions of space. */
export const DEEP_FIELDS = Object.freeze(['regions']);

function checkFields(keys, where, field) {
  const expected = field && field !== 'classic' ? [...WORLD_FIELDS, ...DEEP_FIELDS] : WORLD_FIELDS;
  const extra = keys.filter(k => !expected.includes(k)), missing = expected.filter(k => !keys.includes(k));
  if (extra.length || missing.length) throw new CheckpointError(`The ${where} does not have the schema-${CHECKPOINT_SCHEMA} world fields`
    + `${extra.length ? `; unknown: ${extra.join(', ')}` : ''}${missing.length ? `; missing: ${missing.join(', ')}` : ''}`);
}

/** Runs a class's own import, reporting what it refuses as a CheckpointError for `key`. */
function guard(key, run) {
  try { return run(); } catch (error) { throw error instanceof CheckpointError ? error : new CheckpointError(`${key} cannot be restored: ${error.message}`); }
}

const typedKey = id => JSON.stringify([typeof id, id]);
/** The bodies the capture system can name: the player, its companions and the candidates, each with a unique typed id. */
function captureRoster(w, where) {
  const roster = [w.player, ...(w.player?.companions ?? []), ...(w.candidates ?? [])], index = new Map();
  for (const body of roster) {
    if (!plain(body) || (typeof body.id !== 'string' && typeof body.id !== 'number')) throw new CheckpointError(`${where}: a capture body needs a string or number id`);
    if (index.has(typedKey(body.id))) throw new CheckpointError(`${where}: two capture bodies share the id ${JSON.stringify(body.id)}`);
    index.set(typedKey(body.id), body);
  }
  return { roster, index };
}

/**
 * The checkpoint of world `w` in `scope` (BOUNDARY_SCOPE by default, or LIVE_SCOPE), as a plain JSON object
 * (JSON.stringify it to store it). Throws a CheckpointError when `w` is not at a moment the scope accepts
 * (scopeRefusal) or holds state the schema does not know. Reads only: the world is not changed.
 */
export function exportCheckpoint(w, { scope = BOUNDARY_SCOPE, build = buildId() } = {}) {
  const refusal = scopeRefusal(w, scope);
  if (refusal) throw new CheckpointError(`No ${scope} checkpoint: ${refusal}.`);
  checkFields(Object.keys(w), 'world', w.field);
  const members = new Set(captureRoster(w, 'world').roster);
  const ref = body => (members.has(body) ? { id: body.id, generation: body.generation } : null);
  const instance = (value, type, key) => { if (!(value instanceof type)) throw new CheckpointError(`${key} must be a ${type.name}`); return value; };
  // A milestone still in the event tail is that event's own object: written once more here, and aliased again on restore.
  const events = new Map(w.events.map(e => [e?.seq, e])), seen = new Map(), world = {};
  const milestone = (m, i) => {
    const event = events.get(m?.seq);
    if (event === undefined) return encode(m, `milestones[${i}]`, seen);
    if (event !== m) throw new CheckpointError(`milestones[${i}] has the sequence number of an event it is not`);
    return encode(m, `milestones[${i}]`, new Map());
  };
  for (const key of Object.keys(w)) {
    if (key === '_contacts') world[key] = encode(instance(w[key], ContactEpisodes, key).exportState(), key, seen);
    else if (key === '_capture') world[key] = encode(instance(w[key], CaptureSystem, key).exportState(ref), key, seen);
    else if (key === '_graceSuppressed') world[key] = encode([...instance(w[key], Set, key)], key, seen);
    else if (key === 'milestones') world[key] = Array.isArray(w[key]) ? w[key].map(milestone) : encode(w[key], key, seen);
    else world[key] = encode(w[key], key, seen);
  }
  return { kind: CHECKPOINT_KIND, schema: CHECKPOINT_SCHEMA, scope, build: String(build), descriptor: checkpointDescriptor(campaignOf(w)), world };
}

/**
 * Restores a checkpoint (the object exportCheckpoint returned, or its JSON text) as a new world running on `campaign`,
 * and returns { world, requestMap }. The requestMap maps each outstanding capture request's old id to its reissued
 * token; a request it does not list was consumed or stale and restores as consumed. A checkpoint of either scope loads,
 * and the restored world must be at a moment its scope accepts; `scope`, when given, also requires that scope (a
 * re-form loads only boundary checkpoints). Throws a CheckpointError on another kind, schema, scope, build or
 * descriptor, or a malformed checkpoint. The checkpoint is not changed.
 */
export function restoreCheckpoint(checkpoint, { campaign = CAMPAIGN, build = buildId(), scope } = {}) {
  if (typeof checkpoint === 'string') checkpoint = guard('checkpoint', () => JSON.parse(checkpoint));
  if (!plain(checkpoint) || checkpoint.kind !== CHECKPOINT_KIND) throw new CheckpointError('Not an Accrete checkpoint.');
  const refuse = (what, saved, here) => { throw new CheckpointError(`This checkpoint was taken with ${what} ${JSON.stringify(saved)}; this game has ${JSON.stringify(here)}, so it cannot be loaded.`); };
  if (checkpoint.schema !== CHECKPOINT_SCHEMA) refuse('schema', checkpoint.schema, CHECKPOINT_SCHEMA);
  if (!SCOPES.includes(checkpoint.scope)) refuse('scope', checkpoint.scope, SCOPES);
  if (scope !== undefined && checkpoint.scope !== scope) throw new CheckpointError(`This is a ${checkpoint.scope} checkpoint; a ${scope} checkpoint is needed here.`);
  if (checkpoint.build !== String(build)) refuse('build', checkpoint.build, String(build));
  const descriptor = checkpointDescriptor(campaign);
  if (checkpoint.descriptor !== descriptor) refuse('campaign descriptor', checkpoint.descriptor, descriptor);
  const saved = checkpoint.world;
  if (!plain(saved)) throw new CheckpointError('The checkpoint holds no world.');
  checkFields(Object.keys(saved), 'checkpoint', saved.field);

  // Pass 1: every entity and record, in the world's own field order. The capture system names entities, so its place
  // is kept and it is filled in pass 2.
  const w = {};
  for (const key of Object.keys(saved)) {
    if (key === '_capture') w[key] = null;
    else if (key === '_contacts') w[key] = guard(key, () => new ContactEpisodes().importState(decode(saved[key], key)));
    else if (key === '_graceSuppressed') {
      const keys = decode(saved[key], key);
      if (!Array.isArray(keys) || keys.some(k => typeof k !== 'string')) throw new CheckpointError('_graceSuppressed must be a list of strings');
      w[key] = new Set(keys);
    } else if (key === 'rng') {
      const state = decode(saved[key], key);
      if (!plain(state) || Object.keys(state).join() !== STREAM_NAMES.join()) throw new CheckpointError(`rng must hold exactly the streams ${STREAM_NAMES.join(', ')}`);
      // The streams are rebound to a copy of the saved state; nothing draws.
      w[key] = guard(key, () => restoreStreams(state).state);
    } else if (key === 'arena') w[key] = guard(key, () => createArena(decode(saved[key], key)));
    else w[key] = decode(saved[key], key);
  }
  if (!Object.hasOwn(IDENTITIES, w.identity)) throw new CheckpointError(`Unknown identity ${JSON.stringify(w.identity)}.`);
  if (!Object.hasOwn(FIELDS, w.field)) throw new CheckpointError(`Unknown field ${JSON.stringify(w.field)}.`);
  const space = FIELDS[w.field], finite = v => typeof v === 'number' && Number.isFinite(v);
  // The arena itself is not tied to the field: any valid arena restores (D26).
  if (!Array.isArray(w.wells) || (!space.systems && w.wells.length)) throw new CheckpointError(`The ${w.field} field's wells are malformed.`);
  for (const k of w.wells) if (!plain(k) || typeof k.id !== 'string' || !Object.hasOwn(BODY_KINDS, k.kind) || !['x', 'y', 'vx', 'vy', 'mass', 'core'].every(f => finite(k[f]))
    || !(k.mass > 0 && k.core > 0) || ![k.stormAt, k.stormIn].every(v => v === undefined || finite(v)))
    throw new CheckpointError(`Well ${JSON.stringify(k?.id)} is malformed.`);
  if (space.systems) {
    if (!Array.isArray(w.regions)) throw new CheckpointError(`The ${w.field} field's regions are malformed.`);
    for (const r of w.regions) if (!plain(r) || typeof r.id !== 'string' || !Object.hasOwn(REGION_KINDS, r.kind) || !['x', 'y', 'vx', 'vy', 'radius', 'reserve'].every(f => finite(r[f]))
      || !(r.radius > 0 && r.reserve >= 0)
      || !(r.kind === 'halo' ? typeof r.well === 'string' && ['inner', 'mass', 'soft'].every(f => finite(r[f]))
        : r.well !== undefined ? typeof r.well === 'string' && ['inner', 'extent'].every(f => finite(r[f]))
        : r.shape === 'ring' ? finite(r.inner)
        : r.path === 'drift' ? ['x0', 'y0', 'born', 'life', 'r0', 'grow'].every(f => finite(r[f]))
        : ['omega', 'phase', 'orbit', 'cx', 'cy'].every(f => finite(r[f])))
      // A halo or zone rides a body the world has; an edge lies inside the region; a drifting storm has life left;
      // the Kuiper ring's next comet is a time (or not yet drawn).
      || (r.well !== undefined && !w.wells.some(k => k.id === r.well))
      || (r.inner !== undefined && !(r.inner >= 0 && r.inner < r.radius))
      || (r.path === 'drift' && !(r.life > 0))
      || (r.nextComet !== undefined && !finite(r.nextComet)))
      throw new CheckpointError(`Region ${JSON.stringify(r?.id)} is malformed.`);
  }
  if (!formById(campaign, w.formId)) throw new CheckpointError(`The campaign has no form ${JSON.stringify(w.formId)}.`);
  if (!Number.isSafeInteger(w.encounterIndex) || !encounterList(campaign)[w.encounterIndex]) throw new CheckpointError(`The campaign has no encounter ${JSON.stringify(w.encounterIndex)}.`);
  if (!plain(w.player) || !Array.isArray(w.player.companions) || ![w.candidates, w.events, w.milestones].every(Array.isArray)) throw new CheckpointError('The checkpoint world is malformed.');
  // A deep player's composition and traits (src/sim/traits.js): known traits, finite elements, and an offer of known
  // traits; its modifiers are derived from its traits, so they are rebuilt rather than trusted.
  if (space.systems) {
    const p = w.player, known = id => typeof id === 'string' && Object.hasOwn(TRAITS, id);
    if (!Array.isArray(p.traits) || !p.traits.every(known) || !plain(p.elements) || !ELEMENTS.every(e => finite(p.elements[e]) && p.elements[e] >= 0)
      || !Array.isArray(p.lineage) || ![p.rank, p.banked, p.offers].every(Number.isSafeInteger)
      || (p.offer !== null && (!plain(p.offer) || !Array.isArray(p.offer.options) || !p.offer.options.every(known) || !Array.isArray(p.offer.locked))))
      throw new CheckpointError("The checkpoint player's traits are malformed.");
    p.mods = modsOf(p.traits);
  }

  // Pass 2: links. The capture system's entities, by typed id and generation, among the bodies pass 1 created.
  const { index } = captureRoster(w, 'checkpoint');
  const resolve = key => { const body = index.get(typedKey(key?.id)); return body && body.generation === key.generation ? body : null; };
  const capture = new CaptureSystem(), requestMap = guard('_capture', () => capture.importState(decode(saved._capture, '_capture'), resolve));
  w._capture = capture;
  // The simulation buffers one event object in both the event and milestone tails: restore that aliasing.
  const bySeq = new Map(w.events.map((e, i) => [e?.seq, i]));
  w.milestones = w.milestones.map((m, i) => {
    const at = bySeq.get(m?.seq);
    if (at === undefined) return m;
    if (JSON.stringify(saved.milestones[i]) !== JSON.stringify(saved.events[at])) throw new CheckpointError(`Milestone #${m.seq} differs from the event it buffers.`);
    return w.events[at];
  });
  // An encounter-start payload's `types` is the descriptor's own frozen kind list.
  for (const e of new Set([...w.events, ...w.milestones])) {
    if (e?.type !== 'encounter-start') continue;
    const kinds = encounterList(campaign)[e.encounter]?.kinds;
    if (!kinds || !Array.isArray(e.types) || e.types.length !== kinds.length || e.types.some((k, i) => k !== kinds[i])) throw new CheckpointError(`Event #${e.seq} names kinds its encounter does not field.`);
    e.types = kinds;
  }
  bindCampaign(w, campaign);
  const refusal = scopeRefusal(w, checkpoint.scope);
  if (refusal) throw new CheckpointError(`The checkpoint is not at ${checkpoint.scope === LIVE_SCOPE ? 'a live step boundary' : 'an encounter boundary'}: ${refusal}.`);
  return { world: w, requestMap };
}
