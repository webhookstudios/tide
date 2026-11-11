// The mixer model.
//
// Tide uses two views of the sound system, because neither has everything:
//
// - GNOME's Gvc mixer control, the same connection the built-in volume menu
//   uses. It lists the playing streams and output devices and sets volume,
//   mute and the default device, without any lag.
// - PipeWire's own graph, read from `pw-dump --monitor`. Gvc cannot say which
//   device a stream plays to, or move it. The graph has the links between
//   streams and devices, and a stream is moved by setting its
//   `target.object` in PipeWire's "default" metadata with `pw-metadata`,
//   which WirePlumber then follows.
//
// The two are matched by number: a PulseAudio index in Gvc is the PipeWire
// object serial of the same node.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gvc from 'gi://Gvc';
import Shell from 'gi://Shell';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

const NODE = 'PipeWire:Interface:Node';
const LINK = 'PipeWire:Interface:Link';
const METADATA = 'PipeWire:Interface:Metadata';

// Reads the PipeWire graph and keeps it current.
// Emits 'changed' (batched) whenever nodes, links or metadata change.
export class PwGraph extends EventEmitter {
    constructor() {
        super();
        this.nodes = new Map();      // id -> {id, serial, props, state}
        this.links = new Map();      // id -> {out, in}
        this.targets = new Map();    // node id -> target.object value
        this._buf = '';
        this._stopped = false;
        this._restarts = 0;
        this._start();
    }

