import { settleDamage, settleIntegrity, repairIntegrity, splitBudget, ContactEpisodes, CaptureSystem, evolveGrowth } from './contracts.js';
import { setupEnvironment, environmentAcceleration, stepEnvironment, stepSlalom, movePickup, settleOre } from './environment.js';
import { seedStreams, draw, drawInt, offset, scatter, DIRECTIONS, UNIT } from './rng.js';
import { CHANNELS, GRACE, REARM_GAP, WIDE_IMPACT, contactWindow, targetOf, channelOf, inRearArc } from './kinds.js';
import { CAMPAIGN, campaignOf, formOf, encounterOf, nextEncounterOf, encounterPosition, formById, formPosition, formIdPosition, growthIntervals, resolveForm, resolveEncounter } from './campaign.js';
import { IDENTITIES, DEFAULT_IDENTITY, identityOf, capturesAvailable } from './identities.js';
import { emit as event } from './events.js';
import { REGION_KINDS, moveRegions, mergeHalos, regionDrift, regionThrust, accretionRate, shearRate, elementOf, solarStorm } from './regions.js';
import { TRAITS, RANKS, HABITABLE, SOURCE_ELEMENTS, modsOf, noElements, offerFor } from './traits.js';
import { createArena, bounds } from './arena.js';
import { DEFAULT_FIELD, resolveField, fieldOf, deep, buildSystem, stepWells, gravity, aerobrake, capSpeed, thrustPlayer, strikeWells, playerStrikeDamage,
  wellImpactDamage, clearOfWells, collideWell, bodyKind, touching, playerGravity, enemyGravity, holdAccreted, wellAcceleration, impactLoss, referenceMass, coreMass,
  holdInHorizon } from './field.js';

const TAU = Math.PI * 2;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const angleDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const normal = (x, y) => { const d = Math.hypot(x, y) || 1; return { x: x / d, y: y / d }; };
const alive = e => e.alive && e.mass > 0;
/**
 * The player holds together while it is alive with integrity left (integrity is not matter: src/sim/contracts.js
 * settleIntegrity). A deep field has no integrity: the player is its mass, and is broken apart below the field's core.
 */
const intact = (w, p) => deep(w) ? p.alive && p.mass >= coreMass(w) : p.alive && p.integrity > 0;
/** A timer counting down by dt that ends exactly on its boundary step; the epsilon absorbs float drift from repeated subtraction. */
const countdown = (n, dt) => n - dt > 1e-9 ? n - dt : 0;
// Arena (M2, docs/specs/M2-contact-and-arena-truth.md "Input and arena"; world state since M3 3c, src/sim/arena.js):
// the player and enemies keep the arena's body policy, r + 14 from every edge. Companions keep their unclamped orbit;
// ore and pickups keep their own policies (src/sim/environment.js). Observing enemies steer off their bound from
// WALL_STEER away: a steering distance, not a bound, so it stays here.
const WALL_STEER = 80;
const COMMAND_BUFFER = .15;                      // a press waits this long, inclusive, for the command to be ready
const TELEGRAPH_DAMPING = -120 * Math.log(.88);  // per second, about 15.34: 0.88 per step at 120 Hz, at any step size
const PUSH_PASSES = 4, PUSH_TOLERANCE = .01, RESTITUTION = .3;
function effect(w, type, x, y, detail = {}) {
  w.effects.push({ type, x, y, age: 0, life: .5, ...detail });
  if (w.effects.length > 64) w.effects.shift();
}
const HOOKS = Object.freeze({ event, effect });
// The open field: confine() leaves a body where it is, and no scatter or release is clamped.
const OPEN = Object.freeze({ open: true }), OPEN_BOUNDS = Object.freeze({ minX: -Infinity, maxX: Infinity, minY: -Infinity, maxY: Infinity });
/** The bounds bodies keep: the world's arena, or none in an unbounded field. */
const limits = w => (fieldOf(w).bounded ? w.arena : OPEN);

/**
 * A new run. `identity` is an IDENTITIES id; `form` a form id of `campaign` or, as schema-1 logs record it, its
 * campaign position; `arrangement` the encounter a practice run plays, as its play-order position or its id. Each
 * throws a RangeError when unknown. `campaign` (default: the shipped CAMPAIGN) is the descriptor the world runs on;
 * tests inject others. `telemetry` (harness only; the app never sets it) records where contact is measured each step,
 * as w._measuredAt.
 */
export function createWorld({ seed = 117, identity = DEFAULT_IDENTITY, arrangement = 0, practice = false, form = 0, campaign = CAMPAIGN, telemetry = false, field = DEFAULT_FIELD } = {}) {
  if (!Object.hasOwn(IDENTITIES, identity)) throw new RangeError(`Unknown identity ${JSON.stringify(identity)}: one of ${Object.keys(IDENTITIES).join(', ')}`);
  const start = resolveForm(campaign, form), encounter = resolveEncounter(campaign, arrangement), space = resolveField(field);
  const p = { id: 'player', generation: 1, alive: true, transitioning: false, x: 240, y: 360, vx: 0, vy: 0,
    radius: start.radius, integrity: 100, maxIntegrity: 100, growth: 0, score: 0, angle: 0, invulnerable: 0, pendingCommand: null,
    formation: 'tight', orbitPhase: 0, companions: [], command: { state: 'ready', timer: 0, cooldown: 0, angle: 0 } };
  // Streams (src/sim/rng.js): layout for encounter setup, ai for enemy timers, spawn for runtime scatter.
  // The field (src/sim/field.js) sets the arena and the physics; a classic world is the shipped arena, unchanged.
  const w = { seed, rng: seedStreams(seed), identity, formId: start.id, practice, time: 0, phase: 'playing', arena: createArena(space.arena), field: space.id, wells: [], player: p,
    enemies: [], pickups: [], effects: [], events: [], milestones: [], candidates: [], encounterIndex: practice ? encounter : 0,
    encounterName: '', objective: null, encounterTime: 0, encounterCollected: 0, encounterQuota: 0,
    pendingEvolution: null, threatBudget: { used: 0, max: campaign.threatCapacity },
    stats: { collected: 0, damageTaken: 0, damageDealt: 0, intercepted: 0, harvested: 0, pulses: 0,
      commands: 0, transitions: 0, captures: 0, cleanDodges: 0, guardExploits: 0, encountersCleared: 0,
      maxCommitted: 0, settledImpacts: 0, resourceSpawned: 0, scavenged: 0, returned: 0, evolutions: 0,
      rocksBroken: 0, oreReleased: 0, streamReleased: 0, streamCollected: 0, gatesPassed: 0, slalomsCompleted: 0, maxEnvironmentAcceleration: 0, unallocated: 0 },
    // Contact episodes for every channel, ore included (src/sim/kinds.js); grace-suppressed serials per grace window.
    _contacts: new ContactEpisodes({ hysteresis: REARM_GAP }), _graceSuppressed: new Set(), _capture: new CaptureSystem({ ...campaign.capture }),
    _commandHeld: false, _id: 0, _eventSequence: 0, _telemetry: !!telemetry, _measuredAt: null };
  // Deep-field statistics exist only in deep worlds, so a classic world's stats (and its golden view) are unchanged.
  // The ship's heading and throttle, likewise, exist only in deep worlds (src/sim/field.js thrustPlayer).
  if (space.physics) {
    Object.assign(w.stats, { wellStrikes: 0, oreStrikes: 0, knockouts: 0, peakSpeed: 0, accreted: 0, released: 0, flares: 0, merges: 0, collisions: 0, chunks: 0, shed: 0, enemyAccreted: 0 });
    Object.assign(p, { heading: 0, throttle: 0, mass: Math.round(space.physics.player.start * (start.radius / space.physics.massReference) ** 2) });
    w.regions = []; Object.assign(w.stats, { dustAccreted: 0, sheared: 0, haloed: 0, irradiated: 0, lifeDrawn: 0, traits: 0, swallowed: 0, comets: 0, solarStorms: 0 });
    // Composition and traits (src/sim/traits.js): what the body has accreted, the traits it has taken and their
    // modifiers, the ranks it has reached in its form, picks earned but not yet offered, the offer it holds, how many
    // offers it has had (each offer's key), and the forms it has been (their trees stay open).
    Object.assign(p, { elements: noElements(), traits: [], mods: modsOf([]), rank: 0, banked: 0, offer: null, offers: 0, lineage: [] });
  }
  bindCampaign(w, campaign);
  IDENTITIES[identity].setup(w, p, start);
  setupEncounter(w); event(w, 'choice', { identity, form: formPosition(w), seed, practice }); return w;
}

/**
 * Gives world `w` the descriptor it runs on. The descriptor is not state: it stays out of JSON and copies. `form` is
 * the derived campaign position, kept read-only for tests and tools; nothing in src/ reads it
 * (tests/registry-scan.test.mjs). createWorld and the checkpoint restore (src/sim/checkpoint.js) both call this.
 */
export function bindCampaign(w, campaign) {
  Object.defineProperty(w, 'campaign', { value: campaign, enumerable: false });
  Object.defineProperty(w, 'form', { get() { return formPosition(this); }, enumerable: false });
  return w;
}

/**
 * Fragments `total` matter into up to `count` pickups scattered within `spread` of (x, y). In a deep field nothing is
 * clamped to the arena, and each fragment moves with `motion` ({ vx, vy }, the source's velocity) plus up to the
 * field's debris speed outward along its scatter.
 */
function spawnBudget(w, total, x, y, count = 5, spread = 48, source = 'pocket', stream = 'spawn', motion = null) {
  const spawned = [], physics = fieldOf(w).physics;
  for (const value of splitBudget(total, count)) {
    if (!value) continue;
    const radius = 4 + Math.sqrt(value), { minX, maxX, minY, maxY } = physics ? OPEN_BOUNDS : bounds(w.arena, 'scatter', radius);
    const d = scatter(w.rng, stream, spread), kick = physics ? physics.debrisSpeed / Math.max(1, spread) : 0;
    const pickup = { id: `matter-${++w._id}`, x: clamp(x + d.x, minX, maxX), y: clamp(y + d.y, minY, maxY),
      vx: physics ? (motion?.vx ?? 0) + d.x * kick : 0, vy: physics ? (motion?.vy ?? 0) + d.y * kick : 0, value, radius, source };
    w.pickups.push(pickup); spawned.push(pickup);
  }
  w.stats.resourceSpawned += total;
  return spawned;
}

