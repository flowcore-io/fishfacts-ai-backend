#!/usr/bin/env bash
# Enable the PostGIS extension on the Flowcore customer Azure PostgreSQL Flexible Server.
#
# Pre-conditions:
#  - `az` is logged in to the flowcore.com tenant.
#  - The caller's IP is whitelisted on `flowcore-customer` (Networking -> firewall rules).
#  - Admin password for the `flowcore-customer` server is available in 1Password
#    ("Postgres - Flowcore Customers"). The script does NOT read it; it expects
#    the caller to set $PGPASSWORD or rely on a .pgpass entry before running.
#
# This script is idempotent — re-running it is safe.
#
# References:
#   - Usable fragment f8da2d73-02e8-45cd-8e45-8e24cc2dbc39
#     "Enabling CAST AI Index Advisor on Azure PostgreSQL Flexible Server"
#   - Usable fragment ef9d2064-1cf6-44d7-8aa7-cd9f11961a59
#     "Create a Flowcore Customer Database"
#   - Usable fragment 9eda7c0d-cc8c-448b-bbb4-9079348befd4
#     "Unable to connect to the Flowcore customer databases" (IP whitelisting)

set -euo pipefail

RESOURCE_GROUP="${AZURE_PG_RESOURCE_GROUP:-flowcore-platform}"
SERVER_NAME="${AZURE_PG_SERVER:-flowcore-customer}"
DB_NAME="${AZURE_PG_DATABASE:-}"
ADMIN_USER="${AZURE_PG_ADMIN_USER:-}"
ADMIN_HOST="${AZURE_PG_HOST:-${SERVER_NAME}.postgres.database.azure.com}"

if [[ -z "${DB_NAME}" ]]; then
  echo "AZURE_PG_DATABASE is required (the target Postgres database name on flowcore-customer, e.g. fishfacts_ai_backend)" >&2
  exit 1
fi
if [[ -z "${ADMIN_USER}" ]]; then
  echo "AZURE_PG_ADMIN_USER is required (the Azure PG admin user, see 'Settings -> Connect' on the flowcore-customer resource)" >&2
  exit 1
fi

echo "==> Verifying az login"
az account show --query "user.name" -o tsv

echo
echo "==> Reading current azure.extensions allow-list on ${SERVER_NAME}"
current=$(az postgres flexible-server parameter show \
  --resource-group "${RESOURCE_GROUP}" \
  --server-name "${SERVER_NAME}" \
  --name azure.extensions \
  --query value -o tsv)
echo "    current: ${current:-<empty>}"

if echo ",${current}," | grep -i ",POSTGIS," >/dev/null; then
  echo "==> POSTGIS already present in azure.extensions — skipping parameter update"
else
  if [[ -z "${current}" ]]; then
    new_value="POSTGIS"
  else
    new_value="${current},POSTGIS"
  fi
  echo "==> Setting azure.extensions to: ${new_value}"
  az postgres flexible-server parameter set \
    --resource-group "${RESOURCE_GROUP}" \
    --server-name "${SERVER_NAME}" \
    --name azure.extensions \
    --value "${new_value}" \
    --query "{name:name, value:value, allowedValues:allowedValues}" -o table
fi

echo
echo "==> Creating PostGIS extension in database '${DB_NAME}' as ${ADMIN_USER}"
echo "    (this requires PGPASSWORD or .pgpass; the admin password lives in 1Password)"
psql "host=${ADMIN_HOST} user=${ADMIN_USER} dbname=${DB_NAME} sslmode=require" \
  -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS postgis;" \
  -c "SELECT PostGIS_Version();" \
  -c "\dx postgis"

echo
echo "==> Done. The fishfacts-ai-backend service can now apply drizzle/0002_jmelding_geo.sql"
