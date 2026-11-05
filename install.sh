#!/usr/bin/env bash
# Install rct: link the script, create config, start at login, update daily.
#   ./install.sh            install (safe to re-run)
#   ./install.sh --uninstall
# Daily update time: RC_UPDATE_AT=04:30 ./install.sh
set -eu

here="$(cd "$(dirname "$0")" && pwd -P)"
bin="$HOME/.local/bin"
conf="$HOME/.config/rc-tmux"
at="${RC_UPDATE_AT:-04:30}"
hour=$((10#${at%%:*})); min=$((10#${at##*:}))
label="com.$(id -un).rc-tmux"
agents="$HOME/Library/LaunchAgents"

uninstall() {
    if [ "$(uname -s)" = Darwin ]; then
        for job in up update; do
            launchctl bootout "gui/$(id -u)/$label.$job" 2>/dev/null || true
            rm -f "$agents/$label.$job.plist"
        done
    else
        crontab -l 2>/dev/null | grep -v '# rc-tmux' | crontab - || true
    fi
    rm -f "$bin/rct"
    echo "removed rct and its schedules; config left in $conf"
}
[ "${1:-}" = "--uninstall" ] && { uninstall; exit 0; }

# tmux
if ! command -v tmux >/dev/null; then
    if command -v brew >/dev/null; then brew install tmux
    elif command -v apt-get >/dev/null; then sudo apt-get install -y tmux
    else echo "install tmux first"; exit 1; fi
fi
command -v claude >/dev/null || [ -x "$HOME/.local/bin/claude" ] || { echo "install Claude Code first"; exit 1; }

mkdir -p "$bin" "$conf/logs"
chmod +x "$here/bin/rct"
ln -sfn "$here/bin/rct" "$bin/rct"
"$bin/rct" init
[ -f "$HOME/.tmux.conf" ] || { cp "$here/tmux.conf" "$HOME/.tmux.conf"; echo "wrote ~/.tmux.conf (screen-style Ctrl-a prefix)"; }

if [ "$(uname -s)" = Darwin ]; then
    mkdir -p "$agents"
    write_agent() {   # job, rc-args..., then plist schedule keys on stdin
        local job="$1"; shift
        local plist="$agents/$label.$job.plist" args="" a sched
        sched="$(cat)"
        for a in "$@"; do args="$args<string>$a</string>"; done
        cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label.$job</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$bin/rct</string>$args</array>
  $sched
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>$conf/logs/launchd-$job.log</string>
  <key>StandardErrorPath</key><string>$conf/logs/launchd-$job.log</string>
</dict></plist>
PLIST
        launchctl bootout "gui/$(id -u)/$label.$job" 2>/dev/null || true
        launchctl bootstrap "gui/$(id -u)" "$plist"
        echo "launchd: $label.$job"
    }
    write_agent up up <<<'<key>RunAtLoad</key><true/>'
    write_agent update update <<<"<key>StartCalendarInterval</key><dict><key>Hour</key><integer>$hour</integer><key>Minute</key><integer>$min</integer></dict>"
    echo "rct up runs at login; rct update runs daily at $at (a sleeping Mac runs it on wake)"
else
    { crontab -l 2>/dev/null | grep -v '# rc-tmux' || true
      echo "@reboot /bin/bash $bin/rct up # rc-tmux"
      echo "$min $hour * * * /bin/bash $bin/rct update # rc-tmux"
    } | crontab -
    echo "cron: rct up at boot, rct update daily at $at"
fi

case ":$PATH:" in *":$bin:"*) ;; *) echo "add $bin to your PATH";; esac
echo
echo "next: rct edit   (list your folders)   then: rct up   and: rct a"