    _start() {
        try {
            this._proc = Gio.Subprocess.new(['pw-dump', '--monitor', '--no-colors'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.warn(`Tide: cannot run pw-dump: ${e.message}`);
            this.available = false;
            return;
        }
        this.available = true;
        this._cancel = new Gio.Cancellable();
        this._stdout = this._proc.get_stdout_pipe();
        this._decoder = new TextDecoder();
        this._read();
        this._proc.wait_async(null, () => {
            if (this._stopped)
                return;
            // PipeWire restarted, or pw-dump died: start over after a pause.
            this.nodes.clear();
            this.links.clear();
            this.targets.clear();
            this._buf = '';
            this._rest = null;
            this._changed();
            const delay = Math.min(30, 2 ** this._restarts++);
            this._restartId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
                this._restartId = 0;
                this._start();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _read() {
        this._stdout.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, this._cancel, (stream, res) => {
            let bytes;
            try {
                bytes = stream.read_bytes_finish(res);
            } catch {
                return; // cancelled
            }
            if (bytes.get_size() === 0)
                return; // end of output; wait_async handles the restart
            // GJS's TextDecoder has no streaming mode, so only whole lines
            // are decoded: a newline byte never sits inside a UTF-8 character.
            let data = bytes.toArray();
            if (this._rest) {
                const joined = new Uint8Array(this._rest.length + data.length);
                joined.set(this._rest);
                joined.set(data, this._rest.length);
                data = joined;
            }
            const cut = data.lastIndexOf(10) + 1;
            this._rest = data.slice(cut);
            this._buf += this._decoder.decode(data.subarray(0, cut));
            this._drain();
            this._read();
        });
    }

    // pw-dump prints one JSON array per update, closed by "]" alone on a
    // line. Everything inside is indented, so that line marks the end.
    _drain() {
        let end;
        while ((end = this._buf.indexOf('\n]\n')) !== -1) {
            const chunk = this._buf.slice(0, end + 2);
            this._buf = this._buf.slice(end + 3);
            const start = chunk.indexOf('[');
            if (start === -1)
                continue;
            try {
                for (const obj of JSON.parse(chunk.slice(start)))
                    this._apply(obj);
                this._restarts = 0;
            } catch (e) {
                console.warn(`Tide: could not read pw-dump output: ${e.message}`);
            }
        }
        this._changed();
    }

    _apply(obj) {
        const {id} = obj;
        if (obj.info === null && !obj.metadata) {
            // Removed.
            this.nodes.delete(id);
            this.links.delete(id);
            this.targets.delete(id);
            return;
        }
        if (obj.type === NODE || this.nodes.has(id)) {
            const node = this.nodes.get(id) ?? {id, props: {}};
            const info = obj.info ?? {};
            if (info.props)
                node.props = info.props;
            if (info.state)
                node.state = info.state;
            node.serial = node.props['object.serial'];
            this.nodes.set(id, node);
        } else if (obj.type === LINK || this.links.has(id)) {
            const info = obj.info ?? {};
            const link = this.links.get(id) ?? {};
            if ('output-node-id' in info)
                link.out = info['output-node-id'];
            if ('input-node-id' in info)
                link.in = info['input-node-id'];
            this.links.set(id, link);
        } else if (obj.type === METADATA && obj.props?.['metadata.name'] === 'default') {
            // Only the entries that changed are listed; a null value is a removal.
            for (const {subject, key, value} of obj.metadata ?? []) {
                if (key !== 'target.object' && key !== undefined)
                    continue;
                if (value === null || value === undefined || key === undefined)
                    this.targets.delete(subject);
                else
                    this.targets.set(subject, typeof value === 'string' ? value : JSON.stringify(value));
            }
        }
    }

    _changed() {
        if (this._changedId)
            return;
        this._changedId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
            this._changedId = 0;
            this.emit('changed');
            return GLib.SOURCE_REMOVE;
        });
    }

    nodeBySerial(serial) {
        for (const node of this.nodes.values()) {
            if (node.serial === serial)
                return node;
        }
        return null;
    }

    // The serials of the devices a stream node is linked to.
    sinkSerialsOf(nodeId) {
        const out = new Set();
        for (const link of this.links.values()) {
            if (link.out !== nodeId)
                continue;
            const peer = this.nodes.get(link.in);
            if (peer?.props['media.class']?.startsWith('Audio/Sink'))
                out.add(peer.serial);
        }
        return [...out];
    }

    // Sends a stream to a device by its node name, or back to the default
    // device when name is null.
    moveStream(nodeId, sinkName) {
        const argv = sinkName
            ? ['pw-metadata', '-n', 'default', String(nodeId), 'target.object', sinkName, 'Spa:String']
            : ['pw-metadata', '-n', 'default', '-d', String(nodeId), 'target.object'];
        try {
            const proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.wait_async(null, null);
        } catch (e) {
            console.warn(`Tide: cannot run pw-metadata: ${e.message}`);
        }
    }

    destroy() {
        this._stopped = true;
        this._cancel?.cancel();
        this._proc?.force_exit();
        if (this._restartId)
            GLib.source_remove(this._restartId);
        if (this._changedId)
            GLib.source_remove(this._changedId);
        this._changedId = this._restartId = 0;
    }
}

// Finds the installed app behind a stream, for its proper name and icon.
function findApp(props, stream) {
    const appSys = Shell.AppSystem.get_default();
    const ids = [props['application.id'], props['pipewire.access.portal.app_id'],
        stream?.get_application_id()].filter(Boolean);
    for (const id of ids) {
        const app = appSys.lookup_app(`${id}.desktop`) ?? appSys.lookup_app(id);
        if (app)
            return app;
    }
    const pid = Number(props['application.process.id']);
    if (pid) {
        const app = Shell.WindowTracker.get_default().get_app_from_pid(pid);
        if (app && !app.is_window_backed())
            return app;
    }
    for (const name of [props['application.process.binary'], props['application.name']]) {
        if (!name)
            continue;
        const app = appSys.lookup_desktop_wmclass(name) ?? appSys.lookup_startup_wmclass(name) ??
            appSys.lookup_heuristic_basename(name.toLowerCase());
        if (app)
            return app;
    }
    return null;
}

// What groups streams into one app row. Stable across runs, so it is also
// the key for the remembered device and volume.
function appKey(props, stream, app) {
    if (app)
        return app.get_id();
    return props['application.id'] || props['application.process.binary'] ||
        props['application.name'] || stream.get_application_id() || stream.get_name() || 'unknown';
}

// One app with one or more playing streams, or a remembered app with none.
//   key, name, gicon, streams: [Gvc.MixerStream], nodes: [graph nodes],
//   running: bool, sinkNames: [current device node names],
//   explicit: the device this app was sent to, or null for the default.
export class Mixer extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this.control = Volume.getMixerControl();
        this.graph = new PwGraph();
        this.apps = new Map();
        this._seen = new Set();       // Gvc stream ids already handled
        this._pending = new Set();    // stream ids still waiting for their graph node
        this._initial = true;
        this._memory = this._loadMemory();

        this.control.connectObject(
            'stream-added', () => this._rebuildSoon(),
            'stream-removed', () => this._rebuildSoon(),
            'stream-changed', () => this._rebuildSoon(),
            'default-sink-changed', () => this.emit('default-changed'),
            'state-changed', () => this._onState(),
            'output-added', () => this.emit('sinks-changed'),
            'output-removed', () => this.emit('sinks-changed'),
            this);
        this.graph.connectObject('changed', () => this._rebuildSoon(), this);
        this._settings.connectObject('changed::app-memory', () => {
            if (!this._writing)
                this._memory = this._loadMemory();
        }, this);
        this._onState();
    }

    get ready() {
        return this.control.get_state() === Gvc.MixerControlState.READY;
    }

