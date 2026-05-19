#!/usr/bin/env bash
# download-vendor.sh
# Downloads all browser-side third-party scripts at pinned versions into
# public/vendor/ so they are served from your own origin rather than CDNs.
#
# Idempotent: skips files that already exist. Safe to re-run after a partial
# failure. Commit the downloaded files to version control.
#
# Usage: bash scripts/download-vendor.sh

set -euo pipefail

VENDOR="$(cd "$(dirname "$0")/.." && pwd)/public/vendor"
mkdir -p "$VENDOR"

fetch() {
    local label="$1" dest="$2"
    shift 2
    local urls=("$@")

    if [[ -s "$VENDOR/$dest" ]]; then
        echo "  skip   $dest (already exists)"
        return
    fi

    local ok=0
    for url in "${urls[@]}"; do
        echo "  trying $url"
        if curl -fSL --max-time 30 --retry 2 --retry-delay 3 "$url" -o "$VENDOR/$dest" 2>/dev/null; then
            echo "  saved  -> public/vendor/$dest ($(wc -c < "$VENDOR/$dest") bytes)"
            ok=1
            break
        else
            echo "  failed, trying next URL..."
            rm -f "$VENDOR/$dest"
        fi
    done

    if [[ $ok -eq 0 ]]; then
        echo "ERROR: could not download $label from any source" >&2
        exit 1
    fi
}

echo "Downloading vendor files into public/vendor/ ..."
echo ""

# @solana/web3.js — match the server-side version in package.json
fetch "@solana/web3.js@1.98.4" "web3.js" \
    "https://unpkg.com/@solana/web3.js@1.98.4/lib/index.iife.min.js" \
    "https://cdn.jsdelivr.net/npm/@solana/web3.js@1.98.4/lib/index.iife.min.js"

# buffer — browser IIFE build (bundle.run wraps CommonJS packages for browsers)
fetch "buffer@6.0.3" "buffer.js" \
    "https://bundle.run/buffer@6.0.3" \
    "https://cdn.jsdelivr.net/npm/buffer@6.0.3/index.js"

# moment — match server-side package.json (2.30.1)
fetch "moment@2.30.1" "moment.min.js" \
    "https://cdn.jsdelivr.net/npm/moment@2.30.1/moment.min.js" \
    "https://unpkg.com/moment@2.30.1/moment.min.js"

# NOTE: @solana/spl-token and @project-serum/anchor were removed.
# spl-token has no IIFE/browser build — the original script tag was a silent
# 404. Browser code constructs token instructions manually using web3.js alone.
# anchor is unused by any browser JS file.

echo ""
echo "Generating checksums..."
sha256sum "$VENDOR"/*.js > "$VENDOR/checksums.sha256"
echo "  saved  -> public/vendor/checksums.sha256"
echo ""
echo "Done. Commit public/vendor/ to version control."