function setupEncounter(w, preserveMotion = false) {
  const a = encounterOf(w), form = formOf(w), kinds = campaignOf(w).kinds, p = w.player;
  w.encounterName = a.name; w.encounterTime = 0; w.encounterCollected = 0;
  w.encounterQuota = Math.ceil(form.threshold / 2);
  w.encounterDuration = form.encounterDuration * (fieldOf(w).durationScale ?? 1); w.threatBudget.used = 0;
  // Copy is the app's (src/app/strings.js): the simulation keeps the objective as a key and its parameters.
  w.objective = { key: 'objective.encounter', params: { quota: w.encounterQuota, duration: w.encounterDuration } };
  // Requests can outlive a UI preview. Retire outgoing candidates so no stale request
  // can acquire an entity from an encounter that has already ended.
  for (const c of w.candidates) w._capture.resetEntity(c);
  w.pickups = []; w.enemies = []; w.candidates = []; w.effects = []; resetContact(w);
  if (!preserveMotion) { p.x = 220; p.y = 360; p.vx = 0; p.vy = 0; }
  // Deep fields: the star system first (src/sim/field.js buildSystem), and where everything starts in it. Every
  // encounter is a new system, so the player always starts in orbit in it. A classic field has none and draws nothing.
  const system = buildSystem(w, n => drawInt(w.rng, 'layout', n), { slots: a.kinds.length, ore: form.oreCount * (fieldOf(w).oreScale ?? 1) });
  if (system) Object.assign(p, system.player, { heading: Math.atan2(system.player.vy, system.player.vx), throttle: 0 });
  if (system) w.regions = system.regions;
  p.command = { state: 'ready', timer: 0, cooldown: 0, angle: 0 }; p.transitioning = false;
  const pocketPositions = [{ x: 330, y: 185 }, { x: 625, y: 520 }, { x: 930, y: 185 }, { x: 1070, y: 525 }, { x: 160, y: 560 }];
  const budgets = splitBudget(form.pocketMatter, pocketPositions.length);
  pocketPositions.forEach((v, i) => system
    ? spawnBudget(w, budgets[i], system.pockets[i].x, system.pockets[i].y, 4, 49, 'pocket', 'layout', system.pockets[i])
    : spawnBudget(w, budgets[i], v.x + offset(w.rng, 'layout', 35), v.y + offset(w.rng, 'layout', 27), 4, 49, 'pocket', 'layout'));
  a.kinds.forEach((type, i) => {
    // Deep fields: opponents scale with the form, as the player's reference mass does, so they stay its match, and
    // with every trait the player has taken (an arms race: the system's other bodies evolve too, src/sim/traits.js).
    const adapt = deep(w) ? 1 + fieldOf(w).physics.enemy.adapt * (p.traits?.length ?? 0) : 1;
    const mass = (deep(w) ? Math.round(kinds[type].mass * referenceMass(w, form) / fieldOf(w).physics.player.start * adapt) : kinds[type].mass) + form.enemyMass;
    w.enemies.push({ id: `enemy-${w.encounterIndex}-${i}`, generation: 1, alive: true, type,
      x: 820 + i * 220, y: i ? 490 : 285, vx: 0, vy: 0, radius: kinds[type].radius + form.enemyRadius,
      mass, hp: mass, maxHp: mass, state: 'observe', timer: 2.3 + i * 1.4, angle: Math.PI, guardAngle: Math.PI,
      stolen: 0, target: { x: p.x, y: p.y }, telegraph: null, hitDuringCommit: false,
      // Window serials (one per commit, one per recover window); closing marks a commit's final segment;
      // attackOverlap is the latest attack serial the player's body overlapped before push-out (harness telemetry);
      // closest is the least centre distance to the player over the current commit's path (clean dodges).
      serials: { attack: 0, recover: 0 }, closing: false, attackOverlap: 0, closest: Infinity });
    const enemy = w.enemies.at(-1);
    // Deep fields: how large an enemy can grow by accreting, and how much of its mass is matter the player shed.
    if (system) Object.assign(enemy, system.enemies[i], { capMass: Math.round(mass * fieldOf(w).physics.enemy.growth), shedHeld: 0 });
    else if (distance(enemy, p) < 220) { enemy.x = p.x > 640 ? 280 + i * 160 : 940 + i * 140; enemy.y = i ? 500 : 240; }
  });
  if (capturesAvailable(w)) identityOf(w).candidates(w, p, form.capture);
  if (system) w.candidates.forEach((c, i) => Object.assign(c, system.candidates[i % system.candidates.length]));
  setupEnvironment(w, n => drawInt(w.rng, 'layout', n), system);
  if (system) for (const b of [p, ...w.pickups, ...w.enemies, ...w.candidates, ...w.rocks, ...w.gates]) clearOfWells(w, b);
  updateCompanions(w, 0); event(w, 'encounter-start', { encounter: w.encounterIndex, form: formPosition(w), types: a.kinds });
}

/** Grace, the pending command, window serials and separation history start fresh at encounter setup and on evolution. */
function resetContact(w) {
  w.player.invulnerable = 0; w.player.pendingCommand = null;
  for (const e of w.enemies) Object.assign(e, { serials: { attack: 0, recover: 0 }, closing: false, attackOverlap: 0, closest: Infinity });
  w._contacts = new ContactEpisodes({ hysteresis: REARM_GAP }); w._graceSuppressed.clear();
}

function gain(w, amount, source, element = SOURCE_ELEMENTS[source] ?? 'rock') {
  if (!amount) return;
  const p = w.player;
  let recognized = 0;
  // Deep fields: matter is the player's mass. What it shed and takes back restores mass, never growth, score or quota.
  // Everything else adds its element to the body's composition.
  if (deep(w)) {
    p.mass += amount;
    if (source === 'shed') { event(w, 'collection', { value: amount, source, recognized: 0 }); return; }
    if (p.elements && element) p.elements[element] = (p.elements[element] ?? 0) + amount;
  }
  if (!formOf(w).next) {
    // The base collection score is retained. Only newly overflowing intake earns
    // the terminal recognition bonus; capped growth is never resettled per frame.
    const ledger = evolveGrowth({ formIndex: formPosition(w), growth: p.growth, score: p.score + amount }, amount, growthIntervals(campaignOf(w)));
    p.growth = ledger.growth; p.score = ledger.score; recognized = ledger.recognized;
  } else { p.growth += amount; p.score += amount; }
  w.encounterCollected += amount; w.stats.collected += amount;
  event(w, 'collection', { value: amount, source, recognized });
  if (recognized) event(w, 'overflow-recognition', { value: recognized, source, form: formPosition(w) });
  if (p.traits) rankUp(w);
}

/**
 * Deep fields: growth through a form reaches its ranks (src/sim/traits.js RANKS, shares of the form's threshold); each
 * earns a pick, offered one at a time.
 */
function rankUp(w) {
  const p = w.player, form = formOf(w);
  while (p.rank < RANKS.length && p.growth >= Math.ceil(RANKS[p.rank] * form.threshold)) { p.rank++; p.banked++; }
  offerNext(w);
}

/** Offers the next banked pick, when none is held: three traits the body can take, and the nearest locked ones. */
function offerNext(w) {
  const p = w.player;
  if (p.offer || !p.banked) return;
  const offer = offerFor({ seed: w.seed, key: `${w.formId}|${p.offers}`, formId: w.formId, earlier: p.lineage, traits: p.traits, elements: p.elements });
  p.banked--; p.offers++;
  if (!offer.options.length) return offerNext(w);
  p.offer = { options: offer.options, locked: offer.locked };
  event(w, 'trait-offer', { options: [...offer.options], locked: offer.locked.map(l => l.id) });
}

/**
 * Takes trait `id` from the offer the player holds (deep fields): its modifiers apply from the next step, and the next
 * banked pick is offered. Returns false when there is no offer, it does not hold `id`, or the run is over.
 */
export function chooseTrait(w, id) {
  const p = w.player;
  if (!p.offer || !p.offer.options.includes(id) || w.phase === 'won' || w.phase === 'lost') return false;
  p.traits.push(id); p.mods = modsOf(p.traits); p.offer = null; w.stats.traits++;
  event(w, 'trait-chosen', { trait: id, form: formPosition(w) });
  offerNext(w); return true;
}

function previewEvolution(w) {
  const form = formOf(w);
  if (!form.next || w.practice || !encounterOf(w).completesForm || w.player.growth < form.threshold || !encounterSatisfied(w)) return;
  const next = formById(campaignOf(w), form.next), identity = identityOf(w), from = formPosition(w);
  const ledger = evolveGrowth({ formIndex: from, growth: w.player.growth, score: w.player.score }, 0, growthIntervals(campaignOf(w)));
  // The preview names its forms and identity by id, and its lines by string-table key (src/app/strings.js); the app renders them.
  w.pendingEvolution = { from: form.id, to: next.id, identity: w.identity,
    retained: identity.retained(w.player),
    tradeoff: `identity.${w.identity}.tradeoff`, successor: `identity.${w.identity}.successor.${next.id}`,
    overflow: ledger.overflow, carried: ledger.carried, recognized: ledger.recognized };
  w.phase = 'evolution'; w.player.transitioning = true;
  event(w, 'evolution-preview', { from, to: formIdPosition(campaignOf(w), next.id), growth: w.player.growth });
}

function encounterSatisfied(w) {
  return w.encounterCollected >= w.encounterQuota && (w.slalom.complete || w.encounterTime >= w.encounterDuration || w.enemies.every(e => !alive(e)));
}

export function evolveWorld(w) {
  if (w.phase !== 'evolution' || !w.pendingEvolution || !formOf(w).next) return false;
  const roles = w.player.companions.map(c => c.role), campaign = campaignOf(w);
  const ledger = evolveGrowth({ formIndex: formPosition(w), growth: w.player.growth, score: w.player.score }, 0, growthIntervals(campaign));
  if (!ledger.evolved) return false;
  // One form per operation (contracts.js evolveGrowth), into the form's successor, named by id. evolveGrowth's interval
  // order is campaign order, and defineCampaign requires every successor to be the following form.
  const form = formById(campaign, formOf(w).next);
  w.formId = form.id; w.player.growth = ledger.growth; w.player.score = ledger.score;
  w.player.radius = form.radius; repairIntegrity(w.player, campaign.evolutionRepair);
  // Deep fields: the body re-forms at its new form's reference mass, nimble again (src/sim/field.js load).
  if (deep(w)) {
    w.player.mass = referenceMass(w, form);
    if (w.player.traits) { w.player.lineage.push(campaign.forms.find(f => f.next === form.id).id); w.player.rank = 0; }
  }
  w.player.transitioning = false; w.player.command = { state: 'ready', timer: 0, cooldown: 0, angle: w.player.angle };
  for (const c of w.player.companions) { c.tier = form.evolvedTier; c.radius = form.moonRadius; }
  w._capture.reapply(w.player, { reach: form.moonReach }); resetContact(w);
  w.stats.evolutions++; w.pendingEvolution = null; clearEncounter(w);
  event(w, 'evolution', { form: formPosition(w), roles, carried: ledger.carried, recognized: ledger.recognized }); return true;
}

function clearEncounter(w) {
  if (w.phase === 'encounter-clear' || w.phase === 'won') return;
  // The payload keeps its registered field name, hp (src/sim/events.js), for the player's integrity.
  w.stats.encountersCleared++; w.phase = (w.practice || !encounterOf(w).next) ? 'won' : 'encounter-clear';
  event(w, 'encounter-clear', { encounter: w.encounterIndex, elapsed: w.encounterTime, matter: w.encounterCollected, hp: deep(w) ? w.player.mass : w.player.integrity,
    route: w.slalom.complete ? 'slalom' : w.enemies.every(e => !alive(e)) ? 'combat' : 'survival' });
  if (w.phase === 'won') event(w, 'run-complete', { identity: w.identity, form: formPosition(w), score: w.player.score });
}

export function nextEncounter(w) {
  const next = nextEncounterOf(w);
  if (w.phase !== 'encounter-clear' || !next) return false;
  w.encounterIndex = encounterPosition(campaignOf(w), next.id); w.phase = 'playing';
  repairIntegrity(w.player, campaignOf(w).handoffRepair);
  setupEncounter(w, true); return true;
}

