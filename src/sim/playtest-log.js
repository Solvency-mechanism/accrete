// Playtest log, schema 1 (docs/specs/playtest-log-schema.md): the contract between the app, which records a
// session, and tools/replay/, which replays it headlessly. Inputs are quantized before they reach stepWorld and
// the world is stepped with the quantized values, so a replay is exact. A session wraps every call that changes a
// world (stepWorld, requestCapture, commitCapture, evolveWorld, nextEncounter, chooseTrait) and records each one in call order.
// The app and tools/replay/record.mjs both record through startSession, so they share one code path.

import { createWorld, stepWorld, evolveWorld, nextEncounter, requestCapture, commitCapture, chooseTrait } from './simulation.js';
import { projectionHash, PROJECTION_VERSION, canonicalJson, fnv1a, hex } from './projection.js';
import { formPosition } from './campaign.js';

export const LOG_SCHEMA = 1;
export const STATE_VERSION = 2;                   // bump when replayState changes: every recorded state digest moves (2: M2 grace and command buffer)
export const FIXED_STEP = 1 / 120;               // the app's fixed step: src/app/main.js and tools/harness/core.mjs take it from here
export const AXIS_SCALE = 1000;                   // x and y: integers in -1000..1000
export const AIM_SCALE = 10, AIM_LIMIT = 1e6;     // aimX and aimY: integer tenths of a world unit, clamped to +-AIM_LIMIT
export const CHECKPOINT_EVERY = 120;              // one checkpoint hash per simulated second at FIXED_STEP
export const ACTION_TYPES = Object.freeze(['capture-request', 'capture-commit', 'evolve', 'next', 'choose']);  // choose: a deep field's trait pick

const finite = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const int = n => Math.round(n) || 0;              // never -0: JSON cannot carry it, and atan2 tells -0 from 0
const aim = v => int(Math.max(-AIM_LIMIT, Math.min(AIM_LIMIT, v * AIM_SCALE)));

/**
 * A stepWorld input as its schema-1 tuple [x, y, aimX, aimY, command] of integers. A movement component beyond
 * +-1 scales both components down together (stepWorld normalizes movement, so the direction is kept). aimX and
 * aimY are null unless both are finite, as stepWorld ignores aim otherwise. Non-numeric movement counts as 0.
 */
export function quantizeInput(input) {
  input ??= {};
  let x = finite(input.x), y = finite(input.y);
  const m = Math.max(Math.abs(x), Math.abs(y)); if (m > 1) { x /= m; y /= m; }
  const aimed = Number.isFinite(input.aimX) && Number.isFinite(input.aimY);
  return [int(x * AXIS_SCALE), int(y * AXIS_SCALE), aimed ? aim(input.aimX) : null, aimed ? aim(input.aimY) : null, input.command ? 1 : 0];
}

/** The exact stepWorld input a tuple stands for. The app, the recorder and the replay all step with this. */
export function dequantizeInput([x, y, aimX, aimY, command]) {
  const input = { x: x / AXIS_SCALE, y: y / AXIS_SCALE, command: command === 1 };
  if (aimX !== null && aimY !== null) { input.aimX = aimX / AIM_SCALE; input.aimY = aimY / AIM_SCALE; }
  return input;
}

const sameRun = (run, q) => run[1] === q[0] && run[2] === q[1] && run[3] === q[2] && run[4] === q[3] && run[5] === q[4];
/** Appends one step's tuple to schema-1 runs [count, x, y, aimX, aimY, command], extending the last run when equal. */
export function appendRun(runs, q) { const last = runs.at(-1); if (last && sameRun(last, q)) last[0]++; else runs.push([1, ...q]); return runs; }
/** Run-length encodes one tuple per fixed step. */
export const encodeRuns = tuples => tuples.reduce(appendRun, []);
/** Expands runs back into one tuple per fixed step. */
export function decodeRuns(runs) { const out = []; for (const [count, ...q] of runs) for (let i = 0; i < count; i++) out.push([...q]); return out; }

const r2 = n => Math.round(n * 100) / 100, r3 = n => Math.round(n * 1000) / 1000;
const rounded = o => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, typeof v === 'number' ? r2(v) : v]));
const body = b => ({ id: b.id, role: b.role, tier: b.tier, ownerId: b.ownerId ?? null, alive: b.alive, x: r2(b.x), y: r2(b.y), cooldown: r3(b.cooldown ?? 0), stats: rounded(b.stats) });

/**
 * The replay-only state digest: what a replay must reproduce that the identity-free gameplay projection
 * (src/sim/projection.js) leaves out. Companions, candidates, the capture registry's request counter and modifiers,
 * form, the command state, stats, the RNG stream states and the entity and event counters, so a dropped capture
 * request or commit, evolve or next changes it. It is not identity-free: the harness never compares it across
 * identities. Floats are rounded as the projection rounds them, so a 1-ulp engine difference does not reach it;
 * RNG states and counters are exact integers. Reads the CaptureSystem's public fields and the player's own capture
 * modifiers (modifiersOf, its ModifierLedger entry since M3b); changes nothing.
 */
