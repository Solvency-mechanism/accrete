import { campaignOf, encounterList, encounterOf } from "../sim/campaign.js";
import { text } from "./strings.js";

// Interim player-facing terms (identity bible section 5). Internal ids such as
// `interceptor`, `collector` and `tight` stay unchanged; only display text is
// rewritten, keeping the first letter's case so sentences stay in sentence case.
const keepCase = (match, word) =>
  match[0] !== match[0].toLowerCase()
    ? word[0].toUpperCase() + word.slice(1)
    : word;
const TERMS = [
  [/\b(tight|wide) formation\b/gi, (m, w) =>
    keepCase(m, `${w.toLowerCase() === "tight" ? "close" : "wide"} orbit`)],
  [/\bmantle fragments\b/gi, (m) => keepCase(m, "shards")],
  [/\breplacement preview\b/gi, (m) => keepCase(m, "claim preview")],
  [/\binterceptor/gi, (m) => keepCase(m, "sentinel")],
  [/\bcollector/gi, (m) => keepCase(m, "gatherer")],
  [/\btight\b/gi, (m) => keepCase(m, "close")],
  [/\bslalom\b/gi, (m) => keepCase(m, "transit")],
  [/\bcaptur(e|es|ed|ing)\b/gi, (m, end) =>
    keepCase(m, `claim${{ e: "", es: "s", ed: "ed", ing: "ing" }[end.toLowerCase()]}`)],
];
export function playerCopy(value) {
  let line = String(value ?? "");
  for (const [pattern, replace] of TERMS) line = line.replace(pattern, replace);
  return line.replace(/\u2014/g, ".");
}

// The title card shown as an encounter starts: its description from the
// string table (src/app/strings.js, `encounter.<id>.description`, in
// player-facing terms, under 30 words). An encounter the table has no copy
// for (injected test content) shows its name alone.
export function encounterCard(encounter) {
  return text(`encounter.${encounter?.id}.description`);
}

export function encounterLabel(world, total = encounterList(campaignOf(world)).length) {
  return world.practice
    ? `Practice · ${world.encounterName}`
    : `${world.encounterIndex + 1} / ${total} · ${world.encounterName}`;
}

export function hudModel(world, threshold) {
  const quotaMet = world.encounterCollected >= world.encounterQuota;
  // The encounter that completes a form also requires the form's growth.
  const growthRequired = !world.practice && !!encounterOf(world)?.completesForm;
  const growthMet = !growthRequired || world.player.growth >= threshold;
  const exitsReady = quotaMet && growthMet;
  const opponents = world.enemies.filter((e) => e.alive !== false && e.mass > 0);
  const states = {
    commit: [0, "committed"],
    telegraph: [1, "warning"],
    recover: [2, "recovering"],
  };
  const threats = opponents
    .filter((e) => states[e.state])
    .sort((a, b) => states[a.state][0] - states[b.state][0])
    .map((e) => `${e.type[0].toUpperCase()}${e.type.slice(1)} ${states[e.state][1]}`);
  return {
    encounter: encounterLabel(world),
    objective: `Required: matter ${world.encounterCollected} / ${world.encounterQuota}, then one exit${growthRequired ? ` · growth ${Math.floor(world.player.growth)} / ${threshold}` : ""}`,
    transit: {
      text: world.slalom?.complete
        ? "Transit complete"
        : `Transit ${world.slalom?.next || 0} / ${world.slalom?.total || 3}`,
      achieved: exitsReady && !!world.slalom?.complete,
    },
    combat: {
      text: opponents.length
        ? `Break ${opponents.length} opponent${opponents.length === 1 ? "" : "s"}`
        : "Opponents broken",
      achieved: exitsReady && opponents.length === 0,
    },
    survive: {
      text: `Survive ${Math.max(0, Math.ceil(world.encounterDuration - world.encounterTime))} s`,
      achieved: exitsReady && world.encounterTime >= world.encounterDuration,
    },
    threats: threats.length ? threats : ["Quiet"],
  };
}
