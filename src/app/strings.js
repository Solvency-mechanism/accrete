// The string table (docs/specs/M3-data-spine.md 3b.3). The simulation emits keys and parameters, never copy: the
// objective (w.objective), capture candidate names, the pending evolution's retained, tradeoff and successor lines,
// capture refusals and the claim preview are keys here, with their parameters. The copy the descriptors used to carry
// (each identity's description, tradeoff, successors, beyond line and menu card, and each encounter's description)
// lives here too, keyed by identity, form and encounter id. The app renders all of it through text().
//
// Names stay with what they name: form, encounter, identity and kind names are descriptor data (identity bible
// section 5, "one name everywhere"), and the world keeps its current encounter's name as `encounterName`. A pending
// evolution names its forms and identity by id, and the app looks the names up.
//
// Interim copy follows the M1 terms (close and wide orbit, sentinel and gatherer, claim, shards, the transit) and the
// copy rules of the identity bible (sections 5-6: sentence case, plain words, numbers first, no em dashes, no developer
// words). The Survey register (plate, epoch, passage, chart) is not approved (decision D16) and is not used.
// tests/strings.test.mjs checks every entry. Dependency-free; no DOM.

/**
 * A message is a key, or `{ key, params }` when the copy has parameters. A table value is a template, whose `{name}`
 * placeholders are filled from the params, or a function `(params, text)` for copy that needs a choice or a list.
 */
