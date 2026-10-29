// This machine's CPU, memory and load average, after herdr-gpui's
// system_load: sampled from /proc every couple of seconds, with recent CPU
// usage kept for a sparkline. Linux only; elsewhere the files are absent and
// `sample` returns null.

/** CPU samples kept for the sparkline. */
export const HISTORY = 16;
export const INTERVAL = 2e3;

export class SystemLoad {
  constructor(read) {
    this.read = read;
    this.ticks = null;
    this.history = [];
    this.latest = null;
  }

  /** Takes one sample; false when /proc could not be read (nothing to show). */
  async sample() {
    const [stat, meminfo, loadavg, uptime] = await Promise.all(["/proc/stat", "/proc/meminfo", "/proc/loadavg", "/proc/uptime"].map((p) => this.read(p).catch(() => null)));
    if (!stat || !meminfo) return false;
    const ticks = parseTicks(stat);
    // CPU usage is measured between two samples, so the first has none.
    const cpu = ticks && this.ticks ? usageSince(ticks, this.ticks) : null;
    this.ticks = ticks;
    if (cpu !== null) this.history = [...this.history, cpu].slice(-HISTORY);
    this.latest = { cpu, cores: countCores(stat), memory: parseMemory(meminfo), load: loadavg ? parseLoad(loadavg) : null, uptime: uptime ? Math.floor(parseFloat(uptime)) : null };
    return true;
  }
}

/** The `cpu` line of /proc/stat: `user nice system idle iowait irq softirq steal …`; guest time is already in user time, so only the first eight columns add up. */
export function parseTicks(stat) {
  const line = stat.split("\n").find((l) => l.startsWith("cpu "));
  const columns = line?.slice(4).trim().split(/\s+/).slice(0, 8).map(Number);
  if (!columns || columns.length < 4 || columns.some(Number.isNaN)) return null;
  const total = columns.reduce((a, b) => a + b, 0);
  return { busy: total - columns[3] - (columns[4] ?? 0), total };
}

/** Share of all cores busy between two samples, 0..100; null if the counters went backwards. */
export function usageSince(now, previous) {
  const total = now.total - previous.total;
  const busy = now.busy - previous.busy;
  if (total <= 0 || busy < 0) return null;
  return Math.min(100, Math.max(0, (busy / total) * 100));
}

/** Bytes in use: total less available, as `free` and sysinfo count it. */
export function parseMemory(meminfo) {
  const kb = (key) => Number(meminfo.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1]);
  const total = kb("MemTotal") * 1024;
  const available = kb("MemAvailable") * 1024;
  return total > 0 && available >= 0 ? { used: total - available, total } : null;
}

export function parseLoad(loadavg) {
  const load = loadavg.trim().split(/\s+/).slice(0, 3).map(Number);
  return load.length === 3 && !load.some(Number.isNaN) ? load : null;
}

function countCores(stat) {
  return stat.split("\n").filter((l) => /^cpu\d+ /.test(l)).length || null;
}

export const memoryPercent = (m) => Math.min(100, Math.max(0, (m.used / m.total) * 100));

/** Binary gigabytes, as `free -h` counts them: "7.0 GB". */
export const gigabytes = (bytes) => `${(bytes / 2 ** 30).toFixed(1)} GB`;

/** How long the machine has been up, in its two largest units: "116d 0h", "3h 12m", "12m". */
export function uptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds / 3600) % 24;
  const minutes = Math.floor(seconds / 60) % 60;
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}
