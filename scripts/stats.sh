#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GENERATOR_DIR="$ROOT_DIR/node_modules/github-profile-summary-cards"
OUTPUT_DIR="$ROOT_DIR/data/stats"
TSX="$ROOT_DIR/node_modules/.bin/tsx"

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "Error: GITHUB_TOKEN is not set." >&2
  exit 1
fi

for command in python3 curl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Error: Required command is missing: $command" >&2
    exit 1
  fi
done

if [[ ! -f "$GENERATOR_DIR/scripts/dev-server.ts" ]]; then
  echo "Error: The installed generator does not contain scripts/dev-server.ts." >&2
  echo "Run pnpm install and check the installed upstream revision." >&2
  exit 1
fi

if [[ ! -x "$TSX" ]]; then
  echo "Error: The project's tsx executable was not found." >&2
  echo "Run pnpm install first." >&2
  exit 1
fi

TEMP_DIR="$(mktemp -d)"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi

  rm -rf "$TEMP_DIR"
}

trap cleanup EXIT

# Avoid accidentally connecting to an unrelated local server.
if python3 - <<'PY'
import socket

with socket.socket() as sock:
    sock.bind(("127.0.0.1", 3000))
PY
then
  :
else
  echo "Error: Port 3000 is already in use." >&2
  exit 1
fi

(
  cd "$GENERATOR_DIR"
  exec "$TSX" scripts/dev-server.ts
) >"$TEMP_DIR/server.log" 2>&1 &

SERVER_PID=$!

echo "Waiting for the local card generator..."

READY=false

for ((attempt = 1; attempt <= 90; attempt++)); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Error: The generator stopped unexpectedly." >&2
    cat "$TEMP_DIR/server.log" >&2
    exit 1
  fi

  if curl \
    --silent \
    --max-time 3 \
    "http://127.0.0.1:3000/" \
    --output /dev/null; then
    READY=true
    break
  fi

  sleep 2
done

if [[ "$READY" != true ]]; then
  echo "Error: The generator did not become ready." >&2
  cat "$TEMP_DIR/server.log" >&2
  exit 1
fi

mkdir -p "$TEMP_DIR/cards"

generate_card() {
  local endpoint="$1"
  local key="$2"

  echo "Generating ${key}.svg..."

  if ! curl \
    --fail \
    --silent \
    --show-error \
    --get \
    --retry 3 \
    --retry-delay 5 \
    --connect-timeout 10 \
    --max-time 180 \
    "http://127.0.0.1:3000/api/cards/${endpoint}" \
    --data-urlencode "username=Master3307" \
    --data-urlencode "theme=zenburn" \
    --data-urlencode "animation=load" \
    --data-urlencode "duration=1.3" \
    --data-urlencode "utcOffset=2" \
    --data-urlencode "title_color=dc8add" \
    --data-urlencode "text_color=8e58d4" \
    --data-urlencode "bg_color=00000000" \
    --data-urlencode "border_color=00000000" \
    --data-urlencode "icon_color=8e58d4" \
    --data-urlencode "chart_color=dc8add" \
    --data-urlencode "mock=0" \
    --output "$TEMP_DIR/cards/${key}.svg"; then
    echo "Error: Failed to generate ${key}.svg." >&2
    cat "$TEMP_DIR/server.log" >&2
    return 1
  fi
}

generate_card profile-details profile
generate_card repos-per-language repos
generate_card most-commit-language commits
generate_card stats stats
generate_card productive-time time

echo "Fetching WakaTime coding time..."

curl \
  --fail \
  --silent \
  --show-error \
  --location \
  --retry 3 \
  --retry-delay 5 \
  --connect-timeout 10 \
  --max-time 60 \
  "https://wakatime.com/badge/user/229ef515-6448-4da4-8301-8209d6e208dc.svg" \
  --output "$TEMP_DIR/wakatime-original.svg"

echo "Building WakaTime card and adding typing animations..."

python3 - \
  "$TEMP_DIR/cards" \
  "$TEMP_DIR/wakatime-original.svg" <<'PY'
import html
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"

ET.register_namespace("", SVG_NS)
ET.register_namespace("xlink", XLINK_NS)

directory = Path(sys.argv[1])
wakatime_source = Path(sys.argv[2])

EXPECTED = (
    "profile",
    "repos",
    "commits",
    "stats",
    "time",
    "wakatime",
)

# Typing settings, in seconds.
CHARACTER_INTERVAL = 0.035
FIRST_TEXT_START = 0.20
TEXT_STAGGER = 0.12

# Cap a long field's typing time without dropping any characters.
MAX_FIELD_DURATION = 1.65

