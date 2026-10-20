// The look registry (docs/specs/M3-data-spine.md, 3c-move): how the renderer draws each identity, form and enemy kind,
// keyed by the same ids as the gameplay registries in src/sim/ (identities.js, campaign.js, kinds.js), which hold
// gameplay only. Until 3c-move these `look` fields sat inside the gameplay entries; they moved here unchanged, so the
// simulation never imports presentation and the checkpoint descriptor hash (src/sim/checkpoint.js) covers gameplay
// only. The app's copy and sound for the same ids are in src/app/presentation.js. Dependency-free apart from the
// campaign descriptor it is keyed to.
//
// A campaign other than the shipped one (injected test content) registers looks for the ids it adds with defineLooks;
// they are merged over the shipped looks for that descriptor alone. An id with no look is drawn procedurally from
// UNKNOWN_LOOK (a kind) or UNKNOWN_FORM_LOOK (a form), so missing presentation is never an error.

import { CAMPAIGN } from "../sim/campaign.js";
import { deepFreeze as freeze } from "../sim/descriptor.js";

/**
 * Per identity: the body's colour and procedural tone; whether it draws an orbit, a burst shell, mantle ticks or side
 * arcs; and whether the title preview shows a burst.
 */
export const IDENTITY_LOOKS = freeze({
  warden: { color: "#8de5e9", tone: "#406f80", orbit: true, shell: false, ticks: true, sideArcs: false, previewBurst: false },
  harvester: { color: "#f2b866", tone: "#886850", orbit: false, shell: true, ticks: false, sideArcs: false, previewBurst: true },
  unbound: { color: "#c5d4de", tone: "#406f80", orbit: false, shell: false, ticks: false, sideArcs: true, previewBurst: false },
});

/** Per form: the burst shell's half-arc, the mantle tick count and gas bands on the procedural body. */
export const FORM_LOOKS = freeze({
  dwarf: { shellArc: .9, ticks: 3, bands: false },
  planet: { shellArc: .62, ticks: 4, bands: false },
  "gas-giant": { shellArc: .62, ticks: 5, bands: true },
});

/** Per kind: colour, sprite tone, telegraph line width and labels, body mark, halo and shield. */
export const KIND_LOOKS = freeze({
  charger: { color: "#fa8776", tone: "#406f80", telegraphLine: 2, labels: { telegraph: "Charge incoming", commit: "Committed" },
    mark: "nose", halo: null, shield: false },
  guard: { color: "#b9a1ef", tone: "#695780", telegraphLine: 1.5, labels: { telegraph: "Opening", commit: "Active" },
    mark: null, halo: null, shield: true },
  scavenger: { color: "#edcc7d", tone: "#406f80", telegraphLine: 1.5, labels: { telegraph: "Opening", commit: "Active" },
    mark: "mandibles", halo: "#efca7960", shield: false },
});

/** The look of a kind with none registered: drawn procedurally, with no marks and a neutral colour. */
export const UNKNOWN_LOOK = freeze({ color: "#a6b9c4", tone: "#406f80", telegraphLine: 1.5, labels: { telegraph: "Opening", commit: "Active" },
  mark: null, halo: null, shield: false });
/** The look of a form with none registered. */
export const UNKNOWN_FORM_LOOK = freeze({ shellArc: .62, ticks: 4, bands: false });

/** The shipped looks, keyed by identity, form and kind id. */
export const LOOKS = freeze({ identities: IDENTITY_LOOKS, forms: FORM_LOOKS, kinds: KIND_LOOKS });

const registered = new WeakMap([[CAMPAIGN, LOOKS]]);
/**
 * Registers looks for `campaign`, a descriptor other than the shipped one: { identities, forms, kinds }, each keyed by
 * id, merged over the shipped looks. Once per descriptor. Returns the merged registry.
 */
export function defineLooks(campaign, { identities = {}, forms = {}, kinds = {} } = {}) {
  if (!campaign || typeof campaign !== "object") throw new TypeError("defineLooks needs a campaign descriptor");
  if (registered.has(campaign)) throw new RangeError(`Looks for campaign ${campaign.id} are already defined`);
  const looks = freeze({ identities: { ...IDENTITY_LOOKS, ...identities }, forms: { ...FORM_LOOKS, ...forms }, kinds: { ...KIND_LOOKS, ...kinds } });
  registered.set(campaign, looks);
  return looks;
}
/** The looks for `campaign`: its registered ones, or the shipped looks. */
export const looksOf = (campaign = CAMPAIGN) => registered.get(campaign) ?? LOOKS;

const lookup = (table, id) => (Object.hasOwn(table, id) ? table[id] : undefined);
/** The look of identity `id` in `campaign`, or undefined. */
export const identityLook = (id, campaign = CAMPAIGN) => lookup(looksOf(campaign).identities, id);
/** The look of form `id` in `campaign`, or UNKNOWN_FORM_LOOK. */
export const formLook = (id, campaign = CAMPAIGN) => lookup(looksOf(campaign).forms, id) ?? UNKNOWN_FORM_LOOK;
/** The look of kind `type` in `campaign`, or UNKNOWN_LOOK. */
export const kindLook = (type, campaign = CAMPAIGN) => lookup(looksOf(campaign).kinds, type) ?? UNKNOWN_LOOK;
