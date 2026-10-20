// Enemy kind registry (docs/specs/M3-data-spine.md, 3a.2). ENEMY_KINDS holds, per kind id, every gameplay value of
// that kind: mass and radius bases (the form adds its own bonus), speeds, telegraph, commit and recover timings, the
// hover band, the targeting function and the kind's contact windows. A site that used to branch on a kind's name reads
// its entry instead, so a new kind is one entry here. A kind's presentation is keyed by the same id outside the
// simulation since 3c-move: its look in src/render/looks.js, its warning pitch and taught hint in
// src/app/presentation.js.
//
// The M2 contact-channel table (docs/specs/M2-contact-and-arena-truth.md, decision D17) moved here mechanically from
// src/contact-channels.js: CHANNELS, the windows of each body, GRACE, REARM_GAP, WIDE_IMPACT and the channel rules.
// Contact settles per declared window, not per overlap. A finite window has a serial that increments whenever a new
// instance of it opens; a persistent channel re-arms by separation and time instead.
//
// A kind entry is plain data (Astra review P2, probes B2 and B3): its targeting and channel behaviour are named rules
// with plain data parameters, `{ rule, ...parameters }`, looked up in TARGET_RULES and CHANNEL_RULES, never functions,
// whose source text cannot identify the state a closure captured. defineKind refuses anything else and freezes the
// entry all the way down. Imports only the descriptor helpers.

import { deepFreeze as freeze, impurity } from './descriptor.js';
const angleDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export const GRACE = .5;        // seconds after each player hit during which no damage settles; overlap never refreshes it
export const REARM_GAP = 12;    // a persistent channel re-arms only after the surface gap has exceeded this
export const WIDE_IMPACT = 7;   // a wide companion's impact, one per companion per enemy vulnerability serial

/**
 * effect: 'damage' hurts the player, 'vulnerability' hurts the body that declares the channel.
 * finite: settles at most once per pair and serial. Otherwise persistent: a new opportunity needs `interval` seconds
 * since the pair's last settlement on the channel and, when `separation` is set, a gap beyond REARM_GAP in between.
 */
export const CHANNELS = Object.freeze({
  attack: Object.freeze({ effect: 'damage', finite: true }),
  front: Object.freeze({ effect: 'damage', interval: .8, separation: false }),
  recover: Object.freeze({ effect: 'vulnerability', finite: true }),
  rear: Object.freeze({ effect: 'vulnerability', interval: .8, separation: true }),
  intercept: Object.freeze({ effect: 'vulnerability', finite: true }),
  ore: Object.freeze({ effect: 'vulnerability', interval: .35, separation: true }),
});

/** The declared windows of the bodies that are not enemy kinds. Contact outside every open window is neutral. */
export const BODIES = Object.freeze({
  interceptor: Object.freeze({ damage: [], vulnerability: ['intercept'] }), // opens only on an enemy's open attack serial
  wide: Object.freeze({ damage: [], vulnerability: [] }),                  // either role; strikes enemy vulnerability windows
  ore: Object.freeze({ damage: [], vulnerability: ['ore'] }),
});

/** The guard's broken rear arc, wider while it recovers: half-angles in radians from the guard's back. */
export function inRearArc(e, body, arc = { open: 1.02, recovering: 1.45 }) {
  const a = Math.atan2(body.y - e.y, body.x - e.x);
  return Math.abs(angleDelta(a, e.guardAngle + Math.PI)) < (e.state === 'recover' ? arc.recovering : arc.open);
}

const channelOrNone = v => v === null || Object.hasOwn(CHANNELS, v);
/**
 * Channel rules, by identifier. A kind's `channel` is `{ rule, ...parameters }`; each rule declares the parameters it
 * takes, with a check for each, and `apply(e, body, kind, parameters)` returns the channel a body touching enemy `e`
 * meets this step, or null (neutral). A body meets one channel per step, or none.
 */
