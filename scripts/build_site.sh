#!/bin/sh
# Assemble the static site GitHub Pages serves (.github/workflows/pages.yml), into $1 (default _site):
#   index.html, setup.html        the app and the GitHub setup page
#   static/*.js|css|txt           the app; worker.js + decider.js run the board in a browser
#   static/py/app/*.py            the board's Python that the browser runs (Pyodide): see app/browser.py
set -e
OUT="${1:-_site}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$OUT/static/py/app"
cp "$ROOT"/web/index.html "$ROOT"/web/setup.html "$OUT/"
cp "$ROOT"/web/*.js "$ROOT"/web/*.css "$ROOT"/web/wordlist.txt "$OUT/static/"
for f in __init__ browser lang pay profile questions scoring settings sources systemone urls; do
  cp "$ROOT/app/$f.py" "$OUT/static/py/app/"
done
touch "$OUT/.nojekyll"
echo "site in $OUT"
