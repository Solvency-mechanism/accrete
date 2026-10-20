import { spaceIsNative } from "./input.js";

export function createDialogs({ document, panel, wrap, now }) {
  let current = null;
  const stack = [],
    background = new Map();
  const focusable = () =>
    [
      ...panel.querySelectorAll(
        "button,input,select,textarea,a[href],summary,[tabindex]",
      ),
    ].filter((el) => {
      if (el.disabled || el.tabIndex < 0) return false;
      for (let ancestor = el; ancestor !== panel; ancestor = ancestor.parentElement) {
        if (ancestor.hidden || ancestor.inert) return false;
        if (
          ancestor.tagName === "DETAILS" &&
          !ancestor.open &&
          !ancestor.querySelector("summary")?.contains(el)
        ) return false;
      }
      return true;
    });
  const lock = () => {
    for (let branch = wrap; branch.parentElement; branch = branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling === branch || background.has(sibling)) continue;
        // Live regions stay exposed so announcements made while a dialog is
        // open are still spoken.
        if (sibling.getAttribute?.("aria-live") != null) continue;
        background.set(sibling, sibling.inert);
        sibling.inert = true;
      }
      if (branch.parentElement === document.body) break;
    }
  };
  const unlock = () => {
    for (const [element, inert] of background) element.inert = inert;
    background.clear();
  };
  const ready = () => !current?.choice || now() >= current.readyAt;
  return {
    open({ kind, choice = false, nested = false, opener = document.activeElement }) {
      if (nested && current) {
        stack.push({
          current,
          children: [...panel.childNodes],
          focus: document.activeElement,
          describedBy: panel.getAttribute("aria-describedby"),
        });
      }
      current = {
        kind,
        choice,
        readyAt: now() + 300,
        opener: current?.opener || opener,
      };
      lock();
      wrap.hidden = false;
    },
    focus() {
      panel.tabIndex = -1;
      if (current?.choice) {
        panel.focus();
        return;
      }
      // Other dialogs start on their primary button, where Space is inert,
      // rather than on a setting a stray command press would toggle.
      const items = focusable();
      (items.find((el) => el.classList.contains("primary")) || items[0] || panel).focus();
    },
    guard(action) {
      const owner = current;
      return (event) => {
        if (owner !== current || !ready()) {
          event?.preventDefault();
          return;
        }
        action(event);
      };
    },
    keydown(e) {
      if (!current) return;
      if (e.code === "Space") {
        if (!spaceIsNative(e.target)) e.preventDefault();
      } else if (e.code === "Tab") {
        const items = focusable(),
          index = items.indexOf(document.activeElement);
        if (
          !items.length || index < 0 ||
          (e.shiftKey ? index === 0 : index === items.length - 1)
        ) {
          e.preventDefault();
          (e.shiftKey ? items.at(-1) || panel : items[0] || panel).focus();
        }
      } else if (e.code === "Enter" && current.choice) {
        // Reflection answers keep native multiline editing. Enter on a
        // textarea must never confirm the surrounding choice dialog.
        if (e.target?.tagName === "TEXTAREA") return;
        e.preventDefault();
        if (!ready() || e.repeat) return;
        const focused = document.activeElement;
        if (focused?.tagName === "BUTTON" && panel.contains(focused))
          focused.click();
        else panel.querySelector("button.primary")?.click();
      }
    },
    close({ restore = true } = {}) {
      if (stack.length) {
        const previous = stack.pop();
        current = previous.current;
        panel.replaceChildren(...previous.children);
        if (previous.describedBy == null) panel.removeAttribute("aria-describedby");
        else panel.setAttribute("aria-describedby", previous.describedBy);
        (previous.focus?.isConnected ? previous.focus : panel).focus();
      } else {
        const opener = current?.opener;
        current = null;
        wrap.hidden = true;
        unlock();
        if (restore && opener?.isConnected) opener.focus();
      }
      return current?.kind || "";
    },
    reset() {
      stack.length = 0;
      current = null;
      wrap.hidden = true;
      unlock();
    },
  };
}

// Shared dialog view. The composition root retains phase and run decisions.
export function createDialogView({ $, document, dialogs, getModal, setModal, input, identityName, escape, announce }) {
return function dialog(kind, title, body, actions, opener = document.activeElement) {
  dialogs.open({
    kind,
    choice: ["evolution", "trait", "capture", "won", "lost", "reflection", "quit"].includes(kind),
    nested: (kind === "pause" || kind === "quit") && !!getModal(),
    opener,
  });
  setModal(kind);
  input.reset();
  $("#dialog").innerHTML =
    `<p class="eyebrow">${escape(identityName())}</p><h2 id="dialog-title">${escape(title)}</h2><div id="dialog-body">${body}</div><div class="actions"></div>`;
  // Choice and error dialogs focus the panel itself, so expose their text as
  // its description. The settings list stays out of the pause description.
  if (kind === "pause") $("#dialog").removeAttribute("aria-describedby");
  else $("#dialog").setAttribute("aria-describedby", "dialog-body");
  for (const { text, action, primary } of actions) {
    const b = document.createElement("button");
    b.textContent = text;
    if (primary) b.className = "primary";
    b.onclick = dialogs.guard(action);
    $("#dialog .actions").append(b);
  }
  dialogs.focus();
  // A question starts in its answer field, where typing works at once and
  // Enter adds a line instead of confirming.
  if (kind === "reflection" || kind === "quit") $("#playtest-answer")?.focus();
  announce(title);
}
}
