const KEY = "hyhq.privacy.v1";
const memory = new Map();
// A failed browser-storage write must never restore an earlier consent.
let volatileChoice = null;
const preferenceKeys = ["hyhq.theme", "hyhq.region", "hyhq.weather.city"];
export function privacyChoice() {
  if (volatileChoice) return volatileChoice;
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "null");
    return value?.version === 1 && typeof value.preferences === "boolean"
      ? value
      : null;
  } catch {
    return null;
  }
}
export function savePrivacyChoice(preferences) {
  const choice = {
    version: 1,
    necessary: true,
    preferences: preferences === true,
    saved_at: new Date().toISOString(),
  };
  volatileChoice = choice;
  try {
    localStorage.setItem(KEY, JSON.stringify(choice));
    volatileChoice = null;
  } catch {
    // Remove an old "allow" value when writes fail (for example, quota full).
    // The in-memory decision still applies if even removal is unavailable.
    try {
      localStorage.removeItem(KEY);
    } catch {}
  }
  if (!choice.preferences) {
    for (const key of preferenceKeys) {
      try {
        localStorage.removeItem(key);
      } catch {}
    }
  } else {
    for (const [key, value] of memory) {
      try {
        localStorage.setItem(key, value);
      } catch {}
    }
  }
  window.dispatchEvent(
    new CustomEvent("hyhq-privacy-change", { detail: choice }),
  );
  return choice;
}
export const preferenceStorage = {
  getItem(key) {
    if (memory.has(key)) return memory.get(key);
    if (!privacyChoice()?.preferences) return null;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    memory.set(key, String(value));
    if (privacyChoice()?.preferences)
      try {
        localStorage.setItem(key, String(value));
      } catch {}
  },
};
