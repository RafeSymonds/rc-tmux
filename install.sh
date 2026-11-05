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
daemons=/Library/LaunchDaemons

uninstall() {
    if [ "$(uname -s)" = Darwin ]; then
        for job in up update; do
            launchctl bootout "gui/$(id -u)/$label.$job" 2>/dev/null || true
            rm -f "$agents/$label.$job.plist"
            if [ -f "$daemons/$label.$job.plist" ]; then
                echo "as an admin, run: sudo launchctl bootout system/$label.$job && sudo rm $daemons/$label.$job.plist"
            fi
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
    mkdir -p "$agents" "$conf/launchd"
    # gui/<uid> exists only while the user is logged in at the desktop. A user who only
    # comes in over SSH needs LaunchDaemons that run as that user. Those also start at
    # boot with no login, but an admin has to install them.
    has_gui=""
    launchctl print "gui/$(id -u)" >/dev/null 2>&1 && has_gui=1
    write_agent() {   # job, rc-args..., then plist schedule keys on stdin
        local job="$1"; shift
        local plist="$agents/$label.$job.plist" args="" a sched run_as=""
        sched="$(cat)"
        for a in "$@"; do args="$args<string>$a</string>"; done
        if [ -z "$has_gui" ]; then
            plist="$conf/launchd/$label.$job.plist"
            run_as="<key>UserName</key><string>$(id -un)</string><key>EnvironmentVariables</key><dict><key>HOME</key><string>$HOME</string></dict>"
        fi
        cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label.$job</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$bin/rct</string>$args</array>
  $sched
  $run_as
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>$conf/logs/launchd-$job.log</string>
  <key>StandardErrorPath</key><string>$conf/logs/launchd-$job.log</string>
</dict></plist>
PLIST
        [ -n "$has_gui" ] || return 0
        launchctl bootout "gui/$(id -u)/$label.$job" 2>/dev/null || true
        launchctl bootstrap "gui/$(id -u)" "$plist"
        echo "launchd: $label.$job"
    }
    write_agent up up <<<'<key>RunAtLoad</key><true/>'
    write_agent update update <<<"<key>StartCalendarInterval</key><dict><key>Hour</key><integer>$hour</integer><key>Minute</key><integer>$min</integer></dict>"
    if [ -n "$has_gui" ]; then
        echo "rct up runs at login; rct update runs daily at $at (a sleeping Mac runs it on wake)"
    else
        echo "$(id -un) has no desktop session, so the schedules must run as LaunchDaemons. As an admin, run:"
        for job in up update; do
            echo "  sudo install -m 644 -o root -g wheel $conf/launchd/$label.$job.plist $daemons/ && sudo launchctl bootstrap system $daemons/$label.$job.plist"
        done
    fi
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
