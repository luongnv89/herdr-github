# Changelog

## Unreleased

### Added

- Custom prompts for Resolve and Review (#20). Each action can send a prompt you write, with `{number}` where the issue's or pull request's number goes, instead of the IDD skill's `/issue-resolver <N>` or `/issue-pr-review <N>`; left empty, it sends the skill's prompt as before. The prompt is sent as written to every harness, and a custom prompt starts the agent even when the IDD skills aren't installed. Set it under the profiles, in the terminal panel's profiles view (the **Resolve prompt** and **Review prompt** rows) and in the app's (the two prompt boxes). A prompt must contain `{number}` and is refused with a backslash, a line break, a control or invisible character, a leading `-`, `!` or `#`, or more than 500 characters with the number filled in. Nothing else from the row goes into it.
- A **Resolve #N** button under every issue and a **Review #N** button under every pull request, on GitHub (#18). Each acts on its own row; the header button and `a` still act on the selected one. There are no buttons on GitLab, since both skills work through `gh`.
- Agent profiles (#18). A profile has a name, an id, a harness (Claude Code via `mcc run`, Claude Code, Codex, Pi or OpenCode) and an optional model and thinking level; an empty one leaves the harness's own default. Resolve and Review each get their own profile. Models with shell characters or brackets (such as `opus[1m]`) are refused. OpenCode has no model or thinking flag when it starts, so the panel says it ignores them.
- A profiles view in the terminal panel (`s`, or `⚙` in the header) and in the app (the gear, or `s`) to add, edit, delete and assign profiles. Both read and write `~/.config/herdr/plugins/config/herdr-github/profiles.json` on the machine where they run, and never overwrite a change the other made meanwhile, nor a file they can't read or that holds a profile they can't use. Both views work from the keyboard and the mouse.
- With mcc, the skills are looked up in the Claude Code folder `mcc env` names for the repo. The terminal panel says "Started" only once herdr sees Claude Code idle or working, and otherwise says mcc is waiting in the new pane, for example asking about a usage limit; the app says it opened the tab.
- The Herdr app mod is now in the repo, in `mods/herdr-github`, with the same buttons, profiles and default. Link or copy it into `~/.config/herdr-app/mods/herdr-github` to install it.

### Changed

- The profiles file holding a custom prompt is version 2, with a `prompts` entry; without one it stays version 1. Older versions of the panel show a version 2 file read only, so they never overwrite your prompts (#20).
- **Behavior change:** with no profile assigned, Resolve and Review start Claude Code through `mcc run`, instead of the same kind of agent as the one in your tab. Assign a profile to keep using another agent. The terminal panel no longer needs an agent in the tab: with none, the new pane opens below the pane the panel follows. In the app, the new tab opens in the space you're in.

### Fixed

- The app mod's `forge.js` no longer fails to load as a module (as on Node 26): a regular expression held raw line-separator characters. They are written as escapes now (#18).

## 0.4.0 (2026-11-04)

### Added

- A `bind-key` action that binds a key to the panel: `herdr plugin action invoke herdr-github.bind-key`. It adds `prefix+i` to herdr's `config.toml`, or the first free `prefix+` letter when `prefix+i` is taken, then reloads the config. It edits the config herdr reads, so it honors `HERDR_CONFIG_PATH` (#12), and it sees the keys a config with Windows (CRLF) line endings already uses (#13). It never rebinds a key that's in use, does nothing when the panel already has a key, and keeps a backup of the old config next to it. When `herdr config check` already fails before the edit, it changes nothing, exits 1 and quotes the first problem (#14). Herdr's plugin manifest can't declare keys, so this is a one-time step after installing.

## 0.3.0 (2026-11-03)

### Added

- **Resolve** and **Review** buttons in the header, for the selected issue or pull request on GitHub (#5, #6). A click, or `a`, opens a new pane below your agent, starts the same kind of agent there and sends it `/issue-resolver N` or `/issue-pr-review N`. Only the number goes into the prompt. If the skill isn't installed, nothing starts and the panel points you to https://luongnv.com/idd. The panel says when the agent starts, and why when it can't.

### Fixed

- A click on **Resolve** or **Review** now sends the command to the new agent, instead of leaving you to type `/issue-resolver N` or `/issue-pr-review N` yourself. When the agent first asks something, such as whether you trust the folder, the panel waits for your answer, then sends the prompt. When Claude leaves the typed prompt in its input box, the panel presses Enter once more. The panel reports the agent started only once herdr sees it working on the prompt.

## 0.2.2 (2026-11-03)

### Fixed

- On a remote machine, a click or enter on a pull request or issue no longer does nothing (#3). When `open` or `xdg-open` is missing or fails, the panel shows the reason and the whole URL, ready to copy. The selected row also shows its URL as plain text, so under `herdr --remote` or a saved SSH machine a Ctrl-click on it opens the row on your own computer (herdr 0.9.5 ignores terminal hyperlinks, so the titles' OSC 8 links don't do this). A URL too long for one line breaks after `https://`, so a Ctrl-click never opens a cut-off address. A plain click on a remote machine still can't open a browser on your computer. Opening locally works as before.

## 0.2.1 (2026-11-02)

- The README now says up front that a click or enter opens a pull request or issue in your browser, and tests check that a click opens the row you clicked, even after scrolling.

## 0.2.0 (2026-11-01)

- GitLab support through `glab`, including self-hosted GitLab: merge requests (as `!123`, with draft and review state) and issues with label colors. The panel reads the repo's remote to pick `gh` or `glab`, and tries both for an unknown host.
- The plugin id stays `herdr-github`, so installs and key bindings keep working. The pane is now titled "PRs & issues".
- The action is now titled "Toggle PR and issue panel".
- On GitLab, merge requests have no checks mark, since `glab`'s list output has no pipeline status, and never show Approved.
- GitLab label colors come from `glab label list`. If that call fails, the dots are grey.
- A repo with no remote, or only a local-path one, now shows "No GitHub or GitLab remote". A missing CLI shows "gh isn't installed" or "glab isn't installed".

## 0.1.1 (2026-11-01)

- Run outside herdr, the panel keeps its state in the system temp folder, never in the plugin folder.
- Opening a link no longer starts a detached process.

## 0.1.0 (2026-11-01)

- First release: a side pane listing the current repo's open pull requests and issues, with titles, descriptions, checks, review state, labels and age.
- The `herdr-github.toggle` action opens the panel beside the focused pane, or closes it.
- Keyboard and mouse navigation; enter or a click opens a row in the browser.
