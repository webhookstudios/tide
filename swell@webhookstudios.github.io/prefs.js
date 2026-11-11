import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Row titles are read as markup, so names with & or < must be escaped.
const esc = text => GLib.markup_escape_text(text, -1);

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, subtitle, step) {
    // The allowed range comes from the schema, so it is defined once.
    const [, [lower, upper]] = settings.settings_schema.get_key(key)
        .get_range().recursiveUnpack();
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function choiceRow(settings, key, title, subtitle, choices) {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(choices.map(([, label]) => label)),
    });
    const show = () => {
        const index = choices.findIndex(([value]) => value === settings.get_string(key));
        if (index >= 0 && row.selected !== index)
            row.selected = index;
    };
    show();
    settings.connect(`changed::${key}`, show);
    row.connect('notify::selected', () => {
        const [value] = choices[row.selected] ?? [];
        if (value && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    return row;
}

function readMemory(settings) {
    try {
        const memory = JSON.parse(settings.get_string('app-memory'));
        return memory && typeof memory === 'object' && !Array.isArray(memory) ? memory : {};
    } catch {
        return {};
    }
}

function generalPage(settings) {
    const page = new Adw.PreferencesPage({title: 'General', icon_name: 'audio-volume-high-symbolic'});

    const mixer = new Adw.PreferencesGroup({title: 'Mixer'});
    mixer.add(switchRow(settings, 'show-inactive', 'Show inactive apps',
        'Also list apps that are paused or have stopped playing, so you can set them up in advance'));
    mixer.add(switchRow(settings, 'show-meters', 'Level meters',
        'A live bar under each slider that shows how loud the app is right now'));
    mixer.add(switchRow(settings, 'show-percent', 'Show percentages', 'The volume next to each slider'));
    mixer.add(spinRow(settings, 'max-volume', 'Loudest volume',
        'Percent. Above 100 boosts quiet apps, but can distort', 5));
    page.add(mixer);

    const icon = new Adw.PreferencesGroup({title: 'Top bar icon'});
    icon.add(switchRow(settings, 'scroll-master', 'Scroll to change the volume',
        'Scrolling on the icon turns the main output up or down'));
    const step = spinRow(settings, 'scroll-step', 'Scroll step', 'Percent per scroll', 1);
    settings.bind('scroll-master', step, 'sensitive', Gio.SettingsBindFlags.GET);
    icon.add(step);
    icon.add(choiceRow(settings, 'panel-position', 'Position', 'Which side of the system menu the icon sits on', [
        ['left', 'Left'],
        ['right', 'Right'],
    ]));
    page.add(icon);

    return page;
}

function appsPage(settings) {
    const page = new Adw.PreferencesPage({title: 'Apps', icon_name: 'view-list-symbolic'});

    const memory = new Adw.PreferencesGroup({title: 'Memory'});
    memory.add(switchRow(settings, 'remember-apps', 'Remember each app',
        'When an app plays again, it goes back to the output device and volume you last gave it'));
    page.add(memory);

    const forgetAll = new Gtk.Button({label: 'Forget all', valign: Gtk.Align.CENTER, css_classes: ['flat']});
    const list = new Adw.PreferencesGroup({
        title: 'Remembered apps',
        description: 'Apps you have changed in the mixer. Forget one to let it use the default device and its own volume again.',
        header_suffix: forgetAll,
    });
    page.add(list);

    let rows = [];
    const render = () => {
        for (const row of rows)
            list.remove(row);
        rows = [];
        const entries = Object.entries(readMemory(settings))
            .sort(([, a], [, b]) => (a.name ?? '').localeCompare(b.name ?? ''));
        forgetAll.sensitive = entries.length > 0;
        if (entries.length === 0) {
            const row = new Adw.ActionRow({title: 'No apps yet', subtitle: 'Change an app’s volume or device in the mixer and it shows up here'});
            list.add(row);
            rows.push(row);
            return;
        }
        for (const [key, entry] of entries) {
            const parts = [];
            if (typeof entry.volume === 'number')
                parts.push(`${Math.round(entry.volume * 100)}%`);
            if (entry.muted)
                parts.push('muted');
            parts.push(entry.sink ? `plays on ${entry.sinkLabel || entry.sink}` : 'plays on the default device');
            const row = new Adw.ActionRow({title: esc(entry.name ?? key), subtitle: esc(parts.join(' · '))});
            let gicon = null;
            try {
                gicon = entry.icon ? Gio.icon_new_for_string(entry.icon) : null;
            } catch {}
            row.add_prefix(new Gtk.Image({gicon: gicon ?? Gio.ThemedIcon.new('audio-x-generic-symbolic'), pixel_size: 32}));
            const forget = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: 'Forget',
                css_classes: ['flat'],
            });
            forget.connect('clicked', () => {
                const current = readMemory(settings);
                delete current[key];
                settings.set_string('app-memory', JSON.stringify(current));
            });
            row.add_suffix(forget);
            list.add(row);
            rows.push(row);
        }
    };
    forgetAll.connect('clicked', () => settings.set_string('app-memory', '{}'));
    settings.connect('changed::app-memory', render);
    render();

    return page;
}

export default class SwellPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(620, 680);
        window.add(generalPage(settings));
        window.add(appsPage(settings));
    }
}
