#!/bin/sh
# Builds dist/tide_<version>_all.deb. Needs only dpkg-deb.
#
# The package installs Tide for every user of the machine:
#   /usr/share/gnome-shell/extensions/<uuid>/   the extension
#   /usr/share/glib-2.0/schemas/                its settings schema
#   /usr/bin/tide                              apps-menu launcher
#   /usr/share/applications, /usr/share/icons   apps-menu entry and icon
set -e

UUID=tide@webhookstudios.github.io
APP_ID=io.github.webhookstudios.Tide
ROOT="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(sed -n 's/.*"version-name": *"\([^"]*\)".*/\1/p' "$ROOT/$UUID/metadata.json")"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

EXT="$STAGE/usr/share/gnome-shell/extensions/$UUID"
install -d "$EXT" "$STAGE/DEBIAN" "$STAGE/usr/bin" \
    "$STAGE/usr/share/glib-2.0/schemas" \
    "$STAGE/usr/share/applications" \
    "$STAGE/usr/share/icons/hicolor/scalable/apps" \
    "$STAGE/usr/share/doc/tide"

install -m 644 "$ROOT/$UUID"/*.js "$ROOT/$UUID/metadata.json" \
    "$ROOT/$UUID/stylesheet.css" "$EXT/"
cp -r "$ROOT/$UUID/sedge" "$EXT/"
find "$EXT/sedge" -type f -exec chmod 644 {} +
install -d "$EXT/icons"
install -m 644 "$ROOT/$UUID/icons"/*.svg "$EXT/icons/"
# With no schemas folder of its own, the extension reads its schema from
# the system one, which dpkg compiles through glib's trigger.
install -m 644 "$ROOT/$UUID/schemas"/*.gschema.xml "$STAGE/usr/share/glib-2.0/schemas/"
install -m 755 "$ROOT/data/launcher.js" "$STAGE/usr/bin/tide"
install -m 644 "$ROOT/data/$APP_ID.svg" "$STAGE/usr/share/icons/hicolor/scalable/apps/"
sed -e 's|@EXEC@|tide|' -e "s|@ICON@|$APP_ID|" "$ROOT/data/$APP_ID.desktop.in" \
    > "$STAGE/usr/share/applications/$APP_ID.desktop"
chmod 644 "$STAGE/usr/share/applications/$APP_ID.desktop"

# Turns Tide on in place of Swell at the next login, for people who had Swell on.
install -d "$STAGE/usr/lib/tide" "$STAGE/etc/xdg/autostart"
install -m 755 "$ROOT/data/tide-take-over" "$STAGE/usr/lib/tide/"
install -m 644 "$ROOT/data/io.github.webhookstudios.Tide.take-over.desktop" "$STAGE/etc/xdg/autostart/"

cat > "$STAGE/usr/share/doc/tide/copyright" <<EOF
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: Tide
Source: https://github.com/webhookstudios/tide

Files: *
Copyright: $(date +%Y) webhookstudios
License: GPL-2+
 On Debian systems, the full text of the GNU General Public License
 version 2 can be found in /usr/share/common-licenses/GPL-2.

Files: usr/share/gnome-shell/extensions/*/sedge/fonts/*
Copyright: 2023 The Young Serif Project Authors; 2015 The Public Sans Project Authors
License: OFL-1.1
 The full license texts are in the extension's sedge/fonts/ folder.
EOF
chmod 644 "$STAGE/usr/share/doc/tide/copyright"

# Replaces/Breaks take over from this app's old package name, swell.
cat > "$STAGE/DEBIAN/control" <<EOF
Package: tide
Version: $VERSION
Architecture: all
Maintainer: webhookstudios <354619278+webhookstudios@users.noreply.github.com>
Installed-Size: $(du -sk "$STAGE/usr" | cut -f1)
Depends: gnome-shell (>= 50~), gnome-shell (<< 51~), gjs, gir1.2-adw-1, gir1.2-gtk-4.0, pipewire-bin
Replaces: swell (<< 2~)
Breaks: swell (<< 2~)
Recommends: gstreamer1.0-pipewire, gir1.2-gstreamer-1.0
Section: gnome
Priority: optional
Homepage: https://github.com/webhookstudios/tide
Description: Per-app volume mixer for the GNOME top bar
 Tide is a GNOME Shell extension that adds a volume mixer to the top bar.
 It lists every app playing sound with its own volume slider, mute button,
 level meter and output device, remembers each app's device and volume,
 and lets you pick the main output device.
 .
 After installing, log out and back in, then open Tide from the apps menu.
EOF

# Folders are created with the builder's umask; packages want 755.
find "$STAGE" -type d -exec chmod 755 {} +

mkdir -p "$ROOT/dist"
dpkg-deb --root-owner-group --build "$STAGE" "$ROOT/dist/tide_${VERSION}_all.deb"
