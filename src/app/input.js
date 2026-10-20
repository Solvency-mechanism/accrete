// Physical bindings are data so a later settings screen can remap them.
export const BINDINGS = {
  up: ["KeyW", "ArrowUp"],
  left: ["KeyA", "ArrowLeft"],
  down: ["KeyS", "ArrowDown"],
  right: ["KeyD", "ArrowRight"],
  command: ["Space"],
  capture: ["KeyE"],
  pause: ["Escape"],
};

// Space keeps its native meaning on controls that toggle or take text
// (checkboxes, radios, text fields, disclosure summaries). It never activates
// a button, so a habitual command press cannot confirm a dialog choice.
export function spaceIsNative(target) {
  const tag = target?.tagName;
  if (tag === "SUMMARY" || tag === "SELECT" || tag === "TEXTAREA") return true;
  return (
    tag === "INPUT" &&
    !["button", "submit", "reset", "image"].includes(target.type)
  );
}

export function createInput({
  bindings = BINDINGS,
  active = () => true,
  // Movement can be tracked while commands are refused (the encounter beat).
  commandActive = active,
  modal = () => false,
  modalKey = () => {},
  pause = () => {},
  capture = () => {},
} = {}) {
  const keys = new Set();
  let aim = null,
    commands = 0,
    commandWasSent = false;
  const matches = (action, code) => bindings[action].includes(code);
  const movement = (code) =>
    ["up", "left", "down", "right"].some((a) => matches(a, code));
  return {
    keydown(e) {
      if (modal() && e.code === "Space") {
        // Never a game command while a dialog is open.
        if (!spaceIsNative(e.target)) e.preventDefault();
        return;
      }
      if (matches("pause", e.code)) {
        e.preventDefault();
        if (!e.repeat) pause();
        return;
      }
      if (modal()) {
        modalKey(e);
        return;
      }
      if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target?.tagName)) return;
      if (!active()) return;
      if (movement(e.code)) {
        e.preventDefault();
        keys.add(e.code);
        if (!e.repeat) aim = null;
      }
      if (matches("command", e.code)) {
        e.preventDefault();
        if (!e.repeat && commandActive()) commands++;
      }
      if (matches("capture", e.code) && !e.repeat) capture();
    },
    keyup(e) {
      keys.delete(e.code);
      if (modal() && e.code === "Space" && !spaceIsNative(e.target))
        e.preventDefault();
    },
    point(x, y) {
      aim = { aimX: x, aimY: y };
    },
    // Re-maps a held mouse aim (the follow camera moves the world under a still cursor); a key press still clears it.
    repoint(x, y) {
      if (aim) aim = { aimX: x, aimY: y };
    },
    move(code, held) {
      if (held) {
        keys.add(code);
        aim = null;
      } else keys.delete(code);
    },
    queueCommand() {
      if (commandActive() && !modal()) commands++;
    },
    // Read only at a fixed step. Separate presses need a release step between
    // them because the simulation detects command edges, not held commands.
    consume() {
      const held = (a) => bindings[a].some((code) => keys.has(code));
      const command = commands > 0 && !commandWasSent;
      if (command) commands--;
      commandWasSent = command;
      return {
        x: Number(held("right")) - Number(held("left")),
        y: Number(held("down")) - Number(held("up")),
        ...aim,
        command,
      };
    },
    reset({ clearAim = false, clearCommandEdge = false } = {}) {
      keys.clear();
      commands = 0;
      // Preserve a pending release across pauses; the simulation may still
      // remember the last command edge when no step ran before the dialog.
      if (clearAim) aim = null;
      if (clearCommandEdge) commandWasSent = false;
    },
  };
}