export function requestCapture(w, candidateId, replaceIndex = null) {
  const c = w.candidates.find(c => c.id === candidateId);
  if (!capturesAvailable(w) || w.phase !== 'playing' || !c) return { ok: false, reason: 'captures-unavailable' };
  // A preview offered mid-change could never be confirmed (commit revalidates the same condition): refuse it here.
  if (w.player.transitioning) return { ok: false, reason: 'transitioning' };
  const index = replaceIndex === null ? null : Number(replaceIndex);
  const lost = index !== null ? w.player.companions[index] : null;
  const token = w._capture.request(w.player, c, { replaceId: lost?.id ?? null });
  return { ok: true, candidateId, replaceIndex: index, token, preview: { incomingRole: c.role, lostRole: lost?.role ?? null,
    message: { key: 'capture.preview', params: { incoming: c.role, lost: lost?.role ?? null } } } };
}

export function commitCapture(w, request) {
  if (!request?.token || w.phase !== 'playing' || !capturesAvailable(w)) return { ok: false, reason: 'capture-unavailable' };
  const result = w._capture.commit(request.token);
  if (result.ok) {
    w.stats.captures++; w.candidates = w.candidates.filter(c => c.ownerId === null);
    if (result.released) {
      const { minX, maxX, minY, maxY } = deep(w) ? OPEN_BOUNDS : bounds(w.arena, 'released', result.released.radius);
      if (deep(w)) { result.released.vx = w.player.vx; result.released.vy = w.player.vy; }
      result.released.x = clamp(w.player.x - 75, minX, maxX);
      // On an axis the policy does not bound, (-Infinity, Infinity), clamp returns the player's y bit-identically
      // (including -0 and NaN), so the shipped x-only policy keeps the old literal y.
      result.released.y = clamp(w.player.y, minY, maxY);
      w.candidates.push(result.released);
    }
    event(w, 'capture', { candidate: request.candidateId, roles: w.player.companions.map(c => c.role) });
    updateCompanions(w, 0);
  } else event(w, 'capture-failed', { reason: result.reason });
  return result;
}

/**
 * The command input model shared by the app, bots and replays: a rising edge (holding the key never retriggers)
 * waits as the player's pendingCommand until an inclusive deadline COMMAND_BUFFER seconds later, and fires once, on
 * the first step the command is ready. A repeated press replaces it. Timers advance before the check, so a press
 * whose deadline lands exactly on the readiness step fires.
 */
function command(w, input, dt) {
  const p = w.player, c = p.command;
  c.cooldown = countdown(c.cooldown, dt);
  if (c.timer > 0) {
    c.timer = countdown(c.timer, dt);
    if (!c.timer) {
      if (c.state === 'transition') { c.state = 'ready'; p.transitioning = false; event(w, 'formation-ready', { formation: p.formation }); }
      else if (c.state === 'commit') { c.state = 'recover'; c.timer = .60; }
      else if (c.state === 'recover') c.state = 'ready';
    }
  }
  const pressed = !!input.command && !w._commandHeld; w._commandHeld = !!input.command;
  const identity = identityOf(w);
  if (pressed && identity.command) p.pendingCommand = w.time + COMMAND_BUFFER;
  if (p.pendingCommand == null) return;
  if (w.time - p.pendingCommand > 1e-9) { p.pendingCommand = null; return; }
  if (c.state !== 'ready' || c.cooldown > 0) return;
  p.pendingCommand = null; w.stats.commands++;
  identity.command?.(w, p, c, formOf(w), HOOKS);
}

function updatePlayer(w, input, dt) {
  const p = w.player, c = p.command;
  const m = normal(Number(input.x) || 0, Number(input.y) || 0);
  if (Number.isFinite(input.aimX) && Number.isFinite(input.aimY) && Math.hypot(input.aimX - p.x, input.aimY - p.y) > 4) p.angle = Math.atan2(input.aimY - p.y, input.aimX - p.x);
  else if (m.x || m.y) p.angle = Math.atan2(m.y, m.x);
  command(w, input, dt);
  let desiredX, desiredY;
  const form = formOf(w), bursting = identityOf(w).bursting(c);
  if (bursting) {
    p.angle = c.angle; const speed = form.burst.speed; desiredX = Math.cos(c.angle) * speed; desiredY = Math.sin(c.angle) * speed;
  } else {
    const speed = form.speed * (c.state === 'recover' ? .72 : 1);
    desiredX = m.x * speed; desiredY = m.y * speed;
  }
  const flow = bursting ? { x: 0, y: 0 } : environmentAcceleration(w, p);
  w.stats.maxEnvironmentAcceleration = Math.max(w.stats.maxEnvironmentAcceleration, Math.hypot(flow.x, flow.y));
  if (deep(w)) {
    // Momentum (src/sim/field.js thrustPlayer): the ship turns and spools toward the input, and thrust, gravity and the
    // current integrate; nothing steers the velocity to the input. A burst is a hard, committed push along its angle,
    // its speed delivered over its duration on top of the momentum the ship already has.
    if (bursting) {
      const g = playerGravity(w, p, w.wells, form), push = form.burst.speed / form.burst.duration;
      p.vx += (Math.cos(c.angle) * push + g.x) * dt; p.vy += (Math.sin(c.angle) * push + g.y) * dt; p.heading = c.angle;
      aerobrake(w.wells, p, dt); capSpeed(w, p);
    } else thrustPlayer(w, p, m, form, (c.state === 'recover' ? .72 : 1) * regionThrust(w.regions, p, p.mods?.ion ?? 1), flow, dt);
    regionDrift(w.regions, p, dt, null, p.mods?.drag ?? 1); capSpeed(w, p);
    w.stats.peakSpeed = Math.max(w.stats.peakSpeed, Math.hypot(p.vx, p.vy));
    p.x += p.vx * dt; p.y += p.vy * dt;
    return;
  }
  const response = bursting ? 28 : 18, cap = bursting ? 7800 : 2800;
  let ax = (desiredX - p.vx) * response + flow.x, ay = (desiredY - p.vy) * response + flow.y;
  const magnitude = Math.hypot(ax, ay); if (magnitude > cap) { ax *= cap / magnitude; ay *= cap / magnitude; }
  p.vx += ax * dt; p.vy += ay * dt;
  // Keep burst momentum on entering recovery; the bounded steering acceleration
  // slows it naturally instead of applying an instantaneous normal-speed clamp.
  const speedCap = 610;
  const speed = Math.hypot(p.vx, p.vy); if (speed > speedCap) { p.vx *= speedCap / speed; p.vy *= speedCap / speed; }
  p.x += p.vx * dt; p.y += p.vy * dt; confine(p, w.arena);
}

/**
 * The arena's body policy for the player and enemies: a centre stays r + 14 from every edge of `arena` (bounds), and
 * velocity into a wall is removed.
 */
function confine(b, arena) {
  if (arena === OPEN) return;
  const { minX, maxX, minY, maxY } = bounds(arena, 'body', b.radius);
  if (b.x <= minX) { b.x = minX; if (b.vx < 0) b.vx = 0; } else if (b.x >= maxX) { b.x = maxX; if (b.vx > 0) b.vx = 0; }
  if (b.y <= minY) { b.y = minY; if (b.vy < 0) b.vy = 0; } else if (b.y >= maxY) { b.y = maxY; if (b.vy > 0) b.vy = 0; }
}

function updateCompanions(w, dt) {
  const p = w.player, wide = p.formation === 'wide', moonRadius = formOf(w).moonRadius;
  p.orbitPhase += dt * (wide ? .95 : 1.65);
  p.companions.forEach((c, i) => {
    c.cooldown = Math.max(0, (c.cooldown || 0) - dt);
    const target = p.radius + (wide ? 85 : 22);
    c.orbitRadius ??= target;
    if (c.orbitTransitionElapsed !== undefined && c.orbitTransitionElapsed < .65) {
      c.orbitTransitionElapsed = Math.min(.65, c.orbitTransitionElapsed + dt);
      c.orbitRadius = c.orbitFromRadius + (target - c.orbitFromRadius) * c.orbitTransitionElapsed / .65;
    } else c.orbitRadius += clamp(target - c.orbitRadius, -100 * dt, 100 * dt);
    const orbit = c.orbitRadius, angle = p.orbitPhase + i * TAU / p.companions.length;
    c.x = p.x + Math.cos(angle) * orbit; c.y = p.y + Math.sin(angle) * orbit;
    c.angle = angle; c.radius = moonRadius;
  });
}