    _onState() {
        if (this.ready) {
            this._rebuildSoon();
            this.emit('default-changed');
            this.emit('sinks-changed');
        }
    }

    // ---- remembered apps -----------------------------------------------------

    _loadMemory() {
        try {
            const m = JSON.parse(this._settings.get_string('app-memory'));
            return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
        } catch {
            return {};
        }
    }

    _saveMemorySoon() {
        if (this._saveId)
            return;
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._saveId = 0;
            this._writing = true;
            this._settings.set_string('app-memory', JSON.stringify(this._memory));
            this._writing = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    remembered(key) {
        return this._memory[key] ?? null;
    }

    _remember(app, fields) {
        if (!this._settings.get_boolean('remember-apps'))
            return;
        const entry = this._memory[app.key] ?? {};
        Object.assign(entry, {name: app.name, icon: app.iconString ?? entry.icon ?? null}, fields);
        this._memory[app.key] = entry;
        this._saveMemorySoon();
    }

    // ---- the app list --------------------------------------------------------

    _rebuildSoon() {
        if (this._rebuildId)
            return;
        this._rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._rebuildId = 0;
            this._rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    _rebuild() {
        if (!this.ready)
            return;
        const apps = new Map();
        const liveIds = new Set();
        for (const stream of this.control.get_sink_inputs()) {
            if (stream.is_event_stream || stream.get_application_id() === 'org.gnome.VolumeControl')
                continue;
            const node = this.graph.nodeBySerial(stream.index);
            const props = node?.props ?? {};
            // Our own level meters, and other monitoring streams, are not apps.
            if (props['stream.monitor'] || props['media.class'] && !props['media.class'].startsWith('Stream/Output'))
                continue;
            liveIds.add(stream.id);
            const shellApp = findApp(props, stream);
            const key = appKey(props, stream, shellApp);
            let app = apps.get(key);
            if (!app) {
                const name = shellApp?.get_name() || props['application.name'] ||
                    stream.get_name() || stream.get_description() || 'Unknown app';
                const gicon = shellApp?.get_icon() ?? (props['application.icon-name']
                    ? Gio.ThemedIcon.new(props['application.icon-name']) : stream.get_gicon()) ??
                    Gio.ThemedIcon.new('audio-x-generic-symbolic');
                app = {key, name, gicon, iconString: gicon?.to_string() ?? null,
                    streams: [], nodes: [], running: false, sinkNames: [], explicit: null};
                apps.set(key, app);
            }
            app.streams.push(stream);
            if (node) {
                app.nodes.push(node);
                const target = this.graph.targets.get(node.id);
                if (target)
                    app.explicit = this._sinkNameFromTarget(target);
                for (const serial of this.graph.sinkSerialsOf(node.id)) {
                    const sink = this._sinkByIndex(serial);
                    if (sink && !app.sinkNames.includes(sink.name))
                        app.sinkNames.push(sink.name);
                }
            }
            // The graph knows whether the stream is moving data; Gvc only
            // knows whether it is corked.
            const running = node?.state ? node.state === 'running'
                : stream.state === Gvc.MixerStreamState.RUNNING;
            app.running ||= running;
        }

        // Remembered apps that are not playing now.
        for (const [key, entry] of Object.entries(this._memory)) {
            if (apps.has(key))
                continue;
            let gicon = null;
            try {
                gicon = entry.icon ? Gio.icon_new_for_string(entry.icon) : null;
            } catch {}
            apps.set(key, {key, name: entry.name ?? key, gicon: gicon ?? Gio.ThemedIcon.new('audio-x-generic-symbolic'),
                iconString: entry.icon ?? null, streams: [], nodes: [], running: false, sinkNames: [],
                explicit: entry.sink ?? null, absent: true});
        }

        this._applyMemory(apps, liveIds);
        for (const id of [...this._seen]) {
            if (!liveIds.has(id))
                this._seen.delete(id);
        }
        this.apps = apps;
        this.emit('apps-changed');
    }

    // Gives a newly started stream the device and volume remembered for its
    // app. Streams that were already playing when Tide started are left as
    // they are.
    _applyMemory(apps, liveIds) {
        const remember = this._settings.get_boolean('remember-apps');
        for (const app of apps.values()) {
            for (const stream of app.streams) {
                if (this._seen.has(stream.id) && !this._pending.has(stream.id))
                    continue;
                this._seen.add(stream.id);
                const entry = this._memory[app.key];
                if (this._initial || !remember || !entry) {
                    this._pending.delete(stream.id);
                    continue;
                }
                if (!this._pending.has(stream.id)) {
                    if (typeof entry.volume === 'number') {
                        stream.volume = Math.round(entry.volume * this.control.get_vol_max_norm());
                        stream.push_volume();
                    }
                    if (typeof entry.muted === 'boolean' && entry.muted !== stream.is_muted)
                        stream.change_is_muted(entry.muted);
                }
                // The device needs the stream's graph node, which may come later.
                const node = this.graph.nodeBySerial(stream.index);
                if (!entry.sink || !this.sinkByName(entry.sink)) {
                    this._pending.delete(stream.id);
                } else if (node) {
                    this._pending.delete(stream.id);
                    if (this.graph.targets.get(node.id) !== entry.sink)
                        this.graph.moveStream(node.id, entry.sink);
                } else {
                    this._pending.add(stream.id);
                }
            }
        }
        for (const id of [...this._pending]) {
            if (!liveIds.has(id))
                this._pending.delete(id);
        }
        if (this._initial && this.ready && (this.graph.nodes.size > 0 || !this.graph.available))
            this._initial = false;
    }

    _sinkNameFromTarget(target) {
        // pavucontrol and pactl write the device's serial; Tide writes its name.
        if (/^\d+$/.test(target)) {
            const sink = this._sinkByIndex(Number(target));
            return sink?.name ?? null;
        }
        return target;
    }

    // ---- devices -------------------------------------------------------------

    get sinks() {
        return this.ready ? this.control.get_sinks() : [];
    }

    get defaultSink() {
        return this.ready ? this.control.get_default_sink() : null;
    }

    _sinkByIndex(index) {
        return this.sinks.find(s => s.index === index) ?? null;
    }

    sinkByName(name) {
        return this.sinks.find(s => s.name === name) ?? null;
    }

    // A device's name for people: "Speakers – Built-in Audio" style when the
    // shell knows more about it.
    sinkLabel(sink) {
        if (!sink)
            return '';
        const device = this.control.lookup_device_from_stream(sink);
        if (device?.description && device.origin)
            return `${device.description} – ${device.origin}`;
        return device?.description || sink.get_description() || sink.name;
    }

    sinkIcon(sink) {
        const device = sink ? this.control.lookup_device_from_stream(sink) : null;
        return device?.get_gicon() ?? sink?.get_gicon() ?? Gio.ThemedIcon.new('audio-speakers-symbolic');
    }

    setDefaultSink(sink) {
        this.control.set_default_sink(sink);
    }

    // ---- changing apps -------------------------------------------------------

    get maxNorm() {
        return this.control.get_vol_max_norm();
    }

    // Volume as 0..1.5 (1 = 100 %), the loudest of the app's streams.
    volumeOf(app) {
        if (app.absent) {
            const entry = this._memory[app.key];
            return typeof entry?.volume === 'number' ? entry.volume : 1;
        }
        return Math.max(0, ...app.streams.map(s => s.volume)) / this.maxNorm;
    }

    mutedOf(app) {
        if (app.absent)
            return !!this._memory[app.key]?.muted;
        return app.streams.length > 0 && app.streams.every(s => s.is_muted);
    }

    setVolume(app, value) {
        const volume = Math.round(value * this.maxNorm);
        for (const stream of app.streams) {
            stream.volume = volume;
            stream.push_volume();
            if (volume > 0 && stream.is_muted)
                stream.change_is_muted(false);
        }
        this._remember(app, {volume: value, ...volume > 0 ? {muted: false} : {}});
        if (app.absent)
            this.emit('apps-changed');
    }

    setMuted(app, muted) {
        for (const stream of app.streams)
            stream.change_is_muted(muted);
        this._remember(app, {muted});
        if (app.absent)
            this.emit('apps-changed');
    }

    // Sends every stream of the app to a device, or back to the default
    // device when sinkName is null.
    moveApp(app, sinkName) {
        for (const node of app.nodes)
            this.graph.moveStream(node.id, sinkName);
        app.explicit = sinkName;
        const sink = sinkName ? this.sinkByName(sinkName) : null;
        this._remember(app, {sink: sinkName, sinkLabel: sink ? this.sinkLabel(sink) : null});
        if (app.absent)
            this.emit('apps-changed');
    }

    forget(key) {
        delete this._memory[key];
        this._saveMemorySoon();
        this._rebuildSoon();
    }

    destroy() {
        this.control.disconnectObject(this);
        this._settings.disconnectObject(this);
        this.graph.disconnectObject(this);
        this.graph.destroy();
        for (const id of [this._rebuildId, this._saveId]) {
            if (id)
                GLib.source_remove(id);
        }
        if (this._saveId) {
            this._settings.set_string('app-memory', JSON.stringify(this._memory));
        }
        this._rebuildId = this._saveId = 0;
    }
}
