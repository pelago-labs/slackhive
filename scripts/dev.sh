#!/usr/bin/env bash
# ==============================================================================
# dev.sh — Development startup script for Slack Claude Code Agent Team
#
# Starts all platform services via Docker Compose:
#   - PostgreSQL 16  (localhost:5432)
#   - Redis 7        (localhost:6379)
#   - Web UI         (http://localhost:3000)
#   - Runner service (agent manager)
#
# Usage:
#   sh scripts/dev.sh              # Start all services (foreground)
#   sh scripts/dev.sh -d           # Start all services (detached)
#   sh scripts/dev.sh --no-cache   # Rebuild images without cache
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$ROOT_DIR"

# Bootstrap .env if not present
if [ ! -f .env ]; then
  echo "📋 No .env file found. Creating from .env.example..."
  cp .env.example .env
  echo ""
  echo "⚠️  IMPORTANT: Update .env with your credentials before proceeding."
  echo "   At minimum, set POSTGRES_PASSWORD to a secure value."
  echo ""
  echo "   Then re-run: sh scripts/dev.sh"
  exit 1
fi

echo "╔══════════════════════════════════════════════════════╗"
echo "║        Slack Claude Code Agent Team                  ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  Web UI:   http://localhost:3000                     ║"
echo "║  Postgres: localhost:5432                            ║"
echo "║  Redis:    localhost:6379                            ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

docker compose up --build "$@"