function updateEnemy(w, e, dt) {
  if (!alive(e)) return;
  const kind = campaignOf(w).kinds[e.type], physics = fieldOf(w).physics;
  e.timer -= dt;
  if (e.state === 'observe') {
    const a = Math.atan2(w.player.y - e.y, w.player.x - e.x);
    e.guardAngle += clamp(angleDelta(a, e.guardAngle), -.65 * dt, .65 * dt);
    const d = distance(e, w.player);
    if (physics) {
      // Deep fields: an enemy thrusts, it does not steer. Within engage range it works toward the player's own motion
      // plus its hover band (closing fast from far off); beyond, it coasts with its home, its telegraph held.
      const ep = physics.enemy, p = w.player;
      if (d <= ep.engage) {
        const speed = kind.observeSpeed * (d > 2 * kind.hover.far ? 4 : 1), keep = d > kind.hover.far ? 1 : d < kind.hover.near ? kind.hover.back : 0;
        let dvx = p.vx + Math.cos(a) * speed * keep - e.vx, dvy = p.vy + Math.sin(a) * speed * keep - e.vy;
        const dv = Math.hypot(dvx, dvy), cap = ep.thrust * dt; if (dv > cap) { dvx *= cap / dv; dvy *= cap / dv; }
        e.vx += dvx; e.vy += dvy;
      } else e.timer = Math.max(e.timer, .6);
      const g = enemyGravity(w, e); e.vx += g.x * dt; e.vy += g.y * dt; aerobrake(w.wells, e, dt);
    } else {
    const speed = kind.observeSpeed, keep = d > kind.hover.far ? 1 : d < kind.hover.near ? kind.hover.back : 0;
    // Observing bodies steer off the walls: within WALL_STEER of their bound, up to their own speed away from it.
    const { minX, maxX, minY, maxY } = bounds(w.arena, 'body', e.radius), off = (n, lo, hi) => Math.max(0, 1 - (n - lo) / WALL_STEER) - Math.max(0, 1 - (hi - n) / WALL_STEER);
    let vx = Math.cos(a) * speed * keep + off(e.x, minX, maxX) * speed, vy = Math.sin(a) * speed * keep + off(e.y, minY, maxY) * speed;
    const v = Math.hypot(vx, vy); if (v > speed) { vx *= speed / v; vy *= speed / v; }
    e.vx = vx; e.vy = vy;
    }
    if (e.timer <= 0 && physics) {
      // A deep-field charge is relative: it aims where the player will be, as seen from the enemy's own drift, and adds
      // the commit speed to that drift. The telegraph holds the whole burn (its direction, speed and velocity), so the
      // corridor drawn is the straight line the commit will fly.
      e.state = 'telegraph'; e.timer = kind.telegraph;
      const p = w.player, lead = kind.target.rule === 'player' ? kind.telegraph * physics.enemy.lead : 0;
      const t = targetOf(kind, w, e); e.target = { x: t.x + (p.vx - e.vx) * lead, y: t.y + (p.vy - e.vy) * lead };
      e.angle = Math.atan2(e.target.y - e.y, e.target.x - e.x);
      const burn = kind.commitSpeed * physics.enemy.commitScale, vx = e.vx + Math.cos(e.angle) * burn, vy = e.vy + Math.sin(e.angle) * burn;
      e.telegraph = { x: e.target.x, y: e.target.y, angle: Math.atan2(vy, vx), width: e.radius * 2 + 10, vx, vy, speed: Math.hypot(vx, vy) };
      event(w, 'telegraph', { enemy: e.id, enemyType: e.type });
    } else if (e.timer <= 0) {
      e.state = 'telegraph'; e.timer = kind.telegraph;
      e.target = targetOf(kind, w, e); e.angle = Math.atan2(e.target.y - e.y, e.target.x - e.x);
      e.telegraph = { x: e.target.x, y: e.target.y, angle: e.angle, width: e.radius * 2 + 10 };
      event(w, 'telegraph', { enemy: e.id, enemyType: e.type });
    }
  } else if (e.state === 'telegraph') {
    // A deep-field enemy coasts through its telegraph; a classic one brakes.
    if (physics) { const g = enemyGravity(w, e); e.vx += g.x * dt; e.vy += g.y * dt; aerobrake(w.wells, e, dt); }
    else { const damping = Math.exp(-TELEGRAPH_DAMPING * dt); e.vx *= damping; e.vy *= damping; }
    if (e.timer <= 0 && w.threatBudget.used < campaignOf(w).threatCapacity) {
      e.state = 'commit'; e.timer = kind.commit; e.serials.attack++;
      w.threatBudget.used++; w.stats.maxCommitted = Math.max(w.stats.maxCommitted, w.threatBudget.used); e.hitDuringCommit = false; e.closest = Infinity;
      event(w, 'enemy-commit', { enemy: e.id, enemyType: e.type });
    }
  } else if (e.state === 'commit') {
    const speed = kind.commitSpeed;
    if (physics && e.telegraph?.vx !== undefined) { e.vx = e.telegraph.vx; e.vy = e.telegraph.vy; }
    else { e.vx = Math.cos(e.angle) * speed; e.vy = Math.sin(e.angle) * speed; }
    // The last step of a commit still moves and resolves as attacking; closeCommit opens recovery after contacts.
    if (e.timer <= 0) e.closing = true;
  } else if (physics) {
    // A recovering enemy glides: knockback and gravity carry it, into a well core if the shot was good.
    const damping = Math.exp(-dt * physics.enemy.recoverDamping), g = enemyGravity(w, e);
    e.vx = e.vx * damping + g.x * dt; e.vy = e.vy * damping + g.y * dt; aerobrake(w.wells, e, dt);
    if (e.timer <= 0) { e.state = 'observe'; e.timer = 1.5 + draw(w.rng, 'ai') * .65; w._contacts.close(e, 'recover', e.serials.recover); }
  } else {
    e.vx *= Math.exp(-dt * 8); e.vy *= Math.exp(-dt * 8);
    if (e.timer <= 0) { e.state = 'observe'; e.timer = 1.5 + draw(w.rng, 'ai') * .65; w._contacts.close(e, 'recover', e.serials.recover); }
  }
  if (physics && e.state !== 'commit') regionDrift(w.regions, e, dt);
  if (physics) capSpeed(w, e);
  e.x += e.vx * dt; e.y += e.vy * dt; confine(e, limits(w));
  if (kind.theft && e.state === 'commit') {
    w.pickups = w.pickups.filter(p => {
      if (p.source === 'cache' || p.source === 'shed' || distance(e, p) >= e.radius + p.radius + kind.theft.reach || e.stolen >= kind.theft.cap) return true;
      e.stolen += p.value; w.stats.scavenged += p.value; event(w, 'scavenge', { value: p.value, enemy: e.id }); return false;
    });
  }
}

/** The one cache return: natural recovery, interception and defeat. Moves the value out of `stolen`, at most once per theft. */
function returnCache(w, e) {
  if (!e.stolen) return;
  const value = e.stolen; e.stolen = 0;
  spawnBudget(w, value, e.x, e.y, 4, 52, 'cache', 'spawn', e); w.stats.returned += value; w.stats.resourceSpawned -= value;
  event(w, 'cache-return', { value, enemy: e.id });
}

/** The attack window ends (recovery, interception or defeat): release the threat budget once and close its serial. */
function endAttack(w, e) {
  e.telegraph = null; e.closing = false; w.threatBudget.used = Math.max(0, w.threatBudget.used - 1);
  w._contacts.close(e, 'attack', e.serials.attack); w._contacts.close(e, 'intercept', e.serials.attack);
}

/**
 * Closes a commit after its final segment's contacts: recover transition, clean-dodge accounting, cache return.
 * A clean dodge is a near miss of a commit that targeted the player (the kind's `cleanDodges`: charger and guard): no
 * settled hit on the serial, and the least centre distance over the committed path beyond R (touching is contact) and
 * at most 1.5R, where R is the summed collision radius.
 */
function closeCommit(w, e) {
  e.closing = false;
  if (!alive(e) || e.state !== 'commit') return;
  const kind = campaignOf(w).kinds[e.type];
  endAttack(w, e); e.state = 'recover'; e.timer = kind.recover; e.serials.recover++;
  const reach = w.player.radius + e.radius;
  if (!e.hitDuringCommit && kind.cleanDodges && e.closest > reach && e.closest <= 1.5 * reach) { w.stats.cleanDodges++; event(w, 'clean-dodge', { enemy: e.id }); }
  returnCache(w, e);
}

/** The least distance between two centres moving linearly over a step: `a` from (ax, ay), `b` from `from`, to where each is now. */
function closestApproach(ax, ay, a, from, b) {
  const rx = ax - from.x, ry = ay - from.y, dx = a.x - b.x - rx, dy = a.y - b.y - ry, dd = dx * dx + dy * dy;
  const t = dd > 1e-12 ? clamp(-(rx * dx + ry * dy) / dd, 0, 1) : 0;
  return Math.hypot(rx + dx * t, ry + dy * t);
}

/**
 * Settles `requested` on enemy `e`. `options` (deep fields' collision resolver): `transferFraction` and
 * `debrisFraction` replace the harvest and debris fractions, `kick: false` leaves its motion to the collision,
 * `onTransfer(value)` receives the credited transfer instead of the player and `onDebris(value)` the debris instead of
 * a scatter of matter. Without options, the shipped settlement.
 */
function settleEnemy(w, e, attacker, requested, harvesting, channel, options = {}) {
  const transferFraction = options.transferFraction ?? (harvesting ? .25 : 0), debrisFraction = options.debrisFraction ?? (harvesting ? .25 : .35);
  const massBefore = e.mass, result = settleDamage(e, { requested, transferFraction, debrisFraction });
  e.hp = e.mass; w.stats.unallocated += result.unallocated;
  // `impact` (deep fields: ore and well strikes) is a persistent channel outside the kind table, so it has no serial.
  event(w, 'contact-settle', { channel, serial: CHANNELS[channel]?.finite ? contactWindow(e, channel).serial : null, pair: [attacker.id, e.id], settledLoss: result.settledLoss });
  if (!result.settledLoss) return result;
  if (deep(w) && options.kick !== false) {
    // Knockback: the settled loss moves the enemy away from what struck it, more for a lighter body.
    const physics = fieldOf(w).physics, n = normal(e.x - attacker.x, e.y - attacker.y), kick = Math.min(420, result.settledLoss * physics.knockback / Math.max(1, massBefore));
    e.vx += n.x * kick; e.vy += n.y * kick;
  }
  w.stats.damageDealt += result.settledLoss; w.stats.settledImpacts++;
  // Deep fields: matter the enemy holds of the player's shed mass leaves it first and stays shed (debris, then transfer),
  // so it never comes back to the player as growth. A classic enemy holds none.
  const shedOut = Math.min(e.shedHeld ?? 0, result.debris + result.creditedTransfer), shedDebris = Math.min(shedOut, result.debris), shedTransfer = shedOut - shedDebris;
  if (shedOut) e.shedHeld -= shedOut;
  if (result.creditedTransfer) {
    if (options.onTransfer) options.onTransfer(result.creditedTransfer, shedTransfer);
    else {
      if (shedTransfer) gain(w, shedTransfer, 'shed');
      if (result.creditedTransfer - shedTransfer) { gain(w, result.creditedTransfer - shedTransfer, 'harvest'); w.stats.harvested += result.creditedTransfer - shedTransfer; }
    }
  }
  if (result.debris) {
    if (options.onDebris) options.onDebris(result.debris, shedDebris);
    else {
      if (shedDebris) spawnBudget(w, shedDebris, e.x, e.y, Math.min(3, shedDebris), 28, 'shed', 'spawn', e);
      if (result.debris - shedDebris) spawnBudget(w, result.debris - shedDebris, e.x, e.y, 3, 28, 'impact', 'spawn', e);
    }
  }
  if (campaignOf(w).kinds[e.type].guardExploits && channel !== 'impact') w.stats.guardExploits++;
  event(w, 'settled-impact', { target: e.id, settledLoss: result.settledLoss, creditedTransfer: result.creditedTransfer, debris: result.debris, unallocated: result.unallocated });
  effect(w, 'impact', e.x, e.y, { amount: result.settledLoss, angle: Math.atan2(e.y - attacker.y, e.x - attacker.x) });
  if (!alive(e)) {
    if (e.state === 'commit') endAttack(w, e);
    if (e.state === 'recover') w._contacts.close(e, 'recover', e.serials.recover);
    e.state = 'defeated'; e.telegraph = null; e.closing = false; returnCache(w, e);
    if (channel === 'impact') w.stats.knockouts++;
    event(w, 'enemy-defeated', { enemy: e.id, enemyType: e.type });
  }
  return result;
}

/** A damage window settles on the player: one hit, then GRACE seconds in which no damage settles. */
function hitPlayer(w, e, channel) {
  const p = w.player;
  let requested = campaignOf(w).kinds[e.type].hit;
  const facing = Math.atan2(e.y - p.y, e.x - p.x);
  const braced = identityOf(w).braced(p, formOf(w), facing);
  if (braced) requested = Math.ceil(requested * .4);
  if (p.command.state === 'transition' || p.command.state === 'recover') requested += 3;
  // Integrity is not matter: the player adapter settles with zero transfer and zero debris (src/sim/contracts.js).
  const result = settleIntegrity(p, { requested });
  p.invulnerable = GRACE; w._graceSuppressed.clear();
  w.stats.damageTaken += result.settledLoss; if (channel === 'attack') e.hitDuringCommit = true;
  event(w, 'contact-settle', { channel, serial: CHANNELS[channel].finite ? e.serials.attack : null, pair: [p.id, e.id], settledLoss: result.settledLoss });
  event(w, 'player-hit', { enemy: e.id, settledLoss: result.settledLoss, braced }); effect(w, 'hurt', p.x, p.y, { amount: result.settledLoss });
}

