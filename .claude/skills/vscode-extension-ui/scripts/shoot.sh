#!/usr/bin/env bash
# Screenshot a LocalPilot UI preview harness at a real sidebar width.
# Usage: shoot.sh [harness.html] [width] [query ...]
#   harness  file in scripts/ (default ui-preview.html)
#   width    iframe width in px (default 360); headless Chrome cannot go below 500 px, hence the iframes
#   query    one frame per query string, side by side (default: "live=0" and "" = idle and live run)
# Prints the PNG path.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../../.." && pwd)"
harness="${1:-ui-preview.html}"
width="${2:-360}"
shift $(( $# > 2 ? 2 : $# ))
queries=("$@")
[ ${#queries[@]} -eq 0 ] && queries=("live=0" "")

chrome="${CHROME:-}"
for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "$(command -v google-chrome || true)" "$(command -v chromium || true)" "$(command -v chromium-browser || true)"; do
  [ -z "$chrome" ] && [ -n "$c" ] && [ -x "$c" ] && chrome="$c"
done
[ -z "$chrome" ] && { echo "No Chrome/Chromium found; set CHROME=/path/to/chrome" >&2; exit 1; }

out="$(mktemp -d "${TMPDIR:-/tmp}/lp-ui-XXXX")"
# The harness links ../media/*; rewrite to absolute URLs so the copy works from the temp folder.
sed "s|\.\./media/|file://$root/media/|g" "$root/scripts/$harness" > "$out/page.html"
frames=""
for q in "${queries[@]}"; do
  frames+="<iframe src=\"page.html?$q\" style=\"width:${width}px;height:1400px;border:0\"></iframe>"
done
printf '<body style="margin:0;background:#000;display:flex;gap:8px">%s</body>' "$frames" > "$out/wrap.html"
total=$(( (width + 8) * ${#queries[@]} ))
[ "$total" -lt 500 ] && total=500
"$chrome" --headless=new --disable-gpu --hide-scrollbars --window-size="$total,1400" --virtual-time-budget=4000 \
  --screenshot="$out/shot.png" "file://$out/wrap.html" >/dev/null 2>&1
echo "$out/shot.png"
