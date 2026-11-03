# Changelog

## Unreleased

### Added

- **Resolve** and **Review** buttons in the header, for the selected issue or pull request on GitHub (#5, #6). A click, or `a`, opens a new pane below your agent, starts the same kind of agent there and sends it `/issue-resolver N` or `/issue-pr-review N`. Only the number goes into the prompt. If the skill isn't installed, nothing starts and the panel points you to https://luongnv.com/idd. The panel says when the agent starts, and why when it can't.

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
