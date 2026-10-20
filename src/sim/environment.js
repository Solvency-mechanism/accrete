import { settleDamage, splitBudget } from './contracts.js';
import { DIRECTIONS, UNIT, drawInt } from './rng.js';
import { regionDrift } from './regions.js';
import { CHANNELS } from './kinds.js';
import { formOf, encounterOf } from './campaign.js';
import { identityOf } from './identities.js';
import { bounds } from './arena.js';
import { fieldOf, gravity, radiation, aerobrake, capSpeed, strikeWells, wellImpactDamage, collideWell, bodyKind, holdAccreted } from './field.js';

const TAU = Math.PI * 2;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function bounded(x, y, cap) { const length = Math.hypot(x, y); return length > cap ? { x: x / length * cap, y: y / length * cap } : { x, y }; }

/**
 * Encounter resources are allocated once. Movement/release changes where they are, never their value.
 * `pick(n)` is an integer layout draw in [0, n); every layout value is built from such integers and the rng.js tables.
 * The form sets how much ore, matter and drift there is; the encounter sets the stream's lane and the current's force
 * (src/sim/campaign.js). In a deep field `system` (src/sim/field.js buildSystem) places the asteroid belt, the gates
 * and the comet that carries the stream, everything on its orbit, and there is no shear current.
 */
export function setupEnvironment(w, pick, system = null) {
  const offset = half => pick(2 * half + 1) - half, form = formOf(w), encounter = encounterOf(w);
  const rockPositions = [{ x: 420, y: 340 }, { x: 770, y: 540 }, { x: 940, y: 220 }, { x: 1120, y: 420 }, { x: 490, y: 150 }, { x: 310, y: 550 }];
  w.rocks = (system ? system.rocks : rockPositions.slice(0, form.oreCount)).map((position, i) => {
    const mass = [8, 10, 12, 14, 10, 12][i % 6] + form.oreMass;
    const heading = pick(DIRECTIONS.length), [ux, uy] = DIRECTIONS[heading], speed = 24 + pick(21);
    const rock = { id: `ore-${w.encounterIndex}-${i}`, generation: 1, kind: 'ore', alive: true,
      x: position.x + offset(20), y: position.y + offset(20),
      vx: ux * speed / UNIT, vy: uy * speed / UNIT, radius: 13 + mass * .45,
      mass, hp: mass, maxHp: mass, angle: heading * TAU / DIRECTIONS.length, spin: offset(11) / 20 };
    if (system) Object.assign(rock, { x: position.x, y: position.y, vx: position.vx, vy: position.vy });
    else if (distance(rock, w.player) < 110) rock.y = rock.y < 360 ? 550 : 170;
    return rock;
  });
  const direction = encounter.stream.direction;
  const totalBudget = form.streamMatter;
  w.stream = { id: `stream-${w.encounterIndex}`, x: 100, y: encounter.stream.y,
    width: 1080, height: 60, direction, speed: form.streamSpeed,
    totalBudget, remainingBudget: totalBudget, spawnedBudget: 0, releaseTimer: .8,
    packets: splitBudget(totalBudget, 6), nextPacket: 0 };
  // The deep field's stream is a comet: a body on a plunging orbit that sheds the reservoir along its path.
  if (system) Object.assign(w.stream, { x: system.comet.x, y: system.comet.y, vx: system.comet.vx, vy: system.comet.vy, width: 0, height: 0, radius: 26 });
  w.current = { id: `current-${w.encounterIndex}`, x: 500, y: 230, width: 260, height: 240,
    forceX: encounter.current.forceX, forceY: encounter.current.forceY, maxAcceleration: 680, active: true };
  const gatePositions = [{ x: 330, y: 490 }, { x: 650, y: 180 }, { x: 990, y: 490 }];
  w.gates = gatePositions.map((position, index) => ({ id: `gate-${w.encounterIndex}-${index}`, index,
    x: position.x + offset(17), y: position.y + offset(15),
    radius: 32, passed: false, active: index === 0, _wasInside: false }));
  if (system) {
    w.current.active = false;
    w.gates.forEach((gate, i) => Object.assign(gate, system.gates[i], { radius: fieldOf(w).gateRadius }));
  }
  w.slalom = { next: 0, total: 3, complete: false };
}

/** Acceleration is zero outside the visibly bounded current and capped after the edge ramp. */
export function environmentAcceleration(w, body) {
  const c = w.current;
  if (!c?.active || body.x < c.x || body.x > c.x + c.width || body.y < c.y || body.y > c.y + c.height) return { x: 0, y: 0 };
  const edge = Math.min(body.x - c.x, c.x + c.width - body.x, body.y - c.y, c.y + c.height - body.y);
  const ramp = clamp(edge / 24, 0, 1);
  return bounded(c.forceX * ramp, c.forceY * ramp, c.maxAcceleration);
}

