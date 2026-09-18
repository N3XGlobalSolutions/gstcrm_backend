#!/usr/bin/env bash
# =============================================================================
# GST CRM - Docker PostgreSQL Automated Backup Script
# Keeps compressed daily backups and prunes backups older than RETENTION_DAYS
# =============================================================================

set -euo pipefail

# Script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Load .env if present
if [ -f "${PROJECT_ROOT}/.env" ]; then
  export $(grep -v '^#' "${PROJECT_ROOT}/.env" | grep -E '^(DB_USER|DB_NAME|DB_PASSWORD)=' | xargs)
fi

CONTAINER_NAME="gstcrm-postgres"
DB_USER="${DB_USER:-gstcrm_user}"
DB_NAME="${DB_NAME:-gstcrm_db}"
RETENTION_DAYS=14

# Backup destination directory
BACKUP_DIR="${PROJECT_ROOT}/backups/docker"
mkdir -p "${BACKUP_DIR}"

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILENAME="gstcrm_${DB_NAME}_${TIMESTAMP}.sql.gz"
BACKUP_FILEPATH="${BACKUP_DIR}/${BACKUP_FILENAME}"

echo "=================================================="
echo " Starting GST Docker Database Backup: $(date)"
echo " Container: ${CONTAINER_NAME}"
echo " Database:  ${DB_NAME}"
echo " Target:    ${BACKUP_FILEPATH}"
echo "=================================================="

# Check if Docker container is running
if ! docker ps --format '{{.Names}}' | grep -Eq "^${CONTAINER_NAME}\$"; then
  echo "❌ Error: Docker container '${CONTAINER_NAME}' is not running!" >&2
  exit 1
fi

# Execute pg_dump inside container and compress with gzip
if docker exec "${CONTAINER_NAME}" pg_dump -U "${DB_USER}" -d "${DB_NAME}" --clean --if-exists | gzip > "${BACKUP_FILEPATH}"; then
  FILE_SIZE=$(du -h "${BACKUP_FILEPATH}" | cut -f1)
  echo "✅ Backup completed successfully!"
  echo "   File: ${BACKUP_FILENAME} (${FILE_SIZE})"
else
  echo "❌ Error: pg_dump failed!" >&2
  rm -f "${BACKUP_FILEPATH}"
  exit 1
fi

# Retention policy: remove backups older than RETENTION_DAYS
echo "🧹 Pruning backups older than ${RETENTION_DAYS} days..."
find "${BACKUP_DIR}" -type f -name "gstcrm_${DB_NAME}_*.sql.gz" -mtime +"${RETENTION_DAYS}" -exec rm -v {} \;

echo "🏁 Finished backup process at $(date)"
echo "=================================================="
