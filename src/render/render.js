import { ArenaCamera } from "./camera.js";
import { ArtLibrary, ATLAS, identityCell, kindCell, oreCell, roleCell } from "./art.js";
import { identityLook, formLook, kindLook } from "./looks.js";
import { campaignOf, formOf } from "../sim/campaign.js";
import { IDENTITIES, DEFAULT_IDENTITY } from "../sim/identities.js";
import { kindEntry } from "../sim/kinds.js";
import { fieldOf, predictCoast, influenceRadius, influence, bodyKind, escapeRadius, fullThrust, horizonRadius } from "../sim/field.js";
import { REGION_KINDS, COMPOSITIONS, regionsAt, regionThrust, weight } from "../sim/regions.js";
import { ELEMENTS, HABITABLE } from "../sim/traits.js";

/** Each element's colour, for the rim that shows what a deep-field body is mostly made of. */
const ELEMENT_COLOURS = { rock: "#b8a58c", metal: "#c9d3dc", water: "#6fb7ff", cryo: "#bfefff", radioactive: "#b6ff5a", organic: "#7ee08a" };

/** Region looks: a colour per kind, and per composition for the clouds and storms that carry particles. */
const REGION_TINT = { dust: { silicate: "#d4b287", ice: "#a8dcff", metallic: "#c3cad6" }, storm: { ionised: "#9d86ff", silicate: "#e6b878" },
  shear: "#ff5c7a", mire: "#6fae86", halo: "#ffd9a0", heat: "#ff9548", radiation: "#b6ff5a", tidal: "#d58cff", cold: "#bfe6ff",
  nebula: { silicate: "#c79a7a", ice: "#7fb6e6", tholin: "#d0805c" }, kuiper: "#cfe8ff", "solar-storm": "#ffb35c" };
/** A region's name, as the field, the HUD line and the map show it. */
const regionName = (r) => r.kind === "dust" ? `${COMPOSITIONS[r.composition]?.name ?? ""} dust` : r.kind === "storm" ? `${r.composition === "ionised" ? "ion" : COMPOSITIONS[r.composition]?.name} storm`
  : r.kind === "nebula" ? `${COMPOSITIONS[r.composition]?.name ?? ""} nebula` : REGION_KINDS[r.kind].name;
