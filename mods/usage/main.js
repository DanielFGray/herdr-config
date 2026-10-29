// The status bar, with plan usage and system load, after herdr-gpui's
// (system.js samples CPU, memory and load). Per signed-in agent
// service, a meter for the window closest to its limit. A click opens that
// service's details (this same mod, as a popup, with props.panel set): every
// window with what is left, time to reset and pace against an even spend.
// Only the bar copy reads the services; the popup renders what the bar
// publishes through shared("usage").
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, readTextFile, home, theme, shared, setShared, props, run, nextCommand, openOverlay, closeOverlay, appHome, spaces, agents, window, keys } from "herdr";
import { UsageService } from "./service.js";
import { resetIn, ago, severityColor, tightest, pace, describePace } from "./format.js";
import { SystemLoad, HISTORY, INTERVAL as SYSTEM_INTERVAL, memoryPercent, gigabytes, uptime } from "./system.js";

const STORAGE_KEY = "usage.v1";
const METER_WIDTH = 40;
const PANEL_WIDTH = 340;
const FONT = 12;
const SMALL = FONT * 0.9;
// herdr-gpui's system load thresholds: yellow from these, red from 90%.
const CPU_WARN = 75;
const MEMORY_WARN = 80;
const SPARK_HEIGHT = 11;

export default class Usage extends View {
  init(_props, cx) {
    this.size = null;
    if (props()?.panel) return;
    this.system = new SystemLoad((path) => readTextFile(path));
    const sample = (cx) => cx.spawn(async (cx) => (await this.system.sample()) && cx.notify());
    cx.timer.every(SYSTEM_INTERVAL, sample);
    sample(cx);
    cx.spawn(async (cx) => {
      const config = (await readConfig()) ?? {};
      this.service = new UsageService(await herdrIo(), { providers: config.providers, saved: load() });
      const publish = (cx) => {
        const snapshot = this.service.snapshot();
        save(snapshot);
        setShared("usage", snapshot);
        cx.notify();
      };
      publish(cx);
      // The popup is another copy of this mod: it asks for a refresh with the
      // `usage.refresh` command, naming the provider in shared("usage.refresh").
      cx.spawn(async (cx) => {
        for (;;) {
          if ((await nextCommand()) !== "refresh") continue;
          const only = shared("usage.refresh")?.id ?? null;
          this.service.refresh({ manual: true, only, onProgress: () => publish(cx) });
        }
      });
      // Reads are rare, so the clock ticks only to re-time "resets in" and
      // to start whichever reads have come due.
      cx.timer.every(30e3, (cx) => {
        this.service.refresh({ onProgress: () => publish(cx) });
        cx.notify();
      });
      await this.service.refresh({ onProgress: () => publish(cx) });
    });
  }

  render(cx) {
    const t = theme();
    const data = shared("usage") ?? { readings: [], busy: false };
    const panel = props()?.panel;
    return panel ? this.renderPanel(t, data.readings.find((r) => r.id === panel), data.pending?.includes(panel)) : this.renderBar(t, data);
  }

