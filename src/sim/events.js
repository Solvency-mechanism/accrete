// Event registry (docs/specs/M3-data-spine.md, 3a.4). EVENT_TYPES lists every event the simulation emits, its payload
// fields and whether it is a milestone (kept in the bounded milestone buffer as well as the recent-event buffer).
// It replaces simulation.js's MILESTONE_TYPES. `emit` builds and buffers an event exactly as simulation.js's event()
// did. Under the Node test runner (NODE_TEST_CONTEXT is set) it also checks the type is registered and the payload
// holds exactly the declared fields, and throws if not; in production it never throws. Payload `form` fields carry
// the form's campaign position (src/sim/campaign.js formPosition), as before M3.

const type = (fields, milestone = false) => Object.freeze({ fields: Object.freeze(fields), milestone });

export const EVENT_TYPES = Object.freeze({
  // Run and encounter flow.
  'choice': type(['identity', 'form', 'seed', 'practice'], true),
  'encounter-start': type(['encounter', 'form', 'types'], true),
  'encounter-clear': type(['encounter', 'elapsed', 'matter', 'hp', 'route'], true),
  'run-complete': type(['identity', 'form', 'score'], true),
  'run-lost': type(['encounter'], true),
  // Growth and evolution.
  'collection': type(['value', 'source', 'recognized']),
  'overflow-recognition': type(['value', 'source', 'form']),
  'evolution-preview': type(['from', 'to', 'growth']),
  'evolution': type(['form', 'roles', 'carried', 'recognized'], true),
  // Captures.
  'capture': type(['candidate', 'roles'], true),
  'capture-failed': type(['reason']),
  // Identity commands.
  'formation-change': type(['formation', 'vulnerableFor']),
  'formation-ready': type(['formation']),
  'gravity-pulse': type(['moved', 'created']),
  'burst': type(['angle', 'form']),
  // Enemies.
  'telegraph': type(['enemy', 'enemyType']),
  'enemy-commit': type(['enemy', 'enemyType']),
  'scavenge': type(['value', 'enemy']),
  'cache-return': type(['value', 'enemy']),
  'clean-dodge': type(['enemy']),
  'enemy-defeated': type(['enemy', 'enemyType']),
  // Contact (docs/contracts.md "Contacts and pooled reuse").
  'contact-settle': type(['channel', 'serial', 'pair', 'settledLoss']),
  'grace-suppressed': type(['channel', 'serial', 'enemy']),
  'rearm': type(['channel', 'pair']),
  'settled-impact': type(['target', 'settledLoss', 'creditedTransfer', 'debris', 'unallocated']),
  'player-hit': type(['enemy', 'settledLoss', 'braced']),
  'interception': type(['companion', 'enemy', 'formation']),
  // The living field (src/sim/environment.js).
  'stream-release': type(['stream', 'value', 'remaining']),
  'ore-impact': type(['rock', 'attacker', 'settledLoss', 'debris']),
  'ore-broken': type(['rock', 'initialMass']),
  'gate-pass': type(['gate', 'index', 'remaining']),
  'slalom-complete': type(['encounter'], true),
  // Deep fields (src/sim/field.js): the player striking a well core, and ore striking an enemy, that settled damage.
  // An enemy's or ore's own well strike is its settled-impact or ore-impact.
  'well-strike': type(['well', 'speed', 'settledLoss']),
  'ore-strike': type(['rock', 'enemy', 'speed', 'settledLoss']),
  // A body swallowing matter or ore (its value leaves play as accreted), and two bodies merging.
  'accretion': type(['well', 'value', 'source']),
  'well-merge': type(['into', 'absorbed']),
  // An accreting body throwing the matter it holds back out into orbit.
  'flare': type(['well', 'value']),
  // A shear field grinding mass off a body (the player, an enemy or ore).
  'shear': type(['region', 'body', 'settledLoss']),
  // Composition and traits (src/sim/traits.js).
  'trait-offer': type(['options', 'locked']),
  'trait-chosen': type(['trait', 'form']),
  'irradiate': type(['body', 'settledLoss']),
  // Horizons and visitors (docs/specs/DF-deep-field.md "Horizons, systems and visitors").
  'swallowed': type(['well', 'body', 'mass']),
  'comet': type(['rock', 'mass']),
  'solar-storm': type(['well']),
});

export const EVENT_LIMIT = 160;      // the recent-event buffer
export const MILESTONE_LIMIT = 128;  // the milestone buffer
const RESERVED = Object.freeze(['type', 'seq', 'time']);

let checking = !!globalThis.process?.env?.NODE_TEST_CONTEXT;
/** Turns the payload checks on or off (on by default under the Node test runner only); returns the previous setting. */
export function setEventChecks(on) { const was = checking; checking = !!on; return was; }

/** Every way `type` and `detail` break the registry, as messages; empty when the event is valid. */
export function eventProblems(name, detail = {}) {
  if (!Object.hasOwn(EVENT_TYPES, name)) return [`unregistered event type ${JSON.stringify(name)}`];
  const want = EVENT_TYPES[name].fields, got = Object.keys(detail), problems = [];
  for (const field of want) if (!Object.hasOwn(detail, field)) problems.push(`${name}: missing payload field ${field}`);
  for (const field of got) if (!want.includes(field)) problems.push(`${name}: ${RESERVED.includes(field) ? 'reserved' : 'undeclared'} payload field ${field}`);
  return problems;
}

/** True when `name` is a registered milestone type. */
export const isMilestone = name => Object.hasOwn(EVENT_TYPES, name) && EVENT_TYPES[name].milestone;

/** Builds, numbers and buffers one event on world `w`, and returns it. */
export function emit(w, name, detail = {}) {
  if (checking) { const problems = eventProblems(name, detail); if (problems.length) throw new TypeError(`Event registry: ${problems.join('; ')}`); }
  const e = { ...detail, type: name, seq: ++w._eventSequence, time: Number(w.time.toFixed(3)) };
  w.events.push(e); if (w.events.length > EVENT_LIMIT) w.events.shift();
  if (isMilestone(name)) { w.milestones.push(e); if (w.milestones.length > MILESTONE_LIMIT) w.milestones.shift(); }
  return e;
}
