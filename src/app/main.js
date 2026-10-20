import { createWorld } from "../sim/simulation.js";
import { FIELD_IDS } from "../sim/field.js";
import { startSession, FIXED_STEP } from "../sim/playtest-log.js";
import { CAMPAIGN, encounterList, formOf, formPosition, nextFormOf, nextEncounterOf } from "../sim/campaign.js";
import { IDENTITIES, DEFAULT_IDENTITY, identityOf, capturesAvailable } from "../sim/identities.js";
import { Renderer } from "../render/render.js";
import { createInput, BINDINGS } from "./input.js";
import { createDialogs, createDialogView } from "./dialogs.js";
import { createSettings, validSetting } from "./settings.js";
import { createSettingsMenu } from "./settings-menu.js";
import { createStore } from "./storage.js";
import { encounterLabel, playerCopy } from "./hud-model.js";
import { TimeScaleRequests } from "./time-scale.js";
import { createLoop } from "./loop.js";
import { createHud } from "./hud.js";
import { PresentationState } from "../render/presentation-state.js";
import { FeedbackDirector } from "./feedback.js";
import { AudioDirector } from "./audio.js";
import { HintDirector } from "./hints.js";
import { text } from "./strings.js";
import { TRAITS } from "../sim/traits.js";
import { identityPresentation } from "./presentation.js";
const $ = (s) => document.querySelector(s),
  canvas = $("#game"),
  renderer = new Renderer(canvas),
  seedField = $("#seed");
// One save (src/app/storage.js, key sm-game:save) for the settings and the hints
// seen. Reading localStorage itself can throw, so the store reads it inside
// try/catch and keeps the save in memory when it cannot.
const store = createStore({ storage: () => localStorage });
const preferences = createSettings({
  reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
  store,
});
const settings = preferences.values;
// Later capture, ceremony and tutorial owners acquire their own tokens here.
const timeScale = new TimeScaleRequests(),
  feedback = new FeedbackDirector(timeScale),
  hints = new HintDirector(store),
  audio = new AudioDirector({ caption: (text) => {
    captionLines.set(text, performance.now() + 1400);
  } });
const presentation = new PresentationState();
const captionLines = new Map(),
  captionNodes = new Map(),
  captionRegion = $("#captions"),
  hintRegion = $("#hint");
let hintTime = 0, lastRender = -Infinity, hintText = "",
  transition = null, assistSpeed = null, usedAssist = false;
const dialogs = createDialogs({
  document,
  panel: $("#dialog"),
  wrap: $("#dialog-wrap"),
  now: () => performance.now(),
});
// During the encounter beat, held movement keys keep being tracked so they
// still steer when the next encounter starts. Commands are refused there.
const input = createInput({
  active: () => started && !paused && (world.phase === "playing" || !!transition),
  commandActive: () => started && !paused && world.phase === "playing",
  modal: () => !!modal,
  modalKey: (event) => dialogs.keydown(event),
  pause: () => {
    // A reflection waits for its answer. Esc on the quit dialog means Back.
    if (modal === "reflection") return;
    if (modal === "capture" || modal === "pause" || modal === "quit") closeDialog();
    else if (modal !== "error") pauseMenu();
  },
  capture: () => inspectCapture(),
});
// The field a run plays in (src/sim/field.js): the deep field by default; ?field=classic preselects the classic arena.
const urlField = new URLSearchParams(location.search).get("field");
let selectedField = FIELD_IDS.includes(urlField) ? urlField : "deep";
let selected = DEFAULT_IDENTITY,
  session = null,
  world = createWorld({ seed: 117, identity: selected }),
  started = false,
  paused = false,
  modal = "",
  lastPhase = "",
  last = performance.now(),
  hudClock = 0,
  previewTime = 0,
  previewWide = false,
  eventCursor = 0,
  accumulator = 0,
  noticeUntil = 0;
// Tester builds ask the reflection questions and guard an attempt's record until
// it is downloaded. Release builds record too, but never interrupt leaving.
const tester = new URLSearchParams(location.search).get("tester") === "1" ||
  globalThis.ASTERWAKE_TESTER === true;
const answeredPrompts = new Set();
let exportSequence = 0, downloadedMark = "", answerCount = 0, failed = false;
const exportMark = (data) => `${data.final.steps}:${data.final.hash}:${data.final.state}:${data.actions.length}:${answerCount}`;
// A session with no step, action or answer holds nothing worth keeping.
const emptyRecord = (data) => !data.final.steps && !data.actions.length && !answerCount;
const recordSaved = (data) => emptyRecord(data) || downloadedMark === exportMark(data);
let startOptions = { seed: 117, identity: selected, field: selectedField };
const frames = [],
  intervals = [];
