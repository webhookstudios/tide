import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {Mixer} from './mixer.js';

const VOLUME_ICONS = [
    'audio-volume-muted-symbolic',
    'audio-volume-low-symbolic',
    'audio-volume-medium-symbolic',
    'audio-volume-high-symbolic',
    'audio-volume-overamplified-symbolic',
];

function volumeIcon(value, muted) {
    if (muted || value <= 0)
        return VOLUME_ICONS[0];
    if (value > 1)
        return VOLUME_ICONS[4];
    return VOLUME_ICONS[Math.min(3, 1 + Math.floor(value * 3))];
}

const percent = value => `${Math.round(value * 100)}%`;

// A thin bar under a slider that shows how loud the sound is right now.
// The meter helper reports the linear peak after volume; PulseAudio volume
// is cubic, so the cube root lines the bar up with the slider's position.
const LevelMeter = GObject.registerClass(
class LevelMeter extends St.Widget {
    _init() {
        super._init({
            style_class: 'swell-meter',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: false,
            y_align: Clutter.ActorAlign.START,
        });
        this._fill = new St.Widget({
            style_class: 'swell-meter-fill',
            x_expand: true,
            y_expand: true,
            pivot_point: new Graphene.Point({x: 0, y: 0.5}),
            scale_x: 0,
        });
        this.add_child(this._fill);
        this._shown = 0;
        this.maximum = 1;
    }

    setPeak(peak) {
        const target = Math.min(1, Math.cbrt(peak) / this.maximum);
        // Rise at once, fall gently, like a VU meter.
        this._shown = target >= this._shown ? target : Math.max(target, this._shown * 0.82);
        this._fill.scale_x = this._shown < 0.004 ? 0 : this._shown;
    }

    reset() {
        this._shown = 0;
        this._fill.scale_x = 0;
    }
});