const regionTint = (r) => (typeof REGION_TINT[r.kind] === "string" ? REGION_TINT[r.kind] : REGION_TINT[r.kind]?.[r.composition] ?? "#c9b8a0");
/** A deterministic stream of floats in [0, 1) for particle `i` of region `id` (so particles never flicker between frames). */
function particle(id, i) {
  let n = 2166136261;
  for (let k = 0; k < id.length; k++) n = Math.imul(n ^ id.charCodeAt(k), 16777619);
  n = (n ^ Math.imul(i + 1, 2654435761)) >>> 0;
  return () => { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return n / 4294967296; };
}

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// The backing store follows the CSS box times DPR up to 2560 x 1440 pixels (a 1280 x 720 box at DPR 2), then the
// browser upscales. Frame cost grows with pixel count, and M7's budget was measured at 1280 x 720.
export const MAX_BACKING_PIXELS = 2560 * 1440;
export function backingScale(rect, dpr = globalThis.devicePixelRatio) {
  const wanted = Math.max(1, dpr || 1), area = rect.width * rect.height;
  return area > 0 ? Math.min(wanted, Math.sqrt(MAX_BACKING_PIXELS / area)) : wanted;
}
// Bodies are drawn from the look registry (src/render/looks.js), keyed by the ids of the gameplay registries
// (src/sim/identities.js, src/sim/kinds.js, the forms of src/sim/campaign.js), and the atlas manifest (src/render/art.js).
// A body is { key, cell, color, tone, bands }: the manifest cell (null draws the procedural sprite), the outline and
// base colour, the procedural sprite's mid tone and gas bands. `identity` and `form` are { id, look }.
function playerLook(world) {
  const campaign = campaignOf(world), id = Object.hasOwn(IDENTITIES, world.identity) ? world.identity : DEFAULT_IDENTITY;
  const formId = (formOf(world) ?? campaign.forms[0]).id;
  const identity = { id, look: identityLook(id, campaign) }, form = { id: formId, look: formLook(formId, campaign) };
  return { identity, form, body: { key: `${identity.id}-${form.id}`, cell: identityCell(identity.id, form.id),
    color: identity.look.color, tone: identity.look.tone, bands: form.look.bands } };
}
function enemyLook(world, type) {
  // The kind's gameplay entry (its rear arc, for the guard's shield) and its look, keyed by the same id.
  const kind = kindEntry(type, campaignOf(world).kinds), look = kindLook(type, campaignOf(world));
  return { kind, look, body: { key: `kind-${type}`, cell: kindCell(type), color: look.color, tone: look.tone, bands: false } };
}
function circle(ctx, x, y, r, fill, stroke, width = 1) {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0.1, r), 0, TAU);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.stroke();
  }
}
function seeded(seed) {
  let n = seed >>> 0;
  return () => {
    n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
    return n / 4294967296;
  };
}
export class Renderer {
  constructor(canvas) {
    this.camera = new ArenaCamera();
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.art = new ArtLibrary();
    this.background = null;
    this.sprites = new Map();
    this.rockSprites = new Map();
    this.settings = {
      decoration: true,
      shake: true,
      flashes: true,
      motion: true,
    };
  }
  // The canvas box in CSS pixels. Without layout (a harness canvas) the box is
  // the arena at one CSS pixel per unit, never the DPR-multiplied backing store.
  viewRect(arena) {
    return this.canvas.getBoundingClientRect?.() || { left: 0, top: 0, width: arena.width, height: arena.height };
  }
  reset(arena) {
    this.background = null;
    this.camera.fit(arena, this.viewRect(arena));
  }
  makeBackground(seed, arena) {
    const { width, height } = arena;
    // The composition is authored on the 1280 x 720 reference arena and scales
    // with the arena (docs/evidence/m3c/README.md, "Arena literals"): positions
    // per axis, radii by the larger ratio. The 80-unit grid is world scale.
    // Both ratios are exactly 1 on the shipped arena, so it draws as before.
    const rx = width / 1280, ry = height / 720, k = Math.max(rx, ry);
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    const x = c.getContext("2d"),
      rand = seeded(seed);
    x.fillStyle = "#06101c";
    x.fillRect(0, 0, width, height);
    for (const [px, py, r, col] of [
      [1050, 180, 620, "#173344"],
      [290, 650, 520, "#1c263e"],
      [760, 400, 400, "#0d2630"],
    ]) {
      const g = x.createRadialGradient(px * rx, py * ry, 0, px * rx, py * ry, r * k);
      g.addColorStop(0, col);
      g.addColorStop(1, "#07132200");
      x.fillStyle = g;
      x.fillRect(0, 0, width, height);
    }
    for (let i = 0, stars = Math.round(340 * rx * ry); i < stars; i++) {
      const px = rand() * width,
        py = rand() * height,
        r = rand() < 0.95 ? 0.5 + rand() * 0.6 : 1.6;
      x.globalAlpha = 0.15 + rand() * 0.55;
      circle(x, px, py, r, "#c3d2dc");
    }
    x.globalAlpha = 1;
    if (this.art.background) {
      // Painted atmosphere is deliberately quieter than any tactical marking.
      const image = this.art.background;
      const scale = Math.max(
        width / image.naturalWidth,
        height / image.naturalHeight,
      );
      x.globalAlpha = 0.67;
      x.drawImage(
        image,
        (width - image.naturalWidth * scale) / 2,
        (height - image.naturalHeight * scale) / 2,
        image.naturalWidth * scale,
        image.naturalHeight * scale,
      );
      x.globalAlpha = 1;
      x.fillStyle = "#06101c66";
      x.fillRect(0, 0, width, height);
    }
    const vignette = x.createRadialGradient(640 * rx, 350 * ry, 180 * k, 640 * rx, 360 * ry, 750 * k);
    vignette.addColorStop(0, "#06101c00");
    vignette.addColorStop(1, "#020912cc");
    x.fillStyle = vignette;
    x.fillRect(0, 0, width, height);
    x.strokeStyle = "#8baebe08";
    x.lineWidth = 1;
    for (let i = 80; i < width; i += 80) {
      x.beginPath();
      x.moveTo(i, 0);
      x.lineTo(i, height);
      x.stroke();
    }
    for (let i = 40; i < height; i += 80) {
      x.beginPath();
      x.moveTo(0, i);
      x.lineTo(width, i);
      x.stroke();
    }
    x.save();
    x.translate(640 * rx, 360 * ry);
    x.rotate(-0.3);
    x.strokeStyle = "#8aa7b812";
    for (let i = 0; i < 5; i++) {
      x.beginPath();
      x.ellipse(0, 0, (320 + i * 115) * k, (180 + i * 70) * k, 0, 0, TAU);
      x.stroke();
    }
    x.restore();
    x.font = '9px "Segoe UI", system-ui, sans-serif';
    x.fillStyle = "#8ca6b132";
    x.textAlign = "left";
    for (let i = 0, marks = Math.round(20 * rx * ry); i < marks; i++) {
      const px = (65 + rand() * 1150) * rx,
        py = (65 + rand() * 580) * ry;
      x.strokeStyle = "#b1cdd321";
      x.beginPath();
      x.moveTo(px - 3, py);
      x.lineTo(px + 3, py);
      x.moveTo(px, py - 3);
      x.lineTo(px, py + 3);
      x.stroke();
    }
    this.background = c;
    // The size it was built for: a canvas truncates a fractional width.
    this.bgArena = { width, height };
    this.bgSeed = seed;
    this.bgRevision = this.art.revision;
  }
  /** Draws `look` (playerLook or enemyLook's body): its manifest cell clipped to the radius, or a procedural sprite. */
  body(x, y, r, look, angle = 0) {
    const ctx = this.ctx;
    const texture = this.art.sprite(look.cell, r);
    if (texture) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle * 0.08);
      // The painted silhouette is clipped to precisely the simulation radius.
      ctx.drawImage(texture, -r, -r, r * 2, r * 2);
      circle(ctx, 0, 0, r, null, `${look.color}a8`, 1);
      ctx.restore();
      return;
    }
    const key = look.key;
    let sprite = this.sprites.get(key);
    if (!sprite) {
      sprite = document.createElement("canvas");
      sprite.width = sprite.height = 192;
      const s = sprite.getContext("2d"),
        rand = seeded(key.split("").reduce((n, c) => n + c.charCodeAt(0), 39));
      const base = look.color;
      s.save();
      circle(s, 96, 96, 80, base);
      s.clip();
      const g = s.createRadialGradient(63, 57, 1, 112, 110, 100);
      g.addColorStop(0, base);
      g.addColorStop(0.5, look.tone);
      g.addColorStop(1, "#0b1424");
      s.fillStyle = g;
      s.fillRect(0, 0, 192, 192);
      if (look.bands) {
        s.translate(96, 96);
        s.rotate(-0.22);
        for (let i = -90; i < 100; i += 14) {
          s.fillStyle = i % 28 === 0 ? "#d7ddd120" : "#10243940";
          s.fillRect(-100, i, 200, 8);
        }
        s.translate(-96, -96);
      } else {
        for (let i = 0; i < 24; i++) {
          const cx = 20 + rand() * 152,
            cy = 20 + rand() * 152,
            cr = 3 + rand() * 14;
          circle(s, cx, cy, cr, "#08142328");
          s.beginPath();
          s.arc(cx, cy + 1, cr, Math.PI, TAU);
          s.strokeStyle = "#d7ecea16";
          s.lineWidth = 2;
          s.stroke();
        }
      }
      const shade = s.createLinearGradient(20, 30, 170, 160);
      shade.addColorStop(0, "#efffff18");
      shade.addColorStop(0.7, "#00000000");
      shade.addColorStop(1, "#030b17bb");
      s.fillStyle = shade;
      s.fillRect(0, 0, 192, 192);
      s.restore();
      circle(s, 96, 96, 80, null, `${base}80`, 1.5);
      this.sprites.set(key, sprite);
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle * 0.08);
    ctx.drawImage(sprite, -r * 1.2, -r * 1.2, r * 2.4, r * 2.4);
    ctx.restore();
  }
  wake(x, y, vx, vy, radius, color, strength = 1) {
    if (!this.settings.motion || !this.settings.decoration) return;
    const speed = Math.hypot(vx || 0, vy || 0);
    if (speed < 18) return;
    const c = this.ctx,
      ux = vx / speed,
      uy = vy / speed,
      length = Math.min(88, speed * 0.16) * strength;
    c.save();
    c.translate(x, y);
    c.rotate(Math.atan2(uy, ux));
    const plume = c.createLinearGradient(-radius, 0, -radius - length, 0);
    plume.addColorStop(0, color + "50");
    plume.addColorStop(1, color + "00");
    c.fillStyle = plume;
    c.beginPath();
    c.moveTo(-radius * 0.65, -radius * 0.55);
    c.quadraticCurveTo(
      -radius - length * 0.35,
      -radius * 0.28,
      -radius - length,
      0,
    );
    c.quadraticCurveTo(
      -radius - length * 0.35,
      radius * 0.28,
      -radius * 0.65,
      radius * 0.55,
    );
    c.fill();
    c.strokeStyle = color;
    c.lineCap = "round";
    for (let i = -1; i <= 1; i++) {
      const side = i * radius * 0.56;
      c.globalAlpha = i === 0 ? 0.27 : 0.14;
      c.lineWidth = i === 0 ? Math.max(2, radius * 0.16) : 1;
      c.beginPath();
      c.moveTo(-radius - 3, side);
      c.quadraticCurveTo(
        -radius - length * 0.35,
        side * 0.7,
        -radius - length * (i === 0 ? 1 : 0.68),
        side * 0.35,
      );
      c.stroke();
    }
    c.restore();
  }
  oreBody(x, y, radius, variant, angle = 0) {
    const texture = this.art.sprite(oreCell(variant), radius);
    if (texture) {
      const c = this.ctx;
      c.save();
      c.translate(x, y);
      c.rotate(angle);
      c.drawImage(texture, -radius, -radius, radius * 2, radius * 2);
      c.restore();
      circle(c, x, y, radius, null, "#b9c6b25c", 1);
      return;
    }
    const key = variant % 8;
    let sprite = this.rockSprites.get(key);
    if (!sprite) {
      sprite = document.createElement("canvas");
      sprite.width = sprite.height = 128;
      const c = sprite.getContext("2d"),
        rand = seeded(key * 1717 + 59),
        vertices = [];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU,
          r = 45 + rand() * 13;
        vertices.push([64 + Math.cos(a) * r, 64 + Math.sin(a) * r]);
      }
      c.beginPath();
      vertices.forEach(([px, py], i) =>
        i ? c.lineTo(px, py) : c.moveTo(px, py),
      );
      c.closePath();
      c.fillStyle = "#344853";
      c.fill();
      c.strokeStyle = "#8b9b9e";
      c.lineWidth = 1.5;
      c.stroke();
      for (let i = 0; i < 8; i++) {
        const a = vertices[i],
          b = vertices[(i + 1) % 8];
        c.beginPath();
        c.moveTo(a[0], a[1]);
        c.lineTo(b[0], b[1]);
        c.lineTo(55, 65);
        c.closePath();
        c.fillStyle = i < 4 ? "#a5c2c914" : "#030b172c";
        c.fill();
      }
      c.strokeStyle = "#e9b76a";
      c.lineWidth = 2.5;
      c.beginPath();
      c.moveTo(24, 52);
      c.lineTo(49, 59);
      c.lineTo(61, 47);
      c.lineTo(72, 66);
      c.lineTo(102, 78);
      c.moveTo(61, 47);
      c.lineTo(70, 24);
      c.moveTo(72, 66);
      c.lineTo(63, 96);
      c.stroke();
      this.rockSprites.set(key, sprite);
    }
    const c = this.ctx;
    c.save();
    c.translate(x, y);
    c.rotate(angle);
    c.drawImage(
      sprite,
      -radius * 1.1,
      -radius * 1.1,
      radius * 2.2,
      radius * 2.2,
    );
    c.restore();
    // The faceted silhouette is decorative; this outline is the collision radius.
    circle(c, x, y, radius, null, "#a4b6bc55");
  }
  satellite(x, y, radius, role, angle = 0, disabled = false) {
    const c = this.ctx,
      col = role === "collector" ? "#f2b866" : "#8de5e9";
    const texture = this.art.sprite(roleCell(role), radius);
    c.save();
    c.translate(x, y);
    c.rotate(angle);
    if (disabled) c.globalAlpha = 0.56;
    if (texture) c.drawImage(texture, -radius, -radius, radius * 2, radius * 2);
    else {
      circle(c, 0, 0, radius, "#142937", col, 1);
      circle(c, -radius * 0.2, -radius * 0.25, radius * 0.4, col + "aa");
    }
    circle(c, 0, 0, radius, null, col + "a0");
    c.strokeStyle = col;
    c.lineWidth = 1.5;
    c.beginPath();
    if (role === "collector") {
      // A diamond cage remains distinguishable at a seven-pixel body radius.
      const r = radius + 2.5;
      c.moveTo(r, 0);
      c.lineTo(0, r);
      c.lineTo(-r, 0);
      c.lineTo(0, -r);
      c.closePath();
    } else {
      c.arc(0, 0, radius + 2.5, -1.1, 1.1);
      c.moveTo(radius * 0.5, -radius);
      c.lineTo(radius * 0.75 + 3, -radius);
      c.moveTo(radius * 0.5, radius);
      c.lineTo(radius * 0.75 + 3, radius);
    }
    c.stroke();
    c.restore();
  }
  /**
   * Deep fields, in screen space: open space. Layers hashed from their cell, so the field has no edge and no
   * pre-rendered canvas: faint nebulae deepest, two parallax layers of stars, and fine dust locked to the world nearest.
   * Decoration only.
   */
  space(world, camera, rect) {
    const c = this.ctx, w = rect.width, h = rect.height, focus = camera.focus ?? { x: 0, y: 0 };
    c.fillStyle = "#03070f";
    c.fillRect(0, 0, w, h);
    if (!this.settings.decoration) return;
    const hash = (i, j, k) => {
      let n = (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791) ^ (world.seed | 0)) >>> 0;
      return () => { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return n / 4294967296; };
    };
    for (const [layer, depth, cell, count] of [[0, 0.08, 2600, 1], [1, 0.25, 420, 7], [2, 0.55, 520, 6], [3, 1, 300, 9]]) {
      const scale = camera.scale * (layer === 0 || layer === 3 ? 1 : 0.7 + depth), cx = focus.x * depth, cy = focus.y * depth;
      const halfW = w / (2 * scale), halfH = h / (2 * scale);
      for (let i = Math.floor((cx - halfW) / cell) - 1; i <= Math.floor((cx + halfW) / cell) + 1; i++)
        for (let j = Math.floor((cy - halfH) / cell) - 1; j <= Math.floor((cy + halfH) / cell) + 1; j++) {
          const rand = hash(i, j, layer);
          for (let n = 0; n < count; n++) {
            const ux = (i + rand()) * cell, uy = (j + rand()) * cell, sx = w / 2 + (ux - cx) * scale, sy = h / 2 + (uy - cy) * scale;
            if (layer === 0) {
              if (rand() > 0.42) continue;
              const r = (500 + rand() * 900) * scale, hue = ["#1b2a4a", "#2a1f44", "#123341", "#3a2130"][Math.floor(rand() * 4)];
              const g = c.createRadialGradient(sx, sy, 0, sx, sy, r);
              g.addColorStop(0, hue + "55");
              g.addColorStop(1, hue + "00");
              c.fillStyle = g;
              c.fillRect(sx - r, sy - r, r * 2, r * 2);
              continue;
            }
            if (sx < -4 || sy < -4 || sx > w + 4 || sy > h + 4) continue;
            const bright = rand();
            if (layer === 3) {
              // Fine dust: world-locked, so it streams past at the ship's own speed.
              c.globalAlpha = 0.12 + bright * 0.3;
              c.fillStyle = bright > 0.85 ? "#e8d8bc" : "#8a9aa8";
              c.fillRect(sx, sy, 1.1, 1.1);
              continue;
            }
            c.globalAlpha = 0.2 + bright * (layer === 2 ? 0.7 : 0.45);
            c.fillStyle = bright > 0.93 ? "#ffe9c4" : bright > 0.86 ? "#c8dcff" : "#c3d2dc";
            const size = layer === 2 && bright > 0.8 ? 2 : 1.2;
            c.fillRect(sx, sy, size, size);
          }
        }
    }
    c.globalAlpha = 1;
  }
  /**
   * Records each body's recent path (every 0.12 s of simulation, 50 points) for its fading trail. A new encounter, or
   * time running backwards (a retry of the same seed, a restore to an earlier checkpoint), starts every trail afresh.
   */
  trail(world) {
    const key = `${world.seed}|${world.encounterIndex}`, now = world.time || 0;
    if (this.trailKey !== key || now < (this.trailTime ?? 0)) { this.trails = new Map(); this.trailKey = key; }
    this.trailTime = now;
    for (const well of world.wells || []) {
      const t = this.trails.get(well.id) ?? [];
      if (!t.length || world.time - t.at(-1).time >= 0.12 || world.time < t.at(-1).time) t.push({ x: well.x, y: well.y, time: world.time });
      if (t.length > 50) t.shift();
      this.trails.set(well.id, t);
    }
  }
  /**
   * Deep fields: the regions of space (src/sim/regions.js), in world space under the bodies. Every region's edge and
   * name draw at every effects setting, because what a region does is tactical; its particles are decoration, drawn
   * by kind: a dust cloud's grains swirl, a storm's streaks run along its heading, a shear field sparks, a mire's fog
   * hangs. A halo is a disk of grains orbiting its body, densest at the surface and thinning as it is gathered.
   */
  regions(world, view, scale = 1) {
    const c = this.ctx, s = this.settings, t = s.motion ? world.encounterTime || 0 : 0;
    // Particles are sized in screen pixels (px world units each, from the camera's scale), so a grain stays visible at any zoom.
    const px = 1 / Math.max(1e-6, scale);
    for (const r of world.regions || []) {
      if (r.x + r.radius < view.left || r.x - r.radius > view.right || r.y + r.radius < view.top || r.y - r.radius > view.bottom) continue;
      const color = regionTint(r), kind = REGION_KINDS[r.kind];
      if (r.shape === "ring") {
        // A ring about the centre: both edges, culled by the view like everything else.
        c.save();
        c.setLineDash([18, 14]);
        circle(c, r.x, r.y, r.inner, null, color + "55", 1.6);
        circle(c, r.x, r.y, r.radius, null, color + "55", 1.6);
        c.restore();
      } else if (r.kind !== "halo") {
        if (s.decoration) {
          const g = c.createRadialGradient(r.x, r.y, r.inner ?? 0, r.x, r.y, r.radius);
          g.addColorStop(0, color + (r.kind === "mire" ? "30" : "1c"));
          g.addColorStop(1, color + "00");
          c.fillStyle = g;
          c.beginPath();
          c.arc(r.x, r.y, r.radius, 0, TAU);
          c.fill();
        }
        c.save();
        c.setLineDash(r.kind === "shear" || r.kind === "tidal" ? [4, 6] : [14, 10]);
        c.lineDashOffset = s.motion ? -t * (r.kind === "storm" || r.kind === "solar-storm" ? 40 : 8) : 0;
        circle(c, r.x, r.y, r.radius, null, color + "88", r.kind === "solar-storm" ? 3 : 1.6);
        c.restore();
        c.font = '600 22px "Segoe UI", system-ui, sans-serif';
        c.textAlign = "center";
        c.fillStyle = color + "cc";
        c.fillText(regionName(r).toUpperCase(), r.x, r.y - r.radius - 14);
      } else {
        // A halo's edge, faint and dotted at every setting: where gathering begins.
        c.save();
        c.setLineDash([2, 9]);
        circle(c, r.x, r.y, r.radius, null, color + "40", 1);
        c.restore();
      }
      if (!s.decoration) continue;
      const accreting = kind.accretes > 0, fill = accreting ? Math.max(0.2, Math.min(1, r.reserve / 40)) : 1;
      const count = Math.round(Math.min(r.kind === "halo" ? 340 : r.shape === "ring" ? 900 : 280, Math.max(40, r.radius / (r.kind === "halo" ? 2.2 : 4.5))) * fill);
      const inner = r.inner ?? 0, onScreen = (x, y) => x > view.left && x < view.right && y > view.top && y < view.bottom;
      c.fillStyle = color;
      c.strokeStyle = color;
      for (let i = 0; i < count; i++) {
        const rand = particle(r.id, i), a = rand(), b = rand(), d = rand();
        if (r.kind === "dust") {
          const rho = r.radius * Math.sqrt(a), theta = b * TAU + t * (0.04 + 0.12 * d) * (1 - rho / r.radius + 0.3);
          c.globalAlpha = 0.25 + 0.5 * d;
          c.fillRect(r.x + Math.cos(theta) * rho, r.y + Math.sin(theta) * rho, (1.5 + 2 * d) * px, (1.5 + 2 * d) * px);
        } else if (r.kind === "storm") {
          const speed = Math.hypot(r.vx, r.vy) || 1, ux = r.vx / speed, uy = r.vy / speed, along = ((a * 2 * r.radius + t * (260 + 420 * d)) % (2 * r.radius)) - r.radius;
          const across = (b * 2 - 1) * Math.sqrt(Math.max(0, r.radius * r.radius - along * along)), len = (10 + 22 * d) * px;
          const x = r.x + ux * along - uy * across, y = r.y + uy * along + ux * across;
          c.globalAlpha = 0.3 + 0.5 * d;
          c.lineWidth = (1 + d) * px;
          c.beginPath();
          c.moveTo(x, y);
          c.lineTo(x - ux * len, y - uy * len);
          c.stroke();
        } else if (r.kind === "shear") {
          const flick = particle(r.id, i * 31 + Math.floor(t * 10))(), rho = r.radius * Math.sqrt(a), theta = b * TAU;
          if (flick > 0.55) continue;
          const x = r.x + Math.cos(theta) * rho, y = r.y + Math.sin(theta) * rho, ang = flick * TAU * 3, len = (5 + 9 * d) * px;
          c.globalAlpha = 0.45 + 0.5 * d;
          c.lineWidth = 1.4 * px;
          c.beginPath();
          c.moveTo(x, y);
          c.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
          c.stroke();
        } else if (r.kind === "mire") {
          if (i > 22) break;
          const rho = r.radius * 0.8 * Math.sqrt(a), theta = b * TAU + t * 0.03, size = r.radius * (0.18 + 0.2 * d);
          const x = r.x + Math.cos(theta) * rho, y = r.y + Math.sin(theta) * rho, g = c.createRadialGradient(x, y, 0, x, y, size);
          g.addColorStop(0, color + "26");
          g.addColorStop(1, color + "00");
          c.globalAlpha = 1;
          c.fillStyle = g;
          c.fillRect(x - size, y - size, size * 2, size * 2);
          c.fillStyle = color;
        } else if (r.kind === "heat") {
          // Embers rising off the star's surface and fading as they climb.
          const rise = (a + t * (0.05 + 0.1 * d)) % 1, rho = inner + (r.radius - inner) * rise, theta = b * TAU;
          c.globalAlpha = 0.6 * (1 - rise);
          c.fillRect(r.x + Math.cos(theta) * rho, r.y + Math.sin(theta) * rho, (1.6 + 2 * d) * px, (1.6 + 2 * d) * px);
        } else if (r.kind === "radiation") {
          // Hard sparks flickering in and out, densest near the horizon.
          const flick = particle(r.id, i * 17 + Math.floor(t * 14))(), rho = inner + (r.radius - inner) * a * a, theta = b * TAU;
          if (flick > 0.5) continue;
          c.globalAlpha = 0.35 + 0.55 * d;
          c.fillRect(r.x + Math.cos(theta) * rho, r.y + Math.sin(theta) * rho, 2 * px, 2 * px);
        } else if (r.kind === "tidal") {
          // Grains drawn out radially: what crosses the Roche limit is stretched toward the body.
          if (i > 90) break;
          const rho = inner + (r.radius - inner) * a, theta = b * TAU + t * 0.08, len = (8 + 26 * (1 - a)) * px;
          const ux = Math.cos(theta), uy = Math.sin(theta), x = r.x + ux * rho, y = r.y + uy * rho;
          c.globalAlpha = 0.25 + 0.4 * d;
          c.lineWidth = 1.2 * px;
          c.beginPath();
          c.moveTo(x, y);
          c.lineTo(x - ux * len, y - uy * len);
          c.stroke();
        } else if (r.kind === "cold" || r.kind === "kuiper") {
          // Ice crystals drifting slowly; the Kuiper belt's along its whole ring.
          const rho = r.shape === "ring" ? inner + (r.radius - inner) * a : r.radius * Math.sqrt(a), theta = b * TAU + t * 0.004 * (1 + d);
          const x = r.x + Math.cos(theta) * rho, y = r.y + Math.sin(theta) * rho;
          if (!onScreen(x, y)) continue;
          c.globalAlpha = 0.25 + 0.45 * d;
          c.fillRect(x, y, (1.2 + 1.8 * d) * px, (1.2 + 1.8 * d) * px);
        } else if (r.kind === "nebula") {
          // Vast, soft folds of gas, slowly turning.
          if (i > 26) break;
          const rho = r.radius * 0.75 * Math.sqrt(a), theta = b * TAU + t * 0.01, size = r.radius * (0.22 + 0.25 * d);
          const x = r.x + Math.cos(theta) * rho, y = r.y + Math.sin(theta) * rho, g = c.createRadialGradient(x, y, 0, x, y, size);
          g.addColorStop(0, color + "22");
          g.addColorStop(1, color + "00");
          c.globalAlpha = 1;
          c.fillStyle = g;
          c.fillRect(x - size, y - size, size * 2, size * 2);
          c.fillStyle = color;
        } else if (r.kind === "solar-storm") {
          // The front: streaks running outward along its heading, densest at the leading edge.
          const speed = Math.hypot(r.vx, r.vy) || 1, ux = r.vx / speed, uy = r.vy / speed, theta = (b - 0.5) * 2.2;
          const rho = r.radius * (0.55 + 0.45 * Math.sqrt(a)), hx = ux * Math.cos(theta) - uy * Math.sin(theta), hy = uy * Math.cos(theta) + ux * Math.sin(theta);
          const x = r.x + hx * rho, y = r.y + hy * rho, len = (14 + 30 * d) * px;
          c.globalAlpha = 0.35 + 0.5 * d;
          c.lineWidth = (1.2 + d) * px;
          c.beginPath();
          c.moveTo(x, y);
          c.lineTo(x - hx * len, y - hy * len);
          c.stroke();
        } else {
          // Halo: grains on prograde orbits, crowding toward the surface, each at its own circular speed.
          const rho = r.inner + (r.radius - r.inner) * a * a, v = Math.sqrt((r.mass || 0) * rho / (rho * rho + (r.soft || 0) ** 2));
          const theta = b * TAU + t * (v / rho) * 0.35;
          c.globalAlpha = 0.2 + 0.6 * (1 - a) * (0.5 + 0.5 * d);
          const size = (1.3 + 2.4 * d * (1 - a)) * px;
          c.fillRect(r.x + Math.cos(theta) * rho - size / 2, r.y + Math.sin(theta) * rho - size / 2, size, size);
        }
      }
      c.globalAlpha = 1;
    }
  }
  /**
   * Deep fields: each body, drawn by kind, with its trail and its pull. Two contours mark where its pull reaches 120
   * and 40 units/s²; the rim at the exact core (src/sim/field.js collideWell, a black hole's horizon) and a giant's
   * atmosphere, where drag applies, draw at every effects setting because they are tactical.
   */
  wells(world) {
    const c = this.ctx, s = this.settings, t = s.motion ? world.time || 0 : 0;
    this.trail(world);
    const tint = { star: "#ffcf7a", "black-hole": "#ff9a5c", giant: "#c4a8ff", rocky: "#8fd3c8", moon: "#aab6c4" };
    for (const well of world.wells || []) {
      const points = this.trails.get(well.id) ?? [], color = tint[well.kind] ?? "#c4b2ff";
      if (points.length > 1) {
        c.lineWidth = Math.max(1, Math.min(4, well.core / 40));
        for (let i = 1; i < points.length; i++) {
          c.strokeStyle = color + Math.round((i / points.length) * 60).toString(16).padStart(2, "0");
          c.beginPath();
          c.moveTo(points[i - 1].x, points[i - 1].y);
          c.lineTo(points[i].x, points[i].y);
          c.stroke();
        }
      }
      c.save();
      c.setLineDash([3, 10]);
      for (const [a, alpha] of [[120, "40"], [40, "22"]]) {
        const r = influenceRadius(world, well, a);
        if (r > well.core * 1.3) circle(c, well.x, well.y, r, null, color + alpha, 1.2);
      }
      c.restore();
      const kind = bodyKind(well), r = well.core;
      // The point of no return, tactical at every setting: inside it this body pulls harder than the ship's drive can
      // push, so the ring exists only around bodies that can hold the ship in its current form, and goes when it outgrows them.
      const noReturn = world.player ? escapeRadius(world, well, fullThrust(world, world.player)) : 0;
      if (noReturn > r) {
        c.save();
        c.setLineDash([10, 7]);
        c.lineDashOffset = s.motion ? -t * 14 : 0;
        circle(c, well.x, well.y, noReturn, s.decoration ? "#ff3b3010" : null, "#ff5a4ad0", 2.2);
        c.restore();
      }
      // The event horizon, tactical at every setting: a solid ring inside which nothing escapes, darkening inward.
      if (kind.horizon) {
        const h = horizonRadius(well);
        if (s.decoration) {
          const g = c.createRadialGradient(well.x, well.y, r, well.x, well.y, h);
          g.addColorStop(0, "#000000aa");
          g.addColorStop(1, "#00000000");
          c.fillStyle = g;
          circle(c, well.x, well.y, h, g);
        }
        circle(c, well.x, well.y, h, null, "#ff2a55e0", 2.6);
        c.font = '700 20px "Segoe UI", system-ui, sans-serif';
        c.textAlign = "center";
        c.fillStyle = "#ff2a55cc";
        c.fillText("HORIZON", well.x, well.y - h - 10);
      }
      // A star about to throw a solar storm brightens for its warning.
      if (well.stormIn !== undefined && well.stormIn < (fieldOf(world).physics.solarStorms?.warn ?? 0)) {
        const k = 1 - well.stormIn / fieldOf(world).physics.solarStorms.warn, pulse = s.motion ? 0.6 + 0.4 * Math.sin(t * 12) : 1;
        circle(c, well.x, well.y, r * (1.15 + 0.5 * k), null, `rgba(255, 196, 92, ${0.3 + 0.6 * k * pulse})`, 3 + 4 * k);
      }
      // The flare gauge, tactical at every setting: an arc at the flare's launch radius filling with what the body
      // holds, brightening toward its threshold, so the player can see where and roughly when matter will come back out.
      if (kind.flare && well.held > 0) {
        const fill = Math.min(1, well.held / kind.flare.at), pulse = s.motion && fill > 0.8 ? 0.5 + 0.5 * Math.sin(t * 9) : 1;
        c.save();
        c.lineCap = "round";
        c.globalAlpha = 0.3 + 0.6 * fill * pulse;
        c.strokeStyle = well.kind === "black-hole" ? "#ffd59a" : color;
        c.lineWidth = 2 + fill * 2;
        c.beginPath();
        c.arc(well.x, well.y, r * kind.flare.launch, -Math.PI / 2, -Math.PI / 2 + fill * TAU);
        c.stroke();
        c.restore();
      }
      if (well.kind === "star") {
        if (s.decoration) {
          const corona = c.createRadialGradient(well.x, well.y, r * 0.8, well.x, well.y, r * 3.2);
          corona.addColorStop(0, "#ffd58a90");
          corona.addColorStop(0.4, "#ff9d4a30");
          corona.addColorStop(1, "#ff7a3000");
          c.fillStyle = corona;
          c.beginPath();
          c.arc(well.x, well.y, r * 3.2, 0, TAU);
          c.fill();
        }
        const disk = c.createRadialGradient(well.x - r * 0.2, well.y - r * 0.2, r * 0.1, well.x, well.y, r);
        disk.addColorStop(0, "#fffbe8");
        disk.addColorStop(0.55, "#ffd27a");
        disk.addColorStop(1, "#f0803a");
        circle(c, well.x, well.y, r, disk, "#ffe4b0", 2);
      } else if (well.kind === "black-hole") {
        if (s.decoration) {
          c.save();
          c.translate(well.x, well.y);
          c.rotate(-0.35);
          for (let i = 0; i < 4; i++) {
            c.strokeStyle = ["#ffb46a70", "#ff8a4a55", "#ffd59a40", "#ff6a3a30"][i];
            c.lineWidth = r * (0.28 - i * 0.04);
            c.beginPath();
            c.ellipse(0, 0, r * (2.1 + i * 0.55), r * (0.62 + i * 0.16), t * (0.6 - i * 0.1), 0, TAU);
            c.stroke();
          }
          c.restore();
          const lens = c.createRadialGradient(well.x, well.y, r, well.x, well.y, r * 2.4);
          lens.addColorStop(0, "#ffffff22");
          lens.addColorStop(1, "#ffffff00");
          c.fillStyle = lens;
          c.beginPath();
          c.arc(well.x, well.y, r * 2.4, 0, TAU);
          c.fill();
        }
        circle(c, well.x, well.y, r * 1.18, null, "#fff1d6", 2);
        circle(c, well.x, well.y, r, "#000000", "#ff9a5c", 1.5);
      } else {
        if (kind.atmosphere) {
          c.save();
          c.setLineDash([6, 8]);
          circle(c, well.x, well.y, r * kind.atmosphere, s.decoration ? color + "10" : null, color + "70", 1.5);
          c.restore();
        }
        const body = c.createRadialGradient(well.x - r * 0.35, well.y - r * 0.4, r * 0.1, well.x, well.y, r);
        const shades = { giant: ["#7d6ab8", "#3a2d66", "#120d26"], rocky: ["#7fb3a8", "#2c5552", "#0a1a1c"], moon: ["#a7b0bb", "#4a5562", "#121820"] }[well.kind] ?? ["#2c2650", "#120f26", "#06050f"];
        body.addColorStop(0, shades[0]);
        body.addColorStop(0.7, shades[1]);
        body.addColorStop(1, shades[2]);
        circle(c, well.x, well.y, r, body, color, 2);
        if (s.decoration && well.kind === "giant") {
          c.save();
          c.beginPath();
          c.arc(well.x, well.y, r, 0, TAU);
          c.clip();
          c.translate(well.x, well.y);
          c.rotate(-0.25);
          for (let i = -r; i < r; i += r / 4.5) {
            c.fillStyle = Math.round(i / (r / 4.5)) % 2 ? "#d9c8ff14" : "#0b071a2a";
            c.fillRect(-r, i, r * 2, r / 9);
          }
          c.restore();
        }
      }
    }
  }
  /** Deep fields: the comet that carries the stream, with a tail away from the nearest star while it still holds matter. */
  comet(world) {
    const k = world.stream, c = this.ctx;
    if (!k || k.vx === undefined) return;
    const star = (world.wells || []).filter((x) => x.kind === "star").sort((a, b) => Math.hypot(a.x - k.x, a.y - k.y) - Math.hypot(b.x - k.x, b.y - k.y))[0];
    const away = star ? Math.atan2(k.y - star.y, k.x - star.x) : Math.atan2(-k.vy, -k.vx), full = k.remainingBudget > 0;
    if (this.settings.decoration && full) {
      const tail = c.createLinearGradient(k.x, k.y, k.x + Math.cos(away) * 520, k.y + Math.sin(away) * 520);
      tail.addColorStop(0, "#f2b86688");
      tail.addColorStop(1, "#f2b86600");
      c.fillStyle = tail;
      c.beginPath();
      c.moveTo(k.x + Math.cos(away + Math.PI / 2) * 18, k.y + Math.sin(away + Math.PI / 2) * 18);
      c.lineTo(k.x + Math.cos(away) * 520, k.y + Math.sin(away) * 520);
      c.lineTo(k.x + Math.cos(away - Math.PI / 2) * 18, k.y + Math.sin(away - Math.PI / 2) * 18);
      c.fill();
    }
    circle(c, k.x, k.y, k.radius ?? 26, full ? "#f6dcae" : "#8a8f96", full ? "#f2b866" : "#6a7480", 2);
    c.font = '10px "Segoe UI", system-ui, sans-serif';
    c.textAlign = "center";
    c.fillStyle = "#cdb483";
    if (full) c.fillText("COMET · MATTER", k.x, k.y - (k.radius ?? 26) - 10);
  }
  /**
   * Deep fields: where the player coasts with no thrust over the next 3 s, the bodies moving as they will. The guide
   * strengthens with every body pulling on the player (src/sim/field.js influence), and ends in a reticle, or a
   * warning mark when the drift meets a core.
   */
  coastGuide(world) {
    const p = world.player, c = this.ctx;
    if (Math.hypot(p.vx || 0, p.vy || 0) < 25) return;
    // The prediction steps every body for 3 s, so it is recomputed at most 15 times a second; between, the cached path
    // rides along with the ship. Another world or encounter, or a rewound clock, recomputes at once.
    const now = world.time || 0, key = `${world.seed}:${world.encounterIndex}`, cached = this.coastCache;
    if (!cached || cached.key !== key || now < cached.time || now - cached.time >= 1 / 15) this.coastCache = { key, time: now, x: p.x, y: p.y, ...predictCoast(world) };
    const { struck, x: ox, y: oy } = this.coastCache, path = this.coastCache.path.map(q => ({ x: q.x + p.x - ox, y: q.y + p.y - oy }));
    const { count } = influence(world, p.x, p.y);
    if (path.length < 2) return;
    const strength = Math.min(1, count / 4), alpha = Math.round((0.62 + strength * 0.38) * 255).toString(16).padStart(2, "0");
    const color = struck ? "#f3a27e" : `#d8f1f4`;
    c.save();
    c.setLineDash([8, 6]);
    c.lineWidth = 2 + strength * 2.5;
    c.strokeStyle = color + alpha;
    c.beginPath();
    c.moveTo(p.x, p.y);
    for (const q of path) c.lineTo(q.x, q.y);
    c.stroke();
    c.setLineDash([]);
    const end = path.at(-1), size = 10 + strength * 10;
    c.strokeStyle = color + alpha;
    c.lineWidth = 2 + strength;
    if (struck) {
      c.beginPath();
      c.moveTo(end.x - size, end.y - size);
      c.lineTo(end.x + size, end.y + size);
      c.moveTo(end.x + size, end.y - size);
      c.lineTo(end.x - size, end.y + size);
      c.stroke();
    } else {
      circle(c, end.x, end.y, size, null, color + alpha, 2 + strength);
      c.beginPath();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        c.moveTo(end.x + dx * size * 0.5, end.y + dy * size * 0.5);
        c.lineTo(end.x + dx * size * 1.5, end.y + dy * size * 1.5);
      }
      c.stroke();
    }
    c.restore();
  }
  /** Deep fields: the ship's heading and its engine, so the slow turn and spool are visible. */
  /**
   * Deep fields: what the ship's traits make it (src/sim/traits.js), read from its modifiers, never its trait ids. A
   * rim tinted by the element it is mostly made of; a doubled outline when it is armoured; a ring when its reach is
   * wide; its radiation as a glow out to the radiation's reach, edged at every effects setting since it is gameplay;
   * and with life, a green shimmer and every radiating body's habitable band.
   */
  traitLook(world) {
    const p = world.player, mods = p.mods, c = this.ctx, s = this.settings, t = s.motion ? world.time || 0 : 0;
    if (!mods || !p.elements) return;
    const total = ELEMENTS.reduce((n, e) => n + (p.elements[e] || 0), 0);
    if (total > 0) {
      const top = ELEMENTS.reduce((a, e) => ((p.elements[e] || 0) > (p.elements[a] || 0) ? e : a), ELEMENTS[0]);
      c.globalAlpha = 0.35 + 0.5 * ((p.elements[top] || 0) / total);
      circle(c, p.x, p.y, p.radius + 2, null, ELEMENT_COLOURS[top], 2);
      c.globalAlpha = 1;
    }
    if (mods.toughness >= 1.3) circle(c, p.x, p.y, p.radius + 5, null, "#c9d3dc88", 1.5);
    if (mods.reach >= 16) {
      c.save();
      c.translate(p.x, p.y);
      c.rotate(-0.35);
      c.strokeStyle = "#d8c9a466";
      c.lineWidth = 2;
      c.beginPath();
      c.ellipse(0, 0, p.radius + 9 + mods.reach, (p.radius + 9 + mods.reach) * 0.32, 0, 0, TAU);
      c.stroke();
      c.restore();
    }
    if (mods.aura > 0) {
      const reach = p.radius + mods.auraReach, pulse = 0.85 + 0.15 * Math.sin(t * 3);
      if (s.decoration) {
        const g = c.createRadialGradient(p.x, p.y, p.radius, p.x, p.y, reach * pulse);
        g.addColorStop(0, "#b6ff5a40");
        g.addColorStop(1, "#b6ff5a00");
        circle(c, p.x, p.y, reach * pulse, g);
      }
      c.setLineDash([3, 9]);
      circle(c, p.x, p.y, reach, null, "#b6ff5a66", 1);
      c.setLineDash([]);
    }
    if (mods.life > 0) {
      circle(c, p.x, p.y, p.radius + 3.5, null, `rgba(126, 224, 138, ${0.4 + 0.25 * Math.sin(t * 2)})`, 1.5);
      c.setLineDash([2, 14]);
      for (const well of world.wells || []) {
        if (!bodyKind(well).radiation) continue;
        circle(c, well.x, well.y, well.core * HABITABLE.inner, null, "#7ee08a44", 1.5);
        circle(c, well.x, well.y, well.core * HABITABLE.outer, null, "#7ee08a44", 1.5);
      }
      c.setLineDash([]);
    }
  }
  ship(world) {
    const p = world.player, c = this.ctx;
    if (!Number.isFinite(p.heading)) return;
    const hx = Math.cos(p.heading), hy = Math.sin(p.heading), r = p.radius;
    c.save();
    c.strokeStyle = "#e6f6f8";
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(p.x + hx * (r + 16), p.y + hy * (r + 16));
    c.lineTo(p.x + hx * (r + 6) - hy * 6, p.y + hy * (r + 6) + hx * 6);
    c.moveTo(p.x + hx * (r + 16), p.y + hy * (r + 16));
    c.lineTo(p.x + hx * (r + 6) + hy * 6, p.y + hy * (r + 6) - hx * 6);
    c.stroke();
    const flame = (p.throttle || 0) * (r * 1.6);
    if (flame > 1) {
      c.fillStyle = "#f2b866a0";
      c.beginPath();
      c.moveTo(p.x - hx * r - hy * r * 0.35, p.y - hy * r + hx * r * 0.35);
      c.lineTo(p.x - hx * (r + flame), p.y - hy * (r + flame));
      c.lineTo(p.x - hx * r + hy * r * 0.35, p.y - hy * r - hx * r * 0.35);
      c.fill();
    }
    c.restore();
  }
  /**
   * Marks what the player has seen this encounter: the cells of the field the view has covered, and the bodies in it.
   * A new encounter, or time running backwards (a retry of the same seed, an earlier checkpoint), uncharts it all again.
   */
  chart(world, view) {
    const key = `${world.seed}|${world.encounterIndex}|${world.field}`, cell = 600, now = world.time || 0;
    if (this.fog?.key !== key || now < this.fog.time) this.fog = { key, cells: new Set(), charted: new Set() };
    this.fog.time = now;
    const margin = 300;
    for (let i = Math.floor((view.left - margin) / cell); i <= Math.floor((view.right + margin) / cell); i++)
      for (let j = Math.floor((view.top - margin) / cell); j <= Math.floor((view.bottom + margin) / cell); j++) this.fog.cells.add(`${i},${j}`);
    for (const well of world.wells || [])
      if (well.kind === "star" || (well.x + well.core > view.left - margin && well.x - well.core < view.right + margin && well.y + well.core > view.top - margin && well.y - well.core < view.bottom + margin))
        this.fog.charted.add(well.id);
    for (const r of world.regions || [])
      if (r.x + r.radius > view.left - margin && r.x - r.radius < view.right + margin && r.y + r.radius > view.top - margin && r.y - r.radius < view.bottom + margin)
        this.fog.charted.add(r.id);
  }
  /**
   * Deep fields, in screen space (CSS pixels): edge markers for live enemies within sensor range but out of view
   * (larger, ringed and marked "!" while they telegraph or commit) and for the active gate, a transit beacon at any
   * range; then the field map.
   */
  overlay(world, camera, rect) {
    const c = this.ctx, view = camera.visible(), w = rect.width, h = rect.height, p = world.player;
    const sensor = fieldOf(world).physics.sensor;
    const toScreen = (x, y) => [camera.x + x * camera.scale, camera.y + y * camera.scale];
    const edge = (x, y, color, threat, label) => {
      if (x >= view.left && x <= view.right && y >= view.top && y <= view.bottom) return;
      const [sx, sy] = toScreen(x, y), cx = w / 2, cy = h / 2, a = Math.atan2(sy - cy, sx - cx), inset = threat ? 34 : 26;
      const k = Math.min((w / 2 - inset) / Math.max(1e-6, Math.abs(Math.cos(a))), (h / 2 - inset) / Math.max(1e-6, Math.abs(Math.sin(a))));
      const ex = cx + Math.cos(a) * k, ey = cy + Math.sin(a) * k, size = threat ? 13 : 9;
      c.save();
      c.translate(ex, ey);
      c.rotate(a);
      c.fillStyle = color;
      c.beginPath();
      c.moveTo(size, 0);
      c.lineTo(-size * 0.7, -size * 0.75);
      c.lineTo(-size * 0.7, size * 0.75);
      c.closePath();
      c.fill();
      if (threat) circle(c, 0, 0, size + 6, null, color, 2);
      c.restore();
      if (label) {
        c.font = '10px "Segoe UI", system-ui, sans-serif';
        c.textAlign = "center";
        c.fillStyle = color;
        c.fillText(label, ex - Math.cos(a) * 22, ey - Math.sin(a) * 22 + 3);
      }
    };
    for (const e of world.enemies || []) {
      if (e.alive === false || e.hp <= 0 || Math.hypot(e.x - p.x, e.y - p.y) > sensor) continue;
      const threat = e.state === "telegraph" || e.state === "commit";
      edge(e.x, e.y, enemyLook(world, e.type).look.color, threat, threat ? "!" : "");
    }
    for (const rock of world.rocks || []) if (rock.comet && rock.alive !== false && rock.hp > 0 && Math.hypot(rock.x - p.x, rock.y - p.y) <= sensor) edge(rock.x, rock.y, "#e8fbff", true, "*");
    const gate = (world.gates || []).find((g) => g.active && !g.passed);
    if (gate) edge(gate.x, gate.y, "#b8f0e8", false, ["I", "II", "III"][gate.index] || "");
    const inside = regionsAt(world.regions, p);
    if (inside.length) {
      const [sx, sy] = toScreen(p.x, p.y), lines = inside.slice(0, 2).map(({ region: r }) => {
        const what = regionName(r);
        const doing = REGION_KINDS[r.kind].shear ? "grinding" : REGION_KINDS[r.kind].accretes ? (r.reserve > 0 ? "gathering" : "spent") : "dragging";
        return { text: `${what} \u00b7 ${doing}`, color: regionTint(r) };
      });
      const falter = regionThrust(world.regions, p);
      if (falter < 0.99) lines.push({ text: `thrust ${Math.round(falter * 100)}%`, color: "#c9b8ff" });
      c.font = '11px "Segoe UI", system-ui, sans-serif';
      c.textAlign = "center";
      lines.forEach((l, i) => { c.fillStyle = l.color; c.fillText(l.text, sx, sy + p.radius * camera.scale + 26 + i * 13); });
    }
    this.chart(world, view);
    this.fieldMap(world, view, rect);
  }
  /**
   * The field map, under fog of war: only the cells the view has covered are lit; a body appears once it has been seen
   * (a star always, by its light); enemies, ore, matter and the comet show only within sensor range; the active gate is
   * a beacon at any range. The faint ring is where the tide begins.
   */
  fieldMap(world, view, rect) {
    const c = this.ctx, field = fieldOf(world), { width, height } = world.arena, p = world.player, sensor = field.physics.sensor;
    const mw = Math.min(220, Math.max(150, rect.width * 0.17)), k = mw / width, mh = height * k;
    // Bottom right, above the command card the HUD keeps in the corner.
    const x0 = rect.width - mw - 26, y0 = Math.max(110, rect.height - mh - 66);
    const clampX = (x) => Math.max(x0 + 2, Math.min(x0 + mw - 2, x)), clampY = (y) => Math.max(y0 + 2, Math.min(y0 + mh - 2, y));
    const at = (x, y) => [clampX(x0 + x * k), clampY(y0 + y * k)];
    const veils = (world.regions || []).filter((r) => REGION_KINDS[r.kind]?.veil && !weight(r, p));
    const near = (b) => Math.hypot(b.x - p.x, b.y - p.y) <= sensor && !veils.some((r) => weight(r, b) > 0);
    c.save();
    c.fillStyle = "#03080fe6";
    c.fillRect(x0 - 1, y0 - 1, mw + 2, mh + 2);
    c.beginPath();
    c.rect(x0, y0, mw, mh);
    c.clip();
    const cell = 600;
    c.fillStyle = "#11263a";
    for (const id of this.fog?.cells ?? []) {
      const [i, j] = id.split(",").map(Number);
      c.fillRect(x0 + i * cell * k, y0 + j * cell * k, cell * k + 0.5, cell * k + 0.5);
    }
    c.save();
    c.setLineDash([2, 4]);
    circle(c, x0 + field.centre.x * k, y0 + field.centre.y * k, field.physics.halo.radius * k, null, "#5d7f8f55", 1);
    circle(c, x0 + p.x * k, y0 + p.y * k, sensor * k, null, "#8de5e922", 1);
    c.restore();
    for (const r of world.regions || []) {
      if (r.well || !(r.shape === "ring" || this.fog?.charted.has(r.id) || near(r))) continue;
      const color = regionTint(r);
      if (r.shape === "ring") { circle(c, x0 + r.x * k, y0 + r.y * k, r.inner * k, null, color + "55", 1); circle(c, x0 + r.x * k, y0 + r.y * k, r.radius * k, null, color + "55", 1); continue; }
      circle(c, x0 + r.x * k, y0 + r.y * k, Math.max(2, r.radius * k), color + "2a", color + "88", 1);
    }
    const tint = { star: "#ffcf7a", "black-hole": "#ff9a5c", giant: "#c4a8ff", rocky: "#8fd3c8", moon: "#aab6c4" };
    for (const well of world.wells || []) {
      if (!this.fog?.charted.has(well.id)) continue;
      const [x, y] = at(well.x, well.y);
      circle(c, x, y, Math.max(well.kind === "moon" ? 1.2 : 2, well.core * k * 1.4), well.kind === "black-hole" ? "#000000" : tint[well.kind], tint[well.kind], 1);
    }
    for (const g of world.gates || []) {
      if (g.passed || (!g.active && !near(g))) continue;
      const [x, y] = at(g.x, g.y);
      circle(c, x, y, g.active ? 3.5 : 2.5, null, g.active ? "#b8f0e8" : "#618b9e", g.active ? 1.5 : 1);
    }
    c.fillStyle = "#9db0b4";
    for (const r of world.rocks || []) if (r.alive !== false && r.hp > 0 && near(r)) { const [x, y] = at(r.x, r.y); c.fillRect(x - 1, y - 1, 2, 2); }
    c.fillStyle = "#f2b866";
    for (const q of world.pickups || []) if (near(q)) { const [x, y] = at(q.x, q.y); c.fillRect(x - 0.75, y - 0.75, 1.5, 1.5); }
    if (world.stream?.vx !== undefined && near(world.stream)) { const [x, y] = at(world.stream.x, world.stream.y); circle(c, x, y, 2, "#f6dcae"); }
    for (const e of world.enemies || []) {
      if (e.alive === false || e.hp <= 0 || !near(e)) continue;
      const [x, y] = at(e.x, e.y), color = enemyLook(world, e.type).look.color;
      circle(c, x, y, 2.4, color);
      if (e.state === "telegraph" || e.state === "commit") circle(c, x, y, 5, null, color, 1);
    }
    const [px, py] = at(p.x, p.y), { identity } = playerLook(world);
    circle(c, px, py, 3, identity.look.color, "#ffffff", 1);
    c.strokeStyle = identity.look.color;
    c.beginPath();
    c.moveTo(px, py);
    c.lineTo(px + (p.vx || 0) * k * 2, py + (p.vy || 0) * k * 2);
    c.stroke();
    c.strokeStyle = "#cfe9ee66";
    c.strokeRect(x0 + view.left * k, y0 + view.top * k, (view.right - view.left) * k, (view.bottom - view.top) * k);
    c.restore();
    c.strokeStyle = "#5d7f8f88";
    c.lineWidth = 1;
    c.strokeRect(x0 - 0.5, y0 - 0.5, mw + 1, mh + 1);
  }
  matter(pickup) {
    const c = this.ctx,
      s = this.settings;
    const size = Math.min(8, 4.5 + pickup.value * 0.22);
    const vx = (pickup.vx || 0) + (pickup.driftX || 0),
      vy = (pickup.vy || 0) + (pickup.driftY || 0);
    const texture = this.art.sprite(ATLAS.matter, size, false);
    this.wake(pickup.x, pickup.y, vx, vy, size, "#f2b866", 0.8);
    c.save();
    c.translate(pickup.x, pickup.y);
    c.rotate(pickup.source === "stream" ? Math.atan2(vy, vx) : 0.18);
    if (s.decoration) {
      circle(c, 0, 0, size + 4, "#f2b86609");
      circle(c, 0, 0, size + 2, null, "#f2b86622");
    }
    if (texture) c.drawImage(texture, -size, -size, size * 2, size * 2);
    else {
      c.fillStyle = "#f2b866";
      c.beginPath();
      c.moveTo(size, 0);
      c.lineTo(0, size * 0.7);
      c.lineTo(-size, 0);
      c.lineTo(0, -size * 0.7);
      c.closePath();
      c.fill();
      c.fillStyle = "#fff0c6";
      c.beginPath();
      c.moveTo(0, -size * 0.7);
      c.lineTo(0, 0);
      c.lineTo(-size, 0);
      c.closePath();
      c.fill();
    }
    if (pickup.source === "cache") {
      c.strokeStyle = "#f9df9a";
      c.lineWidth = 1;
      c.strokeRect(-size - 3, -size - 3, size * 2 + 6, size * 2 + 6);
    }
    c.restore();
  }
  environment(world) {
    const c = this.ctx,
      s = this.settings,
      current = world.current;
    const stream = world.stream;
    if (fieldOf(world).physics) this.comet(world);
    else if (stream && stream.remainingBudget > 0) {
      c.save();
      c.fillStyle = "#f2b86606";
      c.fillRect(stream.x, stream.y, stream.width, stream.height);
      c.strokeStyle = "#f2b86638";
      c.lineWidth = 1;
      c.setLineDash([2, 14]);
      c.beginPath();
      c.moveTo(stream.x, stream.y + stream.height / 2);
      c.lineTo(stream.x + stream.width, stream.y + stream.height / 2);
      c.stroke();
      c.setLineDash([]);
      c.lineWidth = 1;
      const drift = s.decoration && s.motion ? (world.time * 24) % 90 : 0;
      for (let i = 0; i < 12; i++) {
        const px =
          stream.x + 15 + ((i * 90 + drift * stream.direction + 1080) % 1080);
        const py = stream.y + stream.height / 2;
        c.strokeStyle = "#f2b86635";
        c.beginPath();
        c.moveTo(px - 4 * stream.direction, py - 4);
        c.lineTo(px + 3 * stream.direction, py);
        c.lineTo(px - 4 * stream.direction, py + 4);
        c.stroke();
      }
      // Paired tick marks separate the travelling resource lane from threats.
      for (const py of [stream.y, stream.y + stream.height]) {
        c.strokeStyle = "#c3a66d26";
        c.beginPath();
        c.moveTo(stream.x, py);
        c.lineTo(stream.x + 36, py);
        c.moveTo(stream.x + stream.width - 36, py);
        c.lineTo(stream.x + stream.width, py);
        c.stroke();
      }
      c.font = '10px "Segoe UI", system-ui, sans-serif';
      c.textAlign = stream.direction < 0 ? "right" : "left";
      c.fillStyle = "#cdb483";
      c.fillText(
        stream.direction < 0 ? "‹ STREAM" : "STREAM ›",
        stream.direction < 0 ? stream.x + stream.width - 10 : stream.x + 10,
        stream.y - 7,
      );
      c.restore();
    }
    if (current?.active) {
      // This is the simulation's exact force rectangle, not a cosmetic lane.
      c.save();
      const fill = c.createLinearGradient(
        current.x,
        current.y,
        current.x + current.width,
        current.y + current.height,
      );
      fill.addColorStop(0, "#6cd6da08");
      fill.addColorStop(0.5, "#8de5e91a");
      fill.addColorStop(1, "#6cd6da08");
      c.fillStyle = fill;
      c.fillRect(current.x, current.y, current.width, current.height);
      c.strokeStyle = "#8de5e95f";
      c.lineWidth = 1;
      c.setLineDash([4, 8]);
      c.strokeRect(current.x, current.y, current.width, current.height);
      c.setLineDash([]);
      c.strokeStyle = "#a2f0e8a0";
      c.lineWidth = 1.5;
      for (const [x, dx] of [
        [current.x, 1],
        [current.x + current.width, -1],
      ]) {
        for (const [y, dy] of [
          [current.y, 1],
          [current.y + current.height, -1],
        ]) {
          c.beginPath();
          c.moveTo(x + dx * 14, y);
          c.lineTo(x, y);
          c.lineTo(x, y + dy * 14);
          c.stroke();
        }
      }
      c.beginPath();
      c.rect(current.x, current.y, current.width, current.height);
      c.clip();
      const angle = Math.atan2(current.forceY, current.forceX),
        ux = Math.cos(angle),
        uy = Math.sin(angle),
        phase = s.motion && s.decoration ? (world.time * 32) % 100 : 0;
      c.strokeStyle = "#8bced166";
      c.lineWidth = 1.4;
      for (let x = -100; x < current.width + 100; x += 100) {
        for (let y = -70; y < current.height + 70; y += 70) {
          c.save();
          c.translate(
            current.x + x + ux * phase + 28,
            current.y + y + uy * phase + 35,
          );
          c.rotate(angle);
          c.beginPath();
          c.moveTo(-8, -5);
          c.lineTo(0, 0);
          c.lineTo(-8, 5);
          c.moveTo(0, -5);
          c.lineTo(8, 0);
          c.lineTo(0, 5);
          c.stroke();
          c.restore();
        }
      }
      if (s.decoration) {
        c.strokeStyle = "#a6e8e323";
        c.lineWidth = 0.8;
        for (let i = 0; i < 6; i++) {
          const y = current.y + 14 + i * 43;
          c.beginPath();
          c.moveTo(current.x, y);
          c.bezierCurveTo(
            current.x + current.width * 0.3,
            y + 12,
            current.x + current.width * 0.65,
            y - 12,
            current.x + current.width,
            y + current.forceY * 0.035,
          );
          c.stroke();
        }
      }
      c.restore();
      c.font = '10px "Segoe UI", system-ui, sans-serif';
      c.textAlign = "left";
      c.fillStyle = "#93cbd0";
      c.fillText("SHEAR LANE", current.x + 10, current.y - 8);
    }
    const gates = world.gates || [];
    c.save();
    c.strokeStyle = "#9adce126";
    c.lineWidth = 1;
    c.setLineDash([3, 9]);
    for (let i = 1; i < gates.length; i++) {
      const a = gates[i - 1],
        b = gates[i];
      if (b.passed) continue;
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      c.beginPath();
      c.moveTo(
        a.x + Math.cos(angle) * a.radius,
        a.y + Math.sin(angle) * a.radius,
      );
      c.lineTo(
        b.x - Math.cos(angle) * b.radius,
        b.y - Math.sin(angle) * b.radius,
      );
      c.stroke();
    }
    c.setLineDash([]);
    for (const gate of gates) {
      const col = gate.passed ? "#83b4a1" : gate.active ? "#b8f0e8" : "#618b9e";
      // The inner ring is the exact entry radius; segmented machinery sits
      // outside it and never changes the scoring region.
      circle(c, gate.x, gate.y, gate.radius + 6, null, "#0b1a26", 8);
      c.strokeStyle = gate.passed
        ? "#344e4a"
        : gate.active
          ? "#87bbb9"
          : "#344c5b";
      c.lineWidth = 4;
      for (let i = 0; i < 8; i++) {
        const a = (i * TAU) / 8 + 0.08;
        c.beginPath();
        c.arc(gate.x, gate.y, gate.radius + 6, a, a + 0.52);
        c.stroke();
      }
      circle(
        c,
        gate.x,
        gate.y,
        gate.radius,
        gate.active ? "#93e7df0d" : null,
        col,
        gate.active ? 2.5 : 1,
      );
      if (gate.passed) {
        c.strokeStyle = col;
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(gate.x - 8, gate.y);
        c.lineTo(gate.x - 2, gate.y + 6);
        c.lineTo(gate.x + 10, gate.y - 7);
        c.stroke();
      } else {
        c.font = `${gate.active ? 18 : 15}px Georgia, serif`;
        c.textAlign = "center";
        c.fillStyle = col;
        c.fillText(
          ["I", "II", "III"][gate.index] || String(gate.index + 1),
          gate.x,
          gate.y + 6,
        );
      }
      if (gate.active) {
        c.strokeStyle = "#b8f0e8";
        c.lineWidth = 2;
        for (let i = 0; i < 4; i++) {
          const a = (i * Math.PI) / 2;
          c.beginPath();
          c.moveTo(
            gate.x + Math.cos(a) * (gate.radius + 5),
            gate.y + Math.sin(a) * (gate.radius + 5),
          );
          c.lineTo(
            gate.x + Math.cos(a) * (gate.radius + 10),
            gate.y + Math.sin(a) * (gate.radius + 10),
          );
          c.stroke();
        }
        c.font = '10px "Segoe UI", system-ui, sans-serif';
        c.textAlign = "center";
        c.fillStyle = "#b8f0e8";
        c.fillText("TRANSIT", gate.x, gate.y + gate.radius + 25);
      }
    }
    c.restore();
    const rocks = world.rocks || [];
    for (let i = 0; i < rocks.length; i++) {
      const rock = rocks[i];
      if (rock.alive === false || rock.hp <= 0) continue;
      if (rock.comet) {
        const speed = Math.hypot(rock.vx, rock.vy) || 1, len = Math.min(900, speed * 0.6), ux = rock.vx / speed, uy = rock.vy / speed;
        const g = c.createLinearGradient(rock.x, rock.y, rock.x - ux * len, rock.y - uy * len);
        g.addColorStop(0, "#e8fbffcc");
        g.addColorStop(1, "#7fd6ff00");
        c.strokeStyle = g;
        c.lineCap = "round";
        c.lineWidth = rock.radius * 1.4;
        c.beginPath();
        c.moveTo(rock.x, rock.y);
        c.lineTo(rock.x - ux * len, rock.y - uy * len);
        c.stroke();
        c.lineCap = "butt";
      }
      this.wake(rock.x, rock.y, rock.vx, rock.vy, rock.radius, "#a5b9bc", 0.6);
      this.oreBody(
        rock.x,
        rock.y,
        rock.radius,
        i,
        s.motion ? rock.angle || 0 : 0,
      );
      if (rock.hp < rock.maxHp) {
        const width = rock.radius * 1.5;
        c.fillStyle = "#101e29";
        c.fillRect(rock.x - width / 2, rock.y - rock.radius - 9, width, 3);
        c.fillStyle = "#e9b76a";
        c.fillRect(
          rock.x - width / 2,
          rock.y - rock.radius - 9,
          width * clamp(rock.hp / rock.maxHp, 0, 1),
          3,
        );
      }
    }
  }
  render(world, settings = {}, preview = false, feedback = null) {
    Object.assign(this.settings, settings);
    const c = this.ctx,
      s = this.settings;
    const deepField = !!fieldOf(world).physics && !preview;
    if (!deepField && (
      !this.background ||
      this.bgSeed !== world.seed ||
      this.bgRevision !== this.art.revision ||
      this.bgArena.width !== world.arena.width || this.bgArena.height !== world.arena.height
    ))
      this.makeBackground(world.seed, world.arena);
    const { width, height } = world.arena;
    const rect = this.viewRect(world.arena);
    if (deepField) {
      // Follow the player through open space, leading along its momentum. The view widens with speed (eased frame to
      // frame) and with the player's size, so a fast or large body sees further ahead.
      const p = world.player, speed = Math.hypot(p.vx || 0, p.vy || 0), lead = Math.min(520, speed * 0.5) / Math.max(1, speed);
      const want = 1900 + Math.max(0, (p.radius || 23) - 23) * 30 + Math.min(1700, speed * 1.8);
      this.span = Number.isFinite(this.span) ? this.span + (want - this.span) * 0.06 : want;
      this.camera.track({ x: p.x + (p.vx || 0) * lead, y: p.y + (p.vy || 0) * lead }, { width: this.span, height: this.span * 9 / 16 }, false);
    } else this.camera.track(null);
    const camera = this.camera.fit(world.arena, rect);
    const dpr = backingScale(rect);
    const bw = Math.max(1, Math.round(rect.width * dpr)), bh = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = "#020912";
    c.fillRect(0, 0, bw, bh);
    if (deepField) {
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.space(world, camera, rect);
    }
    c.setTransform(camera.scale * dpr, 0, 0, camera.scale * dpr, camera.x * dpr, camera.y * dpr);
    if (deepField) { /* open space: no arena to clear, clip or frame */ }
    else {
    c.clearRect(0, 0, width, height);
    if (s.decoration) c.drawImage(this.background, 0, 0);
    else {
      c.fillStyle = "#06101c";
      c.fillRect(0, 0, width, height);
    }
    }
    c.save();
    c.beginPath();
    if (deepField) c.rect(-1e6, -1e6, 2e6, 2e6);
    else c.rect(0, 0, width, height);
    c.clip();
    const impact = (world.effects || []).find(
      (e) => (e.type === "hurt" || e.type === "impact") && e.age < 0.14,
    );
    if (s.shake && s.motion && (impact || feedback?.shake)) {
      const force =
        Math.min(6, feedback?.shake || Math.min(3, (impact.amount || 5) * 0.13) * (1 - impact.age / 0.14));
      // The feedback shake runs on its wall clock: simulation time stands
      // nearly still during hit-stop and the encounter beat.
      const angle = feedback?.shake ? feedback.angle : impact?.angle || 0,
        phase = feedback?.shake ? feedback.clock ?? world.time : world.time,
        offset = Math.sin(phase * 103) * force;
      c.translate(
        Math.cos(angle) * offset,
        Math.sin(angle) * offset,
      );
    }
    if (!deepField) {
    // Tactical boundaries and threat geometry are never decoration.
    c.strokeStyle = "#355468";
    c.lineWidth = 1;
    c.setLineDash([3, 9]);
    c.strokeRect(24, 24, width - 48, height - 48);
    c.setLineDash([]);
    c.strokeStyle = "#75959e88";
    for (const [x, dx] of [
      [24, 1],
      [width - 24, -1],
    ])
      for (const [y, dy] of [
        [24, 1],
        [height - 24, -1],
      ]) {
        c.beginPath();
        c.moveTo(x + dx * 24, y);
        c.lineTo(x, y);
        c.lineTo(x, y + dy * 24);
        c.stroke();
      }
    }
    this.environment(world);
    if (deepField) { this.regions(world, camera.visible(), camera.scale); this.wells(world); }
    for (const p of world.pickups || []) {
      if (p.value <= 0) continue;
      this.matter(p);
    }
    for (const n of world.candidates || []) {
      if (n.ownerId || n.alive === false) continue;
      this.satellite(n.x, n.y, n.radius || 10, n.role || "collector", -0.4);
      c.strokeStyle = "#8de5e999";
      c.lineWidth = 1;
      for (let i = 0; i < 4; i++) {
        const a = (i * TAU) / 4;
        c.beginPath();
        c.arc(n.x, n.y, 20, a + 0.16, a + 0.65);
        c.stroke();
      }
      c.font = '10px "Segoe UI", system-ui, sans-serif';
      c.textAlign = "center";
      c.fillStyle = "#b1d7dd";
      // Display names only (identity bible section 5); role ids stay unchanged.
      c.fillText(({ interceptor: "SENTINEL", collector: "GATHERER" })[n.role] ?? "MOON", n.x, n.y + 36);
    }
    const enemies = world.enemies || [];
    for (const e of enemies) {
      if (e.alive === false || e.hp <= 0) continue;
      const angle = e.angle || 0, { kind, look, body } = enemyLook(world, e.type);
      this.wake(e.x, e.y, e.vx, e.vy, e.radius, look.color, 0.65);
      if (e.state === "telegraph" || e.state === "commit") {
        const line = e.telegraph || {};
        const a = line.angle ?? angle;
        // The corridor is the path the commit covers: the kind's commit speed over its commit time (what remains of it).
        const speed = line.speed ?? kind?.commitSpeed ?? 0;
        const duration =
          e.state === "commit"
            ? Math.max(0, e.timer)
            : kind?.commit ?? 0;
        let len = speed * duration;
        // A commit stops where its body meets a well core, so the corridor ends there.
        for (const well of world.wells || []) {
          const dx = well.x - e.x, dy = well.y - e.y, along = dx * Math.cos(a) + dy * Math.sin(a), reach = well.core + e.radius;
          const miss = dx * dx + dy * dy - along * along;
          if (along > 0 && miss < reach * reach) len = Math.min(len, Math.max(0, along - Math.sqrt(reach * reach - miss)));
        }
        c.save();
        c.translate(e.x, e.y);
        c.rotate(a);
        c.fillStyle = "#030b1780";
        c.fillRect(0, -e.radius - 2, len, e.radius * 2 + 4);
        c.fillStyle = look.color + (e.state === "commit" ? "2b" : "14");
        c.fillRect(0, -e.radius, len, e.radius * 2);
        c.strokeStyle = look.color;
        c.lineWidth = look.telegraphLine;
        c.setLineDash(e.state === "commit" ? [] : [10, 9]);
        c.beginPath();
        c.moveTo(0, -e.radius);
        c.lineTo(len, -e.radius);
        c.moveTo(0, e.radius);
        c.lineTo(len, e.radius);
        c.stroke();
        c.setLineDash([]);
        c.strokeStyle = look.color + "88";
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(len, -e.radius);
        c.lineTo(len, e.radius);
        c.stroke();
        for (let k = 65; k < len; k += 70) {
          c.beginPath();
          c.moveTo(k - 8, -6);
          c.lineTo(k, 0);
          c.lineTo(k - 8, 6);
          c.stroke();
        }
        c.restore();
      }
      if (look.shield) {
        // The shield is drawn where the kind's rear arc is not (src/sim/kinds.js inRearArc).
        const gap = (e.guardAngle ?? angle) + Math.PI;
        const half = e.state === "recover" ? kind.rearArc.recovering : kind.rearArc.open;
        const r = e.radius + 12;
        c.strokeStyle = "#0b1026";
        c.lineWidth = 10;
        c.beginPath();
        c.arc(e.x, e.y, r, gap + half, gap + TAU - half);
        c.stroke();
        c.strokeStyle = look.color;
        c.lineWidth = 4;
        c.beginPath();
        c.arc(e.x, e.y, r, gap + half, gap + TAU - half);
        c.stroke();
        c.strokeStyle = "#e4d6ff70";
        c.lineWidth = 1;
        c.beginPath();
        c.arc(e.x, e.y, r + 4, gap + half, gap + TAU - half);
        c.stroke();
        const start = gap + half,
          length = TAU - half * 2;
        c.strokeStyle = "#352d4b";
        c.lineWidth = 2;
        for (let i = 1; i < 9; i++) {
          const a = start + (length * i) / 9;
          c.beginPath();
          c.moveTo(e.x + Math.cos(a) * (r - 3), e.y + Math.sin(a) * (r - 3));
          c.lineTo(e.x + Math.cos(a) * (r + 3), e.y + Math.sin(a) * (r + 3));
          c.stroke();
        }
        c.strokeStyle = "#e4d6ff";
        c.lineWidth = 1.5;
        for (const a of [gap - half, gap + half]) {
          c.beginPath();
          c.moveTo(e.x + Math.cos(a) * (r - 7), e.y + Math.sin(a) * (r - 7));
          c.lineTo(e.x + Math.cos(a) * (r + 10), e.y + Math.sin(a) * (r + 10));
          c.stroke();
        }
      }
      if (look.halo) {
        c.strokeStyle = look.halo;
        c.setLineDash([3, 6]);
        circle(c, e.x, e.y, e.radius + 10, null, look.halo);
        c.setLineDash([]);
      }
      this.body(e.x, e.y, e.radius, body, angle);
      c.save();
      c.translate(e.x, e.y);
      c.rotate(angle);
      c.strokeStyle = look.color;
      c.lineWidth = 2;
      if (look.mark === "nose") {
        c.beginPath();
        c.moveTo(e.radius + 9, 0);
        c.lineTo(e.radius - 1, -9);
        c.lineTo(e.radius - 1, 9);
        c.closePath();
        c.stroke();
      } else if (look.mark === "mandibles") {
        for (const a of [-1, 1]) {
          c.beginPath();
          c.moveTo(0, a * (e.radius + 4));
          c.lineTo(e.radius * 0.7, a * (e.radius + 9));
          c.stroke();
        }
      }
      c.restore();
      const life = e.hp ?? e.mass,
        max = e.maxHp || e.maxMass || life;
      if (life < max) {
        c.fillStyle = "#081322";
        c.fillRect(e.x - 24, e.y - e.radius - 18, 48, 4);
        c.fillStyle = look.color;
        c.fillRect(
          e.x - 24,
          e.y - e.radius - 18,
          48 * clamp(life / max, 0, 1),
          4,
        );
      }
      const labels = {
        observe: "",
        telegraph: look.labels.telegraph,
        commit: look.labels.commit,
        recover: "Exposed",
        recovery: "Exposed",
      };
      c.font = '10px "Segoe UI", system-ui, sans-serif';
      c.fillStyle = e.state === "recover" ? "#dcece6" : look.color;
      c.textAlign = "center";
      c.strokeStyle = "#06101ce0";
      c.lineWidth = 3;
      c.strokeText(labels[e.state] ?? e.state ?? "", e.x, e.y + e.radius + 25);
      c.fillText(labels[e.state] ?? e.state ?? "", e.x, e.y + e.radius + 25);
    }
    const p = world.player,
      { identity, form, body } = playerLook(world),
      t = s.motion ? world.time : 0;
    const state = p.command?.state || "ready";
    if (deepField) { this.coastGuide(world); this.traitLook(world); this.ship(world); }
    this.wake(p.x, p.y, p.vx, p.vy, p.radius, identity.look.color, 1.2);
    if (identity.look.orbit) {
      const wide = p.formation === "wide";
      const targetOrbit = wide ? p.radius + 85 : p.radius + 22;
      const orbit =
        !preview && p.companions?.length
          ? p.companions.reduce(
              (sum, companion) => sum + (companion.orbitRadius ?? targetOrbit),
              0,
            ) / p.companions.length
          : targetOrbit;
      c.strokeStyle = state === "transition" ? "#e9bb7388" : "#9adce14a";
      c.lineWidth = 1;
      c.setLineDash(state === "transition" ? [5, 8] : []);
      circle(c, p.x, p.y, orbit, null, c.strokeStyle);
      c.setLineDash([]);
      if (s.decoration) {
        c.strokeStyle = "#8de5e920";
        c.lineWidth = 1;
        for (let i = 0; i < 6; i++) {
          const a = (i * TAU) / 6 + t * 0.04;
          c.beginPath();
          c.arc(p.x, p.y, orbit + 4, a, a + 0.14);
          c.stroke();
        }
      }
      const companions = preview
        ? Array.from({ length: 2 }, (_, i) => ({
            role: i % 2 ? "collector" : "interceptor",
          }))
        : (p.companions ?? []);
      companions.forEach((o, i) => {
        const a = t * 0.65 + (i * TAU) / companions.length;
        const x = o.x ?? p.x + Math.cos(a) * orbit,
          y = o.y ?? p.y + Math.sin(a) * orbit;
        this.satellite(
          x,
          y,
          o.radius || 7,
          o.role,
          o.angle ?? a,
          state === "transition" || o.cooldown > 0,
        );
      });
    }
    if (identity.look.shell) {
      const a = p.angle || 0;
      c.save();
      c.translate(p.x, p.y);
      c.rotate(a);
      c.strokeStyle = state === "recover" ? "#ad8461" : "#f2b866";
      c.lineWidth = state === "burst" || state === "commit" ? 5 : 3;
      c.beginPath();
      c.arc(
        0,
        0,
        p.radius + 8,
        -form.look.shellArc,
        form.look.shellArc,
      );
      c.stroke();
      c.strokeStyle = state === "recover" ? "#ad846166" : "#f2b86688";
      c.lineWidth = 1;
      for (const side of [-1, 1]) {
        c.beginPath();
        c.moveTo(-p.radius * 0.4, side * (p.radius + 5));
        c.lineTo(p.radius * 0.45, side * (p.radius + 7));
        c.lineTo(p.radius * 0.7, side * (p.radius + 3));
        c.stroke();
      }
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(p.radius + 19, 0);
      c.lineTo(p.radius + 11, -5);
      c.moveTo(p.radius + 19, 0);
      c.lineTo(p.radius + 11, 5);
      c.stroke();
      if (state === "burst" || state === "commit") {
        c.fillStyle = "#edb56e36";
        c.beginPath();
        c.moveTo(-p.radius, -p.radius * 0.55);
        c.lineTo(-p.radius - 70, 0);
        c.lineTo(-p.radius, p.radius * 0.55);
        c.fill();
      }
      c.restore();
    }
    this.body(p.x, p.y, p.radius, body, p.angle || 0);
    circle(c, p.x, p.y, p.radius + 2, null, identity.look.color + "55");
    if (identity.look.ticks) {
      c.strokeStyle = "#b6f5edb0";
      c.lineWidth = 1;
      for (let i = 0; i < form.look.ticks; i++) {
        const a = (i * TAU) / form.look.ticks - 0.3;
        c.beginPath();
        c.arc(p.x, p.y, p.radius + 5, a, a + 0.26);
        c.stroke();
      }
    } else if (identity.look.sideArcs) {
      c.strokeStyle = "#c5d4de80";
      c.lineWidth = 1;
      for (const side of [-1, 1]) {
        c.beginPath();
        c.arc(
          p.x,
          p.y,
          p.radius + 5,
          side > 0 ? -0.35 : Math.PI - 0.35,
          side > 0 ? 0.35 : Math.PI + 0.35,
        );
        c.stroke();
      }
    }
    if (p.invulnerable > 0) {
      // Grace after a hit is tactical information: a dashed outline at every effects setting.
      c.save();
      c.setLineDash([5, 4]);
      circle(c, p.x, p.y, p.radius + 6, null, "#f4d2a3", 2);
      c.restore();
    }
    if (feedback) {
      if (s.decoration && s.motion) for (const particle of feedback.particles) {
        if (particle.life <= 0) continue;
        c.globalAlpha = clamp(particle.life / 0.55, 0, 1);
        c.fillStyle = particle.kind === "matter" || particle.kind === "ore" ? "#f2b866" : "#b9cbd5";
        c.fillRect(particle.x - 1, particle.y - 1, particle.kind === "defeat" ? 4 : 2, 2);
      }
      c.globalAlpha = 1;
      if (s.flashes && feedback.flash) {
        const flash = feedback.flash;
        c.globalAlpha = clamp(flash.life / 0.16, 0, 1) * 0.65;
        c.strokeStyle = "#f0d6bf";
        c.lineWidth = 3;
        c.beginPath();
        c.arc(flash.x, flash.y, 30, flash.angle - 0.65, flash.angle + 0.65);
        c.stroke();
        c.globalAlpha = 1;
      }
      // Where an opponent broke: a faint dotted outline (line grammar: the
      // past is dotted at 35 %). Static, so it draws at every effects setting.
      if (feedback.marks?.length) {
        c.save();
        c.setLineDash([2, 5]);
        c.lineWidth = 1.5;
        c.strokeStyle = "#b9cbd5";
        for (const mark of feedback.marks) {
          c.globalAlpha = 0.35 * clamp(mark.life / 0.6, 0, 1);
          c.beginPath();
          c.arc(mark.x, mark.y, mark.radius, 0, Math.PI * 2);
          c.stroke();
        }
        c.restore();
      }
    }
    for (const fx of world.effects || []) {
      const life = fx.life ?? fx.timer ?? 0;
      if (life <= 0) continue;
      const progress = clamp((fx.age || 0) / life, 0, 1),
        radius =
          fx.type === "pulse"
            ? (fx.radius || 250) * (s.motion ? progress : 1)
            : fx.type === "gate"
              ? (fx.radius || 32) + (s.motion ? progress * 12 : 0)
              : (5 + Math.min(25, fx.amount || 10)) * (0.6 + progress);
      c.globalAlpha = 1 - progress;
      circle(
        c,
        fx.x ?? p.x,
        fx.y ?? p.y,
        radius,
        null,
        fx.type === "pulse" || fx.type === "gate"
          ? "#a2e5ed80"
          : s.flashes
            ? "#ead2aa90"
            : "#6b8797",
        fx.type === "hurt" ? 3 : 1.5,
      );
      if (fx.type === "pulse") {
        c.strokeStyle = s.flashes ? "#8de5e96a" : "#65868a";
        c.lineWidth = 1;
        c.setLineDash([3, 12]);
        circle(
          c,
          fx.x ?? p.x,
          fx.y ?? p.y,
          Math.max(1, radius - 7),
          null,
          c.strokeStyle,
        );
        c.setLineDash([]);
      }
      if (fx.type === "block") {
        c.strokeStyle = s.flashes ? "#b5f7f2" : "#6c9a9e";
        c.lineWidth = 2;
        c.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (i * TAU) / 6;
          const x = (fx.x ?? p.x) + Math.cos(a) * radius,
            y = (fx.y ?? p.y) + Math.sin(a) * radius;
          if (i) c.lineTo(x, y);
          else c.moveTo(x, y);
        }
        c.closePath();
        c.stroke();
      }
      if (s.decoration && fx.type === "collect") {
        c.strokeStyle = s.flashes ? "#f2b866b0" : "#8b9c9f";
        c.lineWidth = 1;
        const r = 2 + progress * 8;
        c.beginPath();
        c.moveTo(fx.x - r, fx.y);
        c.lineTo(fx.x + r, fx.y);
        c.moveTo(fx.x, fx.y - r);
        c.lineTo(fx.x, fx.y + r);
        c.stroke();
      }
      if (
        s.decoration &&
        s.motion &&
        ["hurt", "impact", "burst"].includes(fx.type)
      ) {
        c.strokeStyle = s.flashes
          ? fx.type === "hurt"
            ? "#fa8776"
            : "#f2b866"
          : "#7d9098";
        c.lineWidth = 1.4;
        for (let i = 0; i < 7; i++) {
          const a = (i * TAU) / 7 + (fx.x || 0) * 0.03,
            distance = radius * 0.7 + progress * 18;
          c.beginPath();
          c.moveTo(
            (fx.x ?? p.x) + Math.cos(a) * distance,
            (fx.y ?? p.y) + Math.sin(a) * distance,
          );
          c.lineTo(
            (fx.x ?? p.x) + Math.cos(a) * (distance + 3 + (i % 3) * 2),
            (fx.y ?? p.y) + Math.sin(a) * (distance + 3 + (i % 3) * 2),
          );
          c.stroke();
        }
      }
      if (fx.type === "ore" && s.decoration && s.motion) {
        c.strokeStyle = s.flashes ? "#e9b76a" : "#8ba0a8";
        c.lineWidth = 2;
        for (let i = 0; i < 6; i++) {
          const a = (i * TAU) / 6 + 0.35,
            distance = radius + progress * 16;
          c.beginPath();
          c.moveTo(
            fx.x + Math.cos(a) * distance,
            fx.y + Math.sin(a) * distance,
          );
          c.lineTo(
            fx.x + Math.cos(a) * (distance + 5),
            fx.y + Math.sin(a) * (distance + 5),
          );
          c.stroke();
        }
      }
      c.globalAlpha = 1;
    }
    // A tiny directional marker keeps the controlled body distinct from opponents.
    c.fillStyle = identity.look.color;
    c.beginPath();
    c.moveTo(p.x - 4, p.y + p.radius + 13);
    c.lineTo(p.x + 4, p.y + p.radius + 13);
    c.lineTo(p.x, p.y + p.radius + 8);
    c.fill();
    c.restore();
    if (deepField) {
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.overlay(world, camera, rect);
    }
  }
}
