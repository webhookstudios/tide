#!/bin/bash
# Checks run against the nested shell. Sourced by headless-inner.sh, which
# provides eval_js, $UUID, $ROOT and $WORK.
SHOTS="${SHOTS:-$WORK/shots}"
mkdir -p "$SHOTS"
export GSETTINGS_SCHEMA_DIR="$ROOT/$UUID/schemas"
BTN="Main.panel.statusArea['$UUID']"
MIX="$BTN._mixer"

shot() {
    timeout 15 gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.Screenshot false false "$SHOTS/$1.png" 2>&1 | head -1
}
show() { echo "== $1"; eval_js "$2"; }
node_of() { pw-dump | python3 -c "
import json,sys
for o in json.load(sys.stdin):
  if o.get('type')=='PipeWire:Interface:Node' and o['info']['props'].get('application.id')=='$1': print(o['id'])" | head -1; }
sink_of() { wpctl inspect "$1" >/dev/null; pw-dump | python3 -c "
import json,sys
d=json.load(sys.stdin); n={o['id']:o for o in d if o.get('type')=='PipeWire:Interface:Node'}
for o in d:
  if o.get('type')=='PipeWire:Interface:Link' and o['info']['output-node-id']==$1:
    p=n.get(o['info']['input-node-id'],{}).get('info',{}).get('props',{})
    if p.get('media.class')=='Audio/Sink': print(p['node.name']); break"; }

# ---- silent test devices and test streams -----------------------------------
SINKS=()
for s in a b; do
    pw-cli -m create-node adapter "{ factory.name=support.null-audio-sink node.name=tide-test-$s node.description=\"Test Speakers ${s^^}\" media.class=Audio/Sink audio.position=[FL FR] node.want-driver=true node.always-process=true }" >/dev/null &
    SINKS+=($!)
done
python3 - "$WORK/tone.wav" <<'PY'
import wave, struct, math, sys
w = wave.open(sys.argv[1], 'wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000)
frames = b''.join(struct.pack('<hh', v, v) for v in (int(9000 * math.sin(2 * math.pi * 440 * i / 48000) * (0.6 + 0.4 * math.sin(2 * math.pi * 0.7 * i / 48000))) for i in range(48000 * 2)))
for _ in range(60): w.writeframes(frames)
w.close()
PY
sleep 1.5
play() { pw-play --target "$2" -P "{ application.name=\"$1\" application.id=$3 }" "$WORK/tone.wav" >/dev/null 2>&1 & echo $!; }
P1=$(play "Tone One" tide-test-a test.tide.one)
P2=$(play "Tone Two" tide-test-a test.tide.two)
cleanup_audio() { kill $P1 $P2 ${SINKS[@]} 2>/dev/null; }
trap cleanup_audio RETURN
sleep 2

show "extension state (1 = enabled)" "Main.extensionManager.lookup('$UUID').state"
show "extension error" "Main.extensionManager.lookup('$UUID').error"
show "graph available, nodes" "[$MIX.graph.available, $MIX.graph.nodes.size]"
show "apps (key name running sinks)" "[...$MIX.apps.values()].map(a=>[a.key,a.name,a.running,a.sinkNames.join('+'),a.streams.length].join('|')).join('  ')"

echo "##### open the mixer"
eval_js "$BTN.menu.open()" >/dev/null; sleep 2
show "rows" "[...$BTN._rows.values()].map(r=>r._name.text+' dev='+r._devLabel.text+' vol='+r._slider.value.toFixed(2)+' meter='+r.meter._shown.toFixed(2)).join('  ')"
show "panel icon (expect tide-symbolic)" "$BTN._panelIcon.gicon.get_file().get_basename()"
show "master" "$BTN._masterDevLabel.text+' '+$BTN._masterPercent.text+' meter='+$BTN._masterMeter._shown.toFixed(2)"
show "meter helper running" "!!$BTN._meterProc"
show "mic-in-use indicator shown (expect false)" "Main.panel.statusArea.quickSettings._volumeInput?._input?.visible ?? 'n/a'"
shot mixer

echo "##### per-app volume"
N1=$(node_of test.tide.one)
eval_js "(() => { const a=$MIX.apps.get('test.tide.one'); $MIX.setVolume(a, 0.5); return 1; })()" >/dev/null; sleep 1
echo "Tone One volume in PipeWire (wpctl shows the cubic scale: expect 0.50): $(wpctl get-volume $N1)"
show "row percent" "$BTN._rows.get('test.tide.one')._percent.text"
eval_js "(() => { const a=$MIX.apps.get('test.tide.one'); $MIX.setMuted(a, true); return 1; })()" >/dev/null; sleep 1
echo "after mute: $(wpctl get-volume $N1)"
eval_js "(() => { const a=$MIX.apps.get('test.tide.one'); $MIX.setMuted(a, false); return 1; })()" >/dev/null; sleep 1

echo "##### per-app device"
echo "Tone One plays on (expect tide-test-a): $(sink_of $N1)"
eval_js "(() => { $BTN._rows.get('test.tide.one')._toggleDevices(); return 1; })()" >/dev/null; sleep 1
shot devices
eval_js "(() => { const a=$MIX.apps.get('test.tide.one'); $MIX.moveApp(a, 'tide-test-b'); $BTN._rows.get('test.tide.one')._toggleDevices(); return 1; })()" >/dev/null; sleep 1.5
echo "Tone One plays on (expect tide-test-b): $(sink_of $N1)"
show "row device label" "$BTN._rows.get('test.tide.one')._devLabel.text"
N2=$(node_of test.tide.two)
echo "Tone Two still on (expect tide-test-a): $(sink_of $N2)"

echo "##### memory: restart Tone One"
sleep 1
show "saved" "$BTN._settings.get_string('app-memory')"
kill $P1; sleep 1.5
show "inactive hidden by default (expect false)" "$BTN._rows.has('test.tide.one')"
gsettings set org.gnome.shell.extensions.tide show-inactive true; sleep 1
show "remembered app listed with inactive on (expect true)" "$BTN._rows.has('test.tide.one')"
shot inactive
gsettings set org.gnome.shell.extensions.tide show-inactive false
P1=$(play "Tone One" tide-test-a test.tide.one); sleep 2.5
N1=$(node_of test.tide.one)
echo "restarted Tone One plays on (expect tide-test-b): $(sink_of $N1)"
echo "restarted Tone One volume (expect 0.50): $(wpctl get-volume $N1)"
eval_js "(() => { const a=$MIX.apps.get('test.tide.one'); $MIX.moveApp(a, null); return 1; })()" >/dev/null; sleep 1.5
echo "back to default (expect tide-test-a, its own target): $(sink_of $N1)"

echo "##### main device"
ORIG=$(eval_js "$MIX.defaultSink.name" | sed -E 's/^\(true, .\"(.*)\".\)$/\1/')
echo "original default: $ORIG"
eval_js "(() => { $MIX.setDefaultSink($MIX.sinkByName('tide-test-b')); return 1; })()" >/dev/null; sleep 1
show "default now (expect tide-test-b)" "$MIX.defaultSink.name + ' / ' + $BTN._masterDevLabel.text"
eval_js "$BTN._toggleMasterDevices()" >/dev/null; sleep 0.8; shot master-devices; eval_js "$BTN._toggleMasterDevices()" >/dev/null
echo "##### scroll on the icon"
eval_js "$BTN.menu.close()" >/dev/null; sleep 0.5
eval_js "(() => { const C=imports.gi.Clutter; globalThis.__dev = C.get_default_backend().get_default_seat().create_virtual_device(C.InputDeviceType.POINTER_DEVICE); const [x,y]=$BTN.get_transformed_position(); globalThis.__dev.notify_absolute_motion(global.get_current_time(), x+10, y+10); return 1; })()" >/dev/null; sleep 0.5
B=$(eval_js "Math.round($MIX.defaultSink.volume/$MIX.maxNorm*100)")
eval_js "(() => { const C=imports.gi.Clutter; for (let i=0;i<4;i++) globalThis.__dev.notify_discrete_scroll(global.get_current_time(), C.ScrollDirection.DOWN, C.ScrollSource.WHEEL); return 1; })()" >/dev/null; sleep 1
show "main volume before $B, after 4 scrolls down (expect 20 lower)" "Math.round($MIX.defaultSink.volume/$MIX.maxNorm*100)"
shot osd
wpctl set-default "$(pw-dump | python3 -c "
import json,sys
for o in json.load(sys.stdin):
  if o.get('type')=='PipeWire:Interface:Node' and o['info']['props'].get('node.name')=='$ORIG': print(o['id'])")"; sleep 1
show "default restored" "$MIX.defaultSink.name"

echo "##### prefs"
export WAYLAND_DISPLAY=wayland-0 XDG_SESSION_TYPE=wayland
(timeout 14 gnome-extensions prefs "$UUID" > "$WORK/prefs.log" 2>&1 &)
sleep 6; shot prefs
cat "$WORK/prefs.log" | head -10

echo "##### disable / enable"
eval_js "$BTN.menu.open()" >/dev/null; sleep 1.5
gnome-extensions disable "$UUID"; sleep 2
show "button gone (expect true)" "!Main.panel.statusArea['$UUID']"
echo "helpers left running (expect none): $(pgrep -a -f 'pw-dump --monitor' | grep -v pgrep; pgrep -a -f tide@webhookstudios.github.io/meter.js)"
gnome-extensions enable "$UUID"; sleep 2
show "back after enable" "Main.extensionManager.lookup('$UUID').state + ' ' + !!Main.panel.statusArea['$UUID']"