  // The one status bar: where you are (machine, branch, agents), a meter per
  // service (its numbers live in the popup), this machine's CPU, memory and
  // load, and the command palette hint.
  renderBar(t, data) {
    const space = spaces().find((s) => s.active);
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    // As herdr-gpui: only services with numbers, closest to a limit first
    // (a stable sort keeps equals in registry order). The rest wait in the popup.
    const shown = data.readings.filter(hasNumbers).sort((a, b) => urgency(b) - urgency(a));
    return h_flex()
      .size_full()
      .px(14)
      .gap(16)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.8)
      .text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), (el) => el.child(label("branch", space.branch)))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().size(6).rounded(3).bg(t.dim))
          .child(`${list.length} agents`)
          .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))),
      )
      .child(
        h_flex()
          .h_full()
          .gap(4)
          .items_center()
          .children(shown.map((r) => segment(t, r)))
          .child(
            div()
              .id("usage-refresh")
              .size(18)
              .flex()
              .items_center()
              .justify_center()
              .rounded(4)
              .hover((s) => s.bg(t.hover))
              .on_click(() => requestRefresh(null))
              .child(svg("mods/usage/refresh.svg").size(11).text_color(t.muted).when(data.busy, (e) => e.spin(1000))),
          ),
      )
      .child(div().flex_1())
      .when(this.system?.latest, (el) => el.child(systemLoad(t, this.system)))
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(`${paletteKey()}  commands`));
  }

  // herdr-gpui's usage panel: header, errors, then windows, balances and
  // sections ruled off from each other, then the actions.
  renderPanel(t, reading, refreshing) {
    const frame = v_flex().w(PANEL_WIDTH).p(4).bg(t.popover).text_size(FONT).text_color(t.foreground);
    if (!reading) return frame.child(block().text_color(t.muted).child("Not updated yet"));
    const report = reading.report;
    const groups = report
      ? [
          ...(report.windows.length ? [block().children(report.windows.map((w) => limit(t, w)))] : []),
          ...(report.balances.length ? [balances(t, report.balances)] : []),
          ...report.sections.map((s) => section(t, s)),
        ]
      : [];
    const updated = reading.updated ? `Updated ${ago(reading.updated)} ago` : refreshing ? "Updating…" : "Not updated yet";
    return frame
      .child(
        h_flex()
          .px(8)
          .py(6)
          .gap(12)
          .justify_between()
          .child(v_flex().flex_1().min_w(0).child(div().text_size(FONT * 1.25).font_semibold().child(reading.name)).child(div().truncate().text_size(SMALL).text_color(t.muted).child(updated)))
          .child(
            v_flex()
              .flex_none()
              .max_w(PANEL_WIDTH * 0.6)
              .items_end()
              .text_color(t.muted)
              .when(report?.email, (el) => el.child(div().max_w_full().truncate().child(report.email)))
              .when(report?.plan, (el) => el.child(div().text_size(SMALL).child(report.plan))),
          ),
      )
      .when(reading.error, (el) => el.child(div().px(8).pb(4).text_size(SMALL).text_color(t.ansi3).child(reading.error)))
      .children(groups.flatMap((g) => [rule(t), g]))
      .child(rule(t))
      .child(action(t, "usage-refresh-one", "refresh", refreshing ? "Refreshing…" : "Refresh", () => !refreshing && requestRefresh(reading.id), refreshing))
      .child(
        action(t, "usage-open", "chart", "Usage Dashboard", () => {
          exec(home().startsWith("/Users") ? "open" : "xdg-open", [reading.dashboard]);
          closeOverlay(props().overlay);
        }),
      );
  }
}

/**
 * `CPU ▁▃▂▅ 12%  MEM ━━─ 61%  LOAD 0.73 1.05 1.10`, as herdr-gpui's status
 * bar draws it, with the details on hover.
 */
function systemLoad(t, system) {
  const { cpu, cores, memory, load, uptime: up } = system.latest;
  const label = (name) => div().flex_none().text_color(t.muted).child(name);
  const item = () => h_flex().flex_none().items_center().gap(5);
  // Load per core reads as a share of the machine, so it warns as CPU does.
  const perCore = load && cores ? (load[0] / cores) * 100 : 0;
  const details = [
    "This computer",
    `${cpu === null ? "CPU measuring…" : `CPU ${Math.round(cpu)}%`}${cores ? ` of ${cores} cores` : ""}${load ? ` · load ${load.map((l) => l.toFixed(2)).join(" ")}` : ""}`,
    ...(memory ? [`Memory ${gigabytes(memory.used)} of ${gigabytes(memory.total)} (${Math.round(memoryPercent(memory))}%)`] : []),
    ...(up ? [`Up ${uptime(up)}`] : []),
  ].join("\n");
  return h_flex()
    .id("system-load")
    .flex_none()
    .h_full()
    .px(6)
    .gap(10)
    .items_center()
    .tooltip(details)
    .child(item().child(label("CPU")).child(sparkline(t, system.history)).when(cpu !== null, (el) => el.child(share(t, cpu, CPU_WARN))))
    .when(memory, (el) => el.child(item().child(label("MEM")).child(loadMeter(t, memoryPercent(memory), MEMORY_WARN)).child(share(t, memoryPercent(memory), MEMORY_WARN))))
    .when(load, (el) =>
      el.child(
        item()
          .child(label("LOAD"))
          .child(div().text_color(loadSeverity(perCore, CPU_WARN, t, t.foreground)).child(load[0].toFixed(2)))
          .child(div().text_color(t.muted).child(`${load[1].toFixed(2)} ${load[2].toFixed(2)}`)),
      ),
    );
}