// A list of output devices with a check next to the chosen one.
// items: [{id, label, gicon, checked}]
function deviceList(items, onPick) {
    const box = new St.BoxLayout({style_class: 'swell-device-list', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
    for (const item of items) {
        const row = new St.BoxLayout({style_class: 'swell-device-row-box', x_expand: true});
        row.add_child(new St.Icon({gicon: item.gicon, style_class: 'swell-device-icon'}));
        row.add_child(new St.Label({text: item.label, x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        row.get_last_child().clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add_child(new St.Icon({
            icon_name: 'object-select-symbolic',
            style_class: 'swell-device-check',
            opacity: item.checked ? 255 : 0,
        }));
        const button = new St.Button({
            style_class: 'swell-device-row',
            child: row,
            can_focus: true,
            x_expand: true,
            accessible_name: item.label,
        });
        if (item.checked)
            button.add_style_pseudo_class('checked');
        button.connect('clicked', () => onPick(item.id));
        box.add_child(button);
    }
    return box;
}

// One app: icon (click to mute), name, device, slider with meter, percent.
const AppRow = GObject.registerClass(
class AppRow extends St.BoxLayout {
    _init(mixer, settings, app) {
        super._init({style_class: 'swell-app', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._mixer = mixer;
        this._settings = settings;

        const line = new St.BoxLayout({style_class: 'swell-app-line', x_expand: true});
        this.add_child(line);

        this._icon = new St.Icon({style_class: 'swell-app-icon', icon_size: 32, fallback_icon_name: 'audio-x-generic-symbolic'});
        this._muteBadge = new St.Icon({
            icon_name: 'audio-volume-muted-symbolic',
            style_class: 'swell-mute-badge',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
        });
        const iconStack = new St.Widget({layout_manager: new Clutter.BinLayout()});
        iconStack.add_child(this._icon);
        iconStack.add_child(this._muteBadge);
        this._muteButton = new St.Button({
            style_class: 'swell-app-mute',
            child: iconStack,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._muteButton.connect('clicked', () =>
            this._mixer.setMuted(this.app, !this._mixer.mutedOf(this.app)));
        line.add_child(this._muteButton);

        const middle = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style_class: 'swell-app-middle'});
        line.add_child(middle);

        const head = new St.BoxLayout({x_expand: true});
        middle.add_child(head);
        this._name = new St.Label({style_class: 'swell-app-name', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        head.add_child(this._name);

        const devBox = new St.BoxLayout({style_class: 'swell-app-device-box'});
        this._devLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._devLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        devBox.add_child(this._devLabel);
        devBox.add_child(new St.Icon({icon_name: 'pan-down-symbolic', style_class: 'swell-app-device-arrow'}));
        this._devButton = new St.Button({
            style_class: 'swell-app-device',
            child: devBox,
            can_focus: true,
            x_align: Clutter.ActorAlign.END,
        });
        this._devButton.connect('clicked', () => this._toggleDevices());
        head.add_child(this._devButton);

        this._slider = new Slider(0);
        this._slider.add_style_class_name('swell-slider');
        this._slider.x_expand = true;
        this._sliderId = this._slider.connect('notify::value', () => this._onSlider());
        this._slider.connect('drag-begin', () => (this._dragging = true));
        this._slider.connect('drag-end', () => (this._dragging = false));
        middle.add_child(this._slider);

        this.meter = new LevelMeter();
        middle.add_child(this.meter);

        this._percent = new St.Label({style_class: 'swell-percent', y_align: Clutter.ActorAlign.CENTER});
        line.add_child(this._percent);

        this._devices = null;
        this.setApp(app);
        this.connect('destroy', () => this._disconnectStreams());
    }

    setApp(app) {
        this._disconnectStreams();
        this.app = app;
        for (const stream of app.streams) {
            stream.connectObject(
                'notify::volume', () => this.sync(),
                'notify::is-muted', () => this.sync(), this);
        }
        this._streams = app.streams;
        this._name.text = app.name;
        this._icon.gicon = app.gicon;
        this._muteButton.accessible_name = _('Mute %s').replace('%s', app.name);
        this._slider.accessible_name = app.name;
        if (this._devices)
            this._showDevices();
        this.sync();
    }

    _disconnectStreams() {
        for (const stream of this._streams ?? [])
            stream.disconnectObject(this);
        this._streams = [];
    }

    sync() {
        const {app} = this;
        const max = this._settings.get_int('max-volume') / 100;
        const muted = this._mixer.mutedOf(app);
        const value = this._mixer.volumeOf(app);
        this._slider.maximum_value = max;
        this.meter.maximum = max;
        if (!this._dragging) {
            this._slider.block_signal_handler(this._sliderId);
            this._slider.value = Math.min(max, muted ? 0 : value);
            this._slider.unblock_signal_handler(this._sliderId);
        }
        this._percent.text = muted ? _('Muted') : percent(value);
        this._percent.visible = this._settings.get_boolean('show-percent');
        this._muteBadge.visible = muted;
        this._icon.opacity = muted ? 110 : 255;
        this.meter.visible = this._settings.get_boolean('show-meters');
        this.opacity = app.running ? 255 : 150;

        const explicit = app.explicit && this._mixer.sinkByName(app.explicit);
        const current = app.sinkNames.map(n => this._mixer.sinkByName(n)).filter(Boolean);
        let label;
        if (explicit)
            label = this._mixer.sinkLabel(explicit);
        else if (current.length === 1 && current[0] !== this._mixer.defaultSink)
            label = this._mixer.sinkLabel(current[0]);
        else
            label = _('Default output');
        this._devLabel.text = label;
        this._devButton.accessible_name = _('Output device: %s').replace('%s', label);
        this._devButton.visible = this._mixer.graph.available && (app.absent || app.nodes.length > 0);
    }

    _onSlider() {
        const value = this._slider.value;
        if (value < 0.005)
            this._mixer.setMuted(this.app, true);
        else
            this._mixer.setVolume(this.app, value);
        this.sync();
    }

    _toggleDevices() {
        if (this._devices) {
            this._devices.destroy();
            this._devices = null;
        } else {
            this._showDevices();
        }
    }

    _showDevices() {
        this._devices?.destroy();
        const mixer = this._mixer;
        const def = mixer.defaultSink;
        const items = [{
            id: null,
            label: def ? _('Default (%s)').replace('%s', mixer.sinkLabel(def)) : _('Default output'),
            gicon: Gio.ThemedIcon.new('emblem-default-symbolic'),
            checked: !this.app.explicit,
        }];
        for (const sink of mixer.sinks) {
            items.push({
                id: sink.name,
                label: mixer.sinkLabel(sink),
                gicon: mixer.sinkIcon(sink),
                checked: this.app.explicit === sink.name,
            });
        }
        this._devices = deviceList(items, name => {
            mixer.moveApp(this.app, name);
            this._devices.destroy();
            this._devices = null;
            this.sync();
        });
        this.add_child(this._devices);
    }

    get meterKeys() {
        return this.app.streams.map(s => `s:${s.index}`);
    }
});

const SwellButton = GObject.registerClass(
class SwellButton extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Swell', false);
        this._ext = ext;
        this._settings = ext.getSettings();
        this._mixer = new Mixer(this._settings);
        this._rows = new Map();

        // Swell's own mixer symbol, so it is not mistaken for the system
        // menu's speaker icon right next to it.
        const iconFile = name => Gio.FileIcon.new(Gio.File.new_for_path(
            GLib.build_filenamev([ext.path, 'icons', `${name}.svg`])));
        this._iconOn = iconFile('swell-symbolic');
        this._iconMuted = iconFile('swell-muted-symbolic');
        this._panelIcon = new St.Icon({gicon: this._iconOn, style_class: 'system-status-icon'});
        this.add_child(this._panelIcon);
        this.connect('scroll-event', (_a, event) => this._onScroll(event));

        this._buildMenu();

        this._mixer.connectObject(
            'apps-changed', () => this._syncApps(),
            'default-changed', () => this._onDefaultChanged(),
            'sinks-changed', () => this._syncMaster(),
            this);
        this._settings.connectObject('changed', (_s, key) => {
            if (key === 'app-memory')
                return;
            this._syncMaster();
            this._syncApps();
            this._syncMeters();
        }, this);

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                this._syncMaster();
                this._syncApps();
            } else {
                this._closeLists();
            }
            this._syncMeters();
        });

        this._onDefaultChanged();
        this._syncApps();
    }

    _buildMenu() {
        this.menu.box.add_style_class_name('swell-menu');
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'swell-item'});
        this.menu.addMenuItem(item);

        const root = new St.BoxLayout({style_class: 'swell-root', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        item.add_child(root);

        // Main output: device and volume.
        const masterHead = new St.BoxLayout({style_class: 'swell-master-head', x_expand: true});
        root.add_child(masterHead);
        this._masterDevIcon = new St.Icon({style_class: 'swell-master-device-icon'});
        this._masterDevLabel = new St.Label({style_class: 'swell-master-device', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._masterDevLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const devBox = new St.BoxLayout({x_expand: true});
        devBox.add_child(this._masterDevIcon);
        devBox.add_child(this._masterDevLabel);
        devBox.add_child(new St.Icon({icon_name: 'pan-down-symbolic', style_class: 'swell-app-device-arrow'}));
        this._masterDevButton = new St.Button({style_class: 'swell-master-device-button', child: devBox, x_expand: true, can_focus: true});
        this._masterDevButton.connect('clicked', () => this._toggleMasterDevices());
        masterHead.add_child(this._masterDevButton);

        this._masterDevices = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        root.add_child(this._masterDevices);

        const masterLine = new St.BoxLayout({style_class: 'swell-app-line swell-master-line', x_expand: true});
        root.add_child(masterLine);
        this._masterMuteIcon = new St.Icon({style_class: 'swell-master-icon', icon_size: 24});
        this._masterMute = new St.Button({style_class: 'swell-app-mute', child: this._masterMuteIcon, can_focus: true,
            accessible_name: _('Mute main output'), y_align: Clutter.ActorAlign.CENTER});
        this._masterMute.connect('clicked', () => {
            const sink = this._mixer.defaultSink;
            if (sink)
                sink.change_is_muted(!sink.is_muted);
        });
        masterLine.add_child(this._masterMute);
        const masterMiddle = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style_class: 'swell-app-middle'});
        masterLine.add_child(masterMiddle);
        this._masterSlider = new Slider(0);
        this._masterSlider.x_expand = true;
        this._masterSlider.accessible_name = _('Main volume');
        this._masterSliderId = this._masterSlider.connect('notify::value', () => this._onMasterSlider());
        masterMiddle.add_child(this._masterSlider);
        this._masterMeter = new LevelMeter();
        masterMiddle.add_child(this._masterMeter);
        this._masterPercent = new St.Label({style_class: 'swell-percent', y_align: Clutter.ActorAlign.CENTER});
        masterLine.add_child(this._masterPercent);

        // Apps.
        root.add_child(new St.Label({text: _('Apps'), style_class: 'swell-heading'}));
        this._scroll = new St.ScrollView({
            style_class: 'swell-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        this._list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'swell-list', x_expand: true});
        this._scroll.set_child(this._list);
        root.add_child(this._scroll);
        this._empty = new St.Label({text: _('No apps are playing sound'), style_class: 'swell-empty', x_align: Clutter.ActorAlign.CENTER});
        root.add_child(this._empty);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addSettingsAction(_('Sound Settings'), 'gnome-sound-panel.desktop');
        this.menu.addAction(_('Swell Settings'), () => this._ext.openPreferences());
    }

    // ---- main output ---------------------------------------------------------

    _onDefaultChanged() {
        const sink = this._mixer.defaultSink;
        if (this._masterStream !== sink) {
            this._masterStream?.disconnectObject(this);
            this._masterStream = sink;
            sink?.connectObject(
                'notify::volume', () => this._syncMaster(),
                'notify::is-muted', () => this._syncMaster(), this);
        }
        this._syncMaster();
        this._syncMeters();
        for (const row of this._rows.values())
            row.sync();
    }

    _syncMaster() {
        const sink = this._mixer.defaultSink;
        const maxNorm = this._mixer.maxNorm;
        const value = sink ? sink.volume / maxNorm : 0;
        const muted = !sink || sink.is_muted;
        this._panelIcon.gicon = muted || value <= 0 ? this._iconMuted : this._iconOn;
        this._masterMuteIcon.icon_name = volumeIcon(value, muted);
        this._masterDevLabel.text = sink ? this._mixer.sinkLabel(sink) : _('No output device');
        this._masterDevIcon.gicon = this._mixer.sinkIcon(sink);
        const max = Math.max(1, this._settings.get_int('max-volume') / 100);
        this._masterSlider.maximum_value = max;
        this._masterMeter.maximum = max;
        this._masterSlider.block_signal_handler(this._masterSliderId);
        this._masterSlider.value = Math.min(max, muted ? 0 : value);
        this._masterSlider.unblock_signal_handler(this._masterSliderId);
        this._masterPercent.text = muted ? _('Muted') : percent(value);
        this._masterPercent.visible = this._settings.get_boolean('show-percent');
        this._masterMeter.visible = this._settings.get_boolean('show-meters');
        this._masterSlider.reactive = !!sink;
        if (this._masterDevices.get_n_children() > 0)
            this._showMasterDevices();
    }

    _onMasterSlider() {
        const sink = this._mixer.defaultSink;
        if (!sink)
            return;
        const value = this._masterSlider.value;
        if (value < 0.005) {
            if (!sink.is_muted)
                sink.change_is_muted(true);
        } else {
            sink.volume = Math.round(value * this._mixer.maxNorm);
            sink.push_volume();
            if (sink.is_muted)
                sink.change_is_muted(false);
        }
    }

    _toggleMasterDevices() {
        if (this._masterDevices.get_n_children() > 0)
            this._masterDevices.destroy_all_children();
        else
            this._showMasterDevices();
    }

    _showMasterDevices() {
        this._masterDevices.destroy_all_children();
        const def = this._mixer.defaultSink;
        const items = this._mixer.sinks.map(sink => ({
            id: sink.name,
            label: this._mixer.sinkLabel(sink),
            gicon: this._mixer.sinkIcon(sink),
            checked: sink === def,
        }));
        this._masterDevices.add_child(deviceList(items, name => {
            const sink = this._mixer.sinkByName(name);
            if (sink)
                this._mixer.setDefaultSink(sink);
            this._masterDevices.destroy_all_children();
        }));
    }

    _closeLists() {
        this._masterDevices.destroy_all_children();
        for (const row of this._rows.values()) {
            if (row._devices)
                row._toggleDevices();
        }
    }

    _onScroll(event) {
        if (!this._settings.get_boolean('scroll-master'))
            return Clutter.EVENT_PROPAGATE;
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return Clutter.EVENT_PROPAGATE;
        const sink = this._mixer.defaultSink;
        if (!sink)
            return Clutter.EVENT_STOP;
        let steps = 0;
        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.UP)
            steps = 1;
        else if (direction === Clutter.ScrollDirection.DOWN)
            steps = -1;
        else if (direction === Clutter.ScrollDirection.SMOOTH) {
            const [, dy] = event.get_scroll_delta();
            steps = -dy;
            if (event.get_scroll_flags() & Clutter.ScrollFlags.INVERTED)
                steps = -steps;
        }
        if (!steps)
            return Clutter.EVENT_STOP;
        const maxNorm = this._mixer.maxNorm;
        const max = Math.max(1, this._settings.get_int('max-volume') / 100);
        const step = this._settings.get_int('scroll-step') / 100;
        const current = sink.is_muted ? 0 : sink.volume / maxNorm;
        const value = Math.max(0, Math.min(max, current + steps * step));
        sink.volume = Math.round(value * maxNorm);
        sink.push_volume();
        if (sink.is_muted !== (value <= 0))
            sink.change_is_muted(value <= 0);
        Main.osdWindowManager.showAll(Gio.ThemedIcon.new(volumeIcon(value, value <= 0)),
            this._mixer.sinkLabel(sink), value, max);
        return Clutter.EVENT_STOP;
    }

    // ---- apps ----------------------------------------------------------------

    _visibleApps() {
        const showInactive = this._settings.get_boolean('show-inactive');
        return [...this._mixer.apps.values()]
            .filter(app => app.running || (showInactive && (app.streams.length > 0 || app.absent)))
            .sort((a, b) => (b.running - a.running) || (!!a.absent - !!b.absent) ||
                a.name.localeCompare(b.name));
    }

    _syncApps() {
        const apps = this._visibleApps();
        const keep = new Set(apps.map(a => a.key));
        for (const [key, row] of this._rows) {
            if (!keep.has(key)) {
                row.destroy();
                this._rows.delete(key);
            }
        }
        apps.forEach((app, i) => {
            let row = this._rows.get(app.key);
            if (row) {
                row.setApp(app);
            } else {
                row = new AppRow(this._mixer, this._settings, app);
                this._rows.set(app.key, row);
                this._list.add_child(row);
            }
            this._list.set_child_at_index(row, i);
        });
        this._empty.visible = apps.length === 0;
        this._scroll.visible = apps.length > 0;
        this._sendMeterTargets();
    }

    // ---- level meters --------------------------------------------------------

    _syncMeters() {
        const want = this.menu.isOpen && this._settings.get_boolean('show-meters') && !this._metersBroken;
        if (want && !this._meterProc)
            this._startMeters();
        else if (!want && this._meterProc)
            this._stopMeters();
        else
            this._sendMeterTargets();
    }

    _startMeters() {
        const path = GLib.build_filenamev([this._ext.path, 'meter.js']);
        let proc;
        try {
            proc = Gio.Subprocess.new(['gjs', '-m', path],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.warn(`Swell: level meters unavailable: ${e.message}`);
            this._metersBroken = true;
            return;
        }
        const started = GLib.get_monotonic_time();
        this._meterProc = proc;
        this._meterIn = proc.get_stdin_pipe();
        this._meterOut = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
        this._meterCancel = new Gio.Cancellable();
        this._lastTargets = null;
        proc.wait_async(null, () => {
            // Quitting right away means GStreamer or its PipeWire plugin is missing.
            if (this._meterProc === proc && !proc.get_successful() &&
                GLib.get_monotonic_time() - started < 3 * GLib.USEC_PER_SEC) {
                console.warn('Swell: the level meter helper stopped; meters are off');
                this._metersBroken = true;
            }
            if (this._meterProc === proc)
                this._stopMeters();
        });
        this._readMeter();
        this._sendMeterTargets();
    }

    _readMeter() {
        const out = this._meterOut;
        out.read_line_async(GLib.PRIORITY_DEFAULT, this._meterCancel, (stream, res) => {
            let line;
            try {
                [line] = stream.read_line_finish_utf8(res);
            } catch {
                return;
            }
            if (line === null || out !== this._meterOut)
                return;
            const [key, value] = line.split(' ');
            this._onLevel(key, Number(value));
            this._readMeter();
        });
    }

    _onLevel(key, peak) {
        if (key.startsWith('d:')) {
            if (this._mixer.defaultSink?.name === key.slice(2))
                this._masterMeter.setPeak(peak);
            return;
        }
        // An app with several streams shows the loudest one.
        for (const row of this._rows.values()) {
            const keys = row.meterKeys;
            if (!keys.includes(key))
                continue;
            row._peaks ??= new Map();
            row._peaks.set(key, peak);
            row.meter.setPeak(Math.max(...keys.map(k => row._peaks.get(k) ?? 0)));
        }
    }

    _sendMeterTargets() {
        if (!this._meterIn)
            return;
        const keys = [];
        const sink = this._mixer.defaultSink;
        if (sink)
            keys.push(`d:${sink.name}`);
        for (const row of this._rows.values())
            keys.push(...row.meterKeys);
        const line = keys.join(' ');
        if (line === this._lastTargets)
            return;
        this._lastTargets = line;
        this._meterIn.write_all_async(new TextEncoder().encode(`${line}\n`), GLib.PRIORITY_DEFAULT, null, (s, res) => {
            try {
                s.write_all_finish(res);
            } catch {}
        });
    }

    _stopMeters() {
        const proc = this._meterProc;
        this._meterProc = null;
        this._meterCancel?.cancel();
        this._meterOut = null;
        // Closing its input lets the helper stop its streams and quit by itself.
        try {
            this._meterIn?.close(null);
        } catch {}
        this._meterIn = null;
        if (proc) {
            const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                proc.force_exit();
                return GLib.SOURCE_REMOVE;
            });
            proc.wait_async(null, () => GLib.source_remove(id));
        }
        this._masterMeter.reset();
        for (const row of this._rows.values())
            row.meter.reset();
    }

    destroy() {
        this._stopMeters();
        this._masterStream?.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._mixer.disconnectObject(this);
        this._mixer.destroy();
        this._rows.clear();
        super.destroy();
    }
});

export default class SwellExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settings.connectObject('changed::panel-position', () => {
            this._removeButton();
            this._addButton();
        }, this);
        this._addButton();
    }

    _addButton() {
        this._button = new SwellButton(this);
        const right = Main.panel._rightBox;
        // The system menu (quickSettings) is the last item on the right.
        const qs = Main.panel.statusArea.quickSettings?.container;
        let index = right.get_n_children();
        if (this._settings.get_string('panel-position') === 'left' && qs && qs.get_parent() === right)
            index = right.get_children().indexOf(qs);
        Main.panel.addToStatusArea(this.uuid, this._button, index, 'right');
    }

    _removeButton() {
        this._button?.destroy();
        this._button = null;
    }

    disable() {
        this._settings?.disconnectObject(this);
        this._removeButton();
        this._settings = null;
    }
}
