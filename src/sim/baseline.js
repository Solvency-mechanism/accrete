export function makeBaseline(seed = 117) {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  return { player: { x: 640, y: 360, radius: 22, mass: 0 }, elapsed: 0, events: [],
    pickups: Array.from({ length: 30 }, (_, i) => ({ id: i, x: 80 + random() * 1120, y: 80 + random() * 560, value: 4 })) };
}
export function stepBaseline(world, input, dt) {
  dt = Math.min(dt, 1 / 30); world.elapsed += dt;
  const length = Math.hypot(input.x, input.y) || 1;
  world.player.x = Math.max(22, Math.min(1258, world.player.x + input.x / length * 220 * dt));
  world.player.y = Math.max(22, Math.min(698, world.player.y + input.y / length * 220 * dt));
  world.pickups = world.pickups.filter(p => {
    if (Math.hypot(p.x - world.player.x, p.y - world.player.y) < 32) { world.player.mass += p.value; world.events.push({ type: 'collection', time: world.elapsed, value: p.value }); return false; }
    return true;
  });
}
