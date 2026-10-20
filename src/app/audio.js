import { playerCopy } from "./hud-model.js";
import { CAMPAIGN, campaignOf, formOf, formById } from "../sim/campaign.js";
import { IDENTITIES, DEFAULT_IDENTITY } from "../sim/identities.js";
import { identityPresentation, formSound, kindCues } from "./presentation.js";
import { coreMass } from "../sim/field.js";

const STEP = 1 / 120;
const BUSES = ["master", "music", "effects", "interface"];
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
// Static captions. Opponent, motion and form names are filled in by
// captionFor when the event names them, so a caption matches the HUD line.
export const CUE_CAPTIONS = Object.freeze({
  motif: "Your motif", warning: "Opponent warning", commit: "Opponent committed",
  collection: "Matter gathered", preview: "Ready to evolve", evolution: "Evolved",
  clear: "Encounter complete", victory: "You made a way through", claim: "Moon claimed",
  refusal: "Claim unavailable", formation: "Orbit changing", burst: "Burst committed",
  dodge: "Clean dodge", cache: "Matter returned", deal: "Opponent struck", break: "Opponent broken",
  intercept: "Sentinel blocked a hit", take: "Cohesion lost", defeat: "The system takes its toll",
  ore: "Ore struck", "ore-break": "Ore broken", gate: "Transit gate threaded", recover: "Opponent recovering",
});

export function captionFor(cue, event = {}, world = null) {
  const id = event?.enemy ?? event?.target;
  const type = event?.enemyType ||
    (id === undefined ? undefined : world?.enemies?.find((e) => e.id === id)?.type);
  const opponent = type ? type[0].toUpperCase() + type.slice(1) : "Opponent";
  switch (cue) {
    case "warning": return `${opponent} warning`;
    case "commit": return `${opponent} committed`;
    case "recover": return `${opponent} recovering`;
    case "deal": return `${opponent} struck`;
    case "break": return `${opponent} broken`;
    case "motif": {
      const name = world && Object.hasOwn(IDENTITIES, world.identity) ? IDENTITIES[world.identity].name : undefined;
      return name ? `${name} motif` : CUE_CAPTIONS.motif;
    }
    case "evolution": {
      const form = world ? formOf(world)?.name : undefined;
      return form ? `Now a ${form.toLowerCase()}` : CUE_CAPTIONS.evolution;
    }
    default: return CUE_CAPTIONS[cue];
  }
}

// Fixed steps the simulation takes before this timer reaches zero, counted
// with its own floating-point decrement: 1.05 s takes 127 steps, not 126.
export function stepsToCommit(timer) {
  if (!Number.isFinite(timer) || timer <= 0) return 0;
  let t = timer, steps = 0;
  while (t > 0 && steps < 1e5) { t -= STEP; steps++; }
  return steps;
}

// The enemy timer is simulation time. Convert only the audio schedule to wall
// time. The final simulation step is silent, including a budget-delayed commit.
// `lead` is simulation time the app has banked in its accumulator but not yet
// stepped, so in the browser the sweep also ends one step before the commit.
// The frame that processes the commit can arrive up to one frame after that.
export function warningSchedule(timer, scale = 1, lead = 0) {
  const remaining = Math.max(0, stepsToCommit(timer) * STEP - Math.max(0, lead));
  if (!(scale > 0) || remaining <= STEP)
    return { duration: 0, silentTail: 0, commit: scale > 0 ? remaining / scale : 0 };
  return { duration: (remaining - STEP) / scale, silentTail: STEP / scale, commit: remaining / scale };
}

// One rising contour per warning. Pitch and cutoff are a pure function of the
// warning's progress, so a retimed voice continues where it is instead of
// starting over from its base pitch. Each kind's base pitch is its `warning`
// cue in src/app/presentation.js; a kind without one uses UNKNOWN_CUES.warning.
export const WARNING_VOICE = Object.freeze({
  top: 480, filterLow: 180, filterHigh: 2200, volume: 0.04, attack: 0.02, release: 0.012,
});
/** The warning's starting pitch for an enemy kind of `campaign`. */
export const warningBase = (type, campaign = CAMPAIGN) => kindCues(type, campaign).warning;
export function warningContour(type, progress, campaign = CAMPAIGN) {
  const base = warningBase(type, campaign), p = clamp(progress, 0, 1);
  return {
    frequency: base * (WARNING_VOICE.top / base) ** p,
    cutoff: WARNING_VOICE.filterLow * (WARNING_VOICE.filterHigh / WARNING_VOICE.filterLow) ** p,
  };
}