/** The global key that opens the palette, as the hint shows it: "ctrl-shift-p" → "Ctrl Shift P". */
function paletteKey() {
  const bound = keys().find((k) => k.section === "global" && k.action === "app.palette")?.keys;
  if (!bound) return "Palette:";
  const mac = window()?.platform === "macos";
  return bound
    .split("-")
    .map((part) => (part === "cmd" || (mac && part === "ctrl") ? "⌘" : part[0].toUpperCase() + part.slice(1)))
    .join(" ");
}

/** Recent CPU usage as thin bars, oldest on the left; empty slots wait on the left until the history fills. */
function sparkline(t, history) {
  const slots = [...Array(HISTORY - history.length).fill(null), ...history];
  return h_flex()
    .flex_none()
    .items_end()
    .gap(1)
    .h(SPARK_HEIGHT)
    .children(slots.map((v) => (v === null ? div().w(2).h(1).rounded(0.5).bg(t.hover) : div().w(2).h(Math.max(1, (SPARK_HEIGHT * v) / 100)).rounded(0.5).bg(loadSeverity(v, CPU_WARN, t, t.muted)))));
}

function loadMeter(t, used, warn) {
  return div()
    .w(32)
    .h(5)
    .flex_none()
    .rounded_full()
    .overflow_hidden()
    .bg(t.hover)
    .child(div().h_full().w((32 * used) / 100).rounded_full().bg(loadSeverity(used, warn, t, t.muted)));
}

/** "12%", wide enough for "100%" so the bar does not shift as the number changes. */
function share(t, value, warn) {
  return div().flex_none().min_w(28).text_color(loadSeverity(value, warn, t, t.foreground)).child(`${Math.round(value)}%`);
}

/** `normal` below `warn`, yellow from it, red from 90%. */
function loadSeverity(value, warn, t, normal) {
  return value >= 90 ? t.ansi1 : value >= warn ? t.ansi3 : normal;
}

/** A bar segment: name, a meter of the tightest window, "!" when the last read failed. */
function segment(t, reading) {
  const report = reading.report;
  const worst = tightest(report.windows);
  const balance = !worst && report.balances[0];
  return h_flex()
    .id(`usage-${reading.id}`)
    .flex_none()
    .h_full()
    .gap(6)
    .px(6)
    .items_center()
    .rounded(4)
    .hover((s) => s.bg(t.hover))
    .on_click(() => openOverlay({ mod: "usage", kind: "popup", props: { panel: reading.id }, width: PANEL_WIDTH }))
    .child(div().text_color(t.foreground).child(reading.name))
    .when(worst, (el) => el.child(meter(t, worst.used)))
    // A service that meters money rather than a window shows what is left or spent.
    .when(balance, (el) => el.child(money(balance.amount)))
    // The numbers are the last good ones; the popup says why.
    .when(reading.error, (el) => el.child(div().flex_none().text_color(t.ansi3).child("!")));
}

/** "Weekly 89% left", its reset, a bar of what is left with a tick where an even spend would have left it, and whether the rest lasts. */
function limit(t, w) {
  const p = pace(w);
  return v_flex()
    .gap(4)
    .child(
      h_flex()
        .justify_between()
        .gap(8)
        .child(div().font_semibold().child(`${w.label} ${100 - Math.round(w.used)}% left`))
        .when(w.resetsAt != null, (el) => el.child(div().flex_none().text_size(SMALL).text_color(t.muted).child(`Resets in ${resetIn(w.resetsAt)}`))),
    )
    .child(bar(t, 100 - w.used, w.used, p))
    .when(p, (el) => el.child(div().text_size(SMALL).text_color(t.muted).child(describePace(p, w.used))));
}

