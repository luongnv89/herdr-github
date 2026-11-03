# herdr-github

The open pull requests and issues of the repo you're in, in a side pane of [herdr](https://herdr.dev). Works with GitHub and GitLab, including self-hosted GitLab and GitHub Enterprise.

![The GitHub panel in herdr](docs/preview.svg)

Each row shows the title (up to 2 lines), the description (up to 3 lines) and a meta line:

- **Pull requests** (merge requests on GitLab): number, author and branch, a Draft chip, the review state (Approved, Changes requested, Review), the checks (✓ passed, ● pending, ✗ failed) and the age.
- **Issues:** number and author, up to 3 labels in their colors, and the age.

The selected row also shows its URL on one more line.

On GitLab, merge requests show as `!123` and have no checks mark: the list doesn't carry pipeline status. Their review state shows Changes requested and Review, but not Approved.

Click a pull request or issue, or select it and press enter, to open it in your browser. Clicking needs `ui.mouse_capture = true` in your herdr config. On a remote machine, see [Remote machines](#remote-machines).

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
description = "PR and issue panel"
```

Run `herdr server reload-config` to load the key. Without a key, run `herdr plugin action invoke herdr-github.toggle`.

To update, run `herdr plugin update herdr-github`. To remove it, run `herdr plugin uninstall herdr-github`.

## Use

Press the key in any pane. The panel opens on the right, about a third of the tab wide. Press the key again in that tab to close it.

- **Which repo:** the folder of the last pane you focused in the panel's tab. It follows you when you `cd` or move to another pane.
- **Which site:** read from the repo's `origin` remote (or its first remote). A host name containing `github` uses `gh`, one containing `gitlab` uses `glab`, and any other host tries `gh`, then `glab`.
- **Keys:**
  - `↑`/`↓` or `j`/`k` select, page up/down jump, `g`/`G` go to the top or bottom;
  - enter opens the selected row in your browser;
  - tab or `←`/`→` switches between pull requests and issues, `1` and `2` choose one;
  - `r` refreshes, `o` opens the repo on GitHub or GitLab;
  - `a` resolves the selected issue, or reviews the selected pull request, with your agent (see [Resolve and review with your agent](#resolve-and-review-with-your-agent));
  - `q` or esc closes the panel.
- **Mouse:** click a row to open it, click the switch to change lists, click `Resolve #N` or `Review #N`, `↻` or `↗` in the header, and scroll with the wheel. This needs `ui.mouse_capture = true` in your herdr config. On a remote machine, Ctrl-click the selected row's URL instead (see [Remote machines](#remote-machines)).
- **When a row can't be opened:** the panel shows why in red, a hint to Ctrl- or Cmd-click the URL, and the whole URL above the key hints. The URL is a terminal hyperlink too. Any key, or the next open, clears it.
- **Fetching:** when the repo changes, every 2 minutes while the panel's tab is on screen, and on `r`. A panel in a tab you aren't looking at doesn't fetch.
- **Lists:** the 50 most recently opened of each on GitHub, and the 50 most recently updated on GitLab. The panel remembers which list you chose.

## Resolve and review with your agent

On GitHub, the header shows a button for the selected row: **Resolve #N** on the issues list, **Review #N** on the pull requests list. Click it, or press `a`, and the panel:

1. finds your agent: the one in the pane the panel follows, else one in the panel's tab (`herdr agent list`);
2. checks that the skill is installed for that kind of agent: `issue-resolver` for an issue, `issue-pr-review` for a pull request;
3. opens a new pane below your agent, in the repo's folder, and starts the same kind of agent there (`herdr pane split`, then `herdr agent start`);
4. sends it the skill and the number, for Claude `/issue-resolver 12` or `/issue-pr-review 34`; other agents get "Use the issue-resolver skill on issue #12." Nothing from the title or description goes into the prompt.

Your own agent and its conversation are left alone. The panel shows what it is doing above the key hints, in yellow while it starts the agent, green once the prompt is sent, and red with the reason when something fails. A pane whose agent failed to start is closed again, unless the agent is waiting for an answer from you, such as a folder trust question.

If the skill isn't installed, nothing starts and the panel points you to [luongnv.com/idd](https://luongnv.com/idd) to install the skills. It looks for `<skill>/SKILL.md` in the `skills` folder of `~/.claude`, `~/.agents`, `~/.codex` and `~/.<agent>`, and of the same folders in the repo. For Claude it also looks in installed plugins and sends a plugin's skill under the plugin's name, such as `/idd:issue-resolver 12`.

The button doesn't show on GitLab, because both skills work through `gh`.

## Remote machines

A click or enter runs `open` (macOS) or `xdg-open` (Linux) on the computer where the panel runs, which is the computer where its herdr server runs. When that is a remote machine, it usually has no browser, so the panel shows the reason and the URL instead of opening it. To open a row on your own computer:

- **`herdr --remote`, or a pane on a saved SSH machine:** select the row, then Ctrl-click the URL shown under it. herdr opens a plain `https://` URL in the browser of the computer running the herdr client, which is yours. herdr 0.9.5 doesn't do this for terminal hyperlinks (OSC 8), so Ctrl-clicking the title does nothing. The URL has to fit on one line: in a panel too narrow for it, the panel breaks it after `https://` so it can't open a cut-off address, and you need to widen the panel to Ctrl-click it.
- **You `ssh` in, then run `herdr` there:** select and copy the URL the panel shows. Mouse capture sends your clicks to herdr, so hold your terminal's bypass modifier while you drag, for example Shift, or Option in some macOS terminals.
- **A remote Mac:** `open` works there, so the row opens in a browser on that Mac's own screen, not yours.

A plain click on a remote machine still can't open a browser on your computer.

## Needs

- herdr 0.9.5 or later, on macOS or Linux.
- Node 18 or later, as `node` on the `PATH` of the herdr server.
- For GitHub repos, [`gh`](https://cli.github.com), logged in (`gh auth login`; add `--hostname` for GitHub Enterprise).
- For GitLab repos, [`glab`](https://gitlab.com/gitlab-org/cli), logged in (`glab auth login`; add `--hostname` for a self-hosted GitLab).

## What it runs

A herdr plugin runs as your user, with no sandbox. This one:

- runs `git` in the repo's folder to find its remote, then `gh` or `glab` there to read the repo and its open pull requests (or merge requests) and issues;
- runs `herdr` to find the focused pane, and to open, resize and close its own pane;
- when you click Resolve or Review, or press `a`: runs `herdr` to list the agents, split a new pane below yours, start the same kind of agent in it and send it the skill and the number, and reads the skill folders listed under [Resolve and review with your agent](#resolve-and-review-with-your-agent);
- runs `open` (macOS) or `xdg-open` (Linux) when you open a row or the repo, on the computer where its herdr server runs (see [Remote machines](#remote-machines));
- writes only under its herdr state folder (`~/.local/state/herdr/plugins/herdr-github/` on macOS): which list you chose, and the ids of its open panes.

It sends nothing anywhere except through `gh` to GitHub, or `glab` to GitLab.

## Troubleshooting

- **"Not a git repository":** the focused pane's folder isn't inside a git repo. `cd` into one, or focus a pane that is.
- **A `gh` or `glab` error in red:** run the same command in that folder, for example `gh pr list` or `glab mr list`, to see the full message. Most often the CLI isn't logged in.
- **"gh isn't installed" or "glab isn't installed":** the repo's site needs that CLI on the `PATH` of the herdr server. Install it (see [Needs](#needs)) and log in.
- **"No GitHub or GitLab remote":** the repo has no remote, or only a local-path one. Pull requests and issues live on a hosting site, so there is nothing to list.
- **Grey label dots on GitLab:** the label colors come from `glab label list`, which failed. Check `glab auth status`.
- **A row doesn't open, and the panel shows its URL with a red reason:** `open` or `xdg-open` is missing or failed, most often because the panel runs on a remote machine. See [Remote machines](#remote-machines).
- **"The issue-resolver skill isn't installed" or "The issue-pr-review skill isn't installed":** install the skills from [luongnv.com/idd](https://luongnv.com/idd) for the agent named in the message, then try again.
- **"No agent in this tab":** Resolve and Review start the same kind of agent as yours. Start your agent (for example `claude`) in a pane of the panel's tab, focus it, and try again.
- **Saved SSH machines and `herdr --remote`:** the panel runs `git`, `gh` and `glab` on the computer where its herdr server runs. Ctrl-clicking the selected row's URL there to open it on your own computer hasn't been tested live yet.

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
- `test/`: unit tests for the text and row rendering, for reading GitHub and GitLab JSON, for which row a click opens, for what a failed open shows and how URLs and links are drawn, and for what Resolve and Review run, with a stand-in for `herdr`.

## License

[MIT](LICENSE)