export function replayState(w) {
  const p = w.player, c = p.command;
  return {
    v: STATE_VERSION, phase: w.phase, form: formPosition(w), encounter: w.encounterIndex, time: r3(w.time), rng: { ...w.rng },
    player: { angle: r3(p.angle), score: p.score, transitioning: p.transitioning, formation: p.formation, orbit: r3(p.orbitPhase),
      command: { state: c.state, timer: r3(c.timer), cooldown: r3(c.cooldown), angle: r3(c.angle), held: !!w._commandHeld,
        pending: p.pendingCommand == null ? null : r3(p.pendingCommand) },
      grace: r3(p.invulnerable || 0), graceSuppressed: w._graceSuppressed ? w._graceSuppressed.size : 0 },
    companions: p.companions.map(body), candidates: w.candidates.map(body),
    capture: { requests: w._capture.nextRequest, modifiers: rounded(w._capture.modifiersOf(p)) },
    stats: rounded(w.stats), counters: { ids: w._id, events: w._eventSequence },
  };
}

/** Stable 8-hex-digit hash of replayState. */
export const stateHash = w => hex(fnv1a(canonicalJson(replayState(w))));

/** The JavaScript engine a session runs in: Node's version and V8 build, or the browser's user agent. */
export function runtimeName() {
  const node = globalThis.process?.versions, agent = globalThis.navigator?.userAgent;
  return node?.node ? `node ${node.node} (V8 ${node.v8})` : agent ? String(agent) : 'unknown';
}

/**
 * Starts a recorded session. `options` are createWorld's own; the log's `start` holds the values the world was
 * actually created with. Call the returned wrappers instead of the simulation functions, so nothing reaches the
 * world unrecorded. Every step uses `step` as its dt; there is deliberately no way to step with another, and the
 * export carries both the projection hash and the replay-only state digest at every checkpoint and at the end.
 */
export function startSession(options = {}, { sha = 'dev', engine = runtimeName(), step = FIXED_STEP, checkpointEvery = CHECKPOINT_EVERY } = {}) {
  const world = createWorld(options);
  // A deep-field run also records its field; a classic log's start is unchanged (src/sim/field.js).
  const start = { seed: world.seed, identity: world.identity, practice: world.practice, arrangement: world.practice ? world.encounterIndex : 0, form: formPosition(world),
    ...(world.field !== 'classic' ? { field: world.field } : {}) };
  const input = [], actions = [], survey = [], checkpoints = [], requests = new WeakMap();
  let steps = 0;
  const act = (type, args = {}) => { actions.push({ step: steps, type, args }); return actions.length - 1; };
  return {
    world, start,
    get steps() { return steps; },
    /** Quantizes `raw`, records it and steps the world with the quantized input. A `dt` other than the session's step throws. */
    step(raw, dt) {
      if (dt !== undefined && dt !== step) throw new RangeError(`A session steps only by its fixed step ${step}, not ${dt}; call step once per fixed step.`);
      const q = quantizeInput(raw); appendRun(input, q);
      stepWorld(world, dequantizeInput(q), step); steps++;
      if (checkpointEvery > 0 && steps % checkpointEvery === 0) checkpoints.push([steps, projectionHash(world), stateHash(world)]);
      return world;
    },
    evolve() { act('evolve'); return evolveWorld(world); },
    next() { act('next'); return nextEncounter(world); },
    /** chooseTrait(world, trait): takes a trait from the offer the player holds (deep fields). */
    choose(trait) { act('choose', { trait: String(trait) }); return chooseTrait(world, String(trait)); },
    /** requestCapture(world, candidateId, replaceIndex); the returned request is what commitCapture takes. */
    requestCapture(candidateId, replaceIndex = null) {
      const replace = replaceIndex === null || replaceIndex === undefined || !Number.isInteger(Number(replaceIndex)) ? null : Number(replaceIndex);
      const index = act('capture-request', { candidate: String(candidateId), replace });
      const request = requestCapture(world, String(candidateId), replace);
      requests.set(request, index); return request;
    },
    commitCapture(request) {
      if (!requests.has(request)) throw new Error('commitCapture takes a request returned by this session.');
      act('capture-commit', { request: requests.get(request) }); return commitCapture(world, request);
    },
    /** A survey answer (tester builds), stamped with the current step index. */
    answer(at, text) { survey.push({ at: String(at), step: steps, answer: String(text) }); },
    /** The schema-1 export of everything so far, with the final projection hash and state digest of the world as it is now. */
    export(summary = {}) {
      return { schema: LOG_SCHEMA, build: { sha: String(sha), engine: String(engine) }, start: { ...start }, step,
        input: input.map(run => [...run]), actions: actions.map(a => ({ step: a.step, type: a.type, args: { ...a.args } })),
        survey: survey.map(s => ({ ...s })), summary,
        final: { steps, phase: world.phase, projection: PROJECTION_VERSION, hash: projectionHash(world), stateVersion: STATE_VERSION, state: stateHash(world) },
        checkpoints: checkpoints.map(c => [...c]) };
    },
  };
}
