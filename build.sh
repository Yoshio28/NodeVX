#!/usr/bin/env bash
# Compila NodeVX.exe para Windows (x64) desde Linux/macOS/Windows (Git Bash).
# Requiere Go 1.22+. El icono se incrusta con "rsrc" (se instala si falta).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
if ! command -v rsrc >/dev/null 2>&1 && [ ! -x "$(go env GOPATH)/bin/rsrc" ]; then
  go install github.com/akavel/rsrc@v0.10.2
fi
RSRC="$(command -v rsrc || echo "$(go env GOPATH)/bin/rsrc")"
"$RSRC" -ico assets/icon.ico -manifest assets/nodevx.manifest -arch amd64 -o rsrc_windows_amd64.syso
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H windowsgui -s -w" -o dist/NodeVX.exe .
echo "Listo: dist/NodeVX.exe"
