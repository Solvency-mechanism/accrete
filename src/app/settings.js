import { createStore } from "./storage.js";

export const SETTING_KEYS = ["decoration", "shake", "flashes", "motion", "sound", "mute", "captions", "hints",
  "masterVolume", "musicVolume", "effectsVolume", "interfaceVolume", "gameSpeed"];

export function validSetting(key, value) {
  if (!SETTING_KEYS.includes(key)) return false;
  if (key === "gameSpeed") return [0.7, 0.85, 1].includes(value);
  if (key.endsWith("Volume")) return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  return typeof value === "boolean";
}

// The settings persist in the save (src/app/storage.js) as `settingsDiff`, the M1
// diff of the keys the player changed, validated here on every load. Old
// whole-settings snapshots cannot tell us what the player touched, so only a
// diff may override the current accessibility defaults (the store's migration
// carries only M1 diffs). `store` is shared with the save's other owners;
// without one, the settings live in memory.
export function createSettings({ reduced = false, store = createStore() } = {}) {
  const defaults = {
    decoration: true,
    shake: !reduced,
    flashes: !reduced,
    motion: !reduced,
    sound: true,
    mute: false,
    captions: true,
    hints: true,
    masterVolume: 0.6,
    musicVolume: 0.6,
    effectsVolume: 0.6,
    interfaceVolume: 0.6,
    gameSpeed: 1,
  };
  const changes = {},
    saved = store.get("settingsDiff") || {};
  for (const key of SETTING_KEYS) {
    if (validSetting(key, saved[key])) changes[key] = saved[key];
  }
  const values = { ...defaults, ...changes };
  return {
    values,
    set(key, value) {
      if (!validSetting(key, value)) return;
      values[key] = value;
      if (value === defaults[key]) delete changes[key];
      else changes[key] = value;
      store.set("settingsDiff", changes);
    },
  };
}
