#!/bin/bash
# Real-app checks and README screenshots: Showtime and Rhythmbox play a file
# inside the nested shell, into silent test devices. Run with
#   CHECKS=test/real-apps.sh test/headless.sh
SHOTS="${SHOTS:-$WORK/shots}"
mkdir -p "$SHOTS"
export GSETTINGS_SCHEMA_DIR="$ROOT/$UUID/schemas"
BTN="Main.panel.statusArea['$UUID']"
MIX="$BTN._mixer"
shot() {
    timeout 15 gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.Screenshot false false "$SHOTS/$1.png" >/dev/null 2>&1
    echo "shot $1"
}
show() { echo "== $1"; eval_js "$2"; }
key_of() { eval_js "[...$MIX.apps.values()].find(a=>a.name.includes('$1'))?.key" | sed -E 's/^\(true, .\"(.*)\".\)$/\1/'; }
sink_of_app() { eval_js "[...$MIX.apps.values()].find(a=>a.name.includes('$1'))?.sinkNames.join('+')"; }

SINKS=()
for s in a b; do
    pw-cli -m create-node adapter "{ factory.name=support.null-audio-sink node.name=swell-test-$s node.description=\"Test Speakers ${s^^}\" media.class=Audio/Sink audio.position=[FL FR] node.want-driver=true node.always-process=true }" >/dev/null &
    SINKS+=($!)
done
python3 - "$WORK/song.wav" <<'PY'
import wave, struct, math, sys
rate = 44100
w = wave.open(sys.argv[1], 'wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(rate)
chords = [(261.6, 329.6, 392.0), (220.0, 261.6, 329.6), (174.6, 220.0, 261.6), (196.0, 246.9, 293.7)]
out = bytearray()
for bar in range(8):
    notes = chords[bar % 4]
    for i in range(rate * 2):
        env = min(1, i / 2000) * (0.55 + 0.45 * math.cos(2 * math.pi * i / (rate / 2)))
        v = int(3000 * env * sum(math.sin(2 * math.pi * f * i / rate) for f in notes))
        out += struct.pack('<hh', v, v)
for _ in range(10): w.writeframes(bytes(out))
w.close()
PY
sleep 1
export WAYLAND_DISPLAY=wayland-0 XDG_SESSION_TYPE=wayland GDK_BACKEND=wayland
export PULSE_SINK=swell-test-a PIPEWIRE_PROPS='{ target.object=swell-test-a }'
showtime "$WORK/song.wav" > "$WORK/showtime.log" 2>&1 & SHOWTIME=$!
rhythmbox "$WORK/song.wav" > "$WORK/rhythmbox.log" 2>&1 & RB=$!
unset PULSE_SINK PIPEWIRE_PROPS
sleep 8
show "apps" "[...$MIX.apps.values()].map(a=>[a.key,a.name,a.running,a.sinkNames.join('+'),a.iconString].join('|')).join('  ')"
# Minimize the app windows so the screenshots show only the mixer.
eval_js "global.get_window_actors().forEach(a=>a.meta_window.minimize())" >/dev/null

eval_js "$BTN.menu.open()" >/dev/null; sleep 2
show "rows" "[...$BTN._rows.values()].map(r=>r._name.text+' dev='+r._devLabel.text+' vol='+r._slider.value.toFixed(2)+' meter='+r.meter._shown.toFixed(2)).join('  ')"
shot mixer

RBK=org.gnome.Rhythmbox3.desktop; STK=org.gnome.Showtime.desktop
echo "keys: $RBK / $STK"
echo "##### move Rhythmbox to B, set Showtime to 35%"
eval_js "(() => { $MIX.moveApp($MIX.apps.get('$RBK'), 'swell-test-b'); $MIX.setVolume($MIX.apps.get('$STK'), 0.35); return 1; })()" >/dev/null; sleep 2
show "Rhythmbox device (expect swell-test-b)" "$MIX.apps.get('$RBK').sinkNames.join('+')"
show "Showtime device (expect swell-test-a)" "$MIX.apps.get('$STK').sinkNames.join('+')"
show "Showtime volume (expect 0.35)" "$MIX.volumeOf($MIX.apps.get('$STK')).toFixed(2)"
eval_js "$BTN._rows.get('$RBK')._toggleDevices()" >/dev/null; sleep 1
shot app-devices
eval_js "$BTN._rows.get('$RBK')._toggleDevices()" >/dev/null
eval_js "$BTN._toggleMasterDevices()" >/dev/null; sleep 1
shot master-devices
eval_js "$BTN._toggleMasterDevices()" >/dev/null

echo "##### pause Showtime (inactive)"
eval_js "$BTN.menu.close()" >/dev/null
kill $SHOWTIME; sleep 2
gsettings set org.gnome.shell.extensions.swell show-inactive true; sleep 1
eval_js "$BTN.menu.open()" >/dev/null; sleep 2
show "rows with inactive" "[...$BTN._rows.values()].map(r=>r._name.text+' opacity='+r.opacity).join('  ')"
shot inactive
eval_js "$BTN.menu.close()" >/dev/null

echo "##### restart Showtime: volume comes back"
export PULSE_SINK=swell-test-a PIPEWIRE_PROPS='{ target.object=swell-test-a }'
showtime "$WORK/song.wav" > "$WORK/showtime2.log" 2>&1 & SHOWTIME=$!
unset PULSE_SINK PIPEWIRE_PROPS
sleep 7
show "Showtime volume after restart (expect 0.35)" "$MIX.volumeOf($MIX.apps.get('$STK')).toFixed(2)"
eval_js "global.get_window_actors().forEach(a=>a.meta_window.minimize())" >/dev/null

echo "##### prefs, Apps page"
gsettings set org.gnome.shell.extensions.swell show-inactive false
(timeout 14 gnome-extensions prefs "$UUID" > "$WORK/prefs.log" 2>&1 &)
sleep 5
eval_js "global.get_window_actors().map(a=>a.meta_window).filter(w=>w.get_wm_class()!=='org.gnome.Shell.Extensions').forEach(w=>w.minimize())" >/dev/null
sleep 1
shot settings-general
eval_js "(() => { const C=imports.gi.Clutter; globalThis.__d=C.get_default_backend().get_default_seat().create_virtual_device(C.InputDeviceType.POINTER_DEVICE); globalThis.__d.notify_absolute_motion(global.get_current_time(), 690, 95); return 1; })()" >/dev/null
sleep 0.7
eval_js "globalThis.__d.notify_absolute_motion(global.get_current_time(), 700, 99)" >/dev/null
sleep 0.7
eval_js "(() => { const C=imports.gi.Clutter; const d=globalThis.__d; d.notify_button(global.get_current_time(), C.BUTTON_PRIMARY, C.ButtonState.PRESSED); d.notify_button(global.get_current_time(), C.BUTTON_PRIMARY, C.ButtonState.RELEASED); return 1; })()" >/dev/null
sleep 1.5
shot settings-apps
sleep 8

# WirePlumber in the real session remembers each app's volume and device.
# Put both apps back as they were so the test leaves nothing behind.
eval_js "(() => { for (const k of ['$RBK', '$STK']) { const a=$MIX.apps.get(k); if (a) { $MIX.setVolume(a, 1); $MIX.moveApp(a, null); } } return 1; })()" >/dev/null
sleep 2
kill $SHOWTIME $RB ${SINKS[@]} 2>/dev/null