/**
 * Breaks `requested` off ore `rock`, struck by `attacker`: the debris scatters as matter of the rock's source, moving
 * with `motion` (the rock's own by default). In a deep-field impact the heavier body sweeps up `transferFraction` of it
 * first, credited through `onTransfer`.
 */
export function settleOre(w, rock, attacker, requested, hooks, channel = 'ore', motion = null, transferFraction = 0, onTransfer = null, loose = null) {
  const result = settleDamage(rock, { requested, transferFraction: onTransfer ? transferFraction : 0, debrisFraction: 1 }); rock.hp = rock.mass; w.stats.unallocated += result.unallocated;
  if (result.creditedTransfer) onTransfer(result.creditedTransfer);
  hooks.event(w, 'contact-settle', { channel, serial: null, pair: [attacker.id, rock.id], settledLoss: result.settledLoss });
  if (!result.settledLoss) return result;
  w.stats.oreReleased += result.debris;
  const debris = hooks.spawnBudget(w, result.debris, rock.x, rock.y, Math.min(4, result.debris), 22, rock.source ?? 'ore', 'spawn', motion ?? rock);
  // In a deep field what breaks off ore is loose, like any impact's debris: it flies clear before anything collects it.
  // Ore ground off by a shear field stays loose as long as a ship's ground-off debris (`loose`).
  if (fieldOf(w).physics) for (const q of debris) q.loose = loose ?? fieldOf(w).physics.impact.loose;
  hooks.event(w, 'ore-impact', { rock: rock.id, attacker: attacker.id, settledLoss: result.settledLoss, debris: result.debris });
  hooks.effect(w, 'ore', rock.x, rock.y, { amount: result.settledLoss, life: .4 });
  // In a deep field the collision itself moves the ore, so the classic kick does not apply.
  if (!fieldOf(w).physics) {
  const dx = rock.x - attacker.x, dy = rock.y - attacker.y, d = Math.hypot(dx, dy) || 1;
  const velocity = bounded(rock.vx + dx / d * 75, rock.vy + dy / d * 75, 125); rock.vx = velocity.x; rock.vy = velocity.y;
  }
  if (!rock.alive) { w.stats.rocksBroken++; hooks.event(w, 'ore-broken', { rock: rock.id, initialMass: rock.maxHp }); }
  return result;
}

