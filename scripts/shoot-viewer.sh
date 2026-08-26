#!/bin/sh
# Headless screenshot of the model viewer, for checking a change without
# needing a human to look at a screen.
#
#   npm run viewer:dev &        # serves on :5174
#   sh scripts/shoot-viewer.sh out.png
#
# Notes that cost an hour to learn:
#  - the page needs ?shot, which stops its animation loop; a headless capture
#    waits for the page to go idle and an endless rAF never does
#  - --disable-gpu produces a BLACK canvas: WebGL renders but is never
#    composited. Use ANGLE + SwiftShader and let the compositor run.
#  - a reused --user-data-dir leaves a SingletonLock behind and Chrome aborts
set -e
OUT=${1:-/tmp/viewer.png}
URL=${2:-http://localhost:5174/?shot}
CHROME=${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
PROFILE=$(mktemp -d)
rm -f "$OUT"

"$CHROME" --headless=new \
  --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader \
  --run-all-compositor-stages-before-draw --disable-new-content-rendering-timeout \
  --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check \
  --disable-component-update --disable-background-networking --hide-scrollbars \
  --window-size="${WIDTH:-1500},${HEIGHT:-850}" --virtual-time-budget=20000 \
  --screenshot="$OUT" "$URL" >/dev/null 2>&1 &
PID=$!
i=0
while [ $i -lt 25 ]; do
  sleep 2
  [ -f "$OUT" ] && break
  i=$((i + 1))
done
kill $PID 2>/dev/null || true
[ -f "$OUT" ] && echo "captured $OUT" || { echo "capture failed"; exit 1; }
