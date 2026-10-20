export function createSettingsMenu({ $, document, getWorld, getModal, isStarted, getStartOptions, setPaused, closeDialog, dialog, storageNotice, escape, percent, settings, preferences, seedField, requestQuit, start, exportSession, audio, renderHint, hints, getHintTime, clearCaptions }) {
  return function pauseMenu(event) {
    if (getModal() === "pause") {
      closeDialog();
      return;
    }
    setPaused(true);
    dialog(
      "pause",
      isStarted() ? "Paused" : "Settings",
      `<p>${isStarted() ? "The system is paused. Take your time." : "Tune the experience before you leave."}</p>${storageNotice() ? `<p class="storage-notice">${escape(storageNotice())}</p>` : ""}<div class="settings">${[
        ["decoration", "Starfield detail"],
        ["shake", "Impact shake"],
        ["flashes", "Impact flashes"],
        ["motion", "Decorative motion"],
        ["sound", "Sound"],
        ["mute", "Mute"],
        ["captions", "Sound captions"],
        ["hints", "First hints"],
      ]
        .map(
          ([key, label]) =>
            `<label><input id="setting-${key}" type="checkbox" data-setting="${key}" ${settings[key] ? "checked" : ""}>${label}</label>`,
        )
        .join(
          "",
        )}${["master", "music", "effects", "interface"].map((bus) =>
          `<label>${bus[0].toUpperCase() + bus.slice(1)} volume<input id="setting-${bus}Volume" type="range" min="0" max="1" step="0.05" data-setting="${bus}Volume" value="${settings[`${bus}Volume`]}" aria-valuetext="${percent(settings[`${bus}Volume`])}"></label>`).join("")}
        <label>Game speed<select id="setting-gameSpeed" data-setting="gameSpeed">${[0.7, 0.85, 1].map((speed) => `<option value="${speed}" ${settings.gameSpeed === speed ? "selected" : ""}>${Math.round(speed * 100)}%</option>`).join("")}</select></label></div><p>Threat paths, guard openings, and collision edges stay visible at every setting.</p><div class="field-guide"><strong>Read the living field</strong><p>Amber ore cracks on contact; a burst breaks it faster. Moving diamonds carry finite matter. Cyan shear lanes push in the marked direction.</p><p>Thread the transit through gates 1 → 2 → 3. Gather the required matter, then finish the transit, break every opponent, or outlast the encounter.</p><p>The rim stays clear of shear.</p></div>`,
      [
        {
          text: getWorld().phase !== "playing" ? "Back" : isStarted() ? "Resume" : "Close",
          primary: true,
          action: closeDialog,
        },
        ...(isStarted()
          ? [
              { text: "Restart expedition", action: () => requestQuit(() => start(getStartOptions()), true) },
              { text: "Return home", action: () => requestQuit() },
            ]
          : []),
      ],
      event?.currentTarget || document.activeElement,
    );
    const advanced = document.createElement("details"),
      summary = document.createElement("summary");
    advanced.className = "advanced";
    summary.textContent = "Advanced";
    advanced.append(summary);
    if (isStarted()) {
      // A run keeps its seed (Restart reuses it), and only a run has a session
      // worth exporting.
      const save = document.createElement("button");
      save.textContent = "Export session";
      save.onclick = exportSession;
      advanced.append(save);
    } else {
      const label = document.createElement("label");
      label.textContent = "Layout seed";
      label.className = "seed-label";
      label.append(seedField);
      advanced.append(label);
    }
    $("#dialog").append(advanced);
    document.querySelectorAll("[data-setting]").forEach((i) => {
      // Sliders speak their level as a percentage, matching the speed options.
      if (i.type === "range")
        i.oninput = () => i.setAttribute("aria-valuetext", percent(Number(i.value)));
      i.onchange = () => {
        preferences.set(i.dataset.setting, i.type === "checkbox" ? i.checked : Number(i.value));
        if (i.type === "range") i.setAttribute("aria-valuetext", percent(settings[i.dataset.setting]));
        audio.configure(settings);
        if (!settings.hints) renderHint(hints.update(getHintTime(), false));
        if (!audio.captionsEnabled()) clearCaptions();
      };
    });
  }
}
