/** Integer gameplay accounting. Physical size and movement are deliberately separate. */
import { ModifierLedger, deltas, deriveStats, rederive } from './ledger.js';

function budget(value, label = 'budget') {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a nonnegative safe integer`);
  return value;
}

function fraction(value, label) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${label} must be between zero and one`);
  return value;
}

// A fraction as the exact rational its shortest decimal text names (String(.35) is "0.35", so 35/100), as BigInt
// numerator and denominator, cached per value. Settlement fractions are finite and between zero and one.
const rationals = new Map();
function rational(value) {
  let r = rationals.get(value);
  if (!r) {
    const [, whole, decimals = '', exponent = '0'] = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(value));
    const shift = Number(exponent) - decimals.length, digits = BigInt(whole + decimals);
    r = shift >= 0 ? { numerator: digits * 10n ** BigInt(shift), denominator: 1n } : { numerator: digits, denominator: 10n ** BigInt(-shift) };
    rationals.set(value, r);
  }
  return r;
}

/**
 * floor(n * f) exactly (M3b), for a nonnegative safe integer n and a fraction f from zero to one, reading f as the exact
 * rational of its decimal text: floorFraction(180, .35) is 63, where the float product 180 * .35 is 62.99999999999999.
 */
export function floorFraction(n, f) {
  budget(n, 'amount');
  fraction(f, 'fraction');
  const { numerator, denominator } = rational(f);
  return Number(BigInt(n) * numerator / denominator);
}

/**
 * Mutates the target once; every reward derives from the actual removed mass. Each reward fraction floors exactly
 * (floorFraction, M3b): identical to the float floor for every settled loss below 180 at the fractions in use, and
 * one more at 180 with .35 (docs/contracts.md).
 */
export function settleDamage(target, { requested, defense = 0, damageCap = Infinity, transferFraction = 0, debrisFraction = 1 } = {}) {
  budget(target.mass, 'target mass');
  budget(requested, 'requested damage');
  budget(defense, 'defense');
  if (damageCap !== Infinity) budget(damageCap, 'damage cap');
  fraction(transferFraction, 'transfer fraction');
  fraction(debrisFraction, 'debris fraction');
  const settledLoss = target.alive === false ? 0 : Math.min(target.mass, Math.max(0, requested - defense), damageCap);
  const creditedTransfer = floorFraction(settledLoss, transferFraction);
  const debris = Math.min(settledLoss - creditedTransfer, floorFraction(settledLoss, debrisFraction));
  target.mass -= settledLoss;
  if (target.mass === 0) target.alive = false;
  return Object.freeze({ requested, settledLoss, creditedTransfer, debris, absorbed: requested - settledLoss, unallocated: settledLoss - creditedTransfer - debris });
}

/**
 * The explicit player adapter for settleDamage (M3b). The player's integrity is not matter: it is stored apart from
 * mass and growth, so damage to it transfers nothing and makes no debris (both fractions are fixed at zero, and the
 * whole settled loss is reported as unallocated, which the simulation does not add to the matter sinks). settleDamage
 * reads and mutates `mass` and `alive`; the adapter lends it the body's integrity as that mass and writes back the
 * integrity and, when it reaches zero, `alive = false`. Defense and the damage cap work as in settleDamage.
 */
export function settleIntegrity(body, { requested, defense = 0, damageCap = Infinity } = {}) {
  const target = { mass: body.integrity, alive: body.alive };
  const result = settleDamage(target, { requested, defense, damageCap, transferFraction: 0, debrisFraction: 0 });
  body.integrity = target.mass;
  if (target.alive === false) body.alive = false;
  return result;
}

/**
 * Repairs a body's integrity by `amount`, up to its maxIntegrity, and returns the integrity restored. A repair is not
 * matter: nothing is spent from or added to the field, the growth or the score (the evolution and handoff repairs).
 */
export function repairIntegrity(body, amount) {
  budget(amount, 'integrity repair');
  budget(body.integrity, 'integrity');
  const before = body.integrity;
  body.integrity = Math.min(body.maxIntegrity, body.integrity + amount);
  return body.integrity - before;
}

