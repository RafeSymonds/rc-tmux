# rct: Remote Control sessions in tmux

`rct` keeps one `claude remote-control` server running per folder, each in its
own window of a tmux session called `rc`. The folders are listed in one config
file. A daily job updates Claude Code (and Homebrew once a week) and restarts
the servers. The sessions show up at claude.ai/code and in the Claude app, and
project threads can start on them.

## Install (on each machine)

```sh
./install.sh
rct edit        # list your folders (opens ~/.config/rc-tmux/sessions.conf)
rct up          # start them
rct a           # attach; answer the one-time prompts in each window
```

`install.sh` does five things, and is safe to re-run:

- links `rct` into `~/.local/bin`
- creates `~/.config/rc-tmux/sessions.conf` and `local.env` from the examples
- installs Homebrew `tmux` if it's missing
- writes a screen-style `~/.tmux.conf` (Ctrl-a prefix), only if you don't have one
- sets up a schedule. On macOS that's two launchd agents: `rct up` at login and `rct update` daily at 04:30 (change the time with `RC_UPDATE_AT=05:15 ./install.sh`). On Linux it's two cron lines.

**The first start needs you at the keyboard.** In a folder Claude Code doesn't
trust yet, `claude remote-control` asks `Trust <dir>? [y/N]`. On the very first
run it also asks `Enable Remote Control? (y/n)`. Run `rct a` and answer y in
each window. After that, starts are unattended.

`rct up` and `rct ls` name any window that is stuck on a question like these
(`rct ls` shows its state as `prompt`). In a git folder claude would also ask
`same-dir` or `worktree` on every start, so `rct` passes `--spawn same-dir`
when the line has no `spawn=`.

Uninstall: `install.sh --uninstall` (your config is left in place).

## Daily use

| Command | What it does |
| - | - |
| `rct ls` | Show each session's state, Chrome setting and folder |
| `rct a [name]` | Attach to tmux, jumping to that session's window |
| `rct up [name...]` | Start everything, or only the sessions named |
| `rct down [name...]` | Stop with Ctrl-C. Sessions can be brought back for about 4 hours. |
| `rct restart [name...]` | Stop and start again, for example after editing the config. A window still running an older `rct` is replaced, so script edits take effect. |
| `rct log <name>` | Follow one session's log |
| `rct update` | Run the daily job now |

When a server exits on its own (for example, after it gives up following a
network outage of about 10 minutes), its window starts it again. The wait
before restarting backs off if it keeps failing.

If you restart within about 4 hours, the folder's earlier sessions come back.
This works because a plain `claude remote-control` in the same folder brings
them back, so `rct` leaves `--name` off the command on those restarts.

## Coming from screen

`~/.tmux.conf` uses Ctrl-a, so most of your screen keys still work:
`C-a d` to detach, `C-a n` / `C-a p` for next and previous window,
`C-a "` to list windows, `C-a <digit>` to jump to a window, and `C-a A` to
rename one. The window names match the session names in the config, so
`rct a work-api` takes you straight to that window.

## Claude in Chrome

There are three settings to know about.

1. **Per session, set by `rct`.** `chrome=on` in the config passes `--chrome`
   to that server. Change it with `rct chrome on|off <name|all>`, which also
   restarts the server. `rct chrome reset <name>` goes back to what the config
   says, and `rct chrome` shows the current state of each session.
2. **Project threads follow Chrome's own default, not the flag.** When this
   project starts a thread on one of your servers, that session uses the
   **Enabled by default** setting. Run `claude`, type `/chrome`, and pick
   **Enabled by default**, once on each machine. (Sessions in
   `bypassPermissions` mode are the exception.)
3. **Chrome itself has to be running** on the same machine, with the Claude
   extension signed in to the same claude.ai account and organization. On your
   own Mac, that's the Chrome you're already using, so you can watch and steer.
   On a headless machine, `rct chrome up` opens Chrome in the background. Sign
   in to the extension there once by hand.

Things to know about the headless machine:

- Chrome integration needs a `/login` sign-in. A `claude setup-token` token or
  an API key turns it off.
- A Mac needs a logged-in GUI session for Chrome to run, and after a reboot
  FileVault waits at the login screen until someone signs in.
- On Linux without a display, `rct chrome up` uses `xvfb-run` if it's
  installed. I haven't tested this path yet.

## Weekly Homebrew upgrade

Once every `RC_BREW_UPGRADE_DAYS` days (7 by default; set it in `local.env`),
the daily job runs `brew update && brew upgrade && brew cleanup`. It counts
from the last successful upgrade, not by weekday, so a Mac that was asleep
still catches up. To keep a formula on its current version, use
`brew pin <name>`. Consider `brew pin tmux` too, so a tmux upgrade doesn't land
underneath the running tmux server. Set the value to 0 to turn the upgrade off.

## Files

- `bin/rct`: the script (bash 3.2, which is what macOS ships)
- `sessions.conf.example`: copied to `~/.config/rc-tmux/sessions.conf`. It can be shared between machines; `host=` limits a line to some machines.
- `local.env.example`: copied to `~/.config/rc-tmux/local.env`, which holds settings for one machine
- `~/.config/rc-tmux/logs/`: one log per session, plus `update.log` and the launchd output

## move-dev (one-off helper)

`bin/move-dev <old-path> [extra-link ...]` moves a projects folder to
`~/Development` and leaves a symlink at the old path, so the agent using it
keeps working. Any extra paths also become links to `~/Development`, which is
how other agents get access. Start with a dry run: `DRY=1 bin/move-dev ...`.

The script refuses to overwrite anything. It lists the processes that still
have the folder open, and it stops if a running Docker container mounts the
folder: a symlink can't point out of a bind mount, so those containers need a
bind mount of `~/Development` instead. When it finishes, it prints the
command that undoes the move.
