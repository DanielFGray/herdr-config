// Keeps one reading per provider fresh. The services rate limit these
// endpoints and the numbers move slowly, so reads are rare; a failed read
// keeps the last good numbers (marked stale) rather than blanking them.
import { PROVIDERS } from "./providers.js";

const REFRESH = 10 * 60e3;
const RATE_LIMITED = 30 * 60e3;
const ERROR_BACKOFF = 5 * 60e3;
// A sign-in the service rejected is asked again half as often after each
// rejection, up to this: a dead token sent every refresh can read as abuse.
const REJECTED_LIMIT = 6 * 3600e3;
const MANUAL_SPACING = 10e3;

export class UsageService {
  /** @param providers ids to read; @param saved readings from the last run */
  constructor(io, { providers = PROVIDERS.map((p) => p.id), saved = {} } = {}) {
    this.io = io;
    this.providers = PROVIDERS.filter((p) => providers.includes(p.id));
    this.readings = {};
    this.state = {};
    for (const p of this.providers) {
      const s = saved[p.id];
      this.readings[p.id] = { id: p.id, name: p.name, dashboard: p.dashboard, report: s?.report ?? null, updated: s?.updated ?? null, error: null, stale: Boolean(s?.report) };
      this.state[p.id] = { due: 0, rejected: 0 };
    }
    this.lastManual = {};
    /** Ids being read now. */
    this.pending = new Set();
  }

  /** Readings with numbers or an error to show, as plain data for `setShared`. */
  snapshot() {
    return {
      busy: this.pending.size > 0,
      pending: [...this.pending],
      readings: this.providers.map((p) => this.readings[p.id]).filter((r) => r.report || r.error || this.pending.has(r.id)),
    };
  }

  /**
   * Reads the providers that are due. A manual refresh (of `only` one id, or
   * all) ignores the schedule and any rejection backoff, but is spaced so a
   * click cannot queue reads back to back.
   */
  async refresh({ manual = false, only = null, onProgress = () => {} } = {}) {
    const now = Date.now();
    const chosen = this.providers.filter((p) => (only ? p.id === only : true));
    const due = chosen.filter((p) => {
      if (this.pending.has(p.id)) return false;
      if (!manual) return this.state[p.id].due <= now;
      if (now - (this.lastManual[p.id] ?? 0) < MANUAL_SPACING) return false;
      this.lastManual[p.id] = now;
      this.state[p.id] = { due: 0, rejected: 0 };
      return true;
    });
    for (const p of due) this.pending.add(p.id);
    if (due.length) onProgress();
    await Promise.all(due.map((p) => this.read(p, onProgress)));
  }

  async read(provider, onProgress) {
    const reading = this.readings[provider.id];
    const state = this.state[provider.id];
    try {
      const report = await provider.fetch(this.io);
      if (report) {
        const sections = (report.sections ?? []).map((s) => (s.windows ? { ...s, windows: s.windows.map(clampWindow) } : s));
        Object.assign(reading, { report: { ...report, windows: report.windows.map(clampWindow), sections, balances: report.balances ?? [] }, updated: Date.now(), error: null, stale: false });
      } else {
        // Signed out: drop the provider's numbers instead of showing old ones.
        Object.assign(reading, { report: null, updated: null, error: null, stale: false });
      }
      state.rejected = 0;
      state.due = Date.now() + REFRESH;
    } catch (error) {
      reading.error = error.message ?? String(error);
      reading.stale = Boolean(reading.report);
      if (error.kind === "rejected") {
        state.rejected += 1;
        state.due = Date.now() + Math.min(REFRESH * 2 ** (state.rejected - 1), REJECTED_LIMIT);
      } else {
        state.due = Date.now() + (error.kind === "rate_limited" ? RATE_LIMITED : ERROR_BACKOFF);
      }
    }
    this.pending.delete(provider.id);
    onProgress();
  }
}

/** A service can report past 100% (overage); the meters and pace read 0..100. */
function clampWindow(w) {
  return { ...w, used: Math.min(100, Math.max(0, w.used)) };
}
