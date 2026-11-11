#!/bin/bash
# Second half of headless.sh, run inside the private D-Bus session.
set -u
MODE="${1:-check}"

gnome-shell --headless --wayland --no-x11 --unsafe-mode --virtual-monitor 1280x800 \
    > "$LOG" 2>&1 &
SHELL_PID=$!

eval_js() {
    timeout 15 gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1" 2>&1
}

# Wait for the shell to own its name and finish starting.
for _ in $(seq 1 60); do
    if gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval 'Main.layoutManager._startingUp' 2>/dev/null | grep -q "'false'"; then
        break
    fi
    sleep 0.5
done
sleep 3

if [ "$MODE" = shell ]; then
    sleep "${2:-60}"
else
    . "${CHECKS:-$ROOT/test/checks.sh}"
fi

kill $SHELL_PID 2>/dev/null
wait $SHELL_PID 2>/dev/null
echo "----- shell log -----"
cat "$LOG"
