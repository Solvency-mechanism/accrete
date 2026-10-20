// Only plain presentation data is copied. Class instances and gameplay services
// never enter the renderer's state. Descriptors are immutable shared templates.
function detach(value) {
  if (Array.isArray(value)) return value.map(detach);
  if (value && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const copy = {};
    for (const field of Object.keys(value)) {
      const v = value[field];
      if (typeof v !== "function") copy[field] = detach(v);
    }
    return copy;
  }
  return value;
}
function snapshot(world) {
  const view = { campaign: world.campaign };
  for (const field of ["seed", "identity", "formId", "encounterIndex", "encounterTime", "phase", "time", "arena", "field", "wells", "regions",
    "player", "enemies", "pickups", "candidates", "rocks", "current", "stream", "gates", "effects"])
    view[field] = detach(world[field]);
  return view;
}
// Typed id and generation. A generation is a number and typeof never holds a
// "|", so the id (which may) comes last and two different keys never collide.
const key = (entity) => `${entity.generation}|${typeof entity.id}|${entity.id}`;
function entities(world) {
  return [world.player, ...(world.player.companions || []), ...(world.enemies || []),
    ...(world.pickups || []), ...(world.candidates || []), ...(world.rocks || []), ...(world.wells || []),
    // Deep fields: the regions of space, the drifting gates and the comet move too.
    ...(world.regions || []), ...(world.gates || []), ...(world.stream?.vx !== undefined ? [world.stream] : [])];
}
// The pose before the latest fixed step is only positions: discrete state
// (radii, timers, telegraphs, settled states) is drawn from the current world.
function positions(world) {
  const pose = new Map();
  for (const entity of entities(world))
    if (entity.id != null) pose.set(key(entity), { x: entity.x, y: entity.y });
  return pose;
}

// One detached copy per drawn frame (in sample), and a small position map per
// fixed step; the world itself is never retained in a copy between frames.
export class PresentationState {
  reset(world) {
    this.source = world;
    this.encounter = world.encounterIndex;
    this.formId = world.formId;
    this.previous = positions(world);
  }
  ensure(world) {
    if (world !== this.source || world.encounterIndex !== this.encounter || world.formId !== this.formId) this.reset(world);
  }
  beforeStep(world) { this.ensure(world); this.previous = positions(world); }
  afterStep(world) {
    this.ensure(world);
    // A phase boundary must show its settled geometry, without a delayed pose.
    if (world.phase !== "playing") this.previous = positions(world);
  }
  sample(world, alpha) {
    this.ensure(world);
    const result = snapshot(world), t = Math.max(0, Math.min(1, alpha));
    for (const entity of entities(result)) {
      if (entity.id == null) continue;
      const old = this.previous.get(key(entity));
      if (!old) continue;
      for (const axis of ["x", "y"]) if (Number.isFinite(old[axis]) && Number.isFinite(entity[axis]))
        entity[axis] = old[axis] + (entity[axis] - old[axis]) * t;
    }
    return result;
  }
}
