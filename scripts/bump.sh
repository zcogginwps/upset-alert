#!/bin/sh
# Usage: scripts/bump.sh 6   — stamps a new build number into every place that needs it.
set -e
v="$1"; [ -n "$v" ] || { echo "usage: $0 <number>"; exit 1; }
cd "$(dirname "$0")/.."
sed -i '' "s/const APP_VERSION = '[0-9]*';/const APP_VERSION = '$v';/" app.js
sed -i '' "s/app\.js?v=[0-9]*/app.js?v=$v/; s/style\.css?v=[0-9]*/style.css?v=$v/" index.html
printf '{"v":"%s"}\n' "$v" > version.json
grep -n "APP_VERSION = " app.js; grep -n "?v=" index.html; cat version.json