# Keep dense charts from taking too long to finish.
MAX_STAGGER = 0.80


def tag(name):
    return f"{{{SVG_NS}}}{name}"


def local_name(element):
    return element.tag.rsplit("}", 1)[-1]


def read_svg(path):
    if not path.is_file() or not path.stat().st_size:
        raise SystemExit(f"Missing or empty SVG: {path.name}")

    root = ET.parse(path).getroot()

    if root.tag != tag("svg"):
        raise SystemExit(f"Invalid SVG root: {path.name}")

    return root


def extract_wakatime_value(root):
    candidates = []

    aria_label = root.get("aria-label", "")
    if aria_label:
        candidates.append(
            aria_label.rsplit(":", 1)[-1].strip()
        )

    for element in root.iter():
        if local_name(element) in {"text", "title"}:
            text = "".join(element.itertext()).strip()

            if text:
                candidates.append(
                    text.rsplit(":", 1)[-1].strip()
                )

    time_pattern = re.compile(
        r"\d[\d,.]*\s*"
        r"(?:hours?|hrs?|minutes?|mins?|seconds?|secs?|days?)\b",
        re.IGNORECASE,
    )

    value = next(
        (
            candidate
            for candidate in candidates
            if time_pattern.search(candidate)
        ),
        None,
    )

    if not value:
        raise SystemExit(
            "Could not extract coding time from WakaTime. "
            "Existing output files were not replaced."
        )

    if len(value) > 100:
        raise SystemExit(
            "Unexpectedly long WakaTime badge value."
        )

    return value


def build_wakatime(value):
    safe_value = html.escape(value)

    accessible_label = html.escape(
        f"WakaTime coding time since Apr 11 2025: {value}",
        quote=True,
    )

    # A small drawing clock replaces the static logo.
    # Its center remains aligned with the original heading layout.
    return f'''<svg xmlns="{SVG_NS}"
  width="440"
  height="88"
  viewBox="0 0 440 88"
  role="img"
  aria-label="{accessible_label}">

  <title>{accessible_label}</title>

  <style>
    text {{
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
                   Helvetica, Arial, sans-serif;
      text-anchor: middle;
      white-space: pre;
    }}

    .waka-icon {{
      fill: none;
      stroke: #dc8add;
      stroke-width: 1.7;
      stroke-linecap: round;
      stroke-linejoin: round;
    }}

    .waka-draw {{
      stroke-dasharray: 1;
      animation: waka-draw 1.1s cubic-bezier(.45, 0, .25, 1) both;
    }}

    .waka-detail {{
      animation-delay: .18s;
    }}

    .waka-pulse {{
      animation: waka-breathe 6s ease-in-out 1.4s infinite;
    }}

    @keyframes waka-draw {{
      from {{
        stroke-dashoffset: 1;
        opacity: 0;
      }}
      10% {{
        opacity: 1;
      }}
      to {{
        stroke-dashoffset: 0;
        opacity: 1;
      }}
    }}

    @keyframes waka-breathe {{
      0%, 100% {{
        opacity: 1;
      }}
      50% {{
        opacity: .65;
      }}
    }}

    @media (prefers-reduced-motion: reduce) {{
      .waka-draw,
      .waka-pulse {{
        animation: none;
      }}

      .waka-draw {{
        stroke-dasharray: none;
      }}
    }}
  </style>

  <g class="waka-icon"
    transform="translate(173 7)"
    aria-hidden="true">
    <g class="waka-pulse">
      <circle
        class="waka-draw"
        pathLength="1"
        cx="9" cy="9" r="7.5"/>

      <path
        class="waka-draw waka-detail"
        pathLength="1"
        d="M9 4.5V9l3 2"/>
    </g>
  </g>

  <text
    x="199"
    y="22"
    fill="#dc8add"
    font-size="14"
    font-weight="600"
    style="text-anchor: start"
    textLength="68"
    lengthAdjust="spacingAndGlyphs">WakaTime</text>

  <text
    x="220"
    y="51"
    fill="#8e58d4"
    font-size="23"
    font-weight="700">{safe_value}</text>

  <text
    x="220"
    y="73"
    fill="#8e58d4"
    font-size="11">Tracked since Apr 11, 2025</text>
</svg>
'''


def text_segments(container):
    """Collect existing text runs without flattening styled tspans."""
    segments = []

    def visit(element):
        if element.text:
            segments.append(element.text)

        for child in element:
            if local_name(child) == "tspan":
                visit(child)

            if child.tail:
                segments.append(child.tail)

    visit(container)
    return segments


