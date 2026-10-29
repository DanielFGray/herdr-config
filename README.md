# Herdr: status bar and prefix keys

Additions for the [Herdr app](https://herdr.dev):

- **A single status bar** that shows plan usage (Claude, Codex, OpenCode,
  Cursor) with pace against an even spend. It also shows this computer's
  CPU sparkline, memory and load average.
- **tmux-style prefix keys:** Ctrl+A, then a key.
- **Catppuccin** Latte (light) and Mocha (dark) themes.

![preview](preview.png)

[RECIPE.md](RECIPE.md) describes what each part does and how it is built.

## Install

Ask your agent to add this layout, or copy these folders into
`~/.config/herdr-app`:
`layouts/main-usage.json`, `mods/usage/`, `mods/prefix/` and
`themes/catppuccin-*.json`. Then:

```sh
herdr-app check ~/.config/herdr-app/mods/usage
herdr-app check ~/.config/herdr-app/mods/prefix
herdr-app do layout.switch --name main-usage
```

To use the prefix keys, add this to the `global` section of `keys.json`:

```json
"ctrl-a": "mod.open:prefix"
```

To use the themes, add this to `settings.json`:

```json
"theme": { "light": "catppuccin-latte", "dark": "catppuccin-mocha" }
```

The prefix bindings are in `mods/prefix/bindings.json`. To read only some
services, write `~/.config/herdr-app/usage.json` with
`{ "providers": ["claude", "codex"] }`.

## Notes

- **Linux only:** system load reads `/proc`, so it shows on Linux only.
- **Undocumented endpoints:** usage is read from the services'
  undocumented endpoints, with the sign-ins their CLIs saved on this
  machine. Nothing is sent anywhere else.

## License

Apache-2.0; see [LICENSE](LICENSE).

## Credits

The usage pace and countdown maths, the system load sampling and the look
of both are adapted from
[herdr-gpui](https://github.com/penso/herdr-gpui) (Apache-2.0). Icons are
from [Lucide](https://lucide.dev) (ISC). Colors are from
[Catppuccin](https://catppuccin.com) (MIT).