const percent = (value) => `${Math.round(Number(value) * 100)}%`;
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
// Identity and form names come from their registries (src/sim/identities.js,
// src/sim/campaign.js); the identity card and every line the simulation sends as
// a key come from the string table (src/app/strings.js).
const nameOf = (id) => (Object.hasOwn(IDENTITIES, id) ? IDENTITIES[id].name : "");
const formName = (form) => form?.name ?? "";
function announce(message) {
  $("#announcer").textContent = message;
}
// A save that cannot be kept stays in memory for the session. The title
// screen says so, and so does Settings, where the player changes it.
const storageNotice = () => (store.problem ? text(`storage.${store.problem}`) : "");
function showStorageNotice() {
  const line = storageNotice(), node = $("#storage-notice");
  node.textContent = line;
  node.hidden = !line;
  // An open Settings dialog shows a problem that starts while it is open.
  const body = modal === "pause" ? $("#dialog-body") : null;
  let shown = body?.querySelector(".storage-notice");
  if (body && line && !shown) {
    shown = document.createElement("p");
    shown.className = "storage-notice";
    body.append(shown);
  }
  if (shown) shown.textContent = line;
}
// Key names in a hint render as keys (bible copy rule 9).
function renderHint(text) {
  if (text === hintText) return;
  hintText = text;
  hintRegion.replaceChildren(
    ...text.split(/\b(Space|Esc|E)\b/).map((part, i) => {
      if (i % 2 === 0) return part;
      const key = document.createElement("kbd");
      key.textContent = part;
      return key;
    }).filter((part) => part !== ""),
  );
}
// The captions region is a log: each caption is its own node, so a screen
// reader hears only the new one, never the whole line again when another
// caption arrives or expires. The separator is drawn by CSS.
function renderCaptions(now) {
  for (const [line, until] of captionLines) if (now >= until) captionLines.delete(line);
  for (const [line, node] of captionNodes)
    if (!captionLines.has(line)) {
      captionRegion.removeChild(node);
      captionNodes.delete(line);
    }
  for (const line of captionLines.keys())
    if (!captionNodes.has(line)) {
      const node = document.createElement("span");
      node.textContent = line;
      captionRegion.append(node);
      captionNodes.set(line, node);
    }
}
function clearCaptions() {
  captionLines.clear();
  captionNodes.clear();
  captionRegion.replaceChildren();
}
function clearHint() {
  hintText = "";
  hintRegion.replaceChildren();
}
// `reason` keeps the detail line visible on narrow layouts, which otherwise
// show only the title. `spoken` adds text for screen readers only, so one
// announcement carries everything instead of a later one replacing it.
function notice(title, detail, { reason = false, spoken = "" } = {}) {
  $("#notice-title").textContent = title;
  $("#notice-detail").textContent = detail;
  $("#encounter-notice").classList.toggle("has-reason", reason);
  $("#encounter-notice").hidden = false;
  noticeUntil = world.time + 3.5;
  announce(`${title}. ${detail}${spoken ? ` ${spoken}` : ""}`);
}
function controlHints() {
  return [
    "Move with WASD.",
    identityOf(world)?.command ? "Space uses your action." : "",
    capturesAvailable(world) ? "E inspects moons." : "",
    "Esc pauses.",
  ]
    .filter(Boolean)
    .join(" ");
}
function selectIdentity(id) {
  selected = id;
  document.querySelectorAll("[data-identity]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.identity === id));
    b.classList.toggle("selected", b.dataset.identity === id);
  });
  $("#identity-description").textContent = text(`identity.${id}.card.effect`);
  $("#identity-cost").textContent = text(`identity.${id}.card.cost`);
  $("#identity-successor").textContent = text(`identity.${id}.card.successor`);
  $("#preview-command").textContent = text(`identity.${id}.card.command`);
  $("#preview-caption").textContent = "";
  previewWide = false;
  world = createWorld({ seed: Number(seedField.value) || 117, identity: id });
  world.player.x = 905;
  world.player.y = 360;
  world.player.radius = 110;
  presentation.reset(world);
  renderer.reset(world.arena);
  CAMPAIGN.forms.forEach((form, i) => {
    $(`#route-${form.id}`).className = i === 0 ? "current" : "";
  });
}
document
  .querySelectorAll("[data-identity]")
  .forEach((b) =>
    b.addEventListener("click", () => selectIdentity(b.dataset.identity)),
  );
