// Simulation notices are complete in the notification card; they have no
// navigation action, including records written before this presentation change.
export function isSimulationNotification(row) {
  return (
    row?.type === "ecology_simulation" ||
    row?.simulation === true ||
    row?.recurrence === "simulation_preview"
  );
}

export function notificationWeatherHref(row) {
  if (!row || isSimulationNotification(row)) return null;
  if (row.type && row.type !== "weather") return null;
  const safeWeatherHref = /^\/weather(?:\?location=[a-z0-9-]+)?$/.test(
    row.href || "",
  );
  // Older weather records may not have a type, but have a weather-only URL.
  if (safeWeatherHref) return row.href;
  return row.type === "weather" ? "/weather" : null;
}