/** One row per balance; one with a total gets a bar of what is left. */
function balances(t, list) {
  return block().children(
    list.map((b) => {
      const row = h_flex()
        .justify_between()
        .gap(8)
        .child(div().text_color(t.muted).child(b.label))
        .child(div().font_semibold().child(b.total != null ? `${money(b.amount)} of ${money(b.total)}` : money(b.amount)));
      if (!(b.total > 0)) return row;
      const left = Math.min(100, Math.max(0, (b.amount / b.total) * 100));
      return v_flex().gap(4).child(row).child(bar(t, left, 100 - left, null));
    }),
  );
}

function section(t, s) {
  return block()
    .child(div().font_semibold().child(s.title))
    .children((s.windows ?? []).map((w) => limit(t, w)))
    .children((s.facts ?? []).map(([k, v]) => h_flex().justify_between().gap(8).text_size(SMALL).child(div().text_color(t.muted).child(k)).child(div().child(v))));
}

/** Padding every panel group shares, so they line up. */
function block() {
  return v_flex().px(8).py(6).gap(4);
}

function rule(t) {
  return div().h(1).my(6).bg(t.hover);
}

function action(t, id, icon, label, onClick, disabled = false) {
  return h_flex()
    .id(id)
    .px(8)
    .py(6)
    .gap(8)
    .items_center()
    .rounded(4)
    .text_color(disabled ? t.muted : t.foreground)
    .hover((s) => s.bg(t.hover))
    .on_click(onClick)
    .child(svg(`mods/usage/${icon}.svg`).size(14).flex_none())
    .child(label);
}

/** The panel's full-width bar, filled to `fill` percent and coloured by how much is `used`; the tick marks where an even spend would have left it. */
function bar(t, fill, used, p) {
  return div()
    .relative()
    .w_full()
    .h(6)
    .rounded_full()
    .bg(t.hover)
    .child(div().h_full().w(`${Math.min(100, Math.max(0, fill))}%`).rounded_full().bg(severityColor(used, t, t.accent)))
    .when(p, (el) => el.child(div().absolute().top(-2).h(10).w(2).left(`${Math.min(100, Math.max(0, 100 - p.expected))}%`).bg(t.foreground)));
}

/** The status bar's small meter of what is used. */
function meter(t, used) {
  return div()
    .w(METER_WIDTH)
    .h(5)
    .flex_none()
    .rounded_full()
    .overflow_hidden()
    .bg(t.hover)
    .child(div().h_full().w((METER_WIDTH * used) / 100).rounded_full().bg(severityColor(used, t, t.muted)));
}

const money = (amount) => `$${amount.toFixed(2)}`;
const hasNumbers = (r) => r.report && (r.report.windows.length > 0 || r.report.balances.length > 0);
const urgency = (r) => tightest(r.report?.windows ?? [])?.used ?? 0;

/** Asks the bar copy to read one provider, or all with `id` null, now. */
function requestRefresh(id) {
  setShared("usage.refresh", { id, at: Date.now() });
  run("usage.refresh");
}


async function herdrIo() {
  const names = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_DATA_HOME", "ANTHROPIC_BASE_URL", "OPENCODE_API_KEY"];
  const r = await exec("sh", ["-c", names.map((n) => `printf '%s\\n' "\${${n}}"`).join(";")]);
  const env = Object.fromEntries(r.stdout.split("\n").map((v, i) => [names[i], v]).filter(([, v]) => v));
  return {
    home: home(),
    env,
    now: () => Date.now(),
    readText: (path) => readTextFile(path),
    exec: async (cmd, args) => {
      const out = await exec(cmd, args);
      return { code: out.code, stdout: out.stdout };
    },
    fetch: async (url, options) => {
      const response = await fetch(url, options);
      return { status: response.status, text: await response.text() };
    },
  };
}

/** Optional `usage.json` in the app folder: { "providers": ["claude", ...] }. */
async function readConfig() {
  try {
    const text = await readTextFile(`${appHome()}/usage.json`);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function save(snapshot) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(snapshot.readings.map((r) => [r.id, { report: r.report, updated: r.updated }]))));
  } catch {
    // Storage can be unavailable; the bar works without it.
  }
}
