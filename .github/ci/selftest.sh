#!/usr/bin/env bash
# Loads the site in headless Chrome at three motion levels and three screen sizes, fails on any
# console.assert, and leaves a screenshot of each. No bundler, no test runner: the site is plain
# ES modules, so "does it compile" means "did boot reach the end", which is the sentinel below.
#
#   bash .github/ci/selftest.sh          # google-chrome
#   CHROME=chromium bash .github/ci/selftest.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

CHROME=${CHROME:-google-chrome}
PORT=${PORT:-8089}
OUT=$(pwd)/shots
DIR=$(mktemp -d)
trap 'rm -rf "$DIR"; [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null || true' EXIT

cp -r site/. "$DIR/"
cp .github/ci/fixture.js "$DIR/ci-fixture.js"
cp .github/ci/seed.js "$DIR/ci-seed.js"
# Appended, not edited in place: the fixture has to run after every module has bound its listeners.
python3 - "$DIR/index.html" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
s = s.replace('</body>', '  <script type="module" src="ci-fixture.js"></script>\n</body>')
# Classic script, first in the head: settings are read at module eval, so seeding them later is
# a first-run wizard over every screenshot.
s = s.replace('<head>', '<head>\n  <script src="ci-seed.js"></script>', 1)
open(p, 'w').write(s)
PY

mkdir -p "$OUT"
python3 -m http.server "$PORT" --directory "$DIR" >/dev/null 2>&1 &
SRV=$!
for _ in $(seq 30); do curl -sf "http://127.0.0.1:$PORT/" >/dev/null && break; sleep 0.2; done

fail=0
for motion in full lite off; do
  for size in 1920,1080 780,360 412,915; do
    url="http://127.0.0.1:$PORT/?selftest&motion=$motion"
    log="$DIR/$motion-$size.log"
    dom="$DIR/$motion-$size.html"
    # A wedged headless Chrome would otherwise hang the whole job until the runner's timeout.
    timeout 120 "$CHROME" --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
      --window-size="$size" --virtual-time-budget=15000 \
      --enable-logging=stderr --screenshot="$OUT/$motion-${size/,/x}.png" \
      --dump-dom "$url" >"$dom" 2>"$log" || true

    if grep -q 'Assertion failed' "$log"; then
      echo "FAIL $motion $size — assertion:"; grep 'Assertion failed' "$log" | sort -u; fail=1
    fi
    if ! grep -q 'data-selftest="ok"' "$dom"; then
      echo "FAIL $motion $size — boot never finished (module error?):"
      grep -iE 'error|SyntaxError' "$log" | head -5; fail=1
    fi
    # Animated icons are the whole point of Full and the whole cost of Lite.
    want=$([ "$motion" = full ] && echo icons/anim/ || echo icons/static/)
    grep -q "$want" "$dom" || { echo "FAIL $motion $size — expected $want in the DOM"; fail=1; }
  done
done

[ "$fail" = 0 ] && echo "selftest: 9 runs clean, screenshots in $OUT"
exit "$fail"