export const CHANNEL_RULES = Object.freeze({
  /**
   * A bash in progress uses `attack` and a recovery `recover`; any other contact meets `otherwise`, a channel id or
   * null (neutral, the default).
   */
  windowed: Object.freeze({ params: Object.freeze({ otherwise: channelOrNone }),
    apply: (e, body, kind, { otherwise = null }) => e.state === 'commit' ? 'attack' : e.state === 'recover' ? 'recover' : otherwise }),
  /**
   * Guard arbitration: the rear arc (the kind's `rearArc`) wins in every state, for the player and for companions, then
   * a bash in progress uses `attack`, then the shield uses `front`, so one contact can never meet two of them in a step.
   */
  shielded: Object.freeze({ params: Object.freeze({}),
    apply: (e, body, kind) => inRearArc(e, body, kind.rearArc) ? 'rear' : e.state === 'commit' ? 'attack' : 'front' }),
});

/**
 * Telegraph target rules, by identifier. A kind's `target` is `{ rule, ...parameters }`, and
 * `apply(w, e, parameters)` returns the point the telegraph aims at. Pure: they read the world and never change it.
 */
export const TARGET_RULES = Object.freeze({
  /** The player's centre. */
  player: Object.freeze({ params: Object.freeze({}), apply: (w) => ({ x: w.player.x, y: w.player.y }) }),
  /** The nearest pickup that is not a returned cache (any pickup when only caches remain), else the player. */
  matter: Object.freeze({ params: Object.freeze({}), apply: (w, e) => {
    if (!w.pickups.length) return { x: w.player.x, y: w.player.y };
    const candidates = w.pickups.filter(p => p.source !== 'cache');
    const p = [...(candidates.length ? candidates : w.pickups)].sort((a, b) => distance(e, a) - distance(e, b))[0];
    return { x: p.x, y: p.y };
  } }),
});

/** The point kind `kind`'s telegraph from enemy `e` aims at in world `w` (its target rule). */
export const targetOf = (kind, w, e) => TARGET_RULES[kind.target.rule].apply(w, e, kind.target);
/** The channel a body touching enemy `e` of kind `kind` meets this step, or null (its channel rule). */
export const channelOf = (kind, e, body) => CHANNEL_RULES[kind.channel.rule].apply(e, body, kind, kind.channel);

/** Refuses a kind's `field` unless it names a rule of `rules` with only that rule's parameters, each valid. */
function checkRule(kind, field, rules) {
  const spec = kind[field], names = Object.keys(rules).join(', ');
  const fail = message => { throw new RangeError(`Kind ${kind.id}: ${field} ${message}`); };
  if (!spec || typeof spec !== 'object' || Array.isArray(spec))
    fail(`must be a named rule { rule, ...parameters } with rule one of ${names}, not ${typeof spec === 'function' ? 'a function' : JSON.stringify(spec)}`);
  if (typeof spec.rule !== 'string' || !Object.hasOwn(rules, spec.rule)) fail(`names an unknown rule ${JSON.stringify(spec.rule)} (one of ${names})`);
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'rule') continue;
    if (!Object.hasOwn(rules[spec.rule].params, key)) fail(`rule ${spec.rule} takes no parameter ${key}`);
    if (!rules[spec.rule].params[key](value)) fail(`rule ${spec.rule}: ${key} cannot be ${JSON.stringify(value)}`);
  }
}

/**
 * A kind entry, with the persistent channels of its windows (tracked every step, touching or not) derived once. Throws
 * a RangeError unless its target and channel are named rules with valid parameters and the whole entry is plain data;
 * returns it frozen all the way down.
 */
export function defineKind(kind) {
  checkRule(kind, 'target', TARGET_RULES);
  checkRule(kind, 'channel', CHANNEL_RULES);
  const persistent = [...kind.windows.damage, ...kind.windows.vulnerability].filter(c => !CHANNELS[c].finite);
  const entry = { ...kind, persistent }, impure = impurity(entry, `kind ${kind.id}`);
  if (impure) throw new RangeError(`Kind ${kind.id} holds ${impure}: a kind is plain data, and configurable behaviour is a named rule`);
  return freeze(entry);
}

