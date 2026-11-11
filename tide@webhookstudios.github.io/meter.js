#!/usr/bin/gjs -m
// Tide's level meter helper. It runs as its own process while the mixer is
// open, so GStreamer never runs inside GNOME Shell.
//
// It reads lines from stdin, each one the full list of things to measure:
//   s:<serial>   an app's playback stream (PipeWire object serial)
//   d:<name>     an output device, measured at its monitor
// and prints "<key> <level>" lines, level from 0 to 1, about 20 times a second.
//
// Each meter is a quiet capture stream linked to the stream or device. It is
// marked passive so it never keeps a device awake, and it uses the
// application id that GNOME's volume menu skips, so the shell does not show
// the microphone-in-use indicator for it.

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Gst from 'gi://Gst?version=1.0';

Gst.init(null);

const meters = new Map();   // key -> {pipeline, level}
const stdout = new Gio.DataOutputStream({
    base_stream: new GioUnix.OutputStream({fd: 1, close_fd: false}),
});

function props(key) {
    const isDevice = key.startsWith('d:');
    const fields = [
        'application.name="Tide level meter"',
        'application.id=org.PulseAudio.pavucontrol',
        'media.type=Audio',
        'media.category=Monitor',
        'media.role=DSP',
        'stream.monitor=true',
        'node.passive=true',
        'node.dont-reconnect=true',
        'node.latency=1024/48000',
        'resample.peaks=true',
        `stream.capture.sink=${isDevice}`,
    ];
    return Gst.Structure.from_string(`props,${fields.join(',')}`)[0];
}

function start(key) {
    const target = key.slice(2);
    let pipeline;
    try {
        pipeline = Gst.parse_launch(
            'pipewiresrc name=src always-copy=true ! audioconvert ! ' +
            'audio/x-raw,format=F32LE,channels=1 ! ' +
            'level name=level interval=50000000 post-messages=true ! fakesink sync=false');
    } catch (e) {
        printerr(`tide-meter: ${e.message}`);
        return;
    }
    const src = pipeline.get_by_name('src');
    src.target_object = target;
    src.client_name = 'Tide level meter';
    src.stream_properties = props(key);

    const bus = pipeline.get_bus();
    bus.add_signal_watch();
    bus.connect('message', (_bus, msg) => {
        if (msg.type === Gst.MessageType.ELEMENT) {
            const s = msg.get_structure();
            if (s?.get_name() !== 'level')
                return;
            // The peaks come as a GValueArray, which GJS cannot index, so
            // they are read from the message text: peak=(GValueArray)< a, b >
            const match = /peak=\(GValueArray\)<([^>]*)>/.exec(s.to_string());
            const db = Math.max(-100, ...(match?.[1].split(',').map(Number).filter(Number.isFinite) ?? []));
            const level = Math.min(1, Math.max(0, 10 ** (db / 20)));
            stdout.put_string(`${key} ${level.toFixed(3)}\n`, null);
        } else if (msg.type === Gst.MessageType.ERROR || msg.type === Gst.MessageType.EOS) {
            stop(key);
            stdout.put_string(`${key} 0\n`, null);
        }
    });
    pipeline.set_state(Gst.State.PLAYING);
    meters.set(key, {pipeline, bus});
}

function stop(key) {
    const meter = meters.get(key);
    if (!meter)
        return;
    meters.delete(key);
    meter.bus.remove_signal_watch();
    meter.pipeline.set_state(Gst.State.NULL);
}

function update(line) {
    const wanted = new Set(line.split(/\s+/).filter(k => /^[sd]:./.test(k)));
    for (const key of [...meters.keys()]) {
        if (!wanted.has(key))
            stop(key);
    }
    for (const key of wanted) {
        if (!meters.has(key))
            start(key);
    }
}

const loop = new GLib.MainLoop(null, false);
const stdin = new Gio.DataInputStream({
    base_stream: new GioUnix.InputStream({fd: 0, close_fd: false}),
});

function readLine() {
    stdin.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
        let line;
        try {
            [line] = stream.read_line_finish_utf8(res);
        } catch {
            line = null;
        }
        if (line === null) {
            // The shell closed our input: the mixer closed, or Tide was turned off.
            for (const key of [...meters.keys()])
                stop(key);
            loop.quit();
            return;
        }
        update(line);
        readLine();
    });
}

readLine();
loop.run();
