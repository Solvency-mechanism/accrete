// Original painted atlases are loaded once. Runtime crop caches are deliberately
// bounded; raster art never determines a simulation radius or collision shape.
const SOURCES = {
  celestial: new URL("../../assets/celestial-atlas.png", import.meta.url).href,
  field: new URL("../../assets/field-atlas.png", import.meta.url).href,
  nebula: new URL("../../assets/nebula.png", import.meta.url).href,
};
// Atlas manifest (docs/specs/M3-data-spine.md, 3a.5): which painted cell draws each identity in each form, each enemy
// kind, each ore variant, each moon role and matter. A cell is its atlas, its column and row in that atlas's 3 x 3
// grid, and its inspected region in the original 1254 px atlas: the painted rows are not perfectly aligned to
// mathematical thirds, so explicit bounds keep adjacent planet tips out of a cell and avoid pixel readback during play.
// Anything the manifest has no cell for (a form or kind added later, or test-only content) is drawn procedurally by
// src/render/render.js from the registries' colours, so a missing cell is never an error.
const cell = (key, atlas, column, row, region) => Object.freeze({ key, atlas, column, row, region: Object.freeze(region) });
export const ATLAS = Object.freeze({
  identities: Object.freeze({
    warden: Object.freeze({
      dwarf: cell("warden-dwarf", "celestial", 0, 0, [32, 33, 369, 364]),
      planet: cell("warden-planet", "celestial", 1, 0, [440, 32, 374, 367]),
      "gas-giant": cell("warden-gas-giant", "celestial", 2, 0, [854, 32, 373, 367]),
    }),
    harvester: Object.freeze({
      dwarf: cell("harvester-dwarf", "celestial", 0, 1, [33, 439, 363, 359]),
      planet: cell("harvester-planet", "celestial", 1, 1, [441, 436, 371, 365]),
      "gas-giant": cell("harvester-gas-giant", "celestial", 2, 1, [852, 432, 377, 372]),
    }),
    unbound: Object.freeze({
      dwarf: cell("unbound-dwarf", "celestial", 0, 2, [32, 836, 371, 368]),
      planet: cell("unbound-planet", "celestial", 1, 2, [438, 833, 378, 373]),
      "gas-giant": cell("unbound-gas-giant", "celestial", 2, 2, [852, 835, 375, 371]),
    }),
  }),
  kinds: Object.freeze({
    charger: cell("charger", "field", 0, 0, [42, 17, 353, 377]),
    guard: cell("guard", "field", 1, 0, [447, 35, 361, 361]),
    scavenger: cell("scavenger", "field", 2, 0, [856, 25, 355, 363]),
  }),
  ore: Object.freeze([
    cell("ore-0", "field", 0, 1, [27, 441, 380, 375]),
    cell("ore-1", "field", 1, 1, [440, 439, 373, 377]),
    cell("ore-2", "field", 2, 1, [845, 435, 388, 381]),
  ]),
  roles: Object.freeze({
    interceptor: cell("interceptor", "field", 0, 2, [50, 871, 325, 328]),
    collector: cell("collector", "field", 1, 2, [452, 860, 344, 348]),
  }),
  matter: cell("matter", "field", 2, 2, [852, 852, 364, 362]),
});
const lookup = (table, key) => (Object.hasOwn(table, key) ? table[key] : null);
/** The cell for an identity in a form, or null (drawn procedurally). */
export const identityCell = (identity, formId) => lookup(lookup(ATLAS.identities, identity) ?? {}, formId);
/** The cell for an enemy kind, or null (drawn procedurally). */
export const kindCell = (kind) => lookup(ATLAS.kinds, kind);
/** The cell for ore variant `variant` (any integer; variants repeat). */
export const oreCell = (variant) => ATLAS.ore[variant % ATLAS.ore.length];
/** The cell for a moon role, or null. */
export const roleCell = (role) => lookup(ATLAS.roles, role);
/** Every cell in the manifest, for checks. */
export function atlasCells() {
  return [
    ...Object.values(ATLAS.identities).flatMap((forms) => Object.values(forms)),
    ...Object.values(ATLAS.kinds), ...ATLAS.ore, ...Object.values(ATLAS.roles), ATLAS.matter,
  ];
}
let shared;
function loadSources() {
  if (shared) return shared;
  const entries = Object.fromEntries(
    Object.keys(SOURCES).map((key) => [
      key,
      { state: "loading", image: null, width: 0, height: 0 },
    ]),
  );
  shared = { entries, revision: 0, ready: null };
  shared.ready = Promise.all(
    Object.entries(SOURCES).map(
      ([key, url]) =>
        new Promise((resolve) => {
          const image = new Image();
          image.onload = () => {
            entries[key] = {
              state: "ready",
              image,
              width: image.naturalWidth,
              height: image.naturalHeight,
            };
            shared.revision++;
            resolve();
          };
          image.onerror = () => {
            entries[key] = { ...entries[key], state: "failed" };
            shared.revision++;
            resolve();
          };
          image.src = url;
        }),
    ),
  );
  return shared;
}

