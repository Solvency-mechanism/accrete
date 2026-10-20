import { FIXED_STEP } from "../sim/playtest-log.js";
import { nextEncounterOf } from "../sim/campaign.js";
import { encounterCard, playerCopy } from "./hud-model.js";
import { identityLook } from "../render/looks.js";

export function createLoop({ step, state, settings, timeScale, feedback, getSession, consumeEvents, notice, updateHud, showPhase, updateCaptureControl, renderer, hints, renderHint, audio, renderCaptions, frames, intervals, presentation, $ }) {
  return function runFrame(now) {
    const rawDt = (now - state.last) / 1000;
    state.last = now;
    const dt = Math.min(rawDt, 1 / 30),
      startWork = performance.now();
    const realDt = Math.max(0, rawDt);
    const heldForTransition = !!state.transition;
    if (state.assistSpeed !== settings.gameSpeed) {
      timeScale.clearOwner("assist");
      timeScale.acquire("assist", settings.gameSpeed);
      state.assistSpeed = settings.gameSpeed;
    }
    if (state.started && settings.gameSpeed !== 1) state.usedAssist = true;
    feedback.update(now / 1000, realDt, settings);
    if (state.transition && !state.paused && !state.modal) {
      state.transition.elapsed += realDt;
      if (!state.transition.titleShown && state.transition.elapsed >= 0.45) {
        state.transition.titleShown = true;
        const next = nextEncounterOf(state.world);
        notice(playerCopy(next?.name || "Next encounter"), encounterCard(next), {
          spoken: state.transition.spoken,
        });
      }
      if (state.transition.elapsed >= 1.2) {
        getSession().next();
        presentation.reset(state.world);
        renderer.reset(state.world.arena);
        state.transition = null;
        state.lastPhase = "";
        updateHud();
      }
    }
    if (state.started && !state.paused && !state.modal && state.world.phase === "playing" && !heldForTransition) {
      state.accumulator = Math.min(state.accumulator + Math.max(0, rawDt) * timeScale.value, 0.1);
      // At most four steps a frame: a slow frame then slows the game a little instead of banking more steps for the
      // next frame, which made it slower still.
      let steps = 0;
      while (state.accumulator + 1e-9 >= FIXED_STEP && state.world.phase === "playing" && !state.world.player.offer && steps++ < 4) {
        presentation.beforeStep(state.world);
        step();
        presentation.afterStep(state.world);
        state.accumulator = Math.max(0, state.accumulator - FIXED_STEP);
        consumeEvents(now / 1000);
      }
      if (steps > 4) state.accumulator = Math.min(state.accumulator, FIXED_STEP);
    } else state.accumulator = 0;
    consumeEvents(now / 1000);
    showPhase();
    if (state.started) updateCaptureControl();
    if (state.started && state.world.time >= state.noticeUntil)
      $("#encounter-notice").hidden = true;
    // The old 25 ms frame intervals were a capture on an unfocused tab; focused,
    // intervals are a steady 16.7 ms (docs/evidence/m7/browser-check.md). Avoid
    // full canvas work under a dialog's backdrop blur: keep RAF for focus/audio,
    // redraw the paused field at 10 Hz.
    const renderDue = (!state.paused && !state.modal) || now - state.lastRender >= 100;
    if (renderDue && !state.started) {
      state.world.time += dt;
      state.world.player.formation = state.previewWide ? "wide" : "tight";
      state.world.player.command.state =
        identityLook(state.selected).previewBurst && state.previewTime > 1
          ? "burst"
          : identityLook(state.selected).previewBurst && state.previewTime > 0
            ? "recover"
            : "ready";
      state.previewTime = Math.max(0, state.previewTime - dt);
      const preview = {
        ...state.world,
        enemies: [],
        pickups: state.world.pickups.filter((p) => p.x > 680),
        candidates: [],
        rocks: (state.world.rocks || []).filter((r) => r.x > 680),
        current: null,
        stream: null,
        gates: [],
        player: { ...state.world.player, companions: [] },
      };
      renderer.render(preview, settings, true);
    } else if (renderDue) {
      const alpha = state.paused || state.modal || state.world.phase !== "playing" ? 1 : state.accumulator / FIXED_STEP;
      renderer.render(presentation.sample(state.world, alpha), settings, false, feedback);
      if (!state.paused && !state.modal && state.world.phase === "playing") renderer.paced?.(realDt);
    }
    if (renderDue) state.lastRender = now;
    const active = state.started && !state.paused && !state.modal && state.world.phase === "playing";
    if (active) {
      state.hintTime += realDt;
      hints.observe(state.world, settings.hints);
    }
    renderHint(state.started ? hints.update(state.hintTime, settings.hints) : "");
    // The accumulator is simulation time already banked but not yet stepped;
    // the warning sweep subtracts it so it ends one step before the commit.
    audio.update(state.world, timeScale.value, active, state.accumulator);
    renderCaptions(now);
    state.hudClock += dt;
    if (state.hudClock > 0.1) {
      state.hudClock = 0;
      updateHud();
    }
    if (state.started && !state.paused && !state.modal) {
      frames.push(performance.now() - startWork);
      intervals.push(rawDt * 1000);
      if (frames.length > 3600) {
        frames.shift();
        intervals.shift();
      }
    }
  }
}
