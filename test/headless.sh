#!/bin/bash
# Runs the extension in a headless nested GNOME Shell with a throwaway HOME,
# and checks it with a few commands sent to the shell over D-Bus.
#
#   test/headless.sh            run the checks, print the shell log
#   test/headless.sh shell      only start the shell and keep it for N seconds
#
# Needs: gnome-shell, dbus-run-session, glib-compile-schemas, gdbus, pw-cli,
# pw-play. Test streams play into two silent test devices that exist only
# while the checks run, so nothing is heard.
set -u

UUID=tide@webhookstudios.github.io
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$(mktemp -d)}"
export HOME="$WORK/home"
export GSETTINGS_BACKEND=keyfile
export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share" XDG_CACHE_HOME="$HOME/.cache"
# The nested shell talks to the real sound server, so it sees real apps.
REAL_RUNTIME="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export PULSE_SERVER="unix:$REAL_RUNTIME/pulse/native"
export PIPEWIRE_REMOTE="$REAL_RUNTIME/pipewire-0"
export REAL_RUNTIME
unset DISPLAY WAYLAND_DISPLAY
# A private runtime dir keeps the nested shell away from the real session.
# (It has to be a short path: the Wayland socket name has a length limit.)
XDG_RUNTIME_DIR="$(mktemp -d /tmp/dmrun.XXXXXX)"
export XDG_RUNTIME_DIR
trap 'fusermount3 -uz "$XDG_RUNTIME_DIR/doc" 2>/dev/null; rm -rf "$XDG_RUNTIME_DIR" 2>/dev/null || true' EXIT
mkdir -p "$XDG_CONFIG_HOME/glib-2.0/settings" "$XDG_DATA_HOME/gnome-shell/extensions" "$XDG_CACHE_HOME"
glib-compile-schemas "$ROOT/$UUID/schemas"
ln -sfn "$ROOT/$UUID" "$XDG_DATA_HOME/gnome-shell/extensions/$UUID"

cat > "$XDG_CONFIG_HOME/glib-2.0/settings/keyfile" <<EOF
[org/gnome/shell]
enabled-extensions=['$UUID']
welcome-dialog-last-shown-version='999'
favorite-apps=['org.gnome.Nautilus.desktop', 'org.gnome.TextEditor.desktop', 'org.gnome.Settings.desktop']

[org/gnome/desktop/notifications]
show-banners=false
EOF

LOG="$WORK/shell.log"
echo "work dir: $WORK"
export LOG WORK UUID ROOT
dbus-run-session -- bash "$ROOT/test/headless-inner.sh" "$@"
