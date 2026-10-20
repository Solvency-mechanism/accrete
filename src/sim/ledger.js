// The ModifierLedger (docs/specs/M3-data-spine.md 3b.1; docs/expansion-plan.md 7.4). Every stat modifier is an entry
// with a source, a revision and a value, kept in the book of a scope: what the entries apply to. The capture system's
// scopes are owners, whose members derive their stats from the owner's book. A target's stats are always derived
// again from its base stats, never adjusted in place, so revising a source replaces its contribution (a new revision
// is never another additive application) and removing a source restores the base exactly. Sources apply in a fixed
// order, and caps after composition. Dependency-free: nothing here draws from a stream, emits or reads the world.

/** The source kinds, in the order their entries apply (docs/expansion-plan.md 7.4). The capture system uses `capture`. */
export const SOURCES = Object.freeze(['identity', 'form', 'adaptation', 'aspect', 'capture', 'difficulty']);

/** A validated copy of a modifier value: named finite numeric deltas, in the value's own key order. */
export function deltas(modifiers) {
  const copy = {};
  for (const [key, value] of Object.entries(modifiers)) {
    if (!Number.isFinite(value)) throw new TypeError('Modifier values must be finite numeric deltas');
    copy[key] = value;
  }
  return copy;
}

/**
 * Stats derived from `base`: a copy of it, plus each value's deltas in order (a stat the base does not name starts at
 * 0), then `caps`, after composition. `caps` maps a stat to [min, max] and leaves a stat the composition lacks alone.
 * No shipped source sets a cap yet.
 */
export function deriveStats(base, values = [], caps = null) {
  const next = { ...base };
  for (const value of values) for (const [key, delta] of Object.entries(value)) next[key] = (next[key] ?? 0) + delta;
  if (caps) for (const [key, [min, max]] of Object.entries(caps)) {
    if (!(min <= max)) throw new RangeError(`The cap of ${key} needs min <= max`);
    if (Object.hasOwn(next, key)) next[key] = Math.min(max, Math.max(min, next[key]));
  }
  return next;
}

/** Derives `entity.stats` again from its base stats, which are taken from its current stats the first time. */
export function rederive(entity, values = [], caps = null) {
  if (!entity.baseStats) entity.baseStats = { ...(entity.stats ?? {}) };
  entity.stats = deriveStats(entity.baseStats, values, caps);
}

/**
 * Books of modifier entries, one per scope. A scope is an object, keyed by identity (as the capture system's WeakMap
 * was): two owners with the same id keep separate books. Unlike a WeakMap the books can be listed, in the order they
 * were opened, for the checkpoint serializer (exportState, importState). Entries are frozen; changing a value is a new
 * revision.
 */
export class ModifierLedger {
  constructor() { this.books = new Map(); }
  /** The entry of `source` in `scope`'s book, or undefined. */
  entry(scope, source) { return this.books.get(scope)?.get(source); }
  /** The entries of `scope`'s book, in source order. */
  entries(scope) {
    const book = this.books.get(scope);
    return book ? SOURCES.filter(source => book.has(source)).map(source => book.get(source)) : [];
  }
  /**
   * The values `scope`'s targets derive from, in source order. A value in `defaults`, keyed by source, stands in for
   * a source the book has no entry for (the capture system's configured modifiers, for an owner that never set its own).
   */
  values(scope, defaults = {}) {
    const book = this.books.get(scope), out = [];
    for (const source of SOURCES) {
      const entry = book?.get(source);
      if (entry) out.push(entry.value);
      else if (Object.hasOwn(defaults, source)) out.push(defaults[source]);
    }
    return out;
  }
  /**
   * Replaces `source`'s value in `scope`'s book with a frozen, validated copy of `value`, as the next revision of the
   * same entry (the first is revision 1), and returns the entry. An invalid source or value throws and changes nothing.
   */
  set(scope, source, value) {
    if (scope === null || (typeof scope !== 'object' && typeof scope !== 'function')) throw new TypeError('A modifier scope must be an object');
    if (!SOURCES.includes(source)) throw new RangeError(`Unknown modifier source ${JSON.stringify(source)}: one of ${SOURCES.join(', ')}`);
    const copy = Object.freeze(deltas(value));
    let book = this.books.get(scope);
    if (!book) this.books.set(scope, book = new Map());
    const entry = Object.freeze({ source, revision: (book.get(source)?.revision ?? 0) + 1, value: copy });
    book.set(source, entry);
    return entry;
  }
  /** Removes `source`'s entry from `scope`'s book; true when there was one. An emptied book is removed too. */
  remove(scope, source) {
    const book = this.books.get(scope);
    if (!book?.delete(source)) return false;
    if (!book.size) this.books.delete(scope);
    return true;
  }
  /** Removes `scope`'s whole book (a pooled reset); true when there was one. */
  clear(scope) { return this.books.delete(scope); }
  /**
   * The books as plain data, for the checkpoint serializer (src/sim/checkpoint.js): in the order they were opened, each
   * scope as `ref(scope)` and its entries in the order their sources were first set, with their revisions. `ref`
   * returns null for a scope outside the caller's world, which throws: a book nobody can reach is not state to drop.
   */
  exportState(ref) {
    return [...this.books].map(([scope, book]) => {
      const key = ref(scope);
      if (key == null) throw new RangeError('A modifier book belongs to a scope outside the exported state');
      return { scope: key, entries: [...book.values()].map(e => ({ source: e.source, revision: e.revision, value: { ...e.value } })) };
    });
  }
  /**
   * Replaces every book with `state` from exportState(), linking each scope through `resolve(key)`. Entries come back
   * frozen with their revisions, so the next set() is the revision after. Everything is validated first: a malformed
   * state throws and changes nothing. Returns this.
   */
  importState(state, resolve) {
    if (!Array.isArray(state)) throw new TypeError('Ledger state must be a list of books');
    const books = new Map();
    for (const saved of state) {
      const scope = resolve(saved?.scope);
      if (scope === null || (typeof scope !== 'object' && typeof scope !== 'function') || books.has(scope)) throw new TypeError('Each book needs its own object scope');
      if (!Array.isArray(saved.entries) || !saved.entries.length) throw new TypeError('A book holds at least one entry');
      const book = new Map();
      for (const e of saved.entries) {
        if (!SOURCES.includes(e?.source) || book.has(e.source)) throw new RangeError(`Unknown or repeated modifier source ${JSON.stringify(e?.source)}`);
        if (!Number.isSafeInteger(e.revision) || e.revision < 1) throw new RangeError('A revision is a positive integer');
        if (e.value === null || typeof e.value !== 'object' || Array.isArray(e.value)) throw new TypeError('A modifier value is an object of deltas');
        book.set(e.source, Object.freeze({ source: e.source, revision: e.revision, value: Object.freeze(deltas(e.value)) }));
      }
      books.set(scope, book);
    }
    this.books = books;
    return this;
  }
}
