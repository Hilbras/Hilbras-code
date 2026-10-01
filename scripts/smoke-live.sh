#!/usr/bin/env bash
#
# End-to-end check against a real model.
#
# The unit and SSE-level tests cover the plumbing; only this exercises a real
# provider end to end — real credentials, real tool calls, a real file written.
# It is intentionally separate from `bun run check` so CI needs no secrets.
#
# Usage:
#   ANTHROPIC_API_KEY=sk-ant-... ./scripts/smoke-live.sh
#   HILBRAS_PROVIDER=ollama HILBRAS_MODEL=qwen2.5-coder ./scripts/smoke-live.sh
set -euo pipefail

PROVIDER="${HILBRAS_PROVIDER:-anthropic}"
MODEL="${HILBRAS_MODEL:-}"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/hilbras-smoke-XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT

# Prefer the binary built from this checkout. A globally installed
# `hilbras-code` may be an older published build, and this script must report
# on the code in the working tree, not on whatever happens to be on PATH.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -x "$REPO_ROOT/bin/hilbras-code-linux-x64" ]; then
  CLI="$REPO_ROOT/bin/hilbras-code-linux-x64"
elif [ -x "$REPO_ROOT/bin/hilbras-code-darwin-arm64" ]; then
  CLI="$REPO_ROOT/bin/hilbras-code-darwin-arm64"
elif [ -x "$REPO_ROOT/bin/hilbras-code-darwin-x64" ]; then
  CLI="$REPO_ROOT/bin/hilbras-code-darwin-x64"
else
  CLI="$(command -v hilbras-code || true)"
fi

if [ -z "$CLI" ] || [ ! -x "$CLI" ]; then
  echo "error: no hilbras-code binary found." >&2
  echo "       run 'bun run build' first, or install the package globally." >&2
  exit 2
fi

echo "cli:       $CLI"

if [ "$PROVIDER" = "anthropic" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "error: ANTHROPIC_API_KEY is not set." >&2
  echo "       export a key, or set HILBRAS_PROVIDER=ollama for a local run." >&2
  exit 2
fi

echo "workspace: $WORKDIR"
echo "provider:  $PROVIDER ${MODEL:-(default model)}"
echo

# A scratch repo with one obvious, verifiable task: the agent must read the
# file, edit it, and run the test it wrote. That exercises read_file, write_file,
# edit_file and run_shell in a single turn.
#
# Note the module is a .js file: the agent's test imports it, so a .txt name
# would make the task unsatisfiable and the failure would be the fixture's.
cat >"$WORKDIR/greeting.js" <<'EOF'
export function greet() {
  return "hello";
}
EOF

cat >"$WORKDIR/TASK.md" <<'EOF'
# Task

`greeting.js` exports a `greet()` function that returns "hello".

1. Change it so it returns "hello, world".
2. Write `greeting.test.js` in this directory that asserts greet() returns
   "hello, world", and run it with `node --test`.
3. Report what you ran and whether it passed.
EOF

echo "--- files before ---"
ls -1 "$WORKDIR"
echo
echo "--- running agent (up to 6 steps) ---"
echo

set +e
"$CLI" \
  --workspace "$WORKDIR" \
  --max-steps 6 \
  "Read TASK.md and complete it." 2>&1
STATUS=$?
set -e

echo
echo "--- files after ---"
ls -1 "$WORKDIR"
echo

if [ "$STATUS" -ne 0 ]; then
  echo "FAIL: agent exited $STATUS" >&2
  exit "$STATUS"
fi

# The agent may legitimately have failed to do the work; this is what we assert.
echo "--- verifying the result ---"

if [ ! -f "$WORKDIR/greeting.test.js" ]; then
  echo "FAIL: the agent did not create greeting.test.js" >&2
  exit 1
fi

if ! grep -q "hello, world" "$WORKDIR/greeting.js"; then
  echo "FAIL: greeting.js was not updated" >&2
  cat "$WORKDIR/greeting.js" >&2
  exit 1
fi

echo "running the agent's test with node --test:"
if (cd "$WORKDIR" && node --test 2>&1 | tail -12); then
  echo
  echo "PASS: the agent edited the file, wrote a test, and it passes."
else
  echo
  echo "FAIL: the agent's test does not pass" >&2
  exit 1
fi