export function stepEnvironment(w, dt, hooks) {
  const stream = w.stream, physics = fieldOf(w).physics;
  if (physics) {
    const g = gravity(w, stream);
    stream.vx += g.x * dt; stream.vy += g.y * dt; regionDrift(w.regions, stream, dt); capSpeed(w, stream);
    stream.x += stream.vx * dt; stream.y += stream.vy * dt;
    for (const well of w.wells) collideWell(well, stream, physics.buoyRestitution);
  }
  if (stream.remainingBudget > 0 && physics) {
    stream.releaseTimer -= dt;
    if (stream.releaseTimer <= 0) {
      const value = stream.packets[stream.nextPacket++];
      stream.remainingBudget -= value; stream.spawnedBudget += value; stream.releaseTimer += 2.6;
      // The comet breaks up: part of each packet comes off as a solid chunk at the comet's speed, a meteor stream that
      // strikes what it crosses (src/sim/simulation.js collideSolids) and breaks into the stream's matter.
      const solid = value >= 4 ? Math.floor(value * physics.cometSolid) : 0;
      if (solid) {
        const [ux, uy] = DIRECTIONS[drawInt(w.rng, 'spawn', DIRECTIONS.length)].map(n => n / UNIT), radius = 13 + solid * .45, reach = stream.radius + radius + 4;
        w.rocks.push({ id: `ore-${w.encounterIndex}-c${++w._id}`, generation: 1, kind: 'ore', alive: true, source: 'stream',
          x: stream.x + ux * reach, y: stream.y + uy * reach, vx: stream.vx + ux * physics.debrisSpeed, vy: stream.vy + uy * physics.debrisSpeed,
          radius, mass: solid, hp: solid, maxHp: solid, angle: 0, spin: .8 });
      }
      const fragments = value - solid ? hooks.spawnBudget(w, value - solid, stream.x, stream.y, 2, 18, 'stream', 'spawn', stream) : [];
      for (const p of fragments) p.streamId = stream.id;
      w.stats.streamReleased += value; hooks.event(w, 'stream-release', { stream: stream.id, value, remaining: stream.remainingBudget });
    }
  } else if (stream.remainingBudget > 0) {
    stream.releaseTimer -= dt;
    if (stream.releaseTimer <= 0) {
      const value = stream.packets[stream.nextPacket++];
      // Commit the finite reservoir before exposing the resulting fragments.
      stream.remainingBudget -= value; stream.spawnedBudget += value; stream.releaseTimer += 2.6;
      const fromX = stream.direction > 0 ? stream.x + 20 : stream.x + stream.width - 20;
      const fragments = hooks.spawnBudget(w, value, fromX, stream.y + stream.height / 2, 2, 18, 'stream');
      for (const p of fragments) { p.streamId = stream.id; p.driftX = stream.direction * stream.speed; p.driftY = 0; }
      w.stats.streamReleased += value; hooks.event(w, 'stream-release', { stream: stream.id, value, remaining: stream.remainingBudget });
    }
  }
  // Ore is a persistent channel on the world's one ContactEpisodes (src/sim/kinds.js): a pair re-arms only
  // after its gap has exceeded REARM_GAP and 0.35 s have passed since its last strike, in either order.
  const contacts = w._contacts, ore = { now: w.time, interval: CHANNELS.ore.interval, separation: CHANNELS.ore.separation };
  const p = w.player, identity = identityOf(w), form = formOf(w), moonsStrike = identity.moonsBreakOre(p);
  for (const rock of w.rocks) {
    if (!rock.alive) continue;
    if (physics) {
      // Deep fields: ore keeps its momentum. Gravity, the tide and atmospheres act on it, and there is no wall.
      const g = gravity(w, rock);
      rock.vx += g.x * dt; rock.vy += g.y * dt; aerobrake(w.wells, rock, dt); regionDrift(w.regions, rock, dt); capSpeed(w, rock);
      rock.x += rock.vx * dt; rock.y += rock.vy * dt; rock.angle += rock.spin * dt;
      // Ore against the player, enemies, moons and other ore is the simulation's collision resolver (collideSolids).
      strikeOre(w, rock, hooks);
      continue;
    } else {
    const flow = environmentAcceleration(w, rock);
    const velocity = bounded(rock.vx + flow.x * dt * .12, rock.vy + flow.y * dt * .12, 125);
    rock.vx = velocity.x; rock.vy = velocity.y;
    rock.x += rock.vx * dt; rock.y += rock.vy * dt; rock.angle += rock.spin * dt;
    // The arena's ore policy (src/sim/arena.js; shipped: a surface r + 95 from every edge); outside it the ore bounces, then is clamped.
    const { minX, maxX, minY, maxY } = bounds(w.arena, 'ore', rock.radius);
    if (rock.x < minX || rock.x > maxX) { rock.vx *= -1; rock.x = clamp(rock.x, minX, maxX); }
    if (rock.y < minY || rock.y > maxY) { rock.vy *= -1; rock.y = clamp(rock.y, minY, maxY); }
    }
    // Every possible striker keeps its separation history, including moons in tight formation.
    for (const attacker of [p, ...p.companions]) {
      if (!rock.alive) break;
      const gap = distance(attacker, rock) - attacker.radius - rock.radius;
      if (contacts.track(attacker, rock, 'ore', gap, w.time)) hooks.event(w, 'rearm', { channel: 'ore', pair: [attacker.id, rock.id] });
      if (gap > 0 || (attacker !== p && !moonsStrike) || !contacts.enter(attacker, rock, 'ore', ore)) continue;
      const request = attacker === p ? identity.oreImpact(attacker, form) : 7;
      settleOre(w, rock, attacker, request, hooks);
    }
  }
}

/**
 * Deep fields: ore against the bodies. A star or black hole swallows ore whole (its mass is accreted). A rocky planet,
 * moon or giant core that ore strikes faster than its shatter speed breaks it apart entirely: the fragments are matter
 * that moves with that body, an orbiting debris cloud the player, scavengers and the accreting bodies all compete for.
 * A slower strike cracks it by the field's ore rule. Ore against ships and other ore is collideSolids'.
 */
function strikeOre(w, rock, hooks) {
  strikeWells(w, rock, 'ore', (well, speed) => {
    const kind = bodyKind(well), shatter = kind.shatters && speed > kind.shatterSpeed;
    const requested = shatter ? rock.mass : wellImpactDamage(w, 'ore', speed);
    if (!requested) return false;
    settleOre(w, rock, well, requested, hooks, 'impact', shatter ? well : rock); w.stats.wellStrikes++;
    return true;
  }, well => {
    holdAccreted(w, well, rock.mass, rock.source === 'shed'); hooks.event(w, 'accretion', { well: well.id, value: rock.mass, source: rock.source ?? 'ore' });
    rock.mass = 0; rock.hp = 0; rock.alive = false;
  });
}