const TABLE = {
  // The objective the simulation keeps as w.objective (setupEncounter; stepWorld while a form's growth is short).
  'objective.encounter': 'Gather {quota} matter. Then thread the transit, break every opponent, or hold for {duration} s. The rim is always clear.',
  'objective.form-growth': 'Gather {matter} more matter to complete this form. Collect returned caches.',

  // Moon roles and orbits, by their internal ids (identities.js companions, player.formation).
  'role.collector': 'gatherer',
  'role.interceptor': 'sentinel',
  'role.collector.gain': 'More reach in a wide orbit, fewer blocks.',
  'role.interceptor.gain': 'More blocks, less gathering reach.',
  'formation.tight': 'close orbit',
  'formation.wide': 'wide orbit',
  // Capture candidates, by role (a candidate's `name`).
  'candidate.collector': 'Gatherer moon',
  'candidate.interceptor': 'Sentinel moon',

  // The claim preview requestCapture returns (preview.message): { incoming, lost } roles, lost null for the spare slot.
  'capture.preview': ({ incoming, lost }, text) =>
    `Claim a ${text(`role.${incoming}`)}${lost ? ` and release your ${text(`role.${lost}`)}` : ''}. ${text(`role.${incoming}.gain`)} Your roles carry into the next form.`,
  // Why a claim was refused: the capture system's reasons (src/sim/contracts.js) and the simulation's own two.
  'capture.refused': 'This moon is no longer available.',
  'capture.refused.invalid-or-used-request': 'Inspect the moon again before claiming it.',
  'capture.refused.generation-changed': 'The moon changed. Inspect it again.',
  'capture.refused.self-capture': 'You cannot claim your own body.',
  'capture.refused.not-live': 'The moon is no longer available.',
  'capture.refused.transitioning': 'Wait for your orbit to finish changing.',
  'capture.refused.ownership-changed': 'The moon already belongs to another body.',
  'capture.refused.already-member': 'This moon already belongs to you.',
  'capture.refused.tier': 'This moon is too large to claim.',
  'capture.refused.range': 'The moon is too far away.',
  'capture.refused.replacement-changed': 'Your orbit changed. Inspect the moon again.',
  'capture.refused.role-changed': 'The moon\'s role changed. Inspect it again.',
  'capture.refused.capacity': 'Choose a moon to replace first.',
  'capture.refused.out-of-range': 'The moon is too far away.',
  'capture.refused.stale': 'The moon is no longer available.',
  'capture.refused.captures-unavailable': 'Only a Warden can claim moons, as a planet or gas giant.',
  'capture.refused.capture-unavailable': 'Moons cannot be claimed right now.',

  // The evolution dialog's fallback when a preview is missing.
  'evolution.retained': 'Your way of moving carries forward.',

  // Why saved settings are not being kept (src/app/storage.js problem), shown on the title screen and in Settings.
  'storage.unavailable': 'This browser is not saving settings. Changes last until you close the page.',
  'storage.write': 'Settings could not be saved. Changes last until you close the page.',
  'storage.newer': 'Settings from a newer version are not loaded here. Changes last until you close the page.',
  'storage.reset': 'Saved settings could not be read, so the defaults are back.',

  // Identities: the menu card (title screen), the evolution preview's lines, and the description and beyond lines.
  'identity.warden.card.effect': 'Close orbit catches attacks. Wide orbit gathers matter and reaches exposed bodies.',
  'identity.warden.card.cost': 'Your core is exposed while the formation changes.',
  'identity.warden.card.successor': 'Shards → sentinel & gatherer moons → gravity pulse',
  'identity.warden.card.command': 'Preview formation',
  'identity.warden.description': 'Space moves your shards or moons between a close orbit that protects and a wide orbit that gathers. Wide moons also break ore. Read the next attack before you change orbit.',
  'identity.warden.tradeoff': 'The 0.65 second formation change leaves the core exposed. Close orbits surrender collection reach; wide orbits leave defensive gaps.',
  'identity.warden.retained': ({ formation, roles }, text) => `${text(`formation.${formation}`)} and ${roles.map(role => text(`role.${role}`)).join(' + ')} roles`,
  'identity.warden.successor.dwarf': 'Dwarf planet: two shards intercept threats and gather nearby matter.',
  'identity.warden.successor.planet': 'Planet: shards become role-bearing moons. Claim a gatherer or sentinel, with a visible claim preview.',
  'identity.warden.successor.gas-giant': 'Gas giant: changing formation also redirects existing loose matter. Moon roles and formation timing survive evolution.',
  'identity.warden.beyond': 'Later bodies would keep the same moon roles and the close and wide orbits.',

  'identity.harvester.card.effect': 'Aim a short burst into an exposed body. Collect only the matter your impact dislodges.',
  'identity.harvester.card.cost': 'Commit to a direction, then survive the recovery window.',
  'identity.harvester.card.successor': 'Extraction burst → directional brace → pressure ram',
  'identity.harvester.card.command': 'Preview burst',
  'identity.harvester.description': 'Aim, then Space commits a short burst. Crack ore, counter a missed charge, or reach a moving stream first.',
  'identity.harvester.tradeoff': 'A committed burst cannot steer. Its recovery slows movement and leaves the core exposed; a protected guard wastes the approach.',
  'identity.harvester.retained': 'Aim → commit → recover command rhythm',
  'identity.harvester.successor.dwarf': 'Dwarf planet: accurate burst contacts recover a finite share of the target’s actual lost matter.',
  'identity.harvester.successor.planet': 'Planet: the forward shell braces a well-aligned burst. Commitment still removes steering.',
  'identity.harvester.successor.gas-giant': 'Gas giant: a pressure ram carries the same approach, impact, and recovery rhythm. Extraction remains finite.',
  'identity.harvester.beyond': 'Later bodies would keep the same committed approach, with ejection and recoil.',

  'identity.unbound.card.effect': 'Gather, sidestep, and touch exposed opponents. Survive with movement alone.',
  'identity.unbound.card.cost': 'No interception, extraction bonus, or command ability.',
  'identity.unbound.card.successor': 'Dwarf planet → planet → gas giant; movement stays your tool.',
  'identity.unbound.card.command': 'Preview movement',
  'identity.unbound.description': 'Take no new power. Sidestep committed paths, touch recovering opponents or ore, gather moving matter, and thread the transit.',
  'identity.unbound.tradeoff': 'No formation, burst, or claim assistance. Every encounter retains safe retreat routes and a survival route to completion.',
  'identity.unbound.retained': 'Movement, timing, and recovery contacts',
  'identity.unbound.successor.dwarf': 'Dwarf planet: ordinary movement and recovery contacts.',
  'identity.unbound.successor.planet': 'Planet: the same movement and timing, with a larger visible body.',
  'identity.unbound.successor.gas-giant': 'Gas giant: preserve the same timing through paired threats.',
  'identity.unbound.beyond': 'Later bodies promise no extra power.',

  // Encounters: the title card shown as each one starts (under 30 words; opponent names capitalised, as in the HUD).
  'encounter.long-wake.description': 'A Charger warns, then charges in a straight line. Step aside, then touch it while it recovers.',
  'encounter.open-face.description': 'The Guard can be struck through its open arc at any time. Circle around to reach it, or keep away until it recovers.',
  'encounter.borrowed-orbit.description': 'Race a Scavenger to the matter pockets. Matter it steals returns in a cache when it recovers.',
  'encounter.crossed-intentions.description': 'Only one opponent commits at a time. Draw the Charger\'s charge away from the Guard\'s open arc.',
  'encounter.wake-thieves.description': 'Read the Charger\'s warning while you choose which pocket to contest. The rim is always clear.',
  'encounter.last-reserve.description': 'Protect a collection route while you find the Guard\'s open arc. Survive, or break every opponent.',

  // Deep fields: traits, their elements and their modifiers (src/sim/traits.js). A trait's name and what it does.
  'trait.ballast.name': 'Dense ballast',
  'trait.ballast.text': 'Pack the core dense. You hold together at a lower mass.',
  'trait.streamlined.name': 'Streamlined',
  'trait.streamlined.text': 'Shed what drags. More thrust, quicker turns.',
  'trait.wide-grasp.name': 'Wide grasp',
  'trait.wide-grasp.text': 'Reach farther for loose matter, and gather more from clouds.',
  'trait.bulk.name': 'Bulk up',
  'trait.bulk.text': 'A little tougher, a little harder to break apart. Can be taken again.',
  'trait.iron-crust.name': 'Iron crust',
  'trait.iron-crust.text': 'A metal shell. Impacts take less from you and more from what you hit.',
  'trait.nickel-iron.name': 'Nickel-iron body',
  'trait.nickel-iron.text': 'Solid metal through and through. A battering ram, a little slower to push.',
  'trait.rubble-pile.name': 'Rubble pile',
  'trait.rubble-pile.text': 'A loose heap that gathers fast and breaks a little easier.',
  'trait.dust-skirt.name': 'Dust skirt',
  'trait.dust-skirt.text': 'A trailing skirt of fines that sweeps up matter as you pass.',
  'trait.ice-shell.name': 'Ice shell',
  'trait.ice-shell.text': 'A slick ice shell. Slip through slush, mires and storms, but stars melt you faster.',
  'trait.cometary-jets.name': 'Cometary jets',
  'trait.cometary-jets.text': 'Frozen volatiles boil off as thrust. Much more push, quicker turns.',
  'trait.fast-rotator.name': 'Fast rotator',
  'trait.fast-rotator.text': 'A rapid spin. You turn much faster.',
  'trait.hot-isotopes.name': 'Hot isotopes',
  'trait.hot-isotopes.text': 'Decaying isotopes warm you and grind down anything that stays close.',
  'trait.tectonics.name': 'Tectonic crust',
  'trait.tectonics.text': 'A living crust that heals its cracks. You hold together much longer.',
  'trait.iron-core.name': 'Molten iron core',
  'trait.iron-core.text': 'A heavy metal heart. Tougher, and you hit harder.',
  'trait.magnetosphere.name': 'Magnetosphere',
  'trait.magnetosphere.text': 'A field around you. Shear fields, ionised storms and stars barely touch you.',
  'trait.atmosphere.name': 'Thick atmosphere',
  'trait.atmosphere.text': 'A blanket of cold gas. Stars burn less, and impacts are cushioned.',
  'trait.oceans.name': 'Oceans',
  'trait.oceans.text': 'Deep water across the surface. Cooler, steadier, and you gather more.',
  'trait.ring-system.name': 'Ring system',
  'trait.ring-system.text': 'A ring of ice and rock that catches matter far from you.',
  'trait.radiogenic-core.name': 'Radiogenic core',
  'trait.radiogenic-core.text': 'A hot core that irradiates everything near you, and a little more thrust.',
  'trait.retrograde-spin.name': 'Retrograde spin',
  'trait.retrograde-spin.text': 'Spin against the system. Quicker turns, more thrust.',
  'trait.biosphere.name': 'Biosphere',
  'trait.biosphere.text': 'Life takes hold. In a star\'s habitable band it draws matter from the star\'s halo.',
  'trait.deep-gravity.name': 'Deep gravity',
  'trait.deep-gravity.text': 'Your pull drags loose matter in from far away.',
  'trait.metallic-hydrogen.name': 'Metallic hydrogen core',
  'trait.metallic-hydrogen.text': 'Crushed hydrogen turned to metal. Very tough, very hard to break apart.',
  'trait.ice-giant.name': 'Ice giant',
  'trait.ice-giant.text': 'A cold, icy world. Little drag, little heat, more gathering.',
  'trait.great-storm.name': 'Great storm',
  'trait.great-storm.text': 'A storm larger than worlds. It grinds down what comes near, and you turn faster.',
  'trait.brown-dwarf.name': 'Brown dwarf',
  'trait.brown-dwarf.text': 'Almost a star. A wide, fierce glow that grinds everything near, and stars barely burn you.',
  'trait.shepherd-moons.name': 'Shepherd moons',
  'trait.shepherd-moons.text': 'Small moons herd matter toward you and take the edge off impacts.',
  'trait.jet-streams.name': 'Jet streams',
  'trait.jet-streams.text': 'Fast winds you can steer by. More thrust.',
  'trait.aerial-life.name': 'Aerial life',
  'trait.aerial-life.text': 'Life drifting in the clouds. It draws far more from a star\'s habitable band.',
  'element.rock': 'rock',
  'element.metal': 'metal',
  'element.water': 'water',
  'element.cryo': 'cryo',
  'element.radioactive': 'radioactive',
  'element.organic': 'organic',
  'mod.thrust': 'thrust',
  'mod.turn': 'turning',
  'mod.accretion': 'gathering',
  'mod.reach': 'reach',
  'mod.toughness': 'toughness',
  'mod.ram': 'impact',
  'mod.core': 'core',
  'mod.heat': 'star heat',
  'mod.shear': 'shear',
  'mod.drag': 'drag',
  'mod.ion': 'ion falter',
  'mod.aura': 'radiation',
  'mod.auraReach': 'radiation reach',
  'mod.life': 'life',
  'trait.title': 'Your body changes',
  'trait.locked': 'Locked: needs {needs}',
  'trait.none': 'No traits yet',
};

/** The table, frozen: key to template or function. */
export const STRINGS = Object.freeze(TABLE);

/** Whether the table has `key`. */
export const hasText = key => typeof key === 'string' && Object.hasOwn(STRINGS, key);

/**
 * The copy for `message`, a key or `{ key, params }`. A key the table lacks renders as `fallback` (the empty string by
 * default), so a caller can fall back to other copy. A template placeholder whose param is missing stays as `{name}`,
 * which tests/strings.test.mjs looks for. Reads only.
 */
export function text(message, fallback = '') {
  const key = typeof message === 'string' ? message : message?.key, params = (typeof message === 'object' && message?.params) || {};
  if (!hasText(key)) return fallback;
  const entry = STRINGS[key];
  if (typeof entry === 'function') return entry(params, text);
  return entry.replace(/\{(\w+)\}/g, (placeholder, name) => (Object.hasOwn(params, name) ? String(params[name]) : placeholder));
}
