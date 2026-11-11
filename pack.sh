#!/bin/sh
# Builds the release zip in dist/, ready for `gnome-extensions install`.
set -e

UUID=swell@webhookstudios.github.io
ROOT="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$ROOT/dist"
gnome-extensions pack --force --out-dir "$ROOT/dist" \
    --extra-source=mixer.js --extra-source=meter.js --extra-source=icons \
    --extra-source=sedge \
    "$ROOT/$UUID"

echo "Built $ROOT/dist/$UUID.shell-extension.zip"