// The route, the practice encounters and the practice forms come from the
// campaign descriptor, in play order.
$("#route").replaceChildren(...CAMPAIGN.forms.flatMap((form, i) => {
  const span = document.createElement("span");
  span.setAttribute("id", `route-${form.id}`);
  span.textContent = form.name;
  return i ? [document.createElement("i"), span] : [span];
}));
encounterList().forEach((a, i) => {
  const o = document.createElement("option");
  o.value = i;
  o.textContent = a.name;
  $("#arrangement").append(o);
});
$("#arrangement").value = "0";
for (const form of CAMPAIGN.forms) {
  const o = document.createElement("option");
  o.value = form.id;
  o.textContent = form.name;
  $("#practice-form").append(o);
}
$("#practice-form").value = CAMPAIGN.forms[0].id;
const urlSeed = Number(new URLSearchParams(location.search).get("seed"));
if (urlSeed > 0) seedField.value = String(urlSeed);
$("#preview-command").onclick = () => {
  previewWide = !previewWide;
  previewTime = 1.5;
  world.player.formation = previewWide ? "wide" : "tight";
  $("#preview-caption").textContent = identityPresentation(selected).preview[previewWide ? "wide" : "tight"];
};
function start(options = {}) {
  audio.reset();
  audio.start(settings);
  feedback.reset();
  hints.reset();
  clearCaptions();
  clearHint();
  hintTime = 0;
  usedAssist = settings.gameSpeed !== 1;
  transition = null;
  lastRender = -Infinity;
  startOptions = {
    seed: Math.max(
      1,
      Math.min(999999, Math.floor(Number(seedField.value) || 117)),
    ),
    identity: selected,
    field: selectedField,
    ...options,
  };
  startOptions.seed = Math.max(1, Math.min(999999, Math.floor(Number(startOptions.seed) || 117)));
  // The log's start.practice must be a boolean (playtest-log-schema.md).
  startOptions.practice = !!startOptions.practice;
  session = startSession(startOptions, { sha: globalThis.ASTERWAKE_BUILD_SHA || "dev" });
  world = session.world;
  presentation.reset(world);
  renderer.reset(world.arena);
  answeredPrompts.clear();
  answerCount = 0;
  downloadedMark = "";
  started = true;
  paused = false;
  modal = "";
  lastPhase = "";
  eventCursor = 0;
  accumulator = 0;
  frames.length = 0;
  intervals.length = 0;
  dialogs.reset();
  canvas.inert = false;
  canvas.tabIndex = 0;
  $("#app").classList.add("is-playing");
  input.reset({ clearAim: true });
  $("#intro").hidden = true;
  $("#dialog-wrap").hidden = true;
  $("#hud").hidden = false;
  $("#touch-controls").hidden = false;
  $("#seed-display").textContent =
    `Seed ${world.seed}${startOptions.practice ? " · Practice" : ""}`;
  $("#pause").innerHTML = "Pause <kbd>Esc</kbd>";
  canvas.focus();
  updateHud();
  notice(
    world.encounterName,
    world.field === "deep"
      ? "Your ship turns and spools slowly, and drifts. Read the dotted path. Gates 1 → 2 → 3 are beacons on the map."
      : "Touch ore to crack it. Fly through gates 1 → 2 → 3 to leave sooner.",
    { spoken: `${nameOf(world.identity)}. ${controlHints()}` },
  );
}
function selectField(id) {
  selectedField = id;
  document.querySelectorAll("[data-field]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.field === id));
    b.classList.toggle("selected", b.dataset.field === id);
  });
}
document.querySelectorAll("[data-field]").forEach((b) => b.addEventListener("click", () => selectField(b.dataset.field)));
selectField(selectedField);
$("#start").onclick = () => start();
$("#practice-start").onclick = () =>
  start({
    practice: true,
    arrangement: Number($("#arrangement").value),
    form: $("#practice-form").value,
  });
