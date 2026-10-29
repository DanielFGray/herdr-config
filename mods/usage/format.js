// Presentation helpers shared by the bar and the detail panel, ported from
// herdr-gpui's usage model so the numbers read the same.

/** "47m", "2h 53m", "4d 11h": the coarsest two units that still say when. */
export function countdown(ms) {
  const minutes = Math.ceil(Math.max(0, ms) / 60e3);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes / 60) % 24;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  return `${minutes % 60}m`;
}

/** Time from `now` until the epoch-ms `at`, never below zero. */
export function resetIn(at, now = Date.now()) {
  return countdown(at - now);
}

/** Age of a reading: "less than a minute", else whole minutes as a countdown. */
export function ago(at, now = Date.now()) {
  const seconds = Math.floor((now - at) / 1000);
  return seconds < 60 ? "less than a minute" : countdown((seconds - (seconds % 60)) * 1000);
}

/** Warning from 60% used, critical from 80%; below that, `normal`. */
export function severityColor(used, t, normal) {
  return used >= 80 ? t.ansi1 : used >= 60 ? t.ansi3 : normal;
}

/** The window closest to its limit: the last of equally used ones, as Rust's max_by picks. */
export function tightest(windows) {
  return windows.reduce((best, w) => (best && best.used > w.used ? best : w), null);
}

/**
 * How a window's use compares with an even spend across it: the percent an
 * even spend would have used by now, and when it runs out at the rate so far
 * (null when it lasts until reset). Null until a hundredth of the window has
 * passed, since an early estimate swings too far to be useful.
 */
export function pace(w, now = Date.now()) {
  if (!w.length || w.resetsAt == null) return null;
  const left = w.resetsAt - now;
  const elapsed = w.length - left;
  if (left < 0 || elapsed < w.length / 100) return null;
  const runsOutIn = w.used > 0 ? ((100 - w.used) * elapsed) / w.used : null;
  return { expected: (elapsed / w.length) * 100, runsOutIn: runsOutIn !== null && runsOutIn < left ? runsOutIn : null };
}

/** "11% in reserve · Lasts until reset", or "4% in deficit · Runs out in 2d 3h". */
export function describePace(p, used) {
  if (used >= 100) return "Ran out";
  const margin = p.expected - used;
  const standing = margin >= 0.5 ? `${Math.round(margin)}% in reserve` : margin <= -0.5 ? `${Math.round(-margin)}% in deficit` : "On pace";
  return `${standing} · ${p.runsOutIn === null ? "Lasts until reset" : `Runs out in ${countdown(p.runsOutIn)}`}`;
}