/**
 * Per kind: mass and radius bases; observeSpeed while hovering, which keeps `hover.far` to `hover.near` from the
 * player (approaching beyond far, backing off at `hover.back` inside near); telegraph, commit and recover seconds and
 * the commit speed; `hit`, the damage its contact requests from the player; `theft`, matter it lifts while
 * committing (cap and extra reach); `rearArc` for a shielded kind; the clean-dodge and guard-exploit statistics it
 * counts (a near miss is a clean dodge for every kind whose commit targets the player: the charger and the guard, not
 * the scavenger, whose commit targets matter; code-truth F6); `toughness`, how hard the body is to break in a deep
 * field's impacts (src/sim/field.js impactLoss): its `body`, while it commits (a charger's ram), and from behind (a
 * guard's rear arc; other kinds equal their body); and its contact windows and channel rule. `target` and
 * `channel` name rules of TARGET_RULES and CHANNEL_RULES.
 */
export const ENEMY_KINDS = freeze({
  charger: defineKind({
    id: 'charger', name: 'Charger', mass: 40, radius: 24,
    observeSpeed: 42, hover: { far: 330, near: 170, back: -.65 },
    telegraph: 1.05, commit: .82, commitSpeed: 350, recover: 2.65,
    target: { rule: 'player' }, hit: 14, theft: null, rearArc: null, cleanDodges: true, guardExploits: false,
    toughness: { body: 1, commit: 2.5, rear: 1 },
    windows: { damage: ['attack'], vulnerability: ['recover'] }, channel: { rule: 'windowed' },
  }),
  guard: defineKind({
    id: 'guard', name: 'Guard', mass: 50, radius: 31,
    observeSpeed: 28, hover: { far: 330, near: 170, back: -.65 },
    telegraph: 1.2, commit: .75, commitSpeed: 170, recover: 3.1,
    target: { rule: 'player' }, hit: 10, theft: null, rearArc: { open: 1.02, recovering: 1.45 }, cleanDodges: true, guardExploits: true,
    toughness: { body: 4, commit: 4, rear: .6 },
    windows: { damage: ['attack', 'front'], vulnerability: ['rear'] }, channel: { rule: 'shielded' },
  }),
  scavenger: defineKind({
    id: 'scavenger', name: 'Scavenger', mass: 32, radius: 19,
    observeSpeed: 34, hover: { far: 330, near: 170, back: -.65 },
    telegraph: .9, commit: .86, commitSpeed: 260, recover: 2.65,
    target: { rule: 'matter' }, hit: 14, theft: { cap: 15, reach: 12 }, rearArc: null, cleanDodges: false, guardExploits: false,
    toughness: { body: .7, commit: 1.2, rear: .7 },
    windows: { damage: ['attack'], vulnerability: ['recover'] }, channel: { rule: 'windowed' },
  }),
});

/** The entry for `type` in `kinds`, or undefined. */
export const kindEntry = (type, kinds = ENEMY_KINDS) => (Object.hasOwn(kinds, type) ? kinds[type] : undefined);

/** The persistent channels of a body (an enemy kind or a BODIES entry), whose pair history is tracked every step. */
export function persistentChannels(type, kinds = ENEMY_KINDS) {
  const kind = kindEntry(type, kinds);
  if (kind) return kind.persistent;
  const body = Object.hasOwn(BODIES, type) ? BODIES[type] : null;
  return body ? [...body.damage, ...body.vulnerability].filter(c => !CHANNELS[c].finite) : [];
}

/** The channel a body touching enemy `e` meets this step, or null when the contact is neutral. */
export function contactChannel(e, body, kinds = ENEMY_KINDS) {
  return channelOf(kinds[e.type], e, body);
}

/** The ContactEpisodes window for `channel` on body `e`: its current serial, or the persistent re-arm rule at `now`. */
export function contactWindow(e, channel, now) {
  const c = CHANNELS[channel];
  if (c.finite) return { serial: e.serials[channel === 'intercept' ? 'attack' : channel] };
  return { now, interval: c.interval, separation: c.separation };
}
