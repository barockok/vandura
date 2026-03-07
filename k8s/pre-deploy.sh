#!/bin/bash
#
# pre-deploy.sh - Run database migration before deployment
#
# Usage: ./pre-deploy.sh
#
# This script:
# 1. Applies the migration job
# 2. Waits for the job to complete
# 3. Returns success only if migration succeeded
#
# Use in CI/CD before applying deployment.yml

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAMESPACE="vandura"
JOB_NAME="vandura-migrate"
TIMEOUT=300  # 5 minutes

echo "Running database migration..."

# Apply the migration job
kubectl apply -f "$SCRIPT_DIR/migration-job.yml"

echo "Waiting for migration to complete (timeout: ${TIMEOUT}s)..."

# Wait for job completion
START_TIME=$(date +%s)
while true; do
  CURRENT_TIME=$(date +%s)
  ELAPSED=$((CURRENT_TIME - START_TIME))

  if [ $ELAPSED -ge $TIMEOUT ]; then
    echo "ERROR: Migration timed out after ${TIMEOUT} seconds"
    kubectl logs -l app=vandura,component=migration -n $NAMESPACE
    exit 1
  fi

  # Check job status
  SUCCEEDED=$(kubectl get job $JOB_NAME -n $NAMESPACE -o jsonpath='{.status.succeeded}' 2>/dev/null || echo "0")
  FAILED=$(kubectl get job $JOB_NAME -n $NAMESPACE -o jsonpath='{.status.failed}' 2>/dev/null || echo "0")

  if [ "$SUCCEEDED" = "1" ]; then
    echo "Migration completed successfully"
    break
  fi

  if [ "$FAILED" != "0" ]; then
    echo "ERROR: Migration failed"
    echo "=== Migration logs ==="
    kubectl logs -l app=vandura,component=migration -n $NAMESPACE --tail=50
    exit 1
  fi

  echo "  Migration in progress... (${ELAPSED}s elapsed)"
  sleep 5
done

# Show migration logs for debugging
echo "=== Migration output ==="
kubectl logs -l app=vandura,component=migration -n $NAMESPACE --tail=20 || true

echo "Migration job completed. Proceed with deployment."