/** Interception consumes the enemy's attack serial for this pair, opens its recovery and returns any cache. */
function intercept(w, c, e) {
  const serial = e.serials.attack;
  c.cooldown = 2.2; endAttack(w, e); e.state = 'recover'; e.timer = 1.8; e.serials.recover++; e.vx *= .15; e.vy *= .15;
  w.stats.intercepted++;
  event(w, 'contact-settle', { channel: 'intercept', serial, pair: [c.id, e.id], settledLoss: 0 });
  event(w, 'interception', { companion: c.id, enemy: e.id, formation: w.player.formation }); effect(w, 'block', c.x, c.y);
  returnCache(w, e);
}

/** Persistent channels keep each pair's separation history every step, touching or not (rule 2). */
function track(w, a, e, gap) {
  for (const channel of campaignOf(w).kinds[e.type].persistent) if (w._contacts.track(a, e, channel, gap, w.time)) event(w, 'rearm', { channel, pair: [a.id, e.id] });
}

// Contact settles per declared window, never per overlap (src/sim/kinds.js, docs/contracts.md). Each enemy's
// state here is the one it moved with this step: a commit's final segment still attacks (closeCommit runs after).
function resolveContacts(w) {
  const p = w.player, contacts = w._contacts, now = w.time, identity = identityOf(w), kinds = campaignOf(w).kinds;
  for (const e of w.enemies) {
    if (!alive(e)) continue;
    const kind = kinds[e.type];
    // Harness telemetry: the attack serial the player's body overlaps, recorded before any companion can intercept or
    // defeat the enemy this step (code-truth F1). Only a commit uses `attack`, and companions only end one.
    if (distance(p, e) - p.radius - e.radius <= 0 && channelOf(kind, e, p) === 'attack') e.attackOverlap = e.serials.attack;
    for (const c of p.companions) {
      const gap = distance(c, e) - c.radius - e.radius; track(w, c, e, gap);
      // Only the interceptor body, not an invisible orbit ring, stops a charging body; tight orbits reach 9 further.
      if (!identity.companions || p.command.state === 'transition' || gap > (p.formation === 'tight' ? 9 : 0)) continue;
      const channel = channelOf(kind, e, c);
      // The channel the moon meets decides, so the guard's rear arc wins for companions too (code-truth F3): only an
      // open `attack` window, outside the rear arc, can be intercepted. On the rear a wide moon strikes, and a moon in
      // close orbit is neutral. An ineligible overlap (wrong role, cooldown, no open attack serial) consumes nothing.
      if (c.role === 'interceptor' && !c.cooldown && channel === 'attack' && contacts.enter(c, e, 'intercept', contactWindow(e, 'intercept'))) intercept(w, c, e);
      else if (p.formation === 'wide' && CHANNELS[channel]?.effect === 'vulnerability' && contacts.enter(c, e, channel, contactWindow(e, channel, now))) settleEnemy(w, e, c, WIDE_IMPACT, false, channel);
    }
    if (!alive(e)) continue;
    const gap = distance(p, e) - p.radius - e.radius; track(w, p, e, gap);
    if (gap > 0) continue;
    const channel = channelOf(kind, e, p), window = channel && contactWindow(e, channel, now);
    if (CHANNELS[channel]?.effect === 'damage') {
      // Grace is checked before the episode is consumed: a blocked serial stays eligible while its window is open.
      if (!contacts.eligible(p, e, channel, window)) { /* spent: one hit per serial, or the front's 0.8 s clock */ }
      else if (p.invulnerable > 0) {
        const key = `${channel}|${e.id}|${window.serial ?? ''}`;
        if (!w._graceSuppressed.has(key)) { w._graceSuppressed.add(key); event(w, 'grace-suppressed', { channel, serial: window.serial ?? null, enemy: e.id }); }
      } else { contacts.enter(p, e, channel, window); hitPlayer(w, e, channel); }
    } else if (channel && contacts.enter(p, e, channel, window)) {
      // One player-body impact per vulnerability serial: a burst enlarges it (base 17) and never adds a second.
      const harvesting = identity.harvesting(p), direction = normal(e.x - p.x, e.y - p.y);
      const closing = clamp((p.vx - e.vx) * direction.x + (p.vy - e.vy) * direction.y, 0, 600);
      const alignment = Math.max(0, Math.cos(angleDelta(p.angle, Math.atan2(direction.y, direction.x))));
      settleEnemy(w, e, p, Math.floor((harvesting ? 17 : 11) * (1 + .3 * (closing / 600) * alignment)), harvesting, channel);
    }
  }
}

/**
 * Constrained push-out, after every contact has settled on the overlap it saw. The player takes the correction
 * first, up to its bounds, and any remainder moves the enemy within its own. A body that a wall stops on one axis
 * while it takes a remainder, or while it yields around a held player, slides along that wall until the pair clears
 * (shove). Pairs resolve in enemy-id order (byId, which is the order enemies are created in), sorted explicitly so the
 * result never depends on the order of w.enemies, up to PUSH_PASSES passes, until no overlap exceeds PUSH_TOLERANCE.
 * The one exception to "player first" (docs/contracts.md, decision D17 amendment) is the last pass, reached only when
 * the player-first passes have not converged, which happens to a body squeezed between enemies. There the pinned
 * enemies go first, in id order, those that cannot clear the player even by sliding along the wall that stops them
 * (wallPinned), and the player moves off them as in every pass; the free ones then yield around a held player, in id
 * order, and whatever their bounds refuse goes back to the player. So a free enemy cannot press the player back into
 * a pinned one, and an enemy that a wall stops but leaves room to slide yields instead of the player.
 * Coincident centres separate along the enemy's facing, or +x without one. Restitution applies to the approaching
 * part of the relative normal velocity only, player first and the rest to the enemy; tangential velocity is kept,
 * and velocity into a wall is removed.
 */
function pushOut(w) {
  const p = w.player, live = w.enemies.filter(alive).sort(byId), deep = e => p.radius + e.radius - distance(p, e) > PUSH_TOLERANCE, arena = limits(w);
  for (let pass = 1; pass <= PUSH_PASSES; pass++) {
    if (pass < PUSH_PASSES) for (const e of live) separate(p, e, false, arena);
    else {
      const pinned = live.filter(e => deep(e) && wallPinned(p, e, arena));
      for (const e of pinned) separate(p, e, false, arena);
      for (const e of live) if (!pinned.includes(e)) separate(p, e, true, arena);
    }
    if (!live.some(deep)) break;
  }
}

/**
 * Enemy-id order (code-truth F5): typed ids, numbers before strings, numbers by value; strings compare run by run,
 * digit runs by their value and other runs by code unit, so `enemy-0-10` follows `enemy-0-9` and id order is creation
 * order however many enemies an encounter holds. Ids are unique, so the order is total.
 */
export function byId({ id: x }, { id: y }) {
  if (typeof x !== typeof y) return typeof x === 'number' ? -1 : 1;
  if (typeof x === 'number') return x - y;
  const left = x.match(/\d+|\D+/g) ?? [], right = y.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const a = left[i], b = right[i];
    if (a === b) continue;
    if (/^\d/.test(a) && /^\d/.test(b)) {
      const u = a.replace(/^0+/, ''), v = b.replace(/^0+/, '');
      if (u.length !== v.length) return u.length - v.length;
      if (u !== v) return u < v ? -1 : 1;
      continue; // the same value, padded differently: the code-unit tie-break below decides
    }
    return a < b ? -1 : 1;
  }
  return left.length - right.length || (x < y ? -1 : x > y ? 1 : 0);
}

/** The unit normal from enemy e to the player; coincident centres use the enemy's facing, or +x without one. */
function pairNormal(p, e) {
  const d = distance(p, e), facing = Number.isFinite(e.angle) ? e.angle : 0;
  return d > 1e-9 ? { nx: (p.x - e.x) / d, ny: (p.y - e.y) / d } : { nx: Math.cos(facing), ny: Math.sin(facing) };
}

/**
 * Whether the arena bounds keep enemy e from clearing the player by yielding around it: a trial of the very shove a
 * held player's yield applies (separate with hold), wall slide included, on a copy of the enemy.
 */
function wallPinned(p, e, arena) {
  const { nx, ny } = pairNormal(p, e), trial = { x: e.x, y: e.y, vx: 0, vy: 0, radius: e.radius };
  shove(trial, p, p.radius + e.radius - distance(p, e), -nx, -ny, true, arena);
  return p.radius + e.radius - distance(p, trial) > PUSH_TOLERANCE;
}

/**
 * Moves body b away from body o by rest along their centre line ((fx, fy) when the centres coincide), within b's
 * bounds. With slide, a body that a wall stops on one axis carries on along that wall, on the side it was moving,
 * until it clears o: the last body to move in a pair takes the whole remainder when the wall leaves it room.
 */
function shove(b, o, rest, fx, fy, slide, arena) {
  const r = distance(b, o), ux = r > 1e-9 ? (b.x - o.x) / r : fx, uy = r > 1e-9 ? (b.y - o.y) / r : fy;
  const x = b.x + ux * rest, y = b.y + uy * rest;
  b.x = x; b.y = y; confine(b, arena);
  if (!slide || (b.x === x) === (b.y === y)) return; // unstopped, or stopped on both axes in a corner
  const axis = b.x === x ? 'x' : 'y', across = axis === 'x' ? 'y' : 'x', side = Math.sign(axis === 'x' ? ux : uy);
  const reach = b.radius + o.radius, offset = b[across] - o[across];
  if (!side || Math.abs(offset) >= reach) return;
  const target = o[axis] + side * Math.sqrt(reach * reach - offset * offset);
  if ((target - b[axis]) * side > 0) { b[axis] = target; confine(b, arena); }
}

/**
 * Separates the player from one enemy. The player moves first, up to its bounds, and the enemy takes the remainder;
 * with hold, the enemy moves first and the player takes what the enemy's bounds refuse. Then restitution.
 */
function separate(p, e, hold, arena) {
  const gap = () => p.radius + e.radius - distance(p, e), depth = gap();
  if (depth <= PUSH_TOLERANCE) return;
  const { nx, ny } = pairNormal(p, e), [first, second] = hold ? [e, p] : [p, e], sign = hold ? -1 : 1;
  shove(first, second, depth, sign * nx, sign * ny, hold, arena);
  const rest = gap();
  if (rest > 1e-9) shove(second, first, rest, -sign * nx, -sign * ny, true, arena);
  const approach = (p.vx - e.vx) * nx + (p.vy - e.vy) * ny;
  if (approach < 0) {
    const change = -(1 + RESTITUTION) * approach, vx = p.vx, vy = p.vy;
    p.vx += nx * change; p.vy += ny * change; confine(p, arena);
    const remainder = change - ((p.vx - vx) * nx + (p.vy - vy) * ny);
    if (remainder > 1e-9) { e.vx -= nx * remainder; e.vy -= ny * remainder; confine(e, arena); }
  }
}

/**
 * Deep fields: `requested` mass broken off the player (no health: src/sim/contracts.js settleDamage on its mass), at
 * most the field's `most` share of it in one loss, so a ship at full mass survives any single hit. The loss starts GRACE. `sweep` of it goes to `onTransfer` (a heavier body that hit it); `sink` takes the rest instead of a
 * scatter (a star ablating the hull). Otherwise it scatters as matter the player can take back (source `shed`, which
 * restores mass but never growth), with a solid chunk for a large loss, thrown along `away` at the impact `speed` from
 * the `frame` it moves with (default: the player's own motion).
 */
