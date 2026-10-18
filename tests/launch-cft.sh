#!/bin/bash
# Launches Chrome for Testing with the unpacked extension and a fresh profile on CDP port 9334.
# Download it first:  npx @puppeteer/browsers install chrome@stable --path "$QS_TMP/browsers"
# shields-test.example / shields-3p.example resolve to the local test server (tests/serve.py).
QS_TMP="${QS_TMP:-$HOME/.cache/quietshield}"
TEST_HOST_IP="${TEST_HOST_IP:-127.0.0.1}"
CFT="${CFT:-$(ls -d "$QS_TMP"/browsers/chrome/*/chrome-*/"Google Chrome for Testing.app" 2>/dev/null | head -1)/Contents/MacOS/Google Chrome for Testing}"
RULES="MAP shields-test.example $TEST_HOST_IP, MAP shields-3p.example $TEST_HOST_IP"
EXT="$(cd "$(dirname "$0")/../extension" && pwd)"
pkill -f "remote-debugging-port=9334" ; sleep 1
rm -rf "$QS_TMP/profiles/cft" && mkdir -p "$QS_TMP/profiles/cft"
nohup "$CFT" --remote-debugging-port=9334 --user-data-dir="$QS_TMP/profiles/cft" --no-first-run --no-default-browser-check \
  --load-extension="$EXT" --host-resolver-rules="$RULES" --ignore-certificate-errors \
  --enable-logging=stderr --v=0 about:blank > "$QS_TMP/profiles/cft.log" 2>&1 &
