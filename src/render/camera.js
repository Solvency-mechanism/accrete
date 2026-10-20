// CSS pixels define the viewport. DPR is used only by the renderer's backing store.
// Two framings share one mapping: `x`, `y` are where the arena's origin sits in the canvas box, `scale` is CSS pixels
// per arena unit, and `viewportWidth` and `viewportHeight` are the arena's whole extent on screen.
//   fit     (classic fields) the whole arena, letterboxed, as before.
//   follow  (deep fields) a window of `span` arena units around `focus`, filling the canvas box, held inside the
//           arena. Set with track(focus, span); track(null) returns to fit.
export class ArenaCamera {
  /** Frames `span` around `focus` from now on; `bounded` false lets the view leave the arena (an open field). */
  track(focus, span, bounded = true) {
    this.focus = focus ? { x: focus.x, y: focus.y } : null;
    this.span = span ?? null;
    this.bounded = bounded;
    return this;
  }
  fit(arena, rect) {
    if (this.focus) return this.follow(arena, rect);
    const { width, height } = arena;
    this.width = width;
    this.height = height;
    const rw = Math.max(1, rect.width), rh = Math.max(1, rect.height);
    this.scale = Math.min(rw / width, rh / height);
    this.viewportWidth = rw / width <= rh / height ? rw : width * this.scale;
    this.viewportHeight = rh / height <= rw / width ? rh : height * this.scale;
    this.x = (rw - this.viewportWidth) / 2;
    this.y = (rh - this.viewportHeight) / 2;
    return this;
  }
  follow(arena, rect) {
    const { width, height } = arena;
    this.width = width;
    this.height = height;
    const rw = Math.max(1, rect.width), rh = Math.max(1, rect.height);
    // At least the span on both axes, and never more than the whole arena (an open field has no such limit).
    const fill = Math.min(rw / this.span.width, rh / this.span.height);
    this.scale = this.bounded ? Math.max(fill, Math.max(rw / width, rh / height)) : fill;
    const halfW = rw / (2 * this.scale), halfH = rh / (2 * this.scale);
    const cx = !this.bounded ? this.focus.x : halfW * 2 >= width ? width / 2 : Math.max(halfW, Math.min(width - halfW, this.focus.x));
    const cy = !this.bounded ? this.focus.y : halfH * 2 >= height ? height / 2 : Math.max(halfH, Math.min(height - halfH, this.focus.y));
    this.viewportWidth = width * this.scale;
    this.viewportHeight = height * this.scale;
    this.x = rw / 2 - cx * this.scale;
    this.y = rh / 2 - cy * this.scale;
    this.view = { left: cx - halfW, top: cy - halfH, right: cx + halfW, bottom: cy + halfH };
    return this;
  }
  /** The arena rectangle on screen, in arena units: the whole arena when fitted. */
  visible() {
    return this.focus && this.view ? this.view : { left: 0, top: 0, right: this.width, bottom: this.height };
  }
  pointer(clientX, clientY, rect) {
    // Keep the old division-then-multiplication order at the shipped aspect.
    // Points in the bars remain outside the arena, rather than snapping aim.
    return [((clientX - rect.left - this.x) / this.viewportWidth) * this.width,
      ((clientY - rect.top - this.y) / this.viewportHeight) * this.height];
  }
}