function shedMass(w, requested, { sweep = 0, onTransfer = null, sink = null, away = { x: 0, y: 0 }, speed = 0, frame = null, grace = true, loose = undefined } = {}) {
  const p = w.player, most = Math.max(1, Math.floor(fieldOf(w).physics.impact.most * p.mass));
  const result = settleDamage(p, { requested: Math.min(requested, most), transferFraction: onTransfer ? sweep : 0, debrisFraction: 1 });
  if (grace) { p.invulnerable = GRACE; w._graceSuppressed.clear(); }
  w.stats.damageTaken += result.settledLoss; w.stats.shed += result.settledLoss;
  if (result.creditedTransfer) onTransfer(result.creditedTransfer);
  if (result.debris) { if (sink) sink(result.debris); else scatterDebris(w, p, result.debris, 'shed', away, speed, frame, loose); }
  return result;
}

/**
 * Deep fields: `total` matter broken off `body`, flying away along `away` at up to the field's kick share of the impact
 * `speed`, from `frame`'s motion (the body's own by default). A loss of at least the field's chunk size throws a solid
 * chunk of ore (it can strike in turn, and breaks into matter of the same source); the rest is matter.
 */
function scatterDebris(w, body, total, source, away, speed, frame = null, loose = undefined) {
  const rule = fieldOf(w).physics.impact, from = frame ?? body, kick = rule.kick * speed;
  loose ??= rule.loose;
  let rest = total;
  if (total >= rule.chunk) {
    const mass = Math.floor(total * rule.chunkShare), radius = 13 + mass * .45, reach = body.radius + radius + 2;
    rest -= mass; w.stats.chunks++;
    w.rocks.push({ id: `ore-${w.encounterIndex}-f${++w._id}`, generation: 1, kind: 'ore', alive: true, source,
      x: body.x + away.x * reach, y: body.y + away.y * reach, vx: from.vx + away.x * kick, vy: from.vy + away.y * kick,
      radius, mass, hp: mass, maxHp: mass, angle: 0, spin: .6 });
  }
  if (rest > 0) for (const q of spawnBudget(w, rest, body.x, body.y, Math.min(4, rest), 28, source, 'spawn', { vx: from.vx + away.x * kick * .6, vy: from.vy + away.y * kick * .6 })) q.loose = loose;
}

/**
 * Deep fields: every solid body meets every other by physics, never by contact window (docs/specs/DF-deep-field.md,
 * "No health"). The solids are the player, live enemies (in id order) and live ore; a Warden's moons, outside a
 * formation change, are armour anchored to the ship: a moon does not move or break, but what strikes it strikes the
 * ship's whole system, so the impulse moves the ship and the loss comes off the ship's mass, at twice its hull. Each touching pair separates
 * by mass and exchanges momentum with the field's restitution. Closing faster than the impact threshold, once per
 * separation and interval on the persistent `impact` channel, the impact breaks mass off both (field.js impactLoss),
 * each by its toughness: the ship's hull (its identity's, a Harvester's burst armoured), an enemy kind's body, its
 * commit (a charger's ram) or its rear (a guard's open arc), dazed while it recovers; ore is brittle. The heavier body
 * sweeps up part of what the lighter loses, a Harvester's burst more; the rest is debris (scatterDebris). An enemy
 * that collides while it commits ends its commit there. Chunks thrown this step meet the others next step.
 */
function collideSolids(w) {
  const physics = fieldOf(w).physics, rule = physics.impact, p = w.player, identity = identityOf(w), form = formOf(w), kinds = campaignOf(w).kinds;
  const contacts = w._contacts, window = { now: w.time, interval: rule.interval, separation: true };
  const solids = [];
  if (p.alive) solids.push({ body: p, role: 'player' });
  for (const e of w.enemies.filter(alive).sort(byId)) solids.push({ body: e, role: 'enemy' });
  for (const rock of w.rocks) if (rock.alive) solids.push({ body: rock, role: 'ore' });
  const shields = identity.companions && p.command.state !== 'transition' ? p.companions.map(c => ({ body: c, role: 'moon' })) : [];
  const live = s => s.role === 'moon' ? p.alive : s.body.alive && s.body.mass > 0;
  const massOf = s => s.role === 'moon' ? p.mass : s.body.mass;
  // The body that moves for a solid: a moon's impulse moves the ship it is anchored to.
  const motion = s => s.role === 'moon' ? p : s.body;
  const mods = p.mods ?? modsOf([]), struckByShip = other => other === p || p.companions.includes(other);
  const toughness = (s, other) => {
    if (s.role === 'player') return physics.player.hull * identity.hull(p, form).toughness * mods.toughness / mods.core;
    if (s.role === 'ore') return (s.body.comet ? physics.comets.toughness : rule.ore) / (struckByShip(other) ? mods.ram : 1);
    if (s.role === 'moon') return physics.player.hull * identity.hull(p, form).toughness * mods.toughness / mods.core * 2;
    const e = s.body, kind = kinds[e.type], t = kind.toughness ?? { body: 1, commit: 1, rear: 1 };
    const base = e.state === 'commit' ? t.commit : kind.rearArc && inRearArc(e, other, kind.rearArc) ? t.rear : t.body;
    return base * (e.state === 'recover' ? rule.dazed : 1) / (struckByShip(other) ? mods.ram : 1);
  };
  // What a body that breaks mass off another can sweep up of it: ships do, ore and moons do not.
  // An enemy grown to its cap sweeps up nothing more.
  const sweeps = s => s.role !== 'ore' && (s.role !== 'enemy' || !(s.body.mass >= s.body.capMass));
  /**
   * Credits `value` to sweeping body `s`; `shed` is matter the player lost, which stays shed wherever it goes, and
   * `element` what it is made of (a comet's ice), by default what harvesting gives.
   */
  const credit = (s, value, shed = false, element = undefined) => {
    if (!value) return;
    if (s.role === 'player' || s.role === 'moon') { gain(w, value, shed ? 'shed' : 'harvest', element); if (!shed) w.stats.harvested += value; }
    else { const e = s.body; e.mass += value; e.hp = e.mass; e.maxHp = Math.max(e.maxHp, e.mass); if (shed) e.shedHeld = (e.shedHeld ?? 0) + value; }
  };
  const hooks = { event, effect, spawnBudget };
  /** Breaks `loss` off solid `s`, struck by `by` at closing `speed`, its debris thrown along `away`. */
  const breakOff = (s, loss, by, away, speed) => {
    if (!loss || !live(s)) return;
    const heavier = sweeps(by) && massOf(by) > massOf(s), sweep = (heavier ? (s.body.comet ? physics.comets.sweep : rule.sweep) : 0) + (by.role === 'player' || by.role === 'moon' ? identity.hull(p, form).sweep : 0);
    if (s.role === 'player' || s.role === 'moon') {
      const result = shedMass(w, loss, { sweep: Math.min(1, sweep), onTransfer: sweep ? value => credit(by, value, true) : null, away, speed });
      event(w, 'contact-settle', { channel: 'impact', serial: null, pair: [by.body.id, p.id], settledLoss: result.settledLoss });
      event(w, 'player-hit', { enemy: by.body.id, settledLoss: result.settledLoss, braced: false });
      effect(w, 'hurt', p.x, p.y, { amount: result.settledLoss });
      if (by.role === 'enemy' && by.body.state === 'commit') by.body.hitDuringCommit = true;
    } else if (s.role === 'enemy') {
      const e = s.body, result = settleEnemy(w, e, by.body, loss, by.role === 'player' && identity.harvesting(p), 'impact', {
        kick: false, transferFraction: Math.min(1, sweep), debrisFraction: 1,
        onTransfer: (value, shed) => { credit(by, shed, true); credit(by, value - shed); },
        onDebris: (value, shed) => { if (shed) scatterDebris(w, e, shed, 'shed', away, speed); if (value - shed) scatterDebris(w, e, value - shed, 'impact', away, speed); } });
      if (by.role === 'ore') { w.stats.oreStrikes++; event(w, 'ore-strike', { rock: by.body.id, enemy: e.id, speed: Math.round(speed), settledLoss: result.settledLoss }); }
    } else if (s.role === 'ore') {
      // The heavier body sweeps up its share of what breaks off ore (most of a brittle comet), as it does off an enemy.
      const rock = s.body, kick = rule.kick * speed;
      settleOre(w, rock, by.body, loss, hooks, 'impact', { vx: rock.vx + away.x * kick, vy: rock.vy + away.y * kick }, Math.min(1, sweep), sweep ? value => credit(by, value, rock.source === 'shed', rock.comet ? SOURCE_ELEMENTS.comet : undefined) : null);
    }
  };
  const meet = (A, B) => {
    if (!live(A) || !live(B)) return;
    const a = A.body, b = B.body, dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), gap = d - a.radius - b.radius;
    contacts.track(a, b, 'impact', gap, w.time);
    if (gap >= 0) return;
    const nx = d > 1e-9 ? dx / d : 1, ny = d > 1e-9 ? dy / d : 0, ma = massOf(A), mb = massOf(B), va = motion(A), vb = motion(B);
    const vn = (va.vx - vb.vx) * nx + (va.vy - vb.vy) * ny;
    // Separate by mass (a moon holds its orbit, so the other body takes all of it), then exchange momentum: a moon's
    // share moves the ship.
    const wa = A.role === 'moon' ? 0 : mb / (ma + mb), depth = -gap;
    a.x -= nx * depth * wa; a.y -= ny * depth * wa;
    b.x += nx * depth * (1 - wa); b.y += ny * depth * (1 - wa);
    if (vn > 0) {
      const j = (1 + rule.restitution) * vn / (1 / ma + 1 / mb);
      va.vx -= nx * j / ma; va.vy -= ny * j / ma; vb.vx += nx * j / mb; vb.vy += ny * j / mb;
      capSpeed(w, va); capSpeed(w, vb);
    }
    // Grace holds the whole impact, both sides: a ship just hit bounces off what it meets but breaks nothing, and nothing
    // breaks it, so a hit never buys free ramming.
    if ((A.role === 'player' || A.role === 'moon' || B.role === 'player') && p.invulnerable > 0) return;
    if (!(vn > rule.threshold) || !contacts.enter(a, b, 'impact', window)) return;
    w.stats.collisions++;
    const [la, lb] = impactLoss(w, ma, mb, toughness(A, b), toughness(B, a), vn);
    breakOff(A, la, B, { x: -nx, y: -ny }, vn);
    breakOff(B, lb, A, { x: nx, y: ny }, vn);
    for (const s of [A, B]) if (s.role === 'enemy' && alive(s.body) && s.body.state === 'commit') s.body.closing = true;
  };
  for (let i = 0; i < solids.length; i++) for (let j = i + 1; j < solids.length; j++) meet(solids[i], solids[j]);
  for (const moon of shields) for (const s of solids) if (s.role !== 'player') meet(moon, s);
}

/**
 * Deep fields: the regions of space act on the solids inside them (src/sim/regions.js). A dust cloud or storm adds
 * matter from its reserve to the player and to enemies (up to their cap) as they sweep through it, carried in
 * fractions (`dustCarry`) and credited in whole units: the player's is growth, source `dust`. A shear field grinds
 * mass off the player, enemies and ore (`shearCarry`), whole units at a time, as loose debris thrown out of the
 * field: the player's is shed (no grace, since the grinding is continuous), an enemy's and ore's their own debris.
 */
