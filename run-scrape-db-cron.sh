#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/var/www/html/va-scrapper"
LOG_DIR="$PROJECT_DIR/logs"
LOCK_FILE="$PROJECT_DIR/.scrape-db-cron.lock"

mkdir -p "$LOG_DIR"
cd "$PROJECT_DIR"

# Prevent overlapping runs
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[$(date '+%F %T')] Skip: previous scrape job still running"
  exit 0
fi

echo "[$(date '+%F %T')] Cron scrape started"

# Optional explicit chrome path for cron environment
export CHROME_PATH="${CHROME_PATH:-/usr/bin/google-chrome}"

# Run global DB scraper (all supported platforms found in DB URLs)
npm run -s scrape:db:all -- --platforms google,clutch,trustpilot,g2

# Run GoodFirms DB scraper for companies with goodfirms_review_url
npm run -s scrape:goodfirms:db 2>&1 | sed "s/^/[GoodFirms] /"

STATUS=$?
echo "[$(date '+%F %T')] Cron scrape finished with status $STATUS"
exit $STATUS
