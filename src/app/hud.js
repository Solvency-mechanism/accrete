import { CAMPAIGN, formOf } from "../sim/campaign.js";
import { capturesAvailable } from "../sim/identities.js";
import { referenceMass, coreMass, load } from "../sim/field.js";
import { ELEMENTS } from "../sim/traits.js";
import { text } from "./strings.js";
import { hudModel } from "./hud-model.js";
import { identityPresentation } from "./presentation.js";

export function createHud({ $, document, canvas, getWorld, isStarted, nameOf, formName, closestCandidate }) {
  function updateHud() {
    if (!isStarted()) return;
    const world = getWorld();
    const p = world.player;
    const form = formOf(world), threshold = form?.threshold || 100,
      hud = hudModel(world, threshold);
    $("#form-label").textContent = formName(form);
    $("#encounter-label").textContent = hud.encounter;
    $("#identity-label").textContent = nameOf(world.identity);
    $("#growth-label").textContent =
      `Growth ${Math.floor(p.growth)} / ${threshold}`;
    $("#growth-fill").style.width =
      `${Math.min(100, (p.growth / threshold) * 100)}%`;
    // Deep fields have no health: the ship is its mass, broken apart below its core (src/sim/field.js), and the heavier
    // it is the less its drive moves it. The bar is the mass against twice the form's reference.
    if (p.mass !== undefined) {
      const reference = referenceMass(world), core = coreMass(world);
      $("#health-label").textContent = `Mass ${Math.floor(p.mass)} · core ${core} · drive ${Math.round(load(world, p) * 100)}%`;
      $("#health-fill").style.width = `${Math.max(0, Math.min(100, (p.mass / (2 * reference)) * 100))}%`;
      // What the body is made of, most first, and the traits it has taken.
      const made = ELEMENTS.filter((e) => p.elements?.[e] > 0).sort((a, b) => p.elements[b] - p.elements[a]);
      $("#composition-label").textContent = made.map((e) => `${text(`element.${e}`, e)} ${p.elements[e]}`).join(" · ");
      $("#traits-label").textContent = p.traits?.length ? p.traits.map((id) => text(`trait.${id}.name`, id)).join(" · ") : text("trait.none");
    } else {
      $("#health-label").textContent = `Cohesion ${Math.ceil(p.integrity)} / ${p.maxIntegrity}`;
      $("#health-fill").style.width = `${Math.max(0, (p.integrity / p.maxIntegrity) * 100)}%`;
    }
    $("#objective-label").textContent = hud.objective;
    for (const [id, chip] of [
      ["slalom-progress", hud.transit],
      ["combat-progress", hud.combat],
      ["exit-progress", hud.survive],
    ]) {
      $(`#${id}`).textContent = chip.text;
      $(`#${id}`).classList.toggle("achieved", chip.achieved);
    }
    const cmd = p.command || {},
      state = cmd.state || "ready",
      identity = identityPresentation(world.identity);
    $("#command-label").textContent = identity.hud.label(p, cmd, state);
    $("#command-detail").textContent = identity.hud.detail(cmd, form);
    $("#threat-label").replaceChildren(
      ...hud.threats.map((line) => {
        const item = document.createElement("div");
        item.textContent = line;
        return item;
      }),
    );
    updateCaptureControl();
    // Route progress in campaign order: forms before the current one are complete.
    const at = CAMPAIGN.forms.findIndex((f) => f.id === world.formId);
    CAMPAIGN.forms.forEach((f, i) => {
      $(`#route-${f.id}`).className = i === at ? "current" : i < at ? "complete" : "";
    });
  }
  function updateCaptureControl() {
    const world = getWorld();
    const button = $("#capture"),
      hide =
        !capturesAvailable(world) ||
        world.phase !== "playing" ||
        world.player.transitioning ||
        !closestCandidate();
    // Hiding a focused control drops focus to the page; keep it on the field.
    if (hide && !button.hidden && document.activeElement === button)
      canvas.focus();
    button.hidden = hide;
  }
  
  return { updateHud, updateCaptureControl };
}
