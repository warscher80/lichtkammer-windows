#!/bin/bash
# Bedienungs-Messung lokal (Linux, Xvfb): scripts/perf-run.sh <App-Ordner> <Ausgabe> <Fotos>
APP=${1:-.}; OUT=${2:-/tmp/perf}; PHOTOS=${3:-/workspace/perf600}
rm -rf "$OUT"; mkdir -p "$OUT"
cd "$APP"
for PHASE in ${PHASES:-import run}; do
  xvfb-run -a -s "-screen 0 1600x1000x24" timeout 1500 npx electron . --no-sandbox --disable-dev-shm-usage \
    --perf-test="$OUT" --perf-photos="$PHOTOS" --perf-phase=$PHASE > "$OUT/log-$PHASE.txt" 2>&1
  echo "phase $PHASE exit $?"
done
cat "$OUT"/perf-*.json
