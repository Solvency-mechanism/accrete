// The app's presentation registry (docs/specs/M3-data-spine.md, 3c-move): the HUD copy, title-preview captions and
// motif of each identity, the sound of each form, and the warning pitch and taught hint of each enemy kind, keyed by
// the same ids as the gameplay registries in src/sim/ (identities.js, campaign.js, kinds.js), which hold gameplay
// only. Until 3c-move these fields sat inside the gameplay entries (`hud`, `motif`, `look.preview`, the form's `sound`,
// the kind look's `warning` and `impactHint`); they moved here unchanged. How each id is drawn is in
// src/render/looks.js; the rest of the copy is in the string table (src/app/strings.js).
//
// A campaign other than the shipped one (injected test content) registers presentation for the ids it adds with
// definePresentation; it is merged over the shipped presentation for that descriptor alone. An id with none falls
// back: a kind to UNKNOWN_CUES, a form to UNKNOWN_SOUND.

import { CAMPAIGN } from "../sim/campaign.js";
import { deepFreeze as freeze } from "../sim/descriptor.js";

/**
 * Per identity: `hud`, the command label and detail lines; `preview`, the title preview's caption per formation; and
 * `motif(root)`, the identity's motif as notes over a root frequency.
 */
export const IDENTITY_PRESENTATION = freeze({
  warden: {
    hud: {
      label: (p, cmd, state) => `${p.formation === "wide" ? "Wide" : "Close"} orbit${state === "transition" ? " · shifting" : ""}`,
      detail: (cmd, form) => cmd.cooldown > 0 ? `Command ready in ${cmd.cooldown.toFixed(1)}s` : form?.pulse ? "Toggle orbit. Redirect loose matter." : "Toggle coverage and protection",
    },
    preview: { tight: "Close orbit · more cover", wide: "Wide orbit · more reach" },
    motif: (root) => [0, 7, 0].map((note, i) => ({ at: i * 0.4, duration: 0.36, frequency: root * 2 ** (note / 12) })),
  },
  harvester: {
    hud: {
      label: (p, cmd, state) => state === "ready" ? cmd.cooldown > 0 ? "Burst recharging" : "Vector burst ready" : state === "recover" ? "Recovering" : "Committed",
      detail: () => "Mouse aim. Move to turn.",
    },
    preview: { tight: "Commit, then recover", wide: "Commit, then recover" },
    motif: (root) => [
      { at: 0, duration: 0.48, frequency: root, sustain: true },
      { at: 0.48, duration: 0.24, silence: true },
      { at: 0.72, duration: 0.3, frequency: root * 4 / 3 },
    ],
  },
  unbound: {
    hud: { label: () => "Unbound", detail: () => "Movement and timing" },
    preview: { tight: "No power required", wide: "No power required" },
    motif: (root) => [{ at: 0, duration: 0.9, frequency: root, bend: root * 1.035, resolve: root, sustain: true }],
  },
});

/** Per form: the motif's pitch step and wave, and the bed's drone and beat (Hz). */
export const FORM_SOUNDS = freeze({
  dwarf: { motifStep: 0, motifWave: "triangle", drone: 55, beat: 110 },
  planet: { motifStep: 1, motifWave: "sine", drone: 73.416, beat: 146.832 },
  "gas-giant": { motifStep: 2, motifWave: "sine", drone: 98, beat: 196 },
});

/** The sound of a form with none registered (the dwarf planet's). */
export const UNKNOWN_SOUND = freeze({ motifStep: 0, motifWave: "triangle", drone: 55, beat: 110 });

/** Per kind: the warning sweep's base pitch (Hz) and the hint its settled impact teaches, if any. */
export const KIND_CUES = freeze({
  charger: { warning: 180, impactHint: null },
  guard: { warning: 140, impactHint: "guard-rear" },
  scavenger: { warning: 240, impactHint: null },
});
/** The cues of a kind with none registered. */
export const UNKNOWN_CUES = freeze({ warning: 180, impactHint: null });

/** The shipped presentation, keyed by identity, form and kind id. */
export const PRESENTATION = freeze({ identities: IDENTITY_PRESENTATION, forms: FORM_SOUNDS, kinds: KIND_CUES });

const registered = new WeakMap([[CAMPAIGN, PRESENTATION]]);
/**
 * Registers presentation for `campaign`, a descriptor other than the shipped one: { identities, forms, kinds } (form
 * entries are sounds, kind entries cues), each keyed by id, merged over the shipped presentation. Once per descriptor.
 */
export function definePresentation(campaign, { identities = {}, forms = {}, kinds = {} } = {}) {
  if (!campaign || typeof campaign !== "object") throw new TypeError("definePresentation needs a campaign descriptor");
  if (registered.has(campaign)) throw new RangeError(`Presentation for campaign ${campaign.id} is already defined`);
  const presentation = freeze({ identities: { ...IDENTITY_PRESENTATION, ...identities }, forms: { ...FORM_SOUNDS, ...forms }, kinds: { ...KIND_CUES, ...kinds } });
  registered.set(campaign, presentation);
  return presentation;
}
/** The presentation for `campaign`: its registered one, or the shipped presentation. */
export const presentationOf = (campaign = CAMPAIGN) => registered.get(campaign) ?? PRESENTATION;

const lookup = (table, id) => (Object.hasOwn(table, id) ? table[id] : undefined);
/** The presentation of identity `id` in `campaign`, or undefined. */
export const identityPresentation = (id, campaign = CAMPAIGN) => lookup(presentationOf(campaign).identities, id);
/** The sound of form `id` in `campaign`, or UNKNOWN_SOUND. */
export const formSound = (id, campaign = CAMPAIGN) => lookup(presentationOf(campaign).forms, id) ?? UNKNOWN_SOUND;
/** The cues of kind `type` in `campaign`, or UNKNOWN_CUES. */
export const kindCues = (type, campaign = CAMPAIGN) => lookup(presentationOf(campaign).kinds, type) ?? UNKNOWN_CUES;