export class ArtLibrary {
  constructor() {
    this.sources = loadSources();
    this.ready = this.sources.ready;
    this.tiles = new Map();
    this.crops = new Map();
  }
  get revision() {
    return this.sources.revision;
  }
  get status() {
    const sources = Object.fromEntries(
      Object.entries(this.sources.entries).map(([key, value]) => [
        key,
        {
          state: value.state,
          width: value.width,
          height: value.height,
        },
      ]),
    );
    const states = Object.values(sources).map((source) => source.state);
    return {
      ready: states.every((state) => state === "ready"),
      settled: states.every((state) => state !== "loading"),
      loaded: states.filter((state) => state === "ready").length,
      failed: states.filter((state) => state === "failed").length,
      cachedTiles: this.tiles.size,
      cacheLimit: 96,
      sources,
    };
  }
  get background() {
    return this.sources.entries.nebula.image;
  }
  /** The source rectangle of a manifest cell once its atlas has loaded; null for no cell or an atlas not ready. */
  crop(cell) {
    if (!cell) return null;
    if (this.crops.has(cell.key)) return this.crops.get(cell.key);
    const entry = this.sources.entries[cell.atlas];
    if (entry.state !== "ready") return null;
    const [x, y, width, height] = cell.region;
    const scaleX = entry.width / 1254,
      scaleY = entry.height / 1254;
    const crop = {
      image: entry.image,
      x: x * scaleX,
      y: y * scaleY,
      width: width * scaleX,
      height: height * scaleY,
    };
    this.crops.set(cell.key, crop);
    return crop;
  }
  /** A cached tile of a manifest cell at a radius; null when there is no cell or its atlas is not ready. */
  sprite(cell, radius, circular = true) {
    const crop = this.crop(cell);
    if (!crop) return null;
    // Two source pixels per logical pixel, quantized to eight-pixel buckets.
    const size = Math.max(24, Math.min(384, Math.ceil((radius * 4) / 8) * 8));
    const key = `${cell.key}:${size}:${circular}`;
    let tile = this.tiles.get(key);
    if (tile) return tile;
    tile = document.createElement("canvas");
    tile.width = tile.height = size;
    const c = tile.getContext("2d");
    if (circular) {
      c.beginPath();
      c.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      c.clip();
    }
    const scale = size / Math.max(crop.width, crop.height),
      w = crop.width * scale,
      h = crop.height * scale;
    c.drawImage(
      crop.image,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      (size - w) / 2,
      (size - h) / 2,
      w,
      h,
    );
    if (this.tiles.size >= 96)
      this.tiles.delete(this.tiles.keys().next().value);
    this.tiles.set(key, tile);
    return tile;
  }
}
