import { playerCopy } from "./hud-model.js";
import { campaignOf } from "../sim/campaign.js";
import { capturesAvailable } from "../sim/identities.js";
import { kindCues } from "./presentation.js";
import { createStore } from "./storage.js";

export const HINTS = Object.freeze({
  telegraph: "Leave the dashed warning path.",
  "enemy-commit": "Committed opponents cannot turn.",
  "clean-dodge": "Turn back while they recover.",
  recover: "Touch a recovering opponent.",
  "guard-rear": "Touch the Guard's open arc.",
  "ore-impact": "Touch ore to break it.",
  "stream-release": "The stream carries matter.",
  "gate-pass": "Thread gates 1, 2, 3.",
  action: "Your action leaves you exposed.",
  // Key names (Space, E, Esc) render as keys in the hint region.
  candidate: "Press E to claim a moon.",
  "evolution-preview": "Evolving keeps how you play.",
  "player-hit": "Leave a clear retreat route.",
});
// The hints already shown persist in the save (src/app/storage.js) as
// `hintsSeen`; `store` is shared with the save's other owners, and without
// one the hints seen live in memory.
export class HintDirector {
  constructor(store = createStore()) {
    this.store = store;
    this.seen = new Set();
    this.queue = [];
    this.current = null;
    for (const key of store.get("hintsSeen") || []) if (Object.hasOwn(HINTS, key)) this.seen.add(key);
  }
  reset() { this.queue.length = 0; this.current = null; }
  offer(type, enabled = true) {
    const key = ["burst", "formation-change"].includes(type) ? "action" : type;
    if (!enabled || !Object.hasOwn(HINTS, key) || this.seen.has(key) ||
      this.current?.key === key || this.queue.includes(key)) return;
    this.queue.push(key);
  }
  observe(world, enabled = true) {
    if (world.enemies.some((e) => e.alive && e.state === "recover")) this.offer("recover", enabled);
    if (capturesAvailable(world) && (world.candidates || []).some((c) =>
      c.alive !== false && !c.ownerId && Math.hypot(c.x - world.player.x, c.y - world.player.y) <= 155))
      this.offer("candidate", enabled);
  }
  consume(event, world, enabled = true) {
    this.offer(event.type, enabled);
    // A kind can name the hint its settled impact teaches (src/app/presentation.js, its impactHint cue): the Guard's open arc.
    if (event.type === "settled-impact") {
      const target = world.enemies.find((e) => e.id === event.target);
      const hint = target && kindCues(target.type, campaignOf(world)).impactHint;
      if (hint) this.offer(hint, enabled);
    }
  }
  update(now, enabled = true) {
    if (!enabled) { this.reset(); return ""; }
    if (this.current && now >= this.current.until) this.current = null;
    if (!this.current && this.queue.length) {
      const key = this.queue.shift();
      this.current = { key, until: now + 5 };
      this.seen.add(key);
      this.store.set("hintsSeen", [...this.seen]);
    }
    return this.current ? playerCopy(HINTS[this.current.key]) : "";
  }
}