/** Zero-value fragments are intentional: appearance cannot manufacture resources. */
export function splitBudget(total, count) {
  budget(total, 'total');
  budget(count, 'fragment count');
  if (count === 0) {
    if (total !== 0) throw new RangeError('A nonzero budget needs at least one fragment');
    return [];
  }
  if (count > 10000) throw new RangeError('Physical fragment count exceeds the bounded pool');
  const share = Math.floor(total / count);
  const remainder = total % count;
  return Array.from({ length: count }, (_, i) => share + (i < remainder ? 1 : 0));
}

const identities = new WeakMap();
/** The typed id as JSON (1 and '1' differ), cached per entity object because contacts ask for it every step. */
function identity(entity) {
  if (!entity || (typeof entity.id !== 'string' && typeof entity.id !== 'number')) throw new TypeError('Entity needs a stable id');
  budget(entity.generation, 'entity generation');
  let cached = identities.get(entity);
  if (cached?.id !== entity.id) identities.set(entity, cached = { id: entity.id, key: JSON.stringify([typeof entity.id, entity.id]) });
  return cached.key;
}

const ready = (record, now) => (record.separated || !record.separation) && now - record.last >= record.interval - 1e-9;

/**
 * Window-aware contact episodes (D17). A channel episode is keyed by the canonical pair, both generations, the
 * channel, and either the window's serial (finite) or the pair's re-arm state (persistent). Generation high-water
 * marks are per entity across every pair and channel. The two-argument enter/separate keep the pre-M2 per-overlap
 * episode for the stale-generation regression; the simulation uses the channel API everywhere.
 */