def animate_text(text_element, start):
    segments = text_segments(text_element)
    character_count = sum(len(segment) for segment in segments)

    if not character_count:
        return 0

    # Avoid changing per-character positioning semantics.
    # Ordinary single x/y coordinates and styled tspans are supported.
    for element in text_element.iter():
        if local_name(element) not in {"text", "tspan"}:
            raise ValueError(
                "Unsupported child inside SVG text: "
                f"{local_name(element)}"
            )

        for attribute in ("x", "y", "dx", "dy", "rotate"):
            raw = element.get(attribute)

            if raw and len(
                raw.replace(",", " ").split()
            ) > 1:
                raise ValueError(
                    "Cannot safely split text with a coordinate list: "
                    f"{attribute}={raw!r}"
                )

    interval = min(
        CHARACTER_INTERVAL,
        MAX_FIELD_DURATION / max(character_count - 1, 1),
    )

    index = 0

    def make_characters(content):
        nonlocal index

        characters = []

        for character in content:
            span = ET.Element(
                tag("tspan"),
                {
                    "class": "readme-typing-character",
                },
            )
            span.text = character

            ET.SubElement(
                span,
                tag("set"),
                {
                    "attributeName": "visibility",
                    "to": "hidden",
                    "begin": "0s",
                    "dur": f"{start + index * interval:.3f}s",
                },
            )

            characters.append(span)
            index += 1

        return characters

    def rewrite(element):
        # Snapshot original children before inserting character spans.
        original_children = list(element)
        original_text = element.text
        element.text = None

        for child in original_children:
            element.remove(child)

        if original_text:
            element.extend(make_characters(original_text))

        for child in original_children:
            original_tail = child.tail
            child.tail = None

            rewrite(child)
            element.append(child)

            if original_tail:
                element.extend(make_characters(original_tail))

    rewrite(text_element)
    text_element.set(XML_SPACE, "preserve")

    return index


def add_typing(root, filename):
    # Do not modify text inside reusable definitions or clipping data.
    excluded_containers = {
        "defs",
        "clipPath",
        "mask",
        "pattern",
        "marker",
        "symbol",
    }

    targets = []

    def collect(element):
        name = local_name(element)

        if name in excluded_containers:
            return

        if name == "text":
            targets.append(element)
            return

        for child in element:
            collect(child)

    collect(root)

    if not targets:
        raise SystemExit(
            f"No visible SVG text found in {filename}."
        )

    character_total = 0

    for index, element in enumerate(targets):
        start = (
            FIRST_TEXT_START
            + min(index * TEXT_STAGGER, MAX_STAGGER)
        )

        try:
            character_total += animate_text(element, start)
        except ValueError as error:
            raise SystemExit(
                f"Cannot safely animate {filename}: {error}"
            ) from error

    style = ET.Element(tag("style"))
    style.text = """
    .readme-typing-character {
      white-space: pre;
    }

    @media (prefers-reduced-motion: reduce) {
      .readme-typing-character {
        visibility: visible !important;
      }
    }
    """

    # Place this after existing top-level styles.
    root.append(style)

    print(
        f"Animated {filename}: "
        f"{len(targets)} text fields, "
        f"{character_total} characters"
    )


wakatime_root = read_svg(wakatime_source)
wakatime_value = extract_wakatime_value(wakatime_root)

wakatime_path = directory / "wakatime.svg"
wakatime_path.write_text(
    build_wakatime(wakatime_value),
    encoding="utf-8",
)

for key in EXPECTED:
    path = directory / f"{key}.svg"
    root = read_svg(path)

    # Record the visible text before transformation.
    before = [
        "".join(element.itertext())
        for element in root.iter(tag("text"))
    ]

    add_typing(root, path.name)

    # Confirm that every original text field is still complete.
    after = [
        "".join(element.itertext())
        for element in root.iter(tag("text"))
    ]

    if before != after:
        raise SystemExit(
            f"Text changed unexpectedly in {path.name}."
        )

    tree = ET.ElementTree(root)
    tree.write(
        path,
        encoding="utf-8",
        xml_declaration=False,
    )

    # Parse the serialized result too.
    read_svg(path)

    print(f"Validated {path.name}")

print(f"WakaTime coding time: {wakatime_value}")
PY

# Publish only after all six cards have generated and validated.
mkdir -p "$OUTPUT_DIR"

for key in profile repos commits stats time wakatime; do
  cp \
    "$TEMP_DIR/cards/${key}.svg" \
    "$OUTPUT_DIR/${key}.svg"
done

echo "Generated all six animated cards in data/stats/."
