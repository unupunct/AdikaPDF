#!/usr/bin/env bash
# Creates a fresh SoftHSM2 test token "Adika Test Token" (user PIN 123456)
# holding an RSA-2048 and an ECDSA P-256 signing key + certificate.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HSM="$ROOT/.tools/SoftHSM2"
WORK="$ROOT/.tools/softhsm-test"
PY="/c/Program Files/Python313/python.exe"
rm -rf "$WORK"; mkdir -p "$WORK/tokens" "$WORK/certs"
WIN_WORK="$(cygpath -m "$WORK")"
printf 'directories.tokendir = %s/tokens\nobjectstore.backend = file\nlog.level = ERROR\nslots.removable = false\n' "$WIN_WORK" > "$WORK/softhsm2.conf"
export SOFTHSM2_CONF="$WIN_WORK/softhsm2.conf"
PYTHONPATH="$(cygpath -w "$ROOT/node_modules/.cache/py")" "$PY" "$ROOT/tests/token/make_certs.py" "$WIN_WORK/certs"
DLL32="$(cygpath -m "$HSM/lib/softhsm2.dll")"
UTIL() { "$HSM/bin/softhsm2-util.exe" --module "$DLL32" "$@"; }
UTIL --init-token --free --label "Adika Test Token" --pin 123456 --so-pin 12345678
IMPORT="$ROOT/src-tauri/target/release/examples/token_import_cert.exe"
DLL="$(cygpath -m "$HSM/lib/softhsm2-x64.dll")"
for k in rsa:01:"RSA signing key" ec:02:"ECDSA signing key"; do
  tag="${k%%:*}"; rest="${k#*:}"; id="${rest%%:*}"; label="${rest#*:}"
  UTIL --import "$WIN_WORK/certs/$tag.key.pem" --token "Adika Test Token" --label "$label" --id "$id" --pin 123456
  "$IMPORT" "$DLL" "Adika Test Token" 123456 "$id" "$label" "$WIN_WORK/certs/$tag.der"
done
echo "SOFTHSM2_CONF=$SOFTHSM2_CONF"
echo "MODULE=$DLL"
