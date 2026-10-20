// Presentation only. A silence is intentional, not an unhandled event.
export const EVENT_RESPONSES = Object.freeze({
  choice: { cue: "motif" },
  "encounter-start": { silence: "The title card names the encounter." },
  collection: { cue: "collection", particles: "matter" },
  "overflow-recognition": { silence: "Collection already reports this intake." },
  "evolution-preview": { cue: "preview" },
  evolution: { cue: "evolution" },
  "encounter-clear": { cue: "clear" },
  "run-complete": { cue: "victory" },
  capture: { cue: "claim" },
  "capture-failed": { cue: "refusal" },
  "formation-ready": { silence: "The orbit change already has a glide." },
  "formation-change": { cue: "formation" },
  "gravity-pulse": { silence: "The orbit glide accompanies the pulse." },
  burst: { cue: "burst" },
  telegraph: { cue: "warning" },
  "enemy-commit": { cue: "commit" },
  "clean-dodge": { cue: "dodge" },
  "cache-return": { cue: "cache", particles: "matter" },
  scavenge: { silence: "The moving matter and opponent show the loss." },
  "settled-impact": { cue: "deal", stop: 0.04, particles: "impact", flash: true },
  "enemy-defeated": { cue: "break", stop: 0.09, particles: "defeat", flash: true },
  interception: { cue: "intercept" },
  "player-hit": { cue: "take", stop: 0.07, particles: "impact", flash: true },
  "run-lost": { cue: "defeat" },
  "ore-impact": { cue: "ore", particles: "ore" },
  "ore-broken": { cue: "ore-break", particles: "ore" },
  "stream-release": { silence: "The stream is visible; collection has its own tone." },
  "gate-pass": { cue: "gate" },
  "slalom-complete": { silence: "The third gate completes the ascending chime." },
  // Contact telemetry (M2). Each settlement already has its own impact, hit, interception or ore response.
  "contact-settle": { silence: "The impact, hit, interception or ore event carries this settlement." },
  "grace-suppressed": { silence: "The dashed grace outline already shows why the contact did not hurt." },
  rearm: { silence: "Harness telemetry: a persistent contact channel is ready again." },
  // Deep fields: striking a well core is a hit on the player; ore striking an enemy settles as a settled impact.
  "well-strike": { cue: "take", stop: 0.07, particles: "impact", flash: true },
  "ore-strike": { silence: "The settled impact on the enemy carries the ore strike." },
  accretion: { silence: "The matter visibly falls into the body that swallows it." },
  "well-merge": { silence: "The two bodies visibly become one." },
  shear: { silence: "Sparks and debris stream from the body the field is grinding." },
  flare: { silence: "The body's glow builds as it fills, and the matter it throws out is visible." },
  "trait-offer": { silence: "The offer opens its own dialog, which pauses the field." },
  "trait-chosen": { cue: "preview" },
  irradiate: { silence: "The glow around the ship and the debris it grinds loose show it." },
  swallowed: { cue: "break", stop: 0.12, flash: true },
  comet: { silence: "The comet streaks in on the field map and its edge marker before it arrives." },
  "solar-storm": { silence: "The star brightens before it throws the storm, and the front is drawn as it spreads." },
});

export const MARK_LIFE = 0.6;

// Direction of contact. A settled impact uses the simulation's own impact
// effect, whose angle runs from the attacker (a moon, for example), not from
// the player. Other events fall back to the attacker or the player.
function contactAngle(event, world, target) {
  if (Number.isFinite(event.angle)) return event.angle;
  if (event.type === "settled-impact") {
    const effects = world.effects || [];
    for (let i = effects.length - 1; i >= 0; i--) {
      const fx = effects[i];
      if (fx.type === "impact" && Number.isFinite(fx.angle) && Math.hypot(fx.x - target.x, fx.y - target.y) < 1)
        return fx.angle;
    }
  }
  const p = world.player;
  const from = event.attacker == null || event.attacker === p.id ? p
    : (p.companions || []).find((c) => c.id === event.attacker) || p;
  return Math.atan2(target.y - from.y, target.x - from.x);
}

