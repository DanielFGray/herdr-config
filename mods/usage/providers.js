// Plan-usage providers: each reads the sign-in its agent already keeps on
// disk, asks that service's usage endpoint, and returns a Report:
//   { id, name, plan, email, windows: [Window], balances: [..], sections: [..] }
//   Window = { label, used (percent 0..100+), resetsAt (ms epoch | null), length (ms | null) }
// Providers touch the machine only through `io`, so tests can run them under
// bun and the mod can run them under herdr:
//   io.home, io.env, io.now()
//   io.readText(path) -> string | null
//   io.exec(cmd, args) -> { code, stdout }
//   io.fetch(url, { method, headers, body }) -> { status, text }
// A provider returns null when its sign-in is absent (not shown) and throws a
// UsageError when the service answers badly.

export const SESSION = 5 * 3600e3;
export const WEEK = 7 * 86400e3;
export const MONTH = 30 * 86400e3;

export class UsageError extends Error {
  /** @param {"rejected"|"rate_limited"|"http"|"invalid"} kind */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

export const PROVIDERS = [
  { id: "claude", name: "Claude", dashboard: "https://claude.ai/settings/usage", fetch: claude },
  { id: "codex", name: "Codex", dashboard: "https://chatgpt.com/codex/settings/usage", fetch: codex },
  { id: "opencode", name: "OpenCode", dashboard: "https://opencode.ai/auth", fetch: opencode },
  { id: "cursor", name: "Cursor", dashboard: "https://cursor.com/dashboard?tab=usage", fetch: cursor },
];

// ---- Claude ---------------------------------------------------------------

const CLAUDE_URL = "https://api.anthropic.com/api/oauth/usage";

async function claude(io) {
  const dir = io.env.CLAUDE_CONFIG_DIR || `${io.home}/.claude`;
  // A Claude Code pointed at another endpoint, or signing in through a key
  // helper, is not using the OAuth login; the token left behind may be dead.
  const settings = parseJson(await io.readText(`${dir}/settings.json`)) ?? {};
  const base = io.env.ANTHROPIC_BASE_URL || settings.env?.ANTHROPIC_BASE_URL;
  if ((base && !/^https:\/\/api\.anthropic\.com(\/|$)/.test(base.trim())) || settings.apiKeyHelper) return null;

  const credentials = parseJson(await io.readText(`${dir}/.credentials.json`));
  const oauth = credentials?.claudeAiOauth;
  if (!oauth?.accessToken) return null;

  const email = await firstText(io, [`${dir}/.claude.json`, `${io.home}/.claude.json`], ".oauthAccount.emailAddress");
  const body = await get(io, CLAUDE_URL, {
    Authorization: `Bearer ${oauth.accessToken}`,
    "anthropic-beta": "oauth-2025-04-20",
    "User-Agent": "claude-code/2.1.0",
  });
  return parseClaude(body, { plan: claudePlan(oauth.subscriptionType, oauth.rateLimitTier), email });
}

export function parseClaude(body, account) {
  const usage = json(body);
  let windows = (usage.limits ?? []).flatMap((limit) => {
    let label;
    if (limit.kind === "session") label = "Session";
    else if (limit.kind === "weekly_all") label = "Weekly";
    else if (limit.kind === "weekly_scoped") label = limit.scope?.model?.display_name?.trim();
    else return [];
    if (!label || typeof limit.percent !== "number") return [];
    return [window(label, limit.percent, limit.resets_at, limit.kind === "session" ? SESSION : WEEK)];
  });
  if (!windows.length) {
    windows = [
      ["Session", usage.five_hour, SESSION],
      ["Weekly", usage.seven_day, WEEK],
    ].flatMap(([label, w, length]) =>
      typeof w?.utilization === "number" ? [window(label, w.utilization, w.resets_at, length)] : [],
    );
  }
  const sections = [];
  const shares = (usage.seven_day_breakdown?.rows ?? [])
    .filter((row) => row.display_name && row.percent > 0)
    .map((row) => [row.display_name, `${Math.round(row.percent)}%`]);
  if (shares.length) sections.push({ title: "This week by surface", facts: shares });
  if (usage.spend) {
    const { enabled, used, limit } = usage.spend;
    sections.push({
      title: "Extra usage",
      facts: [
        enabled
          ? ["This month", used && limit ? `${money(used)} of ${money(limit)}` : used ? money(used) : "On"]
          : ["Status", "Off"],
      ],
    });
  }
  return { ...account, windows, sections, balances: [] };
}

function claudePlan(subscription, tier) {
  if (!subscription) return null;
  const name = titleCase(subscription);
  const multiple = /_(\d+x)$/.exec(tier ?? "")?.[1];
  return multiple ? `${name} ${multiple}` : name;
}

function money({ amount_minor, currency, exponent }) {
  const exp = Math.min(exponent ?? 0, 6);
  const sign = amount_minor < 0 ? "-" : "";
  const abs = Math.abs(amount_minor);
  const scale = 10 ** exp;
  const value = exp ? `${Math.floor(abs / scale)}.${String(abs % scale).padStart(exp, "0")}` : `${abs}`;
  return `${sign}${value} ${String(currency ?? "").trim()}`.trim();
}

// ---- Codex ----------------------------------------------------------------

const CODEX_URL = "https://chatgpt.com/backend-api/wham/usage";

async function codex(io) {
  const auth = (await codexAuth(io)) ?? (await opencodeOpenaiAuth(io));
  if (!auth) return null;
  const headers = {
    Authorization: `Bearer ${auth.token}`,
    "User-Agent": "codex_cli_rs/0.1",
    "OpenAI-Beta": "codex-1",
    originator: "Codex Desktop",
  };
  if (auth.account) headers["ChatGPT-Account-Id"] = auth.account;
  return parseCodex(await get(io, CODEX_URL, headers));
}

async function codexAuth(io) {
  const file = parseJson(await io.readText(`${io.env.CODEX_HOME || `${io.home}/.codex`}/auth.json`));
  const token = file?.tokens?.access_token;
  return token ? { token, account: file.tokens.account_id } : null;
}

// OpenCode renews and saves this token itself; each poll reads the current file.
async function opencodeOpenaiAuth(io) {
  const file = await opencodeAuth(io);
  return file?.openai?.type === "oauth" && file.openai.access
    ? { token: file.openai.access, account: file.openai.accountId }
    : null;
}

export function parseCodex(body) {
  const usage = json(body);
  const windows = codexWindows(usage.rate_limit);
  const sections = [];
  const review = codexWindows(usage.code_review_rate_limit)[0];
  if (review) sections.push({ title: "Code review", windows: [{ ...review, label: "Code review" }] });
  if (usage.rate_limit_reset_credits)
    sections.push({ title: "Limit reset credits", facts: [["Available", String(usage.rate_limit_reset_credits.available_count)]] });
  if (usage.credits)
    sections.push({
      title: "Credits",
      facts: [["Balance", usage.credits.unlimited ? "Unlimited" : (usage.credits.balance ?? "0")]],
    });
  return {
    email: usage.email?.trim() || null,
    plan: usage.plan_type ? titleCase(usage.plan_type) : null,
    windows,
    sections,
    balances: [],
  };
}

// A window is known by its length; the slot it arrives in only decides when
// the length is missing or unfamiliar.
function codexWindows(limits) {
  return [
    ["Session", limits?.primary_window],
    ["Weekly", limits?.secondary_window],
  ].flatMap(([slot, w]) => {
    if (typeof w?.used_percent !== "number") return [];
    const length = w.limit_window_seconds ? w.limit_window_seconds * 1000 : null;
    const near = (target) => length !== null && Math.abs(length - target) <= 60e3;
    const label = near(SESSION) ? "Session" : near(WEEK) ? "Weekly" : slot;
    const resetsAt = timestamp(w.reset_at) ?? (w.reset_after_seconds != null ? Date.now() + w.reset_after_seconds * 1000 : null);
    return [{ label, used: w.used_percent, resetsAt, length }];
  });
}

// ---- OpenCode (Go subscription) --------------------------------------------

const OPENCODE_URL = "https://opencode.ai/zen/go/v1/usage";
const PERCENT_KEYS = ["usagePercent", "usedPercent", "percentUsed", "percent", "usage_percent", "used_percent", "utilization", "utilizationPercent", "utilization_percent"];
const RESET_IN_KEYS = ["resetInSec", "resetInSeconds", "resetSeconds", "reset_sec", "reset_in_sec", "resetsInSec", "resetsInSeconds", "resetIn", "resetSec"];
const RESET_AT_KEYS = ["resetAt", "resetsAt", "reset_at", "resets_at", "nextReset", "next_reset", "renewAt", "renew_at"];

async function opencode(io) {
  // Any key of the workspace reads its Go usage; the CLI saves one per entry.
  const auth = await opencodeAuth(io);
  const key = io.env.OPENCODE_API_KEY || auth?.["opencode-go"]?.key || auth?.opencode?.key;
  if (!key) return null;
  const response = await io.fetch(OPENCODE_URL, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": "herdr-usage" } });
  // A valid key whose workspace has no Go subscription: nothing to show.
  if (response.status === 403 && parseJson(response.text)?.error?.type === "EntitlementError") return null;
  return parseOpencode(check(response), io.now());
}

export function parseOpencode(body, now) {
  const usage = json(body).usage;
  if (!usage || typeof usage !== "object") throw new UsageError("invalid", "unexpected response");
  const windows = [
    ["Session", usage.rolling, SESSION],
    ["Weekly", usage.weekly, WEEK],
    ["Monthly", usage.monthly, MONTH],
  ].flatMap(([label, meterObject, length]) => {
    const m = meter(meterObject, now);
    return m ? [{ label, used: m.used, resetsAt: m.resetsAt, length }] : [];
  });
  if (!windows.length) throw new UsageError("invalid", "no usage windows");
  return { plan: "Go", email: null, windows, sections: [], balances: [] };
}

function meter(object, now) {
  if (!object || typeof object !== "object") return null;
  const first = (keys) => keys.map((k) => num(object[k])).find((v) => v !== null) ?? null;
  let used = first(PERCENT_KEYS);
  if (used === null) {
    const spent = first(["used", "usage", "consumed", "usedMicroCents"]);
    const limit = first(["limit", "total", "quota", "limitMicroCents"]);
    if (spent === null || !limit || limit <= 0) return null;
    used = (spent / limit) * 100;
  }
  const inSeconds = first(RESET_IN_KEYS);
  const at = RESET_AT_KEYS.map((k) => timestamp(object[k])).find((v) => v !== null && v !== undefined) ?? null;
  return { used, resetsAt: inSeconds !== null && inSeconds >= 0 ? now + inSeconds * 1000 : at };
}

async function opencodeAuth(io) {
  return parseJson(await io.readText(`${io.env.XDG_DATA_HOME || `${io.home}/.local/share`}/opencode/auth.json`));
}

// ---- Cursor ---------------------------------------------------------------

const CURSOR_BASE = "https://cursor.com";
const CURSOR_DBS = [
  "/.config/Cursor/User/globalStorage/state.vscdb",
  "/Library/Application Support/Cursor/User/globalStorage/state.vscdb",
];

// Cursor.app keeps its access token in a local SQLite state database; the
// dashboard API takes it as the WorkOS session cookie `<user id>::<token>`.
async function cursor(io) {
  const db = await firstExisting(io, CURSOR_DBS.map((p) => io.home + p));
  if (!db) return null;
  const read = async (key) => {
    const r = await io.exec("sqlite3", ["-readonly", db, `select value from ItemTable where key='${key}'`]);
    return r.code === 0 ? r.stdout.trim() || null : null;
  };
  const token = await read("cursorAuth/accessToken");
  const user = token && jwtSubject(token)?.split("|").pop();
  if (!user) return null;
  const cookie = `WorkosCursorSessionToken=${encodeURIComponent(`${user}::${token}`)}`;
  const headers = { Cookie: cookie, Accept: "application/json" };
  const summary = await get(io, `${CURSOR_BASE}/api/usage-summary`, headers);
  const email = (await read("cursorAuth/cachedEmail")) ?? null;
  return parseCursor(summary, { email });
}

export function parseCursor(body, account) {
  const summary = json(body);
  const end = timestamp(summary.billingCycleEnd);
  const start = timestamp(summary.billingCycleStart);
  const length = start && end && end > start ? end - start : MONTH;
  const individual = summary.individualUsage ?? {};
  const plan = individual.plan ?? {};
  const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const auto = finite(plan.autoPercentUsed);
  const api = finite(plan.apiPercentUsed);
  const ratio = (used, limit) => (num(limit) > 0 ? ((num(used) ?? 0) / num(limit)) * 100 : null);
  const overall = individual.overall ?? {};
  const team = summary.teamUsage ?? {};
  const pooled = team.pooled ?? {};
  const headline =
    finite(plan.totalPercentUsed) ??
    (auto !== null && api !== null ? (auto + api) / 2 : null) ??
    api ??
    auto ??
    ratio(plan.used, plan.limit) ??
    ratio(overall.used, overall.limit) ??
    ratio(pooled.used, pooled.limit) ??
    0;
  const windows = [{ label: "Monthly", used: headline, resetsAt: end, length }];
  for (const [label, used] of [["Auto + Composer", auto], ["API", api]])
    if (used !== null) windows.push({ label, used, resetsAt: end, length });

  const sections = [];
  const cents = (v) => (num(v) ?? 0) / 100;
  const included = [[plan.used, plan.limit], [overall.used, overall.limit], [pooled.used, pooled.limit]].find(
    ([u, l]) => num(u) > 0 || num(l) > 0,
  );
  if (included)
    sections.push({ title: "Included usage", facts: [["This cycle", `$${cents(included[0]).toFixed(2)} of $${cents(included[1]).toFixed(2)}`]] });

  // A personal cap wins; a team with no member cap shares one budget.
  const onDemand = individual.onDemand ?? {};
  const teamOnDemand = team.onDemand ?? {};
  const personalUsed = cents(onDemand.used);
  let used = personalUsed;
  let limit = null;
  let label = "On-demand";
  if (num(onDemand.limit) > 0) limit = cents(onDemand.limit);
  else if (num(teamOnDemand.limit) > 0) {
    used = cents(teamOnDemand.used);
    limit = cents(teamOnDemand.limit);
    label = "Team on-demand";
  }
  const balances = [];
  if (limit !== null) balances.push({ label: `${label} left`, amount: Math.max(limit - used, 0), total: limit, unit: "USD" });
  else if (used > 0) balances.push({ label: `${label} spend`, amount: used, total: null, unit: "USD" });
  if (limit !== null && (used > 0 || label === "Team on-demand")) {
    const facts = [["Spent this cycle", `$${used.toFixed(2)}`]];
    if (label === "Team on-demand" && personalUsed > 0) facts.push(["Your share", `$${personalUsed.toFixed(2)}`]);
    sections.push({ title: label, facts });
  }
  return {
    email: account.email,
    plan: summary.membershipType ? `Cursor ${cursorMembership(summary.membershipType)}` : null,
    windows,
    sections,
    balances,
  };
}

function cursorMembership(kind) {
  const names = { enterprise: "Enterprise", express: "Start", free: "Free", free_trial: "Pro Trial", hobby: "Hobby", pro: "Pro", pro_student: "Pro", pro_plus: "Pro+", team: "Team", ultra: "Ultra" };
  return names[String(kind).toLowerCase()] ?? kind;
}

// ---- helpers ----------------------------------------------------------------

async function get(io, url, headers) {
  return check(await io.fetch(url, { headers }));
}

function check(response) {
  if (response.status === 401 || response.status === 403)
    throw new UsageError("rejected", parseJson(response.text)?.error?.message ?? `sign-in rejected (${response.status})`);
  if (response.status === 429) throw new UsageError("rate_limited", "rate limited");
  if (response.status < 200 || response.status >= 300) throw new UsageError("http", `HTTP ${response.status}`);
  return response.text;
}

function json(text) {
  const value = parseJson(text);
  if (value === null || typeof value !== "object") throw new UsageError("invalid", "unexpected response");
  return value;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function window(label, used, resets, length) {
  return { label, used, resetsAt: timestamp(resets), length };
}

/** Seconds, milliseconds, or an ISO date, as services variously send times. */
export function timestamp(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !/^\s*-?[\d.]+\s*$/.test(value)) {
    const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
    return Number.isNaN(ms) ? null : ms;
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e11 ? n : n * 1000;
}

/** A number a service may send as a string. */
function num(value) {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function titleCase(text) {
  return String(text)
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function jwtSubject(token) {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "="))).sub ?? null;
  } catch {
    return null;
  }
}

async function firstText(io, files, jqPath) {
  for (const file of files) {
    const r = await io.exec("jq", ["-r", `${jqPath} // empty`, file]).catch(() => null);
    if (r?.code === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

async function firstExisting(io, files) {
  for (const file of files) {
    const r = await io.exec("test", ["-f", file]).catch(() => null);
    if (r?.code === 0) return file;
  }
  return null;
}
