// Descriptor data helpers (docs/specs/M3-data-spine.md, 3c-move; Astra review P2, probes B2 and B3). A campaign
// descriptor and its kinds are plain data: configurable behaviour is a named rule with plain data parameters, never a
// function, because a function's source text cannot identify the state its closure captured (B2). A defined descriptor
// is frozen all the way down, through containers that were already frozen, so no mutable child can sit under a hash
// cached for its descriptor (B3). Dependency-free.

/**
 * Freezes `value` and every object it reaches through its own properties, including the children of objects that were
 * already frozen. Functions are left as they are (only the presentation registries and identity strategies hold them;
 * a campaign descriptor refuses them). Returns `value`.
 */
export function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if ('value' in property) deepFreeze(property.value, seen);
  }
  return value;
}

/** Whether `value` and every object it reaches through its own properties are frozen. */
export function isDeeplyFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Reflect.ownKeys(value).every(key => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !('value' in property) || isDeeplyFrozen(property.value, seen);
  });
}

/**
 * The path of the first value in `value` that is not plain descriptor data (a function, symbol, bigint, accessor or
 * an object that is neither a plain object nor an array), or null when all of it is.
 */
export function impurity(value, path = 'descriptor', seen = new Set()) {
  if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)) return null;
  if (typeof value !== 'object') return `${path} (a ${typeof value})`;
  if (seen.has(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return `${path} (a ${value.constructor?.name ?? 'non-plain object'})`;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') return `${path}[${String(key)}] (a symbol key)`;
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!('value' in property)) return `${path}.${key} (an accessor)`;
    if (Array.isArray(value) && key === 'length') continue;
    const found = impurity(property.value, Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`, seen);
    if (found) return found;
  }
  return null;
}
