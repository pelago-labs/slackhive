#!/usr/bin/env bash
# ============================================================
# migrate-nlq-skills.sh
#
# Migrates skill files from the NLQ Claude Slack Bot into a
# SlackHive agent via the REST API. Also sets up tool permissions.
#
# Usage:
#   ./scripts/migrate-nlq-skills.sh <agent-id> [base-url]
#
# Arguments:
#   agent-id   — UUID of the GILFOYLE agent in SlackHive
#   base-url   — SlackHive web URL (default: http://localhost:3001)
#
# Environment:
#   SLACKHIVE_USER     — admin username (default: admin)
#   SLACKHIVE_PASS     — admin password (required)
#   NLQ_SKILLS_DIR     — path to skills directory (required)
#   PERMISSIONS_FILE   — path to permissions JSON file (optional)
#
# Example:
#   SLACKHIVE_PASS=mypass NLQ_SKILLS_DIR=./skills ./scripts/migrate-nlq-skills.sh abc-123-uuid
# ============================================================

set -euo pipefail

AGENT_ID="${1:?Usage: $0 <agent-id> [base-url]}"
BASE_URL="${2:-http://localhost:3001}"
USERNAME="${SLACKHIVE_USER:-admin}"
PASSWORD="${SLACKHIVE_PASS:?Set SLACKHIVE_PASS to your admin password}"
NLQ_SKILLS_DIR="${NLQ_SKILLS_DIR:?Set NLQ_SKILLS_DIR to the path of your skills directory}"

COOKIE_JAR=$(mktemp)
trap 'rm -f "$COOKIE_JAR"' EXIT

# ------------------------------------------------------------
# 1. Authenticate
# ------------------------------------------------------------
echo "Logging in to ${BASE_URL}..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${BASE_URL}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}" \
  -c "$COOKIE_JAR")

if [ "$HTTP_CODE" != "200" ]; then
  echo "ERROR: Login failed (HTTP ${HTTP_CODE}). Check SLACKHIVE_USER/SLACKHIVE_PASS."
  exit 1
fi
echo "Authenticated as ${USERNAME}."

# ------------------------------------------------------------
# 2. Migrate skill files
# ------------------------------------------------------------
# Sort order counter — skills are ordered globally
SORT_ORDER=0
MIGRATED=0
FAILED=0

## Skills to skip during migration:
## - corrections-check.md: told Claude to read a corrections.md file at runtime.
##   In SlackHive, corrections are stored as a skill (99-corrections) and compiled
##   directly into CLAUDE.md — no runtime file read needed.
## - forbidden-tools.md: lists tools unavailable in the standalone bot.
##   SlackHive manages tool permissions via the permissions system instead.
SKIP_FILES="corrections-check.md forbidden-tools.md"

migrate_skill() {
  local filepath="$1"
  local category="$2"
  local filename
  filename=$(basename "$filepath")

  # Skip files that don't apply in SlackHive
  if echo "$SKIP_FILES" | grep -qw "$filename"; then
    echo "  [SKIP] ${category}/${filename} (not needed in SlackHive)"
    SORT_ORDER=$((SORT_ORDER + 1))
    return
  fi

  local content
  content=$(cat "$filepath")

  # Escape content for JSON (handle newlines, quotes, backslashes, tabs)
  local json_content
  json_content=$(python3 -c "
import json, sys
with open(sys.argv[1], 'r') as f:
    print(json.dumps(f.read()))
" "$filepath")

  local payload
  payload=$(printf '{"category":"%s","filename":"%s","content":%s,"sortOrder":%d}' \
    "$category" "$filename" "$json_content" "$SORT_ORDER")

  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${BASE_URL}/api/agents/${AGENT_ID}/skills" \
    -H "Content-Type: application/json" \
    -b "$COOKIE_JAR" \
    -d "$payload")

  if [ "$http_code" = "201" ]; then
    echo "  [OK]  ${category}/${filename} (sortOrder: ${SORT_ORDER})"
    MIGRATED=$((MIGRATED + 1))
  else
    echo "  [FAIL] ${category}/${filename} (HTTP ${http_code})"
    FAILED=$((FAILED + 1))
  fi

  SORT_ORDER=$((SORT_ORDER + 1))
}

echo ""
echo "Migrating skills from: ${NLQ_SKILLS_DIR}"
echo "Target agent: ${AGENT_ID}"
echo ""

# Process each category directory in sorted order
for category_dir in "$NLQ_SKILLS_DIR"/*/; do
  category=$(basename "$category_dir")
  echo "Category: ${category}"

  # Process files in sorted order within each category
  for skill_file in "$category_dir"*.md; do
    [ -f "$skill_file" ] || continue
    migrate_skill "$skill_file" "$category"
  done
  echo ""
done

echo "Skills migration complete: ${MIGRATED} migrated, ${FAILED} failed."

# ------------------------------------------------------------
# 3. Set up tool permissions (optional)
# ------------------------------------------------------------
PERMISSIONS_FILE="${PERMISSIONS_FILE:-}"

if [ -n "$PERMISSIONS_FILE" ] && [ -f "$PERMISSIONS_FILE" ]; then
  echo ""
  echo "Setting up tool permissions from: ${PERMISSIONS_FILE}"

  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X PUT "${BASE_URL}/api/agents/${AGENT_ID}/permissions" \
    -H "Content-Type: application/json" \
    -b "$COOKIE_JAR" \
    -d "@${PERMISSIONS_FILE}")

  if [ "$HTTP_CODE" = "200" ]; then
    echo "Permissions set successfully."
  else
    echo "WARNING: Failed to set permissions (HTTP ${HTTP_CODE}). Set them via the web UI."
  fi
else
  echo ""
  echo "No PERMISSIONS_FILE provided — set tool permissions via the web UI."
  echo "  Tip: create a JSON file with {\"allowedTools\": [...], \"deniedTools\": []} and re-run with:"
  echo "  PERMISSIONS_FILE=perms.json $0 ${AGENT_ID}"
fi

echo ""
echo "Done! Agent configured with ${MIGRATED} skills."
echo "The runner will auto-reload and recompile CLAUDE.md."