export class FeedbackDirector {
  constructor(timeScale) {
    this.timeScale = timeScale;
    this.particles = Array.from({ length: 256 }, () => ({ life: 0 }));
    // Wall-clock phase for the shake, so it keeps moving while hit-stop or
    // the encounter beat holds simulation time still.
    this.clock = 0;
    this.reset();
  }
  reset() {
    this.timeScale.clearOwner("feedback");
    this.reservations = [];
    this.stopUntil = 0;
    this.release = null;
    this.flash = null;
    this.shake = 0;
    this.angle = 0;
    this.outcomes = new Map();
    // Static, dotted "past" outlines where opponents broke. They draw at every
    // effects setting, so a defeat never reads as a plain disappearance.
    this.marks = [];
    this.cursor = 0;
    for (const p of this.particles) p.life = 0;
  }
  hitStop(duration, now) {
    // Retain each entire reservation until one second after its END. This
    // conservative rolling budget bounds every sliding second, even at edges.
    this.reservations = this.reservations.filter((r) => r.end > now - 1);
    const spent = this.reservations.reduce((sum, r) => sum + r.duration, 0);
    // A killing hit emits both impact and defeat. Overlapping requests extend
    // to the longer beat rather than adding 40 + 90 ms for that one outcome.
    const extension = Math.max(0, now + duration - Math.max(now, this.stopUntil));
    const allowed = Math.max(0, Math.min(extension, 0.12 - spent));
    if (allowed < 1e-9) return 0;
    this.stopUntil = Math.max(now, this.stopUntil) + allowed;
    this.reservations.push({ end: this.stopUntil, duration: allowed });
    this.release ||= this.timeScale.acquire("feedback", 0.05);
    return allowed;
  }
  exportState(now) {
    return {
      remaining: Math.max(0, this.stopUntil - now),
      reservations: this.reservations.map(r => ({ remaining: r.end - now, duration: r.duration })),
    };
  }
  static validateState(state) {
    const time = (value) => Number.isFinite(value) && value >= 0;
    if (!state || !time(state.remaining) || !Array.isArray(state.reservations) ||
      state.reservations.some(r => !r || !Number.isFinite(r.remaining) || !time(r.duration)))
      throw new RangeError("Invalid feedback state");
  }
  importState(state, now, handles) {
    FeedbackDirector.validateState(state);
    this.stopUntil = now + state.remaining;
    this.reservations = state.reservations.map(r => ({ end: now + r.remaining, duration: r.duration }));
    // The request importer already acquired this reservation. Never acquire it twice.
    this.release = handles.find(h => h.owner === "feedback")?.release || null;
  }
  consume(event, world, now, settings) {
    const response = EVENT_RESPONSES[event.type];
    if (!response) return null;
    const target = world.enemies.find((e) => e.id === (event.target || event.enemy)) ||
      (world.rocks || []).find((r) => r.id === event.rock) || world.player;
    const point = event.type === "player-hit" ? world.player : target;
    const angle = contactAngle(event, world, target);
    if (event.type === "settled-impact") this.outcomes.set(event.target, event.settledLoss);
    const intensity = Math.max(0, event.settledLoss ?? event.value ??
      (event.type === "enemy-defeated" ? this.outcomes.get(event.enemy) : undefined) ?? 1);
    if (event.type === "enemy-defeated") {
      this.outcomes.delete(event.enemy);
      if (target !== world.player) {
        this.marks.push({ x: target.x, y: target.y, radius: target.radius || 12, life: MARK_LIFE });
        if (this.marks.length > 8) this.marks.shift();
      }
    }
    if (response.stop && intensity > 0 && settings.motion)
      this.hitStop(response.stop, now);
    if (response.flash && intensity > 0) {
      this.angle = angle;
      this.shake = Math.min(6, 1 + Math.sqrt(intensity));
      this.flash = { x: point.x, y: point.y, angle, life: 0.16 };
    }
    if (response.particles && settings.decoration && settings.motion) {
      const count = response.particles === "defeat" ? 28 : Math.min(16, 3 + Math.ceil(Math.sqrt(intensity)));
      for (let i = 0; i < count; i++) {
        const p = this.particles[this.cursor++ % this.particles.length];
        const a = angle + i * 2.399963 + (event.seq || 0);
        Object.assign(p, {
          x: point.x, y: point.y, vx: Math.cos(a) * (28 + i * 3),
          vy: Math.sin(a) * (28 + i * 3), life: 0.55, kind: response.particles,
        });
      }
    }
    return response;
  }
  update(now, dt, settings) {
    if (!settings.motion || now >= this.stopUntil) {
      this.release?.();
      this.release = null;
    }
    this.clock += dt;
    this.shake = Math.max(0, this.shake - dt * 35);
    for (const mark of this.marks) mark.life -= dt;
    if (this.marks.length && this.marks[0].life <= 0) this.marks = this.marks.filter((m) => m.life > 0);
    if (this.flash) {
      this.flash.life -= dt;
      if (this.flash.life <= 0) this.flash = null;
    }
    for (const p of this.particles) {
      p.life = settings.motion && settings.decoration ? Math.max(0, p.life - dt) : 0;
      if (p.life > 0) { p.x += p.vx * dt; p.y += p.vy * dt; }
    }
  }
}
