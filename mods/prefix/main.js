// tmux-style prefix keys. A global key (Ctrl+A in keys.json) opens this mod
// as a popup that takes the keyboard; the next key runs its action from
// bindings.json and closes it. Herdr's keys.json binds single keystrokes only,
// so the second key of the chord is read here.
//
// The popup draws nothing at first, so a quick chord does not flash it; after
// a pause it lists the bindings, as a reminder.
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, closeOverlay, commands, focused, hc, props, readTextFile, run, theme } from "herdr";

const REMIND_AFTER = 600;
// Keys that only modify another: pressing Shift on the way to "%" is not the chord.
const MODIFIERS = new Set(["shift", "control", "ctrl", "alt", "cmd", "platform", "function", "fn", "super"]);

export default class Prefix extends View {
  init(_props, cx) {
    this.bindings = null;
    this.remind = false;
    this.handle = cx.focus_handle();
    // The overlay is not focusable until its first frame, so focus after it.
    cx.timer.after(0, () => this.handle.focus());
    cx.timer.after(REMIND_AFTER, (cx) => {
      this.remind = true;
      cx.notify();
    });
    cx.spawn(async (cx) => {
      this.bindings = JSON.parse((await readTextFile(`${appHome()}/mods/prefix/bindings.json`)) ?? "{}");
      cx.notify();
    });
  }

  render() {
    const t = theme();
    return v_flex()
      .id("prefix")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        cx.stop_propagation();
        const key = chordKey(e);
        if (key === null) return;
        closeOverlay(props().overlay);
        const action = this.bindings?.[key]?.[0];
        if (action) perform(action);
      })
      .when(this.remind && this.bindings, (el) => el.child(reminder(t, this.bindings)));
  }
}

/** The binding name for a key event: the character it types ("%", "c"), or its keystroke when a modifier other than Shift is held ("ctrl-a") or it types nothing ("left", "escape"). Null for a modifier pressed alone. */
function chordKey(e) {
  if (MODIFIERS.has(e.key)) return null;
  const m = e.modifiers ?? {};
  const held = m.control || m.alt || m.platform || m.function;
  return !held && e.key_char ? e.key_char : e.keystroke;
}

/** Runs a keys.json-style action: "name" or "name:value", the value filling the command's first argument; "send-prefix" sends Ctrl+A on to the focused terminal. */
function perform(action) {
  if (action === "send-prefix") {
    const terminal = focused()?.terminal;
    if (terminal) hc(["keys", terminal, "ctrl+a"]);
    return;
  }
  const [name, value] = action.split(/:(.*)/s);
  if (value === undefined) return run(name);
  const first = commands().find((c) => c.name === name)?.args[0]?.name;
  run(name, { [first]: /^\d+$/.test(value) ? Number(value) : value });
}

/** Every binding as a key chip and what it does; keys sharing an action share a row. */
function reminder(t, bindings) {
  const rows = new Map();
  for (const [key, [action, label]] of Object.entries(bindings)) {
    const row = rows.get(action) ?? { label: label ?? action, keys: [] };
    row.keys.push(key);
    rows.set(action, row);
  }
  const chip = (key) => div().px(5).rounded(4).bg(t.raised).text_color(t.foreground).child(key);
  return v_flex()
    .w_full()
    .p(12)
    .gap(8)
    .rounded(8)
    .border(1)
    .border_color(t.border)
    .bg(t.popover)
    .text_size(12)
    .text_color(t.muted)
    .child(h_flex().gap(6).child(div().font_semibold().text_color(t.foreground).child("Prefix")).child("press a key · Esc cancels"))
    .child(
      h_flex()
        .flex_wrap()
        .gap_y(4)
        .children(
          [...rows.values()].map((r) =>
            h_flex()
              .w("33%")
              .gap(6)
              .items_center()
              .child(h_flex().gap(2).children(r.keys.map(chip)))
              .child(div().truncate().child(r.label)),
          ),
        ),
    );
}