function closeDialog() {
  modal = dialogs.close();
  paused = !!modal;
  input.reset();
}
const dialog = createDialogView({
  $, document, dialogs, getModal: () => modal, setModal: (kind) => { modal = kind; },
  input, identityName: () => nameOf(world.identity), escape, announce,
});
function goHome() {
  audio.reset();
  feedback.reset();
  hints.reset();
  transition = null;
  clearCaptions();
  clearHint();
  dialogs.reset();
  input.reset({ clearAim: true });
  canvas.inert = true;
  canvas.tabIndex = -1;
  $("#app").classList.remove("is-playing");
  started = false;
  paused = false;
  modal = "";
  accumulator = 0;
  $("#encounter-notice").hidden = true;
  $("#dialog-wrap").hidden = true;
  $("#intro").hidden = false;
  $("#hud").hidden = true;
  $("#touch-controls").hidden = true;
  $("#pause").innerHTML = "Settings <kbd>Esc</kbd>";
  selectIdentity(selected);
  $("#start").focus();
}
// Returns whether the download started. A failure keeps the player where
// they are, with a visible reason, so nothing proceeds as if it were saved.
function exportSession() {
  if (!session) return false;
  let url = "";
  try {
    const data = session.export(snapshot());
    // Compact JSON: whitespace carries no meaning in the schema and would
    // roughly triple the file a tester sends back.
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" }),
      a = document.createElement("a");
    url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `asterwake-${new Date().toISOString().replace(/[:.]/g, "-")}-${world.seed}-${world.identity}-${++exportSequence}.json`;
    // Attach the link for browsers that require a connected download target.
    document.body.append(a);
    try {
      a.click();
    } finally {
      if (a.parentElement) a.parentElement.removeChild(a);
    }
    downloadedMark = exportMark(data);
    return true;
  } catch (error) {
    console.error("Accrete download failed", error);
    const message = "The download did not start. Please try again.";
    let line = $("#download-status");
    if (!line && !$("#dialog-wrap").hidden && $("#dialog-body")) {
      line = document.createElement("p");
      line.setAttribute("id", "download-status");
      $("#dialog-body").append(line);
    }
    if (line) line.textContent = message;
    announce(message);
    return false;
  } finally {
    if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
const reflection = "What felt clear, confusing, too easy, or too hard? Did anything make winning feel effortless?";
function answerField(question) {
  return `<label class="playtest-answer" for="playtest-answer">${escape(question)}</label><textarea id="playtest-answer" rows="5" maxlength="4000" aria-describedby="answer-privacy"></textarea><p id="answer-privacy">Answer in your own words. Please leave out names, email addresses, and other personal details.</p>`;
}
function recordAnswer(id) {
  session.answer(id, $("#playtest-answer").value.slice(0, 4000));
  answerCount++;
}
function reflectionPrompt(id, proceed) {
  if (!tester || answeredPrompts.has(id)) { proceed(); return; }
  paused = true;
  const question = id === "first-encounter"
    ? "What were you trying to do? What felt risky?"
    : id.startsWith("evolution-")
      ? "What does your identity do now? What will it become?"
      : reflection;
  dialog("reflection", "A moment to reflect", answerField(question), [{
    text: "Save answer and continue", primary: true,
    action: () => {
      recordAnswer(id);
      answeredPrompts.add(id);
      closeDialog();
      proceed();
    },
  }]);
}
// Leaving or restarting an attempt. Release builds proceed at once. Tester
// builds ask the quit question mid-run, and after a finished run (won or lost)
// they stop only while its record has not been downloaded.
function requestQuit(proceed = goHome, restart = false) {
  if (!tester || !started || failed || !session) { proceed(); return; }
  const finished = world.phase === "won" || world.phase === "lost",
    data = session.export();
  if (emptyRecord(data) || (finished && recordSaved(data))) { proceed(); return; }
  // A finished run's question is the end reflection. If that reflection is
  // still open underneath (a tab close), it is answered here, draft kept.
  const id = !finished ? "quit" : answeredPrompts.has("end") ? "" : "end",
    draft = id === "end" && modal === "reflection" ? $("#playtest-answer")?.value || "" : "",
    over = modal,
    verb = !restart ? "leave" : finished ? "try again" : "restart";
  // Preserve a reflection or evolution choice if the player stays.
  paused = true;
  let answered = false;
  const leave = (download) => {
    // A failed download keeps the dialog open; the answer is recorded once.
    if (id && !answered) {
      recordAnswer(id);
      answeredPrompts.add(id);
      answered = true;
    }
    if (download && !exportSession()) return;
    proceed();
  };
  const closing = restart ? "" : "<p>To close the tab, download here first, then close it.</p>";
  dialog(
    "quit",
    finished ? "Download this attempt's record?" : restart ? "End this attempt and start again?" : "Leave this attempt?",
    `${finished
      ? "<p>This attempt's record is not downloaded yet. Please keep a file for every attempt, including attempts you lost.</p>"
      : `<p>Download your record before ${restart ? "you start again" : "leaving"}.</p>`}${closing}${id ? answerField(reflection) : ""}`,
    [
      { text: `Download and ${verb}`, primary: true, action: () => leave(true) },
      { text: `${verb[0].toUpperCase()}${verb.slice(1)} without downloading`, action: () => leave(false) },
      // Over another dialog this returns to it, not to play.
      { text: over ? "Back" : "Keep playing", action: closeDialog },
    ],
  );
  if (draft) $("#playtest-answer").value = draft;
}
function percentiles(a) {
  const s = [...a].sort((a, b) => a - b);
  return {
    samples: s.length,
    medianMs: s[Math.floor(s.length * 0.5)] || 0,
    p95Ms: s[Math.floor(s.length * 0.95)] || 0,
  };
}
function snapshot() {
  return {
    title: "Accrete",
    version: "0.3.0",
    seed: world.seed,
    identity: world.identity,
    form: formName(formOf(world)),
    phase: world.phase,
    elapsed: world.time,
    encounter: world.encounterName,
    stats: world.stats,
    player: {
      // The summary keeps its v0.3 field name for the player's integrity, or a deep-field ship's mass (it has no integrity).
      hp: world.player.mass ?? world.player.integrity,
      growth: world.player.growth,
      score: world.player.score,
      roles: world.player.companions.map((c) => c.role),
    },
    frameWork: percentiles(frames),
    frameIntervals: percentiles(intervals),
    activeBodies:
      1 +
      world.enemies.filter((e) => e.alive !== false).length +
      world.player.companions.length +
      (world.rocks || []).filter((r) => r.alive).length,
    collectibleFragments: world.pickups.length,
    environment: {
      rocks: (world.rocks || []).filter((r) => r.alive).length,
      streamRemaining: world.stream?.remainingBudget || 0,
      slalom: world.slalom ? { ...world.slalom } : null,
      current: world.current ? { ...world.current } : null,
    },
    settings: { ...settings },
    assisted: usedAssist,
    runtime: navigator.userAgent,
    art: renderer.art.status,
    eventWindows: {
      recentLimit: 160,
      milestoneLimit: 128,
      lastSequence: world.events.at(-1)?.seq || 0,
      recentOmitted: Math.max(
        0,
        (world.events.at(-1)?.seq || 0) - world.events.length,
      ),
    },
    milestones: world.milestones,
    events: world.events,
  };
}
const pauseMenu = createSettingsMenu({
  $, document, getWorld: () => world, getModal: () => modal, isStarted: () => started,
  getStartOptions: () => startOptions, setPaused: (value) => { paused = value; },
  closeDialog, dialog, storageNotice, escape, percent, settings, preferences, seedField,
  requestQuit, start, exportSession, audio, renderHint, hints, getHintTime: () => hintTime, clearCaptions,
});
$("#pause").onclick = pauseMenu;
// A refusal's reason is a key: the capture system's (src/sim/contracts.js) or the
// simulation's own (requestCapture, commitCapture). Its copy is in the string
// table; an unknown reason reads as the moon no longer being available.
function captureReason(reason) {
  return text(`capture.refused.${reason}`, text("capture.refused"));
}
const roleName = (role) => text(`role.${role}`, playerCopy(role));
// Deep fields: a rank's offer (src/sim/traits.js). Each option names what it
// does; a locked trait names the elements it still needs.
const MULTIPLIED = new Set(["thrust", "turn", "accretion", "toughness", "ram"]),
  LOWERED = new Set(["core", "heat", "shear", "drag", "ion"]);
function modLines(mods) {
  return Object.entries(mods).map(([key, value]) => {
    const name = text(`mod.${key}`, key);
    if (MULTIPLIED.has(key)) return `${value >= 1 ? "+" : "-"}${Math.round(Math.abs(value - 1) * 100)}% ${name}`;
    if (LOWERED.has(key)) return `${value <= 1 ? "-" : "+"}${Math.round(Math.abs(1 - value) * 100)}% ${name}`;
    return `+${value} ${name}`;
  }).join(", ");
}
function showOffer() {
  const offer = world.player.offer,
    locked = offer.locked.map(({ id, missing }) => {
      const needs = Object.entries(missing).map(([element, n]) => `${n} ${text(`element.${element}`, element)}`).join(", ");
      return `<li class="locked"><strong>${escape(text(`trait.${id}.name`, id))}</strong> ${escape(text({ key: "trait.locked", params: { needs } }))}</li>`;
    });
  dialog(
    "trait",
    text("trait.title"),
    `<ul class="trait-offer">${offer.options.map((id) => `<li><strong>${escape(text(`trait.${id}.name`, id))}</strong> ${escape(text(`trait.${id}.text`))}<small>${escape(modLines(TRAITS[id].mods))}</small></li>`).join("")}${locked.join("")}</ul>`,
    offer.options.map((id, i) => ({
      text: text(`trait.${id}.name`, id),
      primary: i === 0,
      action: () => chooseRun(id),
    })),
  );
}
function chooseRun(id) {
  if (!session.choose?.(id)) return false;
  closeDialog();
  updateHud();
  return true;
}
function showPhase() {
  if (started && !modal && world.phase === "playing" && world.player.offer) return showOffer();
  if (!started || modal === "reflection" || modal === "quit" || lastPhase === world.phase) return;
  lastPhase = world.phase;
  if (world.phase === "evolution") {
    // The preview's lines are string-table messages (src/sim/simulation.js
    // previewEvolution); each falls back to the identity's own copy.
    const p = world.pendingEvolution || {},
      copy = `identity.${world.identity}`,
      retained = text(p.retained, text("evolution.retained")),
      successor = text(p.successor, text(`${copy}.successor.${nextFormOf(world)?.id}`, text(`${copy}.card.successor`))),
      cost = text(p.tradeoff, text(`${copy}.card.cost`));
    dialog(
      "evolution",
      `Become a ${formName(nextFormOf(world)).toLowerCase()}`,
      `<p><strong>What stays:</strong> ${escape(retained)}</p><p>${escape(successor)}</p><p><strong>The cost:</strong> ${escape(cost)}</p><p>Some extra matter carries into the new body.</p>`,
      [
        {
          text: "Evolve",
          primary: true,
          action: evolveRun,
        },
        { text: "Settings", action: pauseMenu },
      ],
    );
  } else if (world.phase === "encounter-clear") {
    const advance = () => beginTransition(
      `${world.encounterName} · complete`,
      `${world.encounterCollected} matter gathered`,
    );
    if (!world.practice && world.encounterIndex === 0)
      reflectionPrompt("first-encounter", advance);
    else advance();
  } else if (world.phase === "won" || world.phase === "lost") {
    reflectionPrompt("end", showResults);
  }
}
function evolveRun() {
  if (!session.evolve()) return false;
  presentation.reset(world);
  renderer.reset(world.arena);
  closeDialog();
  // Prompt ids name the form reached by its campaign position (playtest-log-schema.md: evolution-1, evolution-2).
  reflectionPrompt(`evolution-${formPosition(world)}`, () => {
    // The claim hint is spoken on reaching the first form that offers moons.
    const before = CAMPAIGN.forms.find((form) => form.next === world.formId),
      spoken = capturesAvailable(world) && !before?.capture ? "E inspects moons." : "";
    if (world.phase === "encounter-clear") {
      // The beat opens on the new form. Its title card repeats the claim
      // hint so a later announcement cannot drop it.
      lastPhase = world.phase;
      beginTransition(
        `Now a ${formName(formOf(world)).toLowerCase()}`,
        nextEncounterOf(world)?.name || world.encounterName,
        spoken,
      );
    } else lastPhase = "";
    updateHud();
  });
  return true;
}
function showResults() {
    const won = world.phase === "won";
    // In tester builds the download is the primary choice, so Enter on the
    // results saves the record instead of discarding it.
    const download = { text: "Download playtest record", primary: tester, action: exportSession };
    dialog(
      world.phase,
      won ? "You made a way through." : "The system takes its toll.",
      `<p>${won ? (startOptions.practice ? "Practice complete. Try another approach on the same seed." : "Your motion survived the journey. Try the same seed with another motion.") : "Read the warning, leave a retreat route, and use recovery windows. Every seed can be retried."}</p><div class="stat-grid"><span><strong>${escape(formName(formOf(world)))}</strong>Final form</span><span><strong>${Math.round(world.time)}s</strong>Elapsed</span><span><strong>${world.stats.collected || 0}</strong>Matter gathered</span><span><strong>${escape(encounterLabel(world))}</strong>Encounter</span></div><p>${world.stats.rocksBroken || 0} ore bodies broken · ${world.stats.gatesPassed || 0} gates threaded · ${world.stats.streamCollected || 0} stream matter gathered</p>`,
      [
        ...(tester ? [download] : []),
        { text: "Try again", primary: !tester, action: () => requestQuit(() => start(startOptions), true) },
        ...(tester ? [] : [download]),
        { text: "Choose another identity", action: () => requestQuit() },
        { text: "Settings", action: pauseMenu },
      ],
    );
}
// The 1.2 s beat between encounters: a short tally, then the next title card.
// The simulation waits in encounter-clear; runFrame calls nextEncounter.
function beginTransition(title, detail, spoken = "") {
  transition = { elapsed: 0, titleShown: false, spoken };
  notice(title, detail, { spoken });
}
function closestCandidate() {
  return (world.candidates || [])
    .filter(
      (c) =>
        c.alive !== false &&
        !c.ownerId &&
        Math.hypot(c.x - world.player.x, c.y - world.player.y) <= 155,
    )
    .sort(
      (a, b) =>
        Math.hypot(a.x - world.player.x, a.y - world.player.y) -
        Math.hypot(b.x - world.player.x, b.y - world.player.y),
    )[0];
}
function inspectCapture(replaceIndex = 0, opener = document.activeElement) {
  const candidate = closestCandidate();
  if (!candidate || world.phase !== "playing") return;
  if (world.player.transitioning) {
    // The control is hidden mid-change; E still deserves a visible reason.
    notice("Claim unavailable", captureReason("transitioning"), {
      reason: true,
    });
    return;
  }
  const request = session.requestCapture(candidate.id, replaceIndex);
  if (!request || request.ok === false) {
    notice("Claim unavailable", captureReason(request?.reason), {
      reason: true,
    });
    return;
  }
  const preview = request.preview || {},
    lost = preview.lostRole || world.player.companions[replaceIndex]?.role;
  paused = true;
  const actions = [
    {
      text: "Claim moon",
      primary: true,
      action: () => {
        const result = session.commitCapture(request);
        // The commit changes the orbit outside a fixed step: settle the drawn
        // pose on it so the released moon does not slide from its old orbit.
        if (result?.ok !== false) presentation.reset(world);
        closeDialog();
        if (result?.ok === false)
          notice("Claim failed", captureReason(result.reason), {
            reason: true,
          });
        else notice("Moon claimed", `Claimed ${roleName(candidate.role)}.`);
        updateHud();
      },
    },
    { text: "Keep current orbit", action: closeDialog },
  ];
  if (world.player.companions.length > 1)
    actions.push({
      text: `Replace ${roleName(world.player.companions[1 - replaceIndex]?.role)} instead`,
      action: () => inspectCapture(1 - replaceIndex),
    });
  dialog(
    "capture",
    "A new moon",
    `<p>Your other moon stays with you.</p><p>Incoming role: <strong>${escape(roleName(candidate.role))}</strong>.</p><p>${lost ? `You will release your <strong>${escape(roleName(lost))}</strong>. Its effect ends immediately.` : "This moon joins the spare slot in your orbit."}</p><p>Sentinels protect a close orbit. Gatherers reach more matter in a wide orbit. Your chosen roles stay with you.</p>`,
    actions,
    opener,
  );
}
$("#capture").onclick = (event) => inspectCapture(0, event.currentTarget);
const { updateHud, updateCaptureControl } = createHud({
  $, document, canvas, getWorld: () => world, isStarted: () => started,
  nameOf, formName, closestCandidate,
});
addEventListener("keydown", (e) => input.keydown(e));
addEventListener("keyup", (e) => input.keyup(e));
// The beat counts as play: leaving during it pauses before the next encounter.
const inPlay = () => world.phase === "playing" || !!transition;
addEventListener("blur", () => {
  input.reset();
  if (started && !modal && inPlay()) pauseMenu();
});
// A browser cannot await a custom prompt during unload. In tester builds its
// native leave confirmation lets the player stay and use the quit dialog,
// until the attempt (finished or not) has been downloaded. After a frame
// failure the error dialog offers the download itself and Reload must work.
addEventListener("beforeunload", (event) => {
  if (!tester || !started || failed || !session || recordSaved(session.export())) return;
  event.preventDefault();
  event.returnValue = "";
  if (modal !== "quit") requestQuit();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    input.reset();
    if (started && !modal && inPlay()) pauseMenu();
  }
});
let lastPointer = null;
canvas.addEventListener("pointermove", (e) => {
  const r = canvas.getBoundingClientRect();
  lastPointer = { x: e.clientX, y: e.clientY };
  input.point(
    ...renderer.camera.fit(world.arena, r).pointer(e.clientX, e.clientY, r),
  );
});
for (const button of document.querySelectorAll("[data-dir]")) {
  const key = BINDINGS[button.dataset.dir][0];
  button.onpointerdown = (e) => {
    e.preventDefault();
    if (modal || paused) return;
    button.setPointerCapture(e.pointerId);
    input.move(key, true);
  };
  button.onpointerup = button.onpointercancel = () => input.move(key, false);
}
$("#touch-command").onpointerdown = (e) => {
  e.preventDefault();
  input.queueCommand();
};
// M4 supplies a controller whose methods act on this exact restored world.
// A recorder closing over the old world must never survive this replacement.
function savePresentation() {
  if (assistSpeed !== settings.gameSpeed) {
    timeScale.clearOwner("assist");
    timeScale.acquire("assist", settings.gameSpeed);
    assistSpeed = settings.gameSpeed;
  }
  return { timeScale: timeScale.exportState(), feedback: feedback.exportState(performance.now() / 1000), assistSpeed, usedAssist: usedAssist || assistSpeed !== 1 };
}
const RUN_METHODS = ["step", "next", "evolve", "requestCapture", "commitCapture", "export", "answer"];
// Everything restoreRun reads is checked here, before the old run is touched,
// so a refused restore leaves the app (a stopped field included) as it was.
function validateRestore(controller, saved) {
  const restored = controller?.world;
  if (!restored || typeof restored !== "object" || RUN_METHODS.some(key => typeof controller[key] !== "function"))
    throw new TypeError("Restore requires a run controller bound to its restored world");
  if (!Array.isArray(restored.events) || !restored.player || typeof restored.player !== "object" ||
    !(restored.arena?.width > 0) || !(restored.arena?.height > 0))
    throw new TypeError("Restore requires a restored world with its events, player and arena");
  if (!saved || typeof saved !== "object") throw new TypeError("Restore requires saved presentation state");
  TimeScaleRequests.validate(saved.timeScale);
  FeedbackDirector.validateState(saved.feedback);
  if (!validSetting("gameSpeed", saved.assistSpeed)) throw new RangeError("Invalid assist speed");
  // The assist request is the assist speed: one record, at that scale.
  const assist = saved.timeScale.filter(r => r.owner === "assist");
  if (assist.length !== 1 || assist[0].scale !== saved.assistSpeed)
    throw new RangeError("The assist time request must match the assist speed");
  if (typeof saved.usedAssist !== "boolean") throw new TypeError("Invalid assisted flag");
}
function restoreRun(controller, saved = savePresentation()) {
  validateRestore(controller, saved);
  let handles;
  try {
    handles = applyRestore(controller, saved);
  } catch (error) {
    // Past validation the old run is already gone; never leave a half-restored
    // field running. It stops like a failed frame, and a later valid restore
    // restarts the loop.
    stopField(error);
    throw error;
  }
  // One RAF chain: a healthy loop keeps its pending frame; a stopped one restarts.
  if (!framePending) scheduleFrame();
  return handles;
}
function applyRestore(controller, saved) {
  failed = false;
  audio.reset();
  // Restore can be the first run of the page (an M4 Continue). Like Start it
  // must be called from a user gesture for the context to be allowed to play.
  audio.start(settings);
  feedback.reset();
  hints.reset();
  clearCaptions();
  clearHint();
  dialogs.reset();
  input.reset({ clearAim: true, clearCommandEdge: true });
  session = controller;
  world = controller.world;
  selected = world.identity;
  startOptions = controller.start ? { ...controller.start } : {
    seed: world.seed, identity: world.identity, practice: world.practice, field: world.field,
    ...(world.practice ? { arrangement: world.encounterIndex, form: world.formId } : {}),
  };
  startOptions.practice = !!startOptions.practice;
  // A classic log's start names no field; the restored world does, so a restart keeps it.
  startOptions.field ??= world.field;
  const handles = timeScale.importState(saved.timeScale);
  feedback.importState(saved.feedback, performance.now() / 1000, handles);
  assistSpeed = saved.assistSpeed;
  preferences.set("gameSpeed", assistSpeed);
  usedAssist = saved.usedAssist;
  // The new controller's record has never been downloaded from this page, and
  // the old run's answers and frame metrics are not part of it.
  answerCount = 0;
  downloadedMark = "";
  frames.length = 0;
  intervals.length = 0;
  transition = null;
  paused = false;
  modal = "";
  started = true;
  lastPhase = "";
  accumulator = 0;
  hintTime = 0;
  hudClock = 0;
  noticeUntil = 0;
  last = performance.now();
  lastRender = -Infinity;
  eventCursor = world.events.at(-1)?.seq || 0;
  presentation.reset(world);
  renderer.reset(world.arena);
  $("#encounter-notice").hidden = true;
  $("#app").classList.add("is-playing");
  $("#intro").hidden = true;
  $("#hud").hidden = false;
  $("#touch-controls").hidden = false;
  $("#seed-display").textContent =
    `Seed ${world.seed}${startOptions.practice ? " · Practice" : ""}`;
  $("#pause").innerHTML = "Pause <kbd>Esc</kbd>";
  canvas.inert = false;
  canvas.tabIndex = 0;
  canvas.focus();
  updateHud();
  // Mid-encounter resumes. Choice/clear phases rebuild their phase UI. A clear
  // starts a fresh beat; no half-finished reflection or capture is resurrected.
  showPhase();
  return handles;
}
// Whether a frame callback is waiting. The chain is tracked directly, not
// inferred from `failed`, so a refused restore cannot lose it.
let framePending = false;
function scheduleFrame() {
  framePending = true;
  requestAnimationFrame(frame);
}
function frame(now) {
  framePending = false;
  if (failed) return;
  try {
    if (lastPointer && world.field !== "classic") {
      // The deep field's camera follows the player, so a still cursor points at a moving world position.
      const r = canvas.getBoundingClientRect();
      input.repoint(...renderer.camera.fit(world.arena, r).pointer(lastPointer.x, lastPointer.y, r));
    }
    runFrame(now);
    scheduleFrame();
  } catch (error) {
    stopField(error);
  }
}
function stopField(error) {
  failed = true;
  paused = true;
  // Cleanup must never stop the error dialog from appearing.
  for (const cleanup of [() => audio.reset(), () => feedback.reset(), () => input.reset()])
    try { cleanup(); } catch {}
  console.error("Accrete frame failed", error);
  // A tester keeps the stopped attempt's record: the download comes first.
  let offer = false;
  try { offer = tester && started && !!session && !recordSaved(session.export()); } catch {}
  dialogs.reset();
  modal = "";
  dialog("error", "The field stopped", `<p id="frame-error"></p>${offer ? "<p>Download your record before you reload.</p>" : ""}`, [
    ...(offer ? [{ text: "Download playtest record", primary: true, action: exportSession }] : []),
    { text: "Reload", primary: !offer, action: () => location.reload() },
  ]);
  $("#frame-error").textContent = error?.message || String(error);
}
const runFrame = createLoop({
  step: () => session.step(input.consume(), FIXED_STEP),
  state: {
    get noticeUntil() { return noticeUntil; },
    get world() { return world; },
    get started() { return started; },
    get paused() { return paused; },
    get modal() { return modal; },
    get previewWide() { return previewWide; },
    get selected() { return selected; },
    get last() { return last; }, set last(value) { last = value; },
    get assistSpeed() { return assistSpeed; }, set assistSpeed(value) { assistSpeed = value; },
    get usedAssist() { return usedAssist; }, set usedAssist(value) { usedAssist = value; },
    get transition() { return transition; }, set transition(value) { transition = value; },
    get accumulator() { return accumulator; }, set accumulator(value) { accumulator = value; },
    get lastPhase() { return lastPhase; }, set lastPhase(value) { lastPhase = value; },
    get lastRender() { return lastRender; }, set lastRender(value) { lastRender = value; },
    get previewTime() { return previewTime; }, set previewTime(value) { previewTime = value; },
    get hintTime() { return hintTime; }, set hintTime(value) { hintTime = value; },
    get hudClock() { return hudClock; }, set hudClock(value) { hudClock = value; },
  }, settings, timeScale, feedback, getSession: () => session, consumeEvents, notice,
  updateHud, showPhase, updateCaptureControl, renderer, hints, renderHint, audio,
  renderCaptions, frames, intervals, presentation, $,
});
function consumeEvents(now) {
  if (!started) return;
  const events = world.events || [];
  // Sequences increase, so walk back only as far as the last one handled
  // instead of rescanning the whole 160-event window after every step.
  let first = events.length;
  while (first > 0 && events[first - 1].seq > eventCursor) first--;
  for (let i = first; i < events.length; i++) {
    const event = events[i];
    const response = feedback.consume(event, world, now, settings);
    audio.play(response?.cue, event, world);
    hints.consume(event, world, settings.hints);
    eventCursor = event.seq;
  }
}
window.asterwake = {
  get art() {
    return renderer.art;
  },
  get world() {
    return world;
  },
  get phase() {
    return started ? world.phase : "menu";
  },
  frames,
  intervals,
  settings,
  start,
  snapshot,
  savePresentation,
  restoreRun,
  // Hooks share the recorder. None acts while a reflection or the quit dialog
  // waits, and evolve acts only on the field or the evolution dialog itself,
  // never under Settings or another dialog. A refused hook returns undefined.
  step: (input, dt) => {
    if (started && session && modal !== "reflection" && modal !== "quit") {
      presentation.beforeStep(world);
      const result = session.step(input, dt);
      presentation.afterStep(world);
      return result;
    }
  },
  evolve: () => {
    if (started && session && (modal === "" || modal === "evolution")) return evolveRun();
  },
  // Deep fields: takes a trait from the offer, on the field or from its dialog.
  choose: (id) => {
    if (started && session && (modal === "" || modal === "trait")) return chooseRun(id);
  },
  next: () => {
    if (!started || !session || modal === "reflection" || modal === "quit") return;
    const advanced = session.next();
    // A hook handoff replaces the 1.2 s beat, so the beat cannot call next again.
    if (advanced) {
      presentation.reset(world);
      renderer.reset(world.arena);
      transition = null;
      lastPhase = "";
      updateHud();
    }
    return advanced;
  },
  render: () => renderer.render(world, settings),
};
canvas.inert = true;
canvas.tabIndex = -1;
store.onProblem(showStorageNotice);
showStorageNotice();
selectIdentity(selected);
scheduleFrame();