export function stepSlalom(w, hooks) {
  for (const gate of w.gates) {
    const inside = distance(w.player, gate) <= gate.radius;
    if (gate.active && !gate.passed && inside && !gate._wasInside) {
      gate.passed = true; gate.active = false; w.slalom.next++; w.stats.gatesPassed++;
      hooks.event(w, 'gate-pass', { gate: gate.id, index: gate.index, remaining: w.slalom.total - w.slalom.next });
      hooks.effect(w, 'gate', gate.x, gate.y, { radius: gate.radius, life: .45 });
      if (w.slalom.next === w.slalom.total) { w.slalom.complete = true; w.stats.slalomsCompleted++; hooks.event(w, 'slalom-complete', { encounter: w.encounterIndex }); }
      else w.gates[w.slalom.next].active = true;
    }
    gate._wasInside = inside;
  }
}

/**
 * Nearby fragments approach the actual body; long-range collection remains a Warden role. In a deep field matter keeps
 * its momentum under every body's pull, starlight and atmospheres; within the player's reach it is pulled in and its
 * motion matched to the player's; and a body that accretes matter swallows it, which this returns (that body), while a
 * solid one lets it settle on its surface.
 */
export function movePickup(w, pickup, dt) {
  const physics = fieldOf(w).physics;
  if (physics) return driftMatter(w, pickup, dt, physics);
  const p = w.player, dx = p.x - pickup.x, dy = p.y - pickup.y, d = Math.hypot(dx, dy);
  const flow = environmentAcceleration(w, pickup);
  let ax = flow.x * .12, ay = flow.y * .12;
  const reach = p.radius + 58;
  if (d > 1 && d < reach) { const pull = 900 * (1 - d / reach); ax += dx / d * pull; ay += dy / d * pull; }
  const acceleration = bounded(ax, ay, 1000);
  const velocity = bounded(pickup.vx + acceleration.x * dt, pickup.vy + acceleration.y * dt, 235);
  pickup.vx = velocity.x; pickup.vy = velocity.y;
  pickup.x += (pickup.vx + (pickup.driftX ?? 0)) * dt; pickup.y += (pickup.vy + (pickup.driftY ?? 0)) * dt;
  // The arena's pickup policy (src/sim/arena.js; shipped: a centre 40 from every edge, so the radius is unread).
  const { minX, maxX, minY, maxY } = bounds(w.arena, 'pickup', pickup.radius);
  if (pickup.x < minX || pickup.x > maxX) { if (pickup.driftX) pickup.driftX *= -1; pickup.vx *= -.35; pickup.x = clamp(pickup.x, minX, maxX); }
  if (pickup.y < minY || pickup.y > maxY) { if (pickup.driftY) pickup.driftY *= -1; pickup.vy *= -.35; pickup.y = clamp(pickup.y, minY, maxY); }
  pickup.vx *= Math.exp(-dt * 3.5); pickup.vy *= Math.exp(-dt * 3.5);
}

function driftMatter(w, pickup, dt, physics) {
  const p = w.player, dx = p.x - pickup.x, dy = p.y - pickup.y, d = Math.hypot(dx, dy), g = gravity(w, pickup), light = radiation(w, pickup);
  let ax = g.x + light.x, ay = g.y + light.y;
  const reach = p.radius + physics.pickup.reach;
  // Freshly broken debris is loose until its time runs out: it flies clear before the player's reach can draw it in.
  if (pickup.loose > 0) pickup.loose = Math.max(0, pickup.loose - dt);
  else if (d > 1 && d < reach) {
    const pull = 900 * (1 - d / reach), k = 1 - Math.exp(-physics.pickup.capture * dt);
    ax += dx / d * pull; ay += dy / d * pull;
    pickup.vx += (p.vx - pickup.vx) * k; pickup.vy += (p.vy - pickup.vy) * k;
  }
  pickup.vx += ax * dt; pickup.vy += ay * dt;
  const drag = Math.exp(-physics.pickup.drag * dt); pickup.vx *= drag; pickup.vy *= drag;
  aerobrake(w.wells, pickup, dt); regionDrift(w.regions, pickup, dt); capSpeed(w, pickup);
  pickup.x += pickup.vx * dt; pickup.y += pickup.vy * dt;
  for (const well of w.wells) {
    if (Math.hypot(pickup.x - well.x, pickup.y - well.y) >= well.core + pickup.radius) continue;
    if (bodyKind(well).accretes.includes('matter')) return well;
    collideWell(well, pickup, .1);
  }
  return null;
}
