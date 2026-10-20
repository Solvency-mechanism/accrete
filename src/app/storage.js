// Saved data (docs/specs/M3-data-spine.md 3b.5; docs/expansion-plan.md 7.6). One localStorage key with a product-neutral
// prefix, `sm-game:` (from the repository owner, Solvency-mechanism). It names neither the codename nor the proposed
// title, so neither a rename nor decision D16 ever touches it. The key holds one versioned save document:
//   { schema: 1, settingsDiff: { <setting>: <value> }, hintsSeen: [<hint key>] }
// settingsDiff is the M1 diff of the settings the player changed (src/app/settings.js validates it); hintsSeen lists the
// first hints already shown (src/app/hints.js). Each owner validates its own part; this module keeps the document.
//
// First load: when the key is absent, the v0.3 keys migrate into it. `asterwake-settings` in the M1 versioned diff
// format ({ version: 1, changes }) carries its changes; an older whole-settings snapshot carries nothing, as M1 decided
// (it cannot tell which settings the player touched, so it never overrides the accessibility defaults);
// `asterwake-hints` ({ version: 1, seen }) carries its seen list. The legacy keys are left in place: a migration never
// destroys data, and an older build on the same origin still reads its own keys.
//
// Every access is wrapped in try/catch. When storage is missing or refuses access, when a write fails, or when the key
// holds a save from a newer version (which this build must not overwrite), the document lives in memory for the
// session and `problem` names why, for the app's visible notice (src/app/strings.js `storage.<problem>`). A document this
// build cannot read is replaced by a fresh one, with the notice `reset`. Dependency-free; no DOM.

export const STORAGE_PREFIX = 'sm-game:';
export const SAVE_KEY = `${STORAGE_PREFIX}save`;
export const SAVE_SCHEMA = 1;
/** The plan's budget for the whole save (docs/expansion-plan.md 7.6), in UTF-16 code units of its JSON text. */
export const SAVE_LIMIT = 64 * 1024;
export const LEGACY_KEYS = Object.freeze({ settings: 'asterwake-settings', hints: 'asterwake-hints' });
/** Why the save is not being kept, for the app's notice: a key of src/app/strings.js under `storage.`. */
export const STORAGE_PROBLEMS = Object.freeze(['unavailable', 'write', 'newer', 'reset']);

const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const parse = raw => { try { return JSON.parse(raw); } catch { return undefined; } };

/** A fresh save document. */
export const emptySave = () => ({ schema: SAVE_SCHEMA, settingsDiff: {}, hintsSeen: [] });

/**
 * The save document built from the v0.3 keys' raw text (each a string, or null when absent). Pure: never throws, and
 * keeps only what the M1 formats can carry.
 */
export function migrateLegacy({ settings = null, hints = null } = {}) {
  const save = emptySave(), diff = parse(settings ?? 'null'), seen = parse(hints ?? 'null');
  if (diff?.version === 1 && plain(diff.changes)) save.settingsDiff = { ...diff.changes };
  if (seen?.version === 1 && Array.isArray(seen.seen)) save.hintsSeen = seen.seen.filter(key => typeof key === 'string');
  return save;
}

/**
 * Reads a save document's text: { save } when this build can use it, { newer: true } for a schema above SAVE_SCHEMA,
 * or { unreadable: true }. Pure.
 */
export function readSave(raw) {
  const doc = parse(raw);
  if (!plain(doc) || !Number.isSafeInteger(doc.schema) || doc.schema < 1) return { unreadable: true };
  if (doc.schema > SAVE_SCHEMA) return { newer: true };
  if (!plain(doc.settingsDiff) || !Array.isArray(doc.hintsSeen)) return { unreadable: true };
  return { save: { schema: SAVE_SCHEMA, settingsDiff: { ...doc.settingsDiff }, hintsSeen: doc.hintsSeen.filter(key => typeof key === 'string') } };
}

const copy = value => JSON.parse(JSON.stringify(value));

/**
 * The save store. `storage` returns the Storage to use (window.localStorage in the app); it is called inside try/catch,
 * because merely reading `localStorage` throws where the browser blocks site data. Loads (and migrates) at once.
 *   get(field)            a copy of a field of the save ('settingsDiff', 'hintsSeen')
 *   set(field, value)     replaces the field and writes the whole save; a failed write keeps it in memory
 *   problem               null while the save is kept, or one of STORAGE_PROBLEMS
 *   onProblem(listener)   calls listener(problem) whenever `problem` changes; returns an unsubscribe function
 */
export function createStore({ storage = () => null } = {}) {
  let backend = null, writable = false, problem = null, save = emptySave();
  const listeners = new Set();
  const report = next => { if (next === problem) return; problem = next; for (const listener of listeners) try { listener(problem); } catch {} };
  const write = () => {
    if (!writable) return false;
    try {
      const text = JSON.stringify(save);
      if (text.length > SAVE_LIMIT) throw new RangeError(`The save is ${text.length} characters, over ${SAVE_LIMIT}`);
      backend.setItem(SAVE_KEY, text);
      if (problem === 'write') report(null);
      return true;
    } catch { report('write'); return false; }
  };
  try {
    backend = storage();
    if (!backend || typeof backend.getItem !== 'function' || typeof backend.setItem !== 'function') throw new TypeError('No storage');
    const raw = backend.getItem(SAVE_KEY);
    writable = true;
    if (raw === null) {
      save = migrateLegacy({ settings: backend.getItem(LEGACY_KEYS.settings), hints: backend.getItem(LEGACY_KEYS.hints) });
      write();
    } else {
      const read = readSave(raw);
      if (read.save) save = read.save;
      else if (read.newer) { writable = false; report('newer'); }
      else { report('reset'); write(); }
    }
  } catch { writable = false; report('unavailable'); }
  return {
    get problem() { return problem; },
    get(field) { return copy(save[field]); },
    set(field, value) {
      if (!Object.hasOwn(save, field) || field === 'schema') throw new RangeError(`The save has no field ${JSON.stringify(field)}`);
      save[field] = copy(value);
      return write();
    },
    onProblem(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