function weatherRegions(w, dt) {
  const p = w.player, hooks = { event, effect, spawnBudget }, physics = fieldOf(w).physics;
  // A halo's stream at body b: the circular speed of the pull b feels from the halo's body (src/sim/field.js).
  const stream = (r, b) => {
    const well = r.kind === 'halo' && w.wells.find(k => k.id === r.well);
    if (!well) return null;
    const a = wellAcceleration(w, well, b.x, b.y, b === p ? bodyKind(well).grip : physics.enemyPull * physics.enemy.thrust);
    return Math.sqrt(Math.hypot(a.x, a.y) * distance(b, well));
  };
  for (const r of w.regions) {
    const ships = [p, ...w.enemies.filter(alive)].filter(b => b.alive);
    for (const b of ships) {
      const rate = accretionRate(r, b, stream(r, b)) * (b === p ? p.mods?.accretion ?? 1 : 1);
      if (!rate || (b !== p && b.mass >= b.capMass)) continue;
      b.dustCarry = (b.dustCarry ?? 0) + rate * dt;
      const n = Math.min(Math.floor(b.dustCarry), r.reserve, b === p ? Infinity : b.capMass - b.mass);
      if (n < 1) continue;
      b.dustCarry -= n; r.reserve -= n;
      if (b === p) { w.stats.dustAccreted += n; gain(w, n, 'dust', elementOf(r)); }
      else { b.mass += n; b.hp = b.mass; b.maxHp = Math.max(b.maxHp, b.mass); w.stats.enemyAccreted += n; }
    }
    for (const b of [...ships, ...w.rocks.filter(rock => rock.alive)]) {
      const shield = REGION_KINDS[r.kind].shield, rate = shearRate(r, b) * (b === p && shield ? p.mods?.[shield] ?? 1 : 1);
      if (!rate) continue;
      b.shearCarry = (b.shearCarry ?? 0) + rate * dt;
      const n = Math.floor(b.shearCarry);
      if (n < 1) continue;
      b.shearCarry -= n;
      const away = b.x !== r.x || b.y !== r.y ? normal(b.x - r.x, b.y - r.y) : normal(r.vx || 1, r.vy), speed = physics.shearThrow.speed;
      let settled = 0;
      if (b === p) settled = shedMass(w, n, { away, speed, grace: false, loose: physics.shearThrow.loose }).settledLoss;
      else if (b.kind === 'ore') settled = settleOre(w, b, r, n, hooks, 'impact', { vx: b.vx + away.x * speed * .3, vy: b.vy + away.y * speed * .3 }, 0, null, physics.shearThrow.loose).settledLoss;
      else settled = settleEnemy(w, b, r, n, false, 'impact', { kick: false, debrisFraction: 1,
        onDebris: (value, shed) => { if (shed) scatterDebris(w, b, shed, 'shed', away, speed, null, physics.shearThrow.loose); if (value - shed) scatterDebris(w, b, value - shed, 'impact', away, speed, null, physics.shearThrow.loose); } }).settledLoss;
      if (settled) { w.stats.sheared += settled; event(w, 'shear', { region: r.id, body: b.id, settledLoss: settled }); }
    }
  }
}

/**
 * Deep fields, traits: a radioactive body's aura (`mods.aura`, mass per second at the ship, fading to nothing at
 * `mods.auraReach` beyond its surface) grinds opponents and ore near it into loose debris, the ship's to gather.
 */
function irradiate(w, dt) {
  const p = w.player, mods = p.mods;
  if (!mods?.aura || !p.alive) return;
  const hooks = { event, effect, spawnBudget };
  for (const b of [...w.enemies.filter(alive), ...w.rocks.filter(rock => rock.alive)].sort(byId)) {
    const gap = distance(p, b) - p.radius - b.radius;
    if (gap >= mods.auraReach) continue;
    b.auraCarry = (b.auraCarry ?? 0) + mods.aura * (1 - Math.max(0, gap) / mods.auraReach) * dt;
    const n = Math.floor(b.auraCarry);
    if (n < 1) continue;
    b.auraCarry -= n;
    const away = normal(b.x - p.x, b.y - p.y), speed = 90;
    const settled = b.kind === 'ore'
      ? settleOre(w, b, p, n, hooks, 'impact', { vx: b.vx + away.x * speed * .3, vy: b.vy + away.y * speed * .3 }).settledLoss
      : settleEnemy(w, b, p, n, false, 'impact', { kick: false, debrisFraction: 1,
        onDebris: (value, shed) => { if (shed) scatterDebris(w, b, shed, 'shed', away, speed); if (value - shed) scatterDebris(w, b, value - shed, 'impact', away, speed); } }).settledLoss;
    if (settled) { w.stats.irradiated += settled; event(w, 'irradiate', { body: b.id, settledLoss: settled }); }
  }
}

/**
 * Deep fields, traits: life (`mods.life`, matter per second) in a radiating body's habitable band (src/sim/traits.js
 * HABITABLE, in cores of that body) draws on that body's halo, fastest midway through the band, as organic growth.
 */
function photosynthesis(w, dt) {
  const p = w.player, life = p.mods?.life;
  if (!life || !p.alive) return;
  for (const well of w.wells) {
    if (!bodyKind(well).radiation) continue;
    const d = distance(p, well) / well.core;
    if (d < HABITABLE.inner || d > HABITABLE.outer) continue;
    const halo = w.regions.find(r => r.kind === 'halo' && r.well === well.id);
    if (!halo || !(halo.reserve > 0)) continue;
    const mid = (HABITABLE.inner + HABITABLE.outer) / 2, half = (HABITABLE.outer - HABITABLE.inner) / 2;
    p.lifeCarry = (p.lifeCarry ?? 0) + life * (1 - ((d - mid) / half) ** 2) * dt;
    const n = Math.min(Math.floor(p.lifeCarry), halo.reserve);
    if (n < 1) return;
    p.lifeCarry -= n; halo.reserve -= n; w.stats.lifeDrawn += n;
    gain(w, n, 'life', 'organic'); return;
  }
}

/**
 * Deep fields: the player and every enemy against the well cores, after push-out. A body inside a core moves to its
 * surface and rebounds; a strike faster than the body's threshold settles damage (src/sim/field.js wellImpactDamage)
 * once per separation, on the persistent `impact` channel. The player's strike is integrity, refused during grace.
 */
function strikeAllWells(w) {
  const p = w.player;
  strikeWells(w, p, 'player', (well, speed) => {
    const requested = playerStrikeDamage(w, well, speed);
    if (!requested || p.invulnerable > 0) return false;
    // No health: the strike breaks mass off the ship. A body that accretes matter takes it (a star ablates the hull);
    // off any other it scatters, moving with the body.
    if (deep(w)) {
      const away = normal(p.x - well.x, p.y - well.y), swallows = bodyKind(well).accretes.includes('matter');
      const result = shedMass(w, requested, { sink: swallows ? value => { holdAccreted(w, well, value, true); event(w, 'accretion', { well: well.id, value, source: 'shed' }); } : null,
        away, speed, frame: well });
      w.stats.wellStrikes++;
      event(w, 'well-strike', { well: well.id, speed: Math.round(speed), settledLoss: result.settledLoss });
      effect(w, 'hurt', p.x, p.y, { amount: result.settledLoss }); return true;
    }
    const result = settleIntegrity(p, { requested });
    p.invulnerable = GRACE; w._graceSuppressed.clear(); w.stats.damageTaken += result.settledLoss; w.stats.wellStrikes++;
    event(w, 'well-strike', { well: well.id, speed: Math.round(speed), settledLoss: result.settledLoss });
    effect(w, 'hurt', p.x, p.y, { amount: result.settledLoss }); return true;
  }, well => {
    holdAccreted(w, well, p.mass); w.stats.swallowed++;
    event(w, 'swallowed', { well: well.id, body: p.id, mass: p.mass });
    effect(w, 'hurt', p.x, p.y, { amount: p.mass }); p.mass = 0; p.alive = false;
  });
  for (const e of w.enemies) {
    if (!alive(e)) continue;
    strikeWells(w, e, 'enemy', (well, speed) => {
      const requested = wellImpactDamage(w, 'enemy', speed) + (bodyKind(well).strike.base ? Math.min(8, bodyKind(well).strike.base) : 0);
      if (!requested) return false;
      settleEnemy(w, e, well, requested, false, 'impact'); w.stats.wellStrikes++; return true;
    }, well => {
      // A horizon takes the whole body; its debris falls in after it.
      event(w, 'swallowed', { well: well.id, body: e.id, mass: e.mass });
      settleEnemy(w, e, well, e.mass, false, 'impact'); w.stats.wellStrikes++; w.stats.swallowed++;
    });
    // A commit is a straight burn: one that meets a core ends there (its final segment), so it never slides around the
    // core past the corridor the renderer draws to that core (src/render/render.js).
    if (alive(e) && e.state === 'commit' && touching(w.wells, { x: e.x, y: e.y, radius: e.radius + 1e-6 })) e.closing = true;
  }
}

/**
 * Deep fields: visitors. A comet falls in from the Kuiper belt every so often (`physics.comets`), made of the belt's
 * matter: aimed at a point of the inner system or, now and then, at the ship, fast and brittle. Each star throws out a
 * solar storm every so often (`physics.solarStorms`), warning (`stormIn`) before it does; a storm runs out after its
 * life. Draws come from the spawn stream as each visitor is due; the schedule lives on the belt and on each star.
 */
function visitors(w) {
  const physics = fieldOf(w).physics, now = w.encounterTime, due = ([lo, hi]) => lo + drawInt(w.rng, 'spawn', hi - lo + 1);
  const kuiper = w.regions.find(r => r.kind === 'kuiper'), c = physics.comets;
  if (kuiper) {
    kuiper.nextComet ??= now + due(c.every);
    if (now >= kuiper.nextComet) { launchComet(w, kuiper, c); kuiper.nextComet = now + due(c.every); }
  }
  const s = physics.solarStorms;
  for (const well of w.wells) {
    if (!bodyKind(well).radiation) continue;
    well.stormAt ??= now + due(s.every);
    well.stormIn = Math.max(0, well.stormAt - now);
    if (now < well.stormAt) continue;
    const [ux, uy] = DIRECTIONS[drawInt(w.rng, 'spawn', DIRECTIONS.length)], dx = ux / UNIT, dy = uy / UNIT;
    w.regions.push(solarStorm(`solar-${well.id}-${++w._id}`, { x0: well.x + dx * well.core * 1.3, y0: well.y + dy * well.core * 1.3,
      vx: well.vx + dx * s.speed, vy: well.vy + dy * s.speed, born: now, life: s.life, r0: s.r0, grow: s.grow }));
    w.stats.solarStorms++; event(w, 'solar-storm', { well: well.id });
    well.stormAt = now + due(s.every);
  }
  if (w.regions.some(r => r.path === 'drift' && now - r.born >= r.life)) w.regions = w.regions.filter(r => r.path !== 'drift' || now - r.born < r.life);
}

