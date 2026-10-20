import { TimeScaleRequests as BaseRequests } from "../sim/contracts.js";

// The owners this app re-binds after an import: main.js reacquires "assist"
// whenever the speed changes and FeedbackDirector.importState binds
// "feedback". A record for any other owner, or a second record for one of
// these, would hold time slowed with nothing to release it, so it is refused.
export const RESTORED_OWNERS = Object.freeze(["assist", "feedback"]);

// App continuation data, deliberately separate from the gameplay checkpoint.
export class TimeScaleRequests extends BaseRequests {
  static validate(records) {
    if (!Array.isArray(records) || records.some(r => !r || !RESTORED_OWNERS.includes(r.owner) ||
      !Number.isFinite(r.scale) || r.scale < 0 || r.scale > 1) ||
      new Set(records.map(r => r.owner)).size !== records.length) throw new RangeError("Invalid time requests");
  }
  exportState() { return Array.from(this.requests.values(), ({ owner, scale }) => ({ owner, scale })); }
  importState(records) {
    TimeScaleRequests.validate(records);
    // Replace the map so an old release function cannot affect a rebuilt handle.
    this.requests = new Map();
    return records.map(({ owner, scale }) => ({ owner, scale, release: this.acquire(owner, scale) }));
  }
}