export function collectionPitch(progress) {
  const pentatonic = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
  return 220 * 2 ** (pentatonic[Math.floor(clamp(progress, 0, 1) * 10)] / 12);
}

// The sound of form `formId` in `campaign` (src/app/presentation.js), or of the campaign's first form when it has no such form.
const soundOf = (formId, campaign) => formSound((formById(campaign, formId) ?? campaign.forms[0]).id, campaign);
// The identity's motif (src/app/presentation.js), pitched by the form's motif step:
// each form is a tritone's half above the one before.
export function motifSchedule(identity, formId = CAMPAIGN.forms[0].id, campaign = CAMPAIGN) {
  const root = 146.832 * 2 ** (soundOf(formId, campaign).motifStep * 0.5);
  return identityPresentation(Object.hasOwn(IDENTITIES, identity) ? identity : DEFAULT_IDENTITY, campaign).motif(root);
}

function disconnectAll(nodes) {
  for (const node of nodes) try { node.disconnect(); } catch {}
}

export class AudioDirector {
  constructor({ context = () => new AudioContext(), caption = () => {} } = {}) {
    this.makeContext = context;
    this.caption = caption;
    this.context = null;
    this.buses = null;
    this.warnings = new Map();
    this.totals = new Map();
    this.enemyStates = new Map();
    this.sources = new Set();
    this.collections = [];
    this.collectionUntil = 0;
    this.settings = {};
    this.available = false;
    this.bedState = { formId: undefined, level: 0, pulse: 0 };
  }
  start(settings) {
    // Called synchronously from Start. No context is created on module load,
    // in the animation loop, or when opening Instruments before a passage.
    try {
      if (!this.context) {
        // Build the whole graph before keeping any of it, so a failure part
        // way through never leaves half a bed for update() to trip over.
        const context = this.makeContext();
        try {
          const buses = {};
          for (const key of BUSES) buses[key] = context.createGain();
          buses.master.connect(context.destination);
          for (const key of ["music", "effects", "interface"]) buses[key].connect(buses.master);
          const bed = this.createBed(context, buses.music);
          this.context = context;
          this.buses = buses;
          Object.assign(this, bed);
          this.bedState = { formId: undefined, level: 0, pulse: 0 };
        } catch (error) {
          try { context.close?.()?.catch?.(() => {}); } catch {}
          throw error;
        }
      }
      this.available = true;
      const resumed = this.context.resume();
      resumed?.catch?.(() => { this.available = false; });
      this.configure(settings);
    } catch { this.available = false; }
  }
  configure(settings) {
    this.settings = settings;
    if (!this.buses) return;
    try {
      const now = this.context.currentTime;
      for (const key of BUSES)
        this.buses[key].gain.setValueAtTime(
          key === "master" && (!settings.sound || settings.mute) ? 0 : settings[`${key}Volume`] ?? 0.6, now,
        );
    } catch { this.available = false; }
  }
  get audible() {
    const s = this.settings;
    return this.available && this.context?.state !== "suspended" && s.sound && !s.mute && s.masterVolume > 0;
  }
  captionsEnabled(bus = "effects") {
    return this.settings.captions || !this.audible || this.settings[`${bus}Volume`] === 0;
  }
  say(cue, bus = "effects", event = {}, world = null) {
    if (this.captionsEnabled(bus)) this.caption(playerCopy(captionFor(cue, event, world)));
  }
  voice(frequency, duration, { at = 0, end = frequency, bend, type = "sine", volume = 0.08,
    bus = "effects", pan = 0, filter = false, sustain = false } = {}) {
    if (!this.audible || !(duration > 0)) return null;
    try {
      const ctx = this.context, start = ctx.currentTime + at, stop = start + duration;
      const oscillator = ctx.createOscillator(), gain = ctx.createGain();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, start);
      if (bend) {
        // Bend, then resolve while the note is still held.
        oscillator.frequency.linearRampToValueAtTime(bend, start + duration * 0.4);
        oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, end), start + duration * 0.8);
      } else oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, end), stop);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(volume, start + Math.min(0.008, duration / 4));
      // A held note keeps its level and releases at the end; a pluck decays.
      if (sustain) gain.gain.linearRampToValueAtTime(volume, stop - Math.min(0.08, duration / 3));
      gain.gain.linearRampToValueAtTime(0, stop);
      const nodes = [oscillator, gain];
      oscillator.connect(gain);
      let output = gain;
      if (filter) {
        const f = ctx.createBiquadFilter();
        f.type = "lowpass";
        f.frequency.setValueAtTime(180, start);
        f.frequency.exponentialRampToValueAtTime(2200, stop);
        output.connect(f); output = f; nodes.push(f);
      }
      if (ctx.createStereoPanner) {
        const panner = ctx.createStereoPanner();
        panner.pan.setValueAtTime(clamp(pan, -1, 1), start);
        output.connect(panner); output = panner; nodes.push(panner);
      }
      output.connect(this.buses[bus]);
      const source = { oscillator, stop, cancel: () => {
        try { oscillator.stop(); } catch {}
        disconnectAll(nodes);
        this.sources.delete(source);
      } };
      oscillator.onended = () => {
        disconnectAll(nodes);
        this.sources.delete(source);
      };
      this.sources.add(source);
      oscillator.start(start); oscillator.stop(stop);
      return source;
    } catch { this.available = false; return null; }
  }
  motif(identity, formId, at = 0, campaign = CAMPAIGN) {
    const wave = soundOf(formId, campaign).motifWave;
    for (const note of motifSchedule(identity, formId, campaign)) {
      if (note.silence) continue;
      this.voice(note.frequency, note.duration, {
        at: at + note.at, end: note.resolve || note.frequency, bend: note.bend, sustain: note.sustain,
        type: wave, bus: "interface",
      });
    }
  }
  play(cue, event = {}, world = null) {
    if (!cue) return;
    const bus = ["motif", "preview", "evolution", "clear", "victory", "defeat", "claim", "refusal"].includes(cue) ? "interface" : "effects";
    // Captions never depend on the audio clock: a suspended context freezes
    // currentTime, and captions are then the only cue.
    this.say(cue, bus, event, world);
    if (cue === "warning" || !this.audible) return; // syncWarnings owns the sweep.
    if (cue === "collection") {
      const now = this.context.currentTime;
      this.collections = this.collections.filter((time) => time > now - 1);
      if (this.collections.length >= 8 || now < this.collectionUntil) return;
      this.collections.push(now); this.collectionUntil = now + 0.075;
    }
    const v = (frequency, duration = 0.12, options = {}) => this.voice(frequency, duration, { bus, ...options });
    const power = clamp(Math.sqrt(Math.max(0, event.settledLoss ?? event.value ?? 1)) / 5, 0.2, 1);
    switch (cue) {
      case "motif": this.motif(world.identity, world.formId, 0, campaignOf(world)); break;
      case "evolution":
        for (let i = 0; i < (this.settings.flashes && this.settings.motion ? 4 : 2); i++)
          v(i % 2 ? 294 : 220, 0.18, { at: i * 0.25 });
        this.motif(world.identity, world.formId, this.settings.flashes && this.settings.motion ? 1 : 0.5, campaignOf(world));
        break;
      case "collection": v(collectionPitch(world.encounterCollected / Math.max(1, world.encounterQuota)), 0.075); break;
      // A dry, high latch: louder than the sweep and well clear of ore and burst.
      case "commit": v(1400, 0.012, { type: "square", volume: 0.06 }); break;
      case "take": v(82, 0.22, { type: "sawtooth", end: 41, volume: power * 0.1 }); break;
      case "deal": v(360, 0.07, { type: "triangle", end: 180, volume: power * 0.09 }); break;
      case "burst": v(180, 0.06, { end: 320 }); v(65, 0.18, { at: 0.16, end: 35 }); break;
      case "formation": {
        const wide = event.formation === "wide";
        v(wide ? 220 : 330, 0.09, { end: 275 });
        v(275, 0.12, { at: 0.09, end: wide ? 330 : 220 }); break;
      }
      case "gate": v(440 * 2 ** ((event.index || 0) * 4 / 12), 0.2); break;
      case "victory": [0, 4, 7].forEach((n, i) => v(220 * 2 ** (n / 12), 0.3, { at: i * 0.18 })); break;
      case "defeat": [220, 165, 110].forEach((f, i) => v(f, 0.3, { at: i * 0.2 })); break;
      case "recover": v(240, 0.25, { end: 110, volume: 0.04 }); break;
      case "dodge": v(660, 0.09, { end: 880 }); break;
      case "intercept": v(520, 0.08, { type: "triangle", end: 260 }); break;
      case "ore": v(145, 0.07, { type: "triangle", volume: power * 0.08 }); break;
      case "ore-break": v(195, 0.19, { end: 70, type: "triangle" }); break;
      case "break": v(120, 0.28, { end: 30, type: "triangle" }); break;
      case "preview": v(330, 0.3, { end: 440 }); break;
      case "clear": v(294, 0.22, { end: 440 }); break;
      case "claim": v(440, 0.24, { end: 660 }); break;
      case "refusal": v(165, 0.1, { end: 147 }); break;
      case "cache": v(550, 0.14, { end: 440 }); break;
    }
  }
  createBed(ctx, music) {
    const bedGain = ctx.createGain(); bedGain.gain.setValueAtTime(0, ctx.currentTime);
    bedGain.connect(music);
    const drone = ctx.createOscillator(); drone.type = "sine";
    drone.connect(bedGain);
    const pulseGain = ctx.createGain(); pulseGain.gain.setValueAtTime(0, ctx.currentTime);
    pulseGain.connect(music);
    const pulse = ctx.createOscillator(); pulse.type = "triangle";
    pulse.connect(pulseGain);
    drone.start(); pulse.start();
    return { bedGain, drone, pulseGain, pulse };
  }
  // The warning voice's gain at `at` under its current schedule: attack from
  // its start, hold, then a short release that ends exactly at `end`.
  warningLevel(warning, at) {
    if (at >= warning.end) return 0;
    const { volume, attack } = WARNING_VOICE;
    const rising = volume * clamp((at - warning.started) / attack, 0, 1);
    return at > warning.end - warning.release
      ? Math.min(rising, (volume * (warning.end - at)) / warning.release)
      : rising;
  }
  startWarning(enemy, world, now) {
    const ctx = this.context;
    const oscillator = ctx.createOscillator(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
    const nodes = [oscillator, filter, gain];
    oscillator.type = "sawtooth"; filter.type = "lowpass";
    gain.gain.setValueAtTime(0, now);
    oscillator.connect(filter); filter.connect(gain);
    let output = gain;
    if (ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(clamp((enemy.x - world.player.x) / 640, -1, 1), now);
      output.connect(panner); output = panner; nodes.push(panner);
    }
    output.connect(this.buses.effects);
    const warning = { type: enemy.type, campaign: campaignOf(world), oscillator, filter, gain, started: now, end: now, release: 0, scale: 0 };
    const source = warning.source = { oscillator, stop: now, cancel: () => {
      try { oscillator.stop(); } catch {}
      disconnectAll(nodes);
      this.sources.delete(source);
    } };
    oscillator.onended = () => { disconnectAll(nodes); this.sources.delete(source); };
    this.sources.add(source);
    oscillator.start(now);
    return warning;
  }
  // Re-aim the one voice at a new end time. Nothing re-attacks: pitch and
  // cutoff continue from the warning's progress and the gain from its level.
  retimeWarning(warning, progress, end, now, scale) {
    const level = this.warningLevel(warning, now), { volume, attack } = WARNING_VOICE;
    const { frequency, cutoff } = warningContour(warning.type, progress, warning.campaign);
    for (const [param, from, to] of [
      [warning.oscillator.frequency, frequency, WARNING_VOICE.top],
      [warning.filter.frequency, cutoff, WARNING_VOICE.filterHigh],
    ]) {
      param.cancelScheduledValues(now);
      param.setValueAtTime(from, now);
      param.exponentialRampToValueAtTime(to, end);
    }
    const g = warning.gain.gain, release = Math.min(WARNING_VOICE.release, (end - now) / 2);
    const peak = Math.max(now, Math.min(warning.started + attack, end - release));
    g.cancelScheduledValues(now);
    g.setValueAtTime(level, now);
    if (peak > now) g.linearRampToValueAtTime(volume, peak);
    if (end - release > peak) g.linearRampToValueAtTime(volume, end - release);
    g.linearRampToValueAtTime(0, end);
    warning.oscillator.stop(end); // The last stop() call is the one applied.
    Object.assign(warning, { end, release, scale });
    warning.source.stop = end;
  }
  // A warning cut short (pause, or its opponent left the warning) fades out
  // quickly. One already in its release ends by itself.
  stopWarning(warning, now) {
    if (now >= warning.end - warning.release) return;
    const g = warning.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(this.warningLevel(warning, now), now);
    g.linearRampToValueAtTime(0, now + 0.015);
    warning.oscillator.stop(now + 0.02);
    warning.end = now + 0.015;
    warning.source.stop = now + 0.02;
  }
  syncWarnings(world, scale, active, lead = 0) {
    const live = new Set(), now = this.context?.currentTime || 0;
    for (const e of world.enemies) {
      if (active && e.alive && e.state === "recover" && this.enemyStates.get(e.id) !== "recover")
        this.play("recover", { enemy: e.id, enemyType: e.type }, world);
      this.enemyStates.set(e.id, e.state);
      if (e.state !== "telegraph" || e.alive === false) { this.totals.delete(e.id); continue; }
      // Simulation time left before the commit step, less what the
      // accumulator has banked but not yet stepped.
      const remaining = Math.max(0, stepsToCommit(e.timer) * STEP - Math.max(0, lead));
      let total = this.totals.get(e.id);
      if (!total || total.key !== e.telegraph) {
        total = { key: e.telegraph, value: Math.max(remaining, 2 * STEP) };
        this.totals.set(e.id, total);
      }
      if (!active || !this.audible) continue;
      const schedule = warningSchedule(e.timer, scale, lead);
      if (!schedule.duration) continue;
      live.add(e.id);
      const end = now + schedule.duration;
      let warning = this.warnings.get(e.id);
      if (warning) {
        // At its top and releasing (or silent): let it finish, never re-swell.
        if (now >= warning.end - warning.release) continue;
        // Keep the schedule unless the time scale changed, the end would now
        // fall late (past one step before the commit), or it drifted early by
        // more than the audio clock's granularity.
        const late = warning.end - end, early = end - warning.end;
        if (warning.scale === scale && late <= STEP / (2 * scale) && early <= Math.max(STEP / scale, 0.025)) continue;
      } else {
        warning = this.startWarning(e, world, now);
        this.warnings.set(e.id, warning);
      }
      const progress = 1 - (remaining - STEP) / Math.max(STEP, total.value - STEP);
      this.retimeWarning(warning, progress, end, now, scale);
    }
    for (const [id, warning] of this.warnings) if (!live.has(id)) {
      this.stopWarning(warning, now);
      this.warnings.delete(id);
    }
  }
  update(world, scale, active, lead = 0) {
    // Never throw into the frame loop. A failing audio graph only loses sound.
    try {
      this.syncWarnings(world, scale, active, lead);
      if (!this.bedGain) return;
      const now = this.context.currentTime, bed = this.bedState;
      // A deep-field ship has no integrity: it runs low near its core mass (src/sim/field.js).
      const p = world.player, low = (p.mass !== undefined ? p.mass < coreMass(world) * 2 : p.integrity < p.maxIntegrity * 0.3) ? 0.35 : 1;
      if (bed.formId !== world.formId) {
        const sound = formSound(world.formId, campaignOf(world));
        this.drone.frequency.setValueAtTime(sound.drone || 55, now);
        this.pulse.frequency.setValueAtTime(sound.beat || 110, now);
        bed.formId = world.formId;
      }
      // Write automation only when a target changes. The threat pulse moves
      // every frame only while an opponent is committed.
      const level = active ? 0.035 * low : 0;
      if (level !== bed.level) { this.bedGain.gain.setTargetAtTime(level, now, 0.05); bed.level = level; }
      const threat = active && world.enemies.some((e) => e.alive && e.state === "commit");
      const pulse = threat ? (0.025 + 0.02 * Math.sin(now * Math.PI * 2) ** 2) * low : 0;
      if (pulse !== bed.pulse) { this.pulseGain.gain.setTargetAtTime(pulse, now, 0.03); bed.pulse = pulse; }
    } catch { this.available = false; }
  }
  reset() {
    for (const source of [...this.sources]) try { source.cancel(); } catch {}
    this.sources.clear();
    this.warnings.clear(); this.totals.clear(); this.enemyStates.clear();
    this.collections.length = 0; this.collectionUntil = 0;
    try {
      if (this.bedGain) {
        this.bedGain.gain.setValueAtTime(0, this.context.currentTime);
        this.pulseGain.gain.setValueAtTime(0, this.context.currentTime);
      }
    } catch { this.available = false; }
    this.bedState = { formId: undefined, level: 0, pulse: 0 };
  }
}