/** A comet from the Kuiper belt `kuiper`, of the belt's matter, launched inward under rule `c`. */
function launchComet(w, kuiper, c) {
  const mass = Math.min(c.mass[0] + drawInt(w.rng, 'spawn', c.mass[1] - c.mass[0] + 1), kuiper.reserve);
  if (mass < c.mass[0]) return;
  const [ux, uy] = DIRECTIONS[drawInt(w.rng, 'spawn', DIRECTIONS.length)], from = (kuiper.inner + kuiper.radius) / 2;
  const x = kuiper.x + ux / UNIT * from, y = kuiper.y + uy / UNIT * from;
  const aim = drawInt(w.rng, 'spawn', c.atPlayer) === 0 && w.player.alive ? w.player : (() => {
    const [ax, ay] = DIRECTIONS[drawInt(w.rng, 'spawn', DIRECTIONS.length)], r = drawInt(w.rng, 'spawn', c.aim);
    return { x: kuiper.x + ax / UNIT * r, y: kuiper.y + ay / UNIT * r };
  })();
  const d = Math.hypot(aim.x - x, aim.y - y) || 1, speed = c.speed[0] + drawInt(w.rng, 'spawn', c.speed[1] - c.speed[0] + 1);
  kuiper.reserve -= mass; w.stats.comets++;
  const rock = { id: `comet-${w.encounterIndex}-${++w._id}`, generation: 1, kind: 'ore', alive: true, source: 'comet', comet: true,
    x, y, vx: (aim.x - x) / d * speed, vy: (aim.y - y) / d * speed, radius: 13 + mass * .45, mass, hp: mass, maxHp: mass, angle: 0, spin: .8 };
  w.rocks.push(rock); event(w, 'comet', { rock: rock.id, mass });
}

/** Deep fields: the transit gates and unclaimed moons coast under gravity, rebounding off any core they meet. */
function driftBuoys(w, dt) {
  const restitution = fieldOf(w).physics.buoyRestitution;
  for (const b of [...w.gates, ...w.candidates.filter(c => c.ownerId === null)]) {
    const g = gravity(w, b);
    b.vx = (b.vx ?? 0) + g.x * dt; b.vy = (b.vy ?? 0) + g.y * dt; aerobrake(w.wells, b, dt); regionDrift(w.regions, b, dt); capSpeed(w, b);
    b.x += b.vx * dt; b.y += b.vy * dt;
    for (const well of w.wells) collideWell(well, b, restitution);
  }
}

/**
 * Deep fields: each accreting body that holds its kind's flare threshold, and whose cooldown has run out, throws all it
 * holds back out as matter (BODY_KINDS flare): split into pieces of about three, each placed `launch` cores out in a
 * direction from the integer table (a jet's alternate ends of one axis) and moving on a circular orbit about the body,
 * with the body's own motion and a little scatter. Stars' light is counted against their pull, so a star's flare climbs.
 * The pieces are matter in play again: released leaves the accreted ledger, and nothing is spawned anew.
 */
function flareWells(w, dt) {
  const physics = fieldOf(w).physics;
  for (const well of w.wells) {
    const kind = bodyKind(well), rule = kind.flare;
    if (!rule) continue;
    well.flareCooldown = Math.max(0, (well.flareCooldown ?? 0) - dt);
    if ((well.held ?? 0) < rule.at || well.flareCooldown > 0) continue;
    const total = well.held, axis = drawInt(w.rng, 'spawn', DIRECTIONS.length), r = well.core * rule.launch;
    well.held = 0; well.flareCooldown = rule.cooldown; w.stats.released += total; w.stats.flares++;
    // What the body holds of the player's shed matter flares back out as shed: taking it back restores mass, not growth.
    const shed = Math.min(well.heldShed ?? 0, total), pieces = [];
    if (shed) for (const value of splitBudget(shed, Math.ceil(shed / 3))) pieces.push({ value, source: 'shed' });
    // Half of the flare's own matter settles into the body's halo, the matter in decaying orbit about it; the rest flies.
    const halo = w.regions.find(x => x.kind === 'halo' && x.well === well.id), settles = halo ? Math.floor((total - shed) / 2) : 0;
    if (settles) { halo.reserve += settles; w.stats.haloed += settles; }
    if (total - shed - settles) for (const value of splitBudget(total - shed - settles, Math.max(2, Math.ceil((total - shed - settles) / 3)))) pieces.push({ value, source: 'flare' });
    well.heldShed = 0;
    pieces.forEach(({ value, source }, i) => {
      if (!value) return;
      const index = rule.jet ? (axis + (i % 2) * DIRECTIONS.length / 2 + offset(w.rng, 'spawn', 1) + DIRECTIONS.length) % DIRECTIONS.length : drawInt(w.rng, 'spawn', DIRECTIONS.length);
      const [ux, uy] = DIRECTIONS[index].map(n => n / UNIT), x = well.x + ux * r, y = well.y + uy * r;
      const a = wellAcceleration(w, well, x, y), light = kind.radiation && rule.launch <= kind.radiationReach ? kind.radiation : 0;
      const v = Math.sqrt(Math.hypot(a.x, a.y) * (1 - light) * r), d = scatter(w.rng, 'spawn', physics.debrisSpeed);
      w.pickups.push({ id: `matter-${++w._id}`, x, y, vx: well.vx - uy * v + d.x, vy: well.vy + ux * v + d.y, value, radius: 4 + Math.sqrt(value), source });
    });
    event(w, 'flare', { well: well.id, value: total });
  }
}

function collect(w, dt) {
  const p = w.player;
  w.pickups = w.pickups.filter(pickup => {
    const swallowed = movePickup(w, pickup, dt);
    if (swallowed) { holdAccreted(w, swallowed, pickup.value, pickup.source === 'shed'); event(w, 'accretion', { well: swallowed.id, value: pickup.value, source: pickup.source }); return false; }
    // Debris an impact has just broken off is loose: nothing collects it until it has flown clear (deep fields only).
    if (pickup.loose > 0) return true;
    let collector = distance(p, pickup) < p.radius + pickup.radius + 9 + (p.mods?.reach ?? 0);
    if (!collector && identityOf(w).companions && p.command.state !== 'transition') collector = p.companions.some(c => c.role === 'collector' && distance(c, pickup) < c.radius + pickup.radius + c.stats.reach);
    if (collector) { gain(w, pickup.value, pickup.source); if (pickup.source === 'stream') w.stats.streamCollected += pickup.value; effect(w, 'collect', pickup.x, pickup.y, { life: .28, value: pickup.value }); return false; }
    // Deep fields: opponents accrete too. Matter a live enemy touches becomes its mass, so they compete with the player
    // for it and grow across an encounter.
    const taker = deep(w) ? w.enemies.find(e => alive(e) && !(e.mass >= e.capMass) && distance(e, pickup) < e.radius + pickup.radius) : null;
    if (taker) {
      taker.mass += pickup.value; taker.hp = taker.mass; taker.maxHp = Math.max(taker.maxHp, taker.mass); w.stats.enemyAccreted += pickup.value;
      if (pickup.source === 'shed') taker.shedHeld = (taker.shedHeld ?? 0) + pickup.value;
      event(w, 'accretion', { well: taker.id, value: pickup.value, source: pickup.source }); return false;
    }
    return true;
  });
}

export function stepWorld(w, input = {}, dt = 1 / 60) {
  if (w.phase !== 'playing') return w;
  dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 1 / 30); if (!dt) return w;
  if (!deep(w)) return advance(w, input, dt);
  // A deep field steps in substeps of at most the field's substep, so bodies at the speed cap cannot pass through each
  // other or a core between two measurements. A substep that ends the encounter ends the step.
  const n = Math.ceil(dt / fieldOf(w).physics.substep - 1e-9);
  for (let i = 0; i < n && w.phase === 'playing'; i++) advance(w, input, dt / n);
  return w;
}

function advance(w, input, dt) {
  w.time += dt; w.encounterTime += dt;
  if (deep(w)) {
    for (const m of stepWells(w, dt)) { w.stats.merges++; event(w, 'well-merge', m); w.regions = mergeHalos(w.regions, m.into, m.absorbed, w.wells.find(k => k.id === m.into)?.kind); }
    visitors(w);
    moveRegions(w.regions, w.encounterTime, w.wells);
    driftBuoys(w, dt);
  }
  // Grace runs out exactly GRACE seconds after the hit.
  const p = w.player; p.invulnerable = countdown(p.invulnerable, dt);
  // Where the bodies start: a commit's closest approach is measured along each step's travelled segment.
  const px = p.x, py = p.y, from = w.enemies.map(e => ({ x: e.x, y: e.y }));
  updatePlayer(w, input, dt); updateCompanions(w, dt);
  for (const e of w.enemies) updateEnemy(w, e, dt);
  // Event horizons (src/sim/field.js holdInHorizon): a ship inside one cannot move outward, and spirals in.
  if (deep(w)) [p, ...w.enemies].forEach((b, i) => { if (alive(b)) holdInHorizon(w.wells, b, dt, i ? from[i - 1] : { x: px, y: py }); });
  w.enemies.forEach((e, i) => { if (alive(e) && e.state === 'commit') e.closest = Math.min(e.closest, closestApproach(px, py, p, from[i], e)); });
  // Harness telemetry, only in a world created with `telemetry`; nothing here reads it. Where the player and each enemy
  // stand while this step's contacts and persistent separations (ore and rear gaps) are measured: after movement, before
  // push-out. Companions (placed by their orbit) and ore (measured after its own move) are not moved again this step.
  if (w._telemetry) w._measuredAt = { time: w.time, positions: Object.fromEntries([[p.id, [p.x, p.y]], ...w.enemies.map(e => [e.id, [e.x, e.y]])]) };
  stepEnvironment(w, dt, { event, effect, spawnBudget, settleEnemy: (w, e, attacker, requested) => settleEnemy(w, e, attacker, requested, false, 'impact') });
  // Move, resolve contacts with the state each enemy moved in, push the bodies apart, then close the commits whose
  // final segment that was.
  if (deep(w)) {
    // A collision's push-apart and impulse cannot carry a ship out of a horizon either: hold every ship again from
    // where it stood before the collisions (no second bleed: dt 0).
    const ships = [p, ...w.enemies].filter(alive), before = ships.map(b => ({ x: b.x, y: b.y }));
    collideSolids(w);
    ships.forEach((b, i) => { if (alive(b)) holdInHorizon(w.wells, b, 0, before[i]); });
    weatherRegions(w, dt); irradiate(w, dt); photosynthesis(w, dt);
  }
  else { resolveContacts(w); pushOut(w); }
  if (w.wells.length) strikeAllWells(w);
  for (const e of w.enemies) if (e.closing) closeCommit(w, e);
  collect(w, dt);
  if (w.wells.length) flareWells(w, dt);
  stepSlalom(w, { event, effect });
  w.effects = w.effects.filter(e => (e.age += dt) < e.life);
  if (!intact(w, w.player)) { w.phase = 'lost'; event(w, 'run-lost', { encounter: w.encounterIndex }); return w; }
  previewEvolution(w);
  if (w.phase !== 'playing') return w;
  if (encounterSatisfied(w)) {
    // Second encounters must finish their form's interval; resources remain finite and accessible until then.
    const form = formOf(w);
    if (!w.practice && encounterOf(w).completesForm && w.player.growth < form.threshold) w.objective = { key: 'objective.form-growth', params: { matter: form.threshold - w.player.growth } };
    else clearEncounter(w);
  }
  return w;
}
