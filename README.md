# herdr-github

The open pull requests and issues of the repo you're in, in a side pane of [herdr](https://herdr.dev).

![The GitHub panel in herdr](docs/preview.svg)

Each row shows the title (up to 2 lines), the description (up to 3 lines) and a meta line:

- **Pull requests:** number, author and branch, a Draft chip, the review state (Approved, Changes requested, Review), the checks (✓ passed, ● pending, ✗ failed) and the age.
- **Issues:** number and author, up to 3 labels in their GitHub colors, and the age.

It is the terminal twin of the GitHub panel in [Whole Herdr](https://github.com/luongnv89/whole-herdr), a layout for the Herdr desktop app.

## Install

```sh
herdr plugin install luongnv89/herdr-github
```

Then bind a key to it in `~/.config/herdr/config.toml`. `prefix+i` is free in herdr's default keys:

```toml
[[keys.command]]
key = "prefix+i"
type = "plugin_action"
command = "herdr-github.toggle"
description = "GitHub panel"
```

Run `herdr server reload-config` to load the key. Without a key, run `herdr plugin action invoke herdr-github.toggle`.

To update, run `herdr plugin update herdr-github`. To remove it, run `herdr plugin uninstall herdr-github`.

## Use

Press the key in any pane. The panel opens on the right, about a third of the tab wide. Press the key again in that tab to close it.

- **Which repo:** the folder of the last pane you focused in the panel's tab. It follows you when you `cd` or move to another pane.
- **Keys:**
  - `↑`/`↓` or `j`/`k` select, page up/down jump, `g`/`G` go to the top or bottom;
  - enter opens the selected row in your browser;
  - tab or `←`/`→` switches between pull requests and issues, `1` and `2` choose one;
  - `r` refreshes, `o` opens the repo on GitHub;
  - `q` or esc closes the panel.
- **Mouse:** click a row to open it, click the switch to change lists, click `↻` or `↗` in the header, and scroll with the wheel. This needs `ui.mouse_capture = true` in your herdr config.
- **Fetching:** when the repo changes, every 2 minutes while the panel's tab is on screen, and on `r`. A panel in a tab you aren't looking at doesn't fetch.
- **Lists:** the 50 most recently updated of each. The panel remembers which list you chose.

## Needs

- herdr 0.9.5 or later, on macOS or Linux.
- Node 18 or later, as `node` on the `PATH` of the herdr server.
- [`gh`](https://cli.github.com), logged in (`gh auth login`).

## What it runs

A herdr plugin runs as your user, with no sandbox. This one:

- runs `git` and `gh` in the repo's folder to read the repo and its open pull requests and issues;
- runs `herdr` to find the focused pane, and to open, resize and close its own pane;
- runs `open` (macOS) or `xdg-open` (Linux) when you open a row or the repo;
- writes only under its herdr state folder (`~/.local/state/herdr/plugins/herdr-github/` on macOS): which list you chose, and the ids of its open panes.

It sends nothing anywhere except through `gh`, to GitHub.

## Troubleshooting

- **"Not a git repository":** the focused pane's folder isn't inside a git repo. `cd` into one, or focus a pane that is.
- **A `gh` error in red:** run the same command in that folder, for example `gh pr list`, to see the full message. Most often `gh` isn't logged in.
- **Nothing opens:** check the action's log with `herdr plugin log list --plugin herdr-github`.
- **Panes on saved SSH machines** are untested. The panel runs `git` and `gh` on the computer where its herdr server runs.

## Develop

```sh
git clone https://github.com/luongnv89/herdr-github
cd herdr-github
herdr plugin link "$PWD"
node --test
```

A linked plugin runs straight from your folder, so a change shows the next time the panel opens. `node panel.js` also runs the panel in any terminal, for the current folder.

- `herdr-plugin.toml`: the manifest, with one action (`toggle`) and one pane (`panel`).
- `toggle.js`: opens the panel beside the focused pane, or closes it.
- `panel.js`: the panel itself. Plain Node, no npm packages.
- `test/`: unit tests for the text and row rendering.

## License

[MIT](LICENSE)