export class ContactEpisodes {
  #involved = new Map();
  constructor({ hysteresis = 12 } = {}) {
    this.contacts = new Map(); this.latestGenerations = new Map(); this.windows = new Map(); this.persistent = new Map();
    this.hysteresis = hysteresis;
  }
  /**
   * How many persistent records name each entity (by typed id), so `track` skips the pair lookup for the many pairs
   * with no history. Derived from `persistent` and private, so it is never exported, compared or restored: `importState` rebuilds it.
   */
  index(id, left, right, change) {
    for (const k of [left, right]) { const n = (this.#involved.get(k) ?? 0) + change; if (n > 0) this.#involved.set(k, n); else this.#involved.delete(k); }
  }
  reindex() {
    this.#involved = new Map();
    for (const id of this.persistent.keys()) { const [l, r] = JSON.parse(id.slice(0, id.lastIndexOf('#'))); this.index(id, JSON.stringify(l), JSON.stringify(r), 1); }
  }
  pair(a, b) {
    const left = identity(a), right = identity(b);
    if (left === right) throw new Error('A contact requires distinct entity ids');
    return left < right ? { key: `[${left},${right}]`, generations: `${a.generation}:${b.generation}` }
      : { key: `[${right},${left}]`, generations: `${b.generation}:${a.generation}` };
  }
  /**
   * The one generation observation (code-truth F2): raises the entity's high-water mark to its generation, and returns
   * false when that generation is older than the mark. Every entry point that is shown an entity observes it first
   * (enter, eligible, close and track), so a newer generation seen anywhere refuses an older one everywhere.
   */
  observe(entity) {
    const id = identity(entity), latest = this.latestGenerations.get(id) ?? -1;
    if (entity.generation < latest) return false;
    this.latestGenerations.set(id, entity.generation);
    return true;
  }
  /** Observes both generations; false when either is older than its high-water mark or either body is dead. */
  current(a, b) {
    const left = this.observe(a), right = this.observe(b);
    return left && right && a.alive !== false && b.alive !== false;
  }
  /**
   * enter(a, b): the pre-M2 episode, true once per live pair/generation until separate(a, b).
   * enter(a, b, channel, {serial}): a finite window owned by `b`; true at most once per pair, generations, channel
   * and serial. Separation never reopens a spent serial; a newer serial is eligible at once; a closed or older one never.
   * enter(a, b, channel, {now, interval, separation = true}): a persistent channel; true when the pair has no pending
   * history, or `interval` seconds have passed since its last settlement and (with `separation`) track() saw a gap
   * beyond the hysteresis in between. A true result is a consumed settlement.
   */
  enter(a, b, channel, window) {
    if (channel === undefined) {
      if (!this.current(a, b)) return false;
      const { key, generations } = this.pair(a, b);
      if (this.contacts.get(key) === generations) return false;
      this.contacts.set(key, generations);
      return true;
    }
    return this.settle(a, b, channel, window, true);
  }
  /**
   * The same answer as enter(a, b, channel, window), without consuming the episode (grace is checked first). Like
   * enter, it observes what it is shown: the generations, and a newer finite serial, which retires the older ones.
   */
  eligible(a, b, channel, window) { return this.settle(a, b, channel, window, false); }
  settle(a, b, channel, window, consume) {
    if (typeof channel !== 'string' || !channel) throw new TypeError('A contact channel needs a name');
    if (window?.serial !== undefined) return this.finite(a, b, channel, budget(window.serial, 'window serial'), consume);
    const { now, interval, separation = true } = window ?? {};
    if (!Number.isFinite(now) || !Number.isFinite(interval) || interval < 0) throw new TypeError('A persistent channel needs a finite time and re-arm interval');
    if (!this.current(a, b)) return false;
    const { key, generations } = this.pair(a, b), id = `${key}#${channel}`, record = this.persistent.get(id);
    // History from older generations is superseded: current() has just confirmed these are the newest.
    if (record && record.generations === generations && !ready(record, now)) return false;
    if (consume) {
      if (!this.persistent.has(id)) this.index(id, identity(a), identity(b), 1);
      this.persistent.set(id, { generations, last: now, interval, separation: !!separation, separated: false });
    }
    return true;
  }
  finite(a, b, channel, serial, consume) {
    if (!this.current(a, b)) return false;
    const owner = `${identity(b)}#${channel}`;
    let window = this.windows.get(owner);
    const newer = !window || b.generation > window.generation || (b.generation === window.generation && serial > window.serial);
    if (!newer && (b.generation < window.generation || serial < window.serial || window.closed)) return false;
    const { key, generations } = this.pair(a, b), episode = `${key}#${generations}`;
    if (!newer && window.spent.has(episode)) return false;
    // A newer serial replaces the record, which prunes the spent episodes of the older one, whether it is consumed or
    // only queried: once a serial has been seen, an older one never settles for any pair (code-truth F4).
    if (newer) this.windows.set(owner, window = { generation: b.generation, serial, closed: false, spent: new Set() });
    if (consume) window.spent.add(episode);
    return true;
  }
  /** The finite window `serial` of `b` has ended: its record is pruned and the serial can never settle again. */
  close(b, channel, serial) {
    budget(serial, 'window serial');
    if (!this.observe(b)) return;
    const owner = `${identity(b)}#${channel}`, window = this.windows.get(owner);
    // A callback carrying an old generation or an old serial never clears a current record.
    if (window && (b.generation < window.generation || (b.generation === window.generation && serial < window.serial))) return;
    this.windows.set(owner, { generation: b.generation, serial, closed: true, spent: new Set() });
  }
  /**
   * Reports a pair's current surface gap on a persistent channel. Call it every step for every pair the channel
   * tracks, touching or not: a pair's history is kept until both re-arm conditions have been seen, then released.
   * Returns true on the step it re-arms. A callback with other generations than the record's never clears it. Both
   * generations are observed, touching or not.
   */
  track(a, b, channel, gap, now) {
    const left = this.observe(a), right = this.observe(b);
    if (!left || !right || !this.persistent.size || !this.#involved.has(identity(a)) || !this.#involved.has(identity(b))) return false;
    const { key, generations } = this.pair(a, b), id = `${key}#${channel}`, record = this.persistent.get(id);
    if (!record || record.generations !== generations) return false;
    if (gap > this.hysteresis) record.separated = true;
    if (!ready(record, now)) return false;
    this.persistent.delete(id); this.index(id, identity(a), identity(b), -1);
    return true;
  }
  separate(a, b) {
    const { key, generations } = this.pair(a, b);
    // A late callback from an old pooled generation must not reopen a new contact.
    if (this.contacts.get(key) === generations) this.contacts.delete(key);
  }
  clear() { this.contacts.clear(); this.latestGenerations.clear(); this.windows.clear(); this.persistent.clear(); this.#involved.clear(); }
  /**
   * Every record as plain data, for the checkpoint serializer (src/sim/checkpoint.js): each map as its entries in insertion
   * order, keyed exactly as the map keys them (typed ids, generations and channels), so nothing is reconstructed.
   */
  exportState() {
    return {
      hysteresis: this.hysteresis,
      contacts: [...this.contacts],
      latestGenerations: [...this.latestGenerations],
      windows: [...this.windows].map(([owner, w]) => [owner, { generation: w.generation, serial: w.serial, closed: w.closed, spent: [...w.spent] }]),
      persistent: [...this.persistent].map(([id, r]) => [id, { generations: r.generations, last: r.last, interval: r.interval, separation: r.separation, separated: r.separated }]),
    };
  }
  /** Replaces every record with `state` from exportState(). Validated first: a malformed state throws and changes nothing. Returns this. */
  importState(state) {
    if (!state || typeof state !== 'object') throw new TypeError('Contact state must be an object');
    const text = (v, label) => { if (typeof v !== 'string') throw new TypeError(`${label} must be a string`); return v; };
    const flag = (v, label) => { if (typeof v !== 'boolean') throw new TypeError(`${label} must be a boolean`); return v; };
    const time = (v, label) => { if (!Number.isFinite(v)) throw new TypeError(`${label} must be finite`); return v; };
    const map = (list, label, value) => {
      if (!Array.isArray(list)) throw new TypeError(`${label} must be a list of entries`);
      const out = new Map();
      for (const entry of list) {
        if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError(`${label} entries are [key, value]`);
        const key = text(entry[0], `${label} key`);
        if (out.has(key)) throw new RangeError(`${label} repeats ${key}`);
        out.set(key, value(entry[1], `${label} ${key}`));
      }
      return out;
    };
    const hysteresis = time(state.hysteresis, 'hysteresis');
    const contacts = map(state.contacts, 'contacts', text);
    const latestGenerations = map(state.latestGenerations, 'latestGenerations', (g, label) => budget(g, label));
    const windows = map(state.windows, 'windows', (w, label) => {
      if (!w || !Array.isArray(w.spent)) throw new TypeError(`${label} needs a spent list`);
      const spent = new Set(w.spent.map(e => text(e, `${label} spent episode`)));
      if (spent.size !== w.spent.length) throw new RangeError(`${label} repeats a spent episode`);
      return { generation: budget(w.generation, `${label} generation`), serial: budget(w.serial, `${label} serial`), closed: flag(w.closed, `${label} closed`), spent };
    });
    const persistent = map(state.persistent, 'persistent', (r, label) => {
      if (!r || typeof r !== 'object') throw new TypeError(`${label} must be a record`);
      if (!(time(r.interval, `${label} interval`) >= 0)) throw new RangeError(`${label} interval must be nonnegative`);
      return { generations: text(r.generations, `${label} generations`), last: time(r.last, `${label} last`), interval: r.interval,
        separation: flag(r.separation, `${label} separation`), separated: flag(r.separated, `${label} separated`) };
    });
    Object.assign(this, { contacts, latestGenerations, windows, persistent, hysteresis });
    this.reindex();
    return this;
  }
}

/**
 * Synchronous commit validates everything before changing either ownership edge. Owner modifiers are entries in a
 * ModifierLedger (src/sim/ledger.js): each owner's book holds its `capture` entry, keyed by the owner object, and its
 * members' stats are derived from their base stats and that book. `modifiers` is the configured default, which a
 * member derives from when its owner never set its own.
 *
 * The ownership edges (`ownerByMember`, member to owner) and the outstanding requests (`requests`, token to record) are
 * Maps keyed by object, as the WeakMaps they replace (M3b, for the checkpoint serializer) were, so exportState can list
 * them. The one difference is retention: an abandoned request's token is held until the system is dropped, and a
 * captured member until it is released or reset.
 */
export class CaptureSystem {
  constructor({ capacity = 2, maxTier = 1, maxRange = 160, modifiers = {} } = {}) {
    budget(capacity, 'capture capacity');
    budget(maxTier, 'capture tier');
    if (!Number.isFinite(maxRange) || maxRange < 0) throw new RangeError('Capture range must be finite and nonnegative');
    this.capacity = capacity;
    this.maxTier = maxTier;
    this.maxRange = maxRange;
    this.modifiers = deltas(modifiers);
    this.ledger = new ModifierLedger();
    this.ownerByMember = new Map();
    this.requests = new Map();
    this.nextRequest = 1;
  }
  request(owner, candidate, { replaceId = null } = {}) {
    identity(owner); identity(candidate);
    const replacement = (owner.companions ?? []).find(member => member.id === replaceId) ?? null;
    const token = Object.freeze({ id: this.nextRequest++, candidateId: candidate.id, replaceId,
      preview: Object.freeze({ lostRole: replacement?.role ?? null, newRole: candidate.role ?? null }) });
    this.requests.set(token, { owner, candidate, ownerId: owner.id, candidateId: candidate.id,
      ownerGeneration: owner.generation, candidateGeneration: candidate.generation,
      expectedOwnerId: candidate.ownerId ?? null, candidateRole: candidate.role ?? null,
      replacement, replaceGeneration: replacement?.generation, replacementRole: replacement?.role ?? null, replaceId });
    return token;
  }
  commit(token) {
    const request = this.requests.get(token);
    if (!request) return { ok: false, reason: 'invalid-or-used-request' };
    this.requests.delete(token);
    const { owner, candidate, replacement, replaceId } = request;
    const fail = reason => ({ ok: false, reason });
    if (owner.id !== request.ownerId || candidate.id !== request.candidateId || owner.generation !== request.ownerGeneration || candidate.generation !== request.candidateGeneration) return fail('generation-changed');
    if (owner === candidate || owner.id === candidate.id) return fail('self-capture');
    if (!owner.alive || !candidate.alive) return fail('not-live');
    if (owner.transitioning || candidate.transitioning) return fail('transitioning');
    if ((candidate.ownerId ?? null) !== request.expectedOwnerId || candidate.ownerId != null || this.ownerByMember.has(candidate)) return fail('ownership-changed');
    const members = owner.companions ?? [];
    if (members.includes(candidate)) return fail('already-member');
    if (!Number.isSafeInteger(candidate.tier) || candidate.tier < 0 || candidate.tier > this.maxTier) return fail('tier');
    if (![owner.x, owner.y, candidate.x, candidate.y].every(Number.isFinite) || Math.hypot(owner.x - candidate.x, owner.y - candidate.y) > this.maxRange) return fail('range');
    if (replaceId != null && (!replacement || !members.includes(replacement) || replacement.id !== replaceId || replacement.generation !== request.replaceGeneration || !replacement.alive || replacement.ownerId !== owner.id)) return fail('replacement-changed');
    if ((candidate.role ?? null) !== request.candidateRole || (replacement?.role ?? null) !== request.replacementRole) return fail('role-changed');
    if (members.length - (replacement ? 1 : 0) >= this.capacity) return fail('capacity');
    // Prepare all derived state before the atomic ownership mutation.
    const mods = this.memberModifiers(owner);
    const base = candidate.baseStats ?? { ...(candidate.stats ?? {}) };
    const nextStats = deriveStats(base, mods);
    if (replacement) this.release(owner, replacement.id);
    owner.companions ??= [];
    candidate.baseStats = base;
    candidate.stats = nextStats;
    candidate.ownerId = owner.id;
    owner.companions.push(candidate);
    this.ownerByMember.set(candidate, owner);
    return { ok: true, captured: candidate, released: replacement };
  }
  release(owner, memberId) {
    const index = (owner.companions ?? []).findIndex(member => member.id === memberId);
    if (index < 0) return { ok: false, reason: 'not-member' };
    const member = owner.companions[index];
    if (member.ownerId !== owner.id) return { ok: false, reason: 'ownership-changed' };
    owner.companions.splice(index, 1);
    member.ownerId = null;
    this.ownerByMember.delete(member);
    rederive(member);
    return { ok: true, released: member };
  }
  /**
   * Evolution uses the same path as a changed build: the owner's capture entry is replaced by its next revision, and
   * every current member derives again from base, so modifiers never compound.
   */
  reapply(owner, modifiers = this.modifiers) {
    this.ledger.set(owner, 'capture', modifiers);
    const mods = this.memberModifiers(owner);
    for (const member of owner.companions ?? []) if (member.ownerId === owner.id) rederive(member, mods);
  }
  /** What an owner's members derive from, in source order: its book, with the default standing in for a capture entry it never set. */
  memberModifiers(owner) { return this.ledger.values(owner, { capture: this.modifiers }); }
  /** The owner's own capture modifiers (its entry's value), or undefined when it never set them. Reads only. */
  modifiersOf(owner) { return this.ledger.entry(owner, 'capture')?.value; }
  resetEntity(entity) {
    const owner = this.ownerByMember.get(entity);
    if (owner) this.release(owner, entity.id);
    for (const member of [...(entity.companions ?? [])]) this.release(entity, member.id);
    this.ledger.clear(entity);
    resetPooledEntity(entity);
  }
  /**
   * The system as plain data, for the checkpoint serializer (src/sim/checkpoint.js): the configuration, `nextRequest`, the
   * ledger's books, the ownership edges and the outstanding requests, in the order each was made. Every entity is
   * written as `ref(entity)`, by default its typed id and generation; the serializer's ref returns null for an entity
   * outside its world. Ownership edges are exported, never inferred from a roster: a mantle member owned from the start
   * has an `ownerId` and no edge. A book or edge outside the world throws.
   *
   * A request is written with its token's fields and its record, field by field. A **stale** request, one that names an
   * entity outside the world or one whose id or generation has changed since it was made, can never be committed
   * again (generations only grow), so it is left out and restores as consumed, like a committed request: every id
   * below `nextRequest` that is not written is consumed.
   */
  exportState(ref = entity => ({ id: entity.id, generation: entity.generation })) {
    const edge = (entity, what) => { const key = ref(entity); if (key == null) throw new RangeError(`A capture ${what} is outside the exported state`); return key; };
    const current = (entity, id, generation) => entity.id === id && entity.generation === generation;
    const requests = [];
    for (const [token, r] of this.requests) {
      const owner = ref(r.owner), candidate = ref(r.candidate), replacement = r.replacement ? ref(r.replacement) : null;
      if (!owner || !candidate || (r.replacement && !replacement)) continue;
      if (!current(r.owner, r.ownerId, r.ownerGeneration) || !current(r.candidate, r.candidateId, r.candidateGeneration)
        || (r.replacement && !current(r.replacement, r.replaceId, r.replaceGeneration))) continue;
      requests.push({ token: { id: token.id, candidateId: token.candidateId, replaceId: token.replaceId, preview: { lostRole: token.preview.lostRole, newRole: token.preview.newRole } },
        owner, candidate, replacement,
        record: { ownerId: r.ownerId, candidateId: r.candidateId, ownerGeneration: r.ownerGeneration, candidateGeneration: r.candidateGeneration,
          expectedOwnerId: r.expectedOwnerId, candidateRole: r.candidateRole, replaceGeneration: r.replaceGeneration, replacementRole: r.replacementRole, replaceId: r.replaceId } });
    }
    return {
      capacity: this.capacity, maxTier: this.maxTier, maxRange: this.maxRange, modifiers: { ...this.modifiers }, nextRequest: this.nextRequest,
      books: this.ledger.exportState(scope => edge(scope, 'modifier owner')),
      edges: [...this.ownerByMember].map(([member, owner]) => ({ member: edge(member, 'member'), owner: edge(owner, 'owner') })),
      requests,
    };
  }
  /**
   * Replaces the system's state with `state` from exportState() and returns the requestMap. The two-pass restore has
   * already created the entities; this links each one through `resolve(key)`, which returns the caller's entity with
   * that typed id and generation. Each outstanding request is reissued as a fresh frozen token with its old id and
   * fields, recorded in the requestMap (a Map from old request id to new token): token identity is the contract, so a
   * token issued before the restore, or a JSON copy of one, stays invalid here. Everything is validated first: a
   * malformed state, or a key `resolve` cannot link, throws and changes nothing.
   */
  importState(state, resolve) {
    if (!state || typeof state !== 'object') throw new TypeError('Capture state must be an object');
    const link = (key, what) => {
      const entity = resolve(key);
      if (!entity || typeof entity !== 'object' || entity.id !== key?.id || entity.generation !== key?.generation) throw new RangeError(`Cannot link the capture ${what} ${JSON.stringify(key)}`);
      return entity;
    };
    const id = (v, label) => { if (typeof v !== 'string' && typeof v !== 'number') throw new TypeError(`${label} must be a string or number id`); return v; };
    const optionalId = (v, label) => (v === null ? v : id(v, label));
    const role = (v, label) => { if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) throw new TypeError(`${label} must be a role or null`); return v; };
    budget(state.capacity, 'capture capacity'); budget(state.maxTier, 'capture tier');
    if (!Number.isFinite(state.maxRange) || state.maxRange < 0) throw new RangeError('Capture range must be finite and nonnegative');
    if (!Number.isSafeInteger(state.nextRequest) || state.nextRequest < 1) throw new RangeError('nextRequest must be a positive integer');
    if (state.modifiers === null || typeof state.modifiers !== 'object') throw new TypeError('Capture modifiers must be an object');
    const modifiers = deltas(state.modifiers);
    const ledger = new ModifierLedger().importState(state.books, key => link(key, 'modifier owner'));
    if (!Array.isArray(state.edges) || !Array.isArray(state.requests)) throw new TypeError('Capture edges and requests must be lists');
    const ownerByMember = new Map();
    for (const e of state.edges) {
      const member = link(e?.member, 'member');
      if (ownerByMember.has(member)) throw new RangeError(`Member ${JSON.stringify(e.member)} has two ownership edges`);
      ownerByMember.set(member, link(e.owner, 'owner'));
    }
    const requests = new Map(), requestMap = new Map();
    for (const saved of state.requests) {
      const t = saved?.token, r = saved?.record;
      if (!t || !r || !t.preview) throw new TypeError('A request needs its token and record');
      if (!Number.isSafeInteger(t.id) || t.id < 1 || t.id >= state.nextRequest || requestMap.has(t.id)) throw new RangeError(`Request id ${t.id} is not an issued, unrepeated id below nextRequest`);
      const owner = link(saved.owner, 'request owner'), candidate = link(saved.candidate, 'request candidate');
      const replacement = saved.replacement === null ? null : link(saved.replacement, 'request replacement');
      if (owner.id !== r.ownerId || owner.generation !== r.ownerGeneration || candidate.id !== r.candidateId || candidate.generation !== r.candidateGeneration
        || (replacement ? replacement.id !== r.replaceId || replacement.generation !== r.replaceGeneration : r.replaceGeneration !== undefined)
        || t.candidateId !== r.candidateId || t.replaceId !== r.replaceId) throw new RangeError(`Request ${t.id} is stale, or links other entities than it names`);
      const token = Object.freeze({ id: t.id, candidateId: id(t.candidateId, 'token candidateId'), replaceId: optionalId(t.replaceId, 'token replaceId'),
        preview: Object.freeze({ lostRole: role(t.preview.lostRole, 'preview lostRole'), newRole: role(t.preview.newRole, 'preview newRole') }) });
      requests.set(token, { owner, candidate, ownerId: r.ownerId, candidateId: r.candidateId,
        ownerGeneration: r.ownerGeneration, candidateGeneration: r.candidateGeneration,
        expectedOwnerId: optionalId(r.expectedOwnerId, 'expectedOwnerId'), candidateRole: role(r.candidateRole, 'candidateRole'),
        replacement, replaceGeneration: r.replaceGeneration, replacementRole: role(r.replacementRole, 'replacementRole'), replaceId: optionalId(r.replaceId, 'replaceId') });
      requestMap.set(t.id, token);
    }
    Object.assign(this, { capacity: state.capacity, maxTier: state.maxTier, maxRange: state.maxRange, modifiers, ledger, ownerByMember, requests, nextRequest: state.nextRequest });
    return requestMap;
  }
}

/**
 * Retains template identity/baseStats; clears every mutable gameplay/effect field, including the M2 contact state:
 * grace seconds, the pending command and window serials (a pool initializer sets the serials its kind declares).
 */
export function resetPooledEntity(entity) {
  identity(entity);
  entity.generation = budget(entity.generation + 1, 'next generation');
  Object.assign(entity, { alive: false, ownerId: null, companions: [], mass: 0,
    x: 0, y: 0, vx: 0, vy: 0, transitioning: false, invulnerable: 0, pendingCommand: null, serials: {},
    effects: [], timers: {}, collisionMask: 'default', role: null,
    visual: { flash: 0, scale: 1, opacity: 1 }, contactTimer: 0, commandTimer: 0 });
  rederive(entity);
  return entity;
}

/** One form per operation. Carry uses proportional progress, at most 10% of next interval. */
export function evolveGrowth({ formIndex = 0, growth = 0, score = 0 }, gain, intervals) {
  budget(formIndex, 'form index'); budget(growth, 'growth'); budget(score, 'score'); budget(gain, 'growth gain');
  if (!Array.isArray(intervals) || intervals.length === 0 || intervals.some(n => !Number.isSafeInteger(n) || n <= 0) || formIndex >= intervals.length) throw new RangeError('Growth intervals must cover the current form');
  const total = budget(growth + gain, 'total growth');
  const current = intervals[formIndex];
  if (total < current) return { formIndex, growth: total, score, evolved: false, overflow: 0, carried: 0, consumedOverflow: 0, recognized: 0 };
  const overflow = total - current;
  if (formIndex === intervals.length - 1) return { formIndex, growth: current, score: budget(score + overflow, 'score'), evolved: false, overflow, carried: 0, consumedOverflow: 0, recognized: overflow };
  const next = intervals[formIndex + 1];
  const proportionalCarry = BigInt(overflow) * BigInt(next) / BigInt(current);
  const carryCap = BigInt(next) / 10n;
  const carried = Number(proportionalCarry < carryCap ? proportionalCarry : carryCap);
  // Charge the source units needed to produce carried progress; rounding dust is score only.
  const consumedOverflow = Math.min(overflow, Number((BigInt(carried) * BigInt(current) + BigInt(next) - 1n) / BigInt(next)));
  const recognized = overflow - consumedOverflow;
  return { formIndex: formIndex + 1, growth: carried, score: budget(score + recognized, 'score'), evolved: true,
    overflow, carried, consumedOverflow, recognized };
}

/** Releasing one effect cannot restore time while another owner still requests a slowdown. */
export class TimeScaleRequests {
  constructor() { this.requests = new Map(); }
  acquire(owner, scale) {
    fraction(scale, 'time scale');
    const token = Symbol('time-scale');
    this.requests.set(token, { owner, scale });
    return () => this.requests.delete(token);
  }
  clearOwner(owner) { for (const [token, request] of this.requests) if (request.owner === owner) this.requests.delete(token); }
  get value() { return Math.min(1, ...Array.from(this.requests.values(), request => request.scale)); }
}
