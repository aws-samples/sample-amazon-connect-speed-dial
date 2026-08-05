#!/usr/bin/env bash
set -uo pipefail
# NOTE: deliberately not `set -e` — teardown is a best-effort sweep; every step
# tolerates already-deleted resources so the script is safely re-runnable.

# teardown.sh — full cleanup of a blueprint deployment.
#
# `cdk destroy --all` alone is NOT enough:
#   1. DELETE_FAILED on the ai-agent security profile: publishing the
#      orchestration agent (console or automation) associates the profile with
#      the agent's numbered version ARNs — associations CloudFormation doesn't
#      know about. They must be disassociated BEFORE destroy.
#   2. Retained-by-design resources survive destroy when retainData=true (the
#      default): the Connect instance, storage/KB/schema/SAP buckets, the
#      storage KMS key, and the sap-orders DynamoDB table. This script sweeps
#      them afterwards.
#
# It also unblocks the "Instance alias is already used" error on redeploy: a
# failed first deploy leaves the retained instance behind, and its globally-
# unique alias blocks a fresh deploy until the instance is deleted.
#
# Usage: teardown.sh <projectName | project-dir> [region]
#   projectName   e.g. "rev" — resolves the rendered project at ./csp-rev
#   project-dir   or pass the rendered dir (csp-<name>) directly
#   region        optional; resolved from the project's values file, else
#                 the AWS_REGION/AWS_DEFAULT_REGION env, else us-east-1
#
# DESTRUCTIVE. Retained resources may hold call recordings, transcripts,
# knowledge-base documents, and customer data you are legally required to keep
# (see README "Full delete"). This script requires an interactive typed
# confirmation; set FORCE_TEARDOWN=1 to skip it in automation.

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓ $1${NC}"; }
info() { echo "→ $1"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }

ARG="${1:?usage: teardown.sh <projectName | project-dir> [region]}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Resolve the rendered project dir: accept either a project name (→ csp-<name>,
# relative to the cwd then the repo root) or an explicit directory path.
if [[ -d "$ARG" && -f "$ARG/.connect-skill-values.json" ]]; then
  PROJECT_DIR="$(cd "$ARG" && pwd)"
elif [[ -f "./csp-$ARG/.connect-skill-values.json" ]]; then
  PROJECT_DIR="$(cd "./csp-$ARG" && pwd)"
elif [[ -f "$ROOT/csp-$ARG/.connect-skill-values.json" ]]; then
  PROJECT_DIR="$ROOT/csp-$ARG"
else
  echo "could not find a rendered project for '$ARG'" >&2
  echo "  expected a values file at <project-dir>/.connect-skill-values.json or ./csp-$ARG/" >&2
  exit 1
fi

VALUES="$PROJECT_DIR/.connect-skill-values.json"
OUTPUTS="$PROJECT_DIR/cdk-outputs.json"
PREFIX="$(jq -r '.projectName' "$VALUES")"

# Region precedence: explicit arg, then the values file (build-values.sh emits
# `region`), then the shell env, then us-east-1. Matches the sibling helper
# scripts — do NOT silently default to us-east-1, or an eu-central-1 deploy's
# resources resolve as "does not exist" even though they are real.
REGION="${2:-}"
[[ -z "$REGION" ]] && REGION="$(jq -r '.region // empty' "$VALUES")"
[[ -z "$REGION" ]] && REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"

# --- confirmation guard ------------------------------------------------------
echo -e "${RED}This will PERMANENTLY DELETE the '$PREFIX' deployment in $ACCOUNT ($REGION),${NC}"
echo -e "${RED}including retained data: Connect instance, storage/KB/schema/SAP buckets,${NC}"
echo -e "${RED}the storage KMS key, and the sap-orders table.${NC}"
if [[ "${FORCE_TEARDOWN:-}" != "1" ]]; then
  read -r -p "Type the project name ('$PREFIX') to confirm: " CONFIRM
  [[ "$CONFIRM" == "$PREFIX" ]] || { echo "aborted — input did not match '$PREFIX'"; exit 1; }
fi

# --- capture ids from outputs (best effort; outputs may predate destroy) ----
INSTANCE_ID="" ; ASSISTANT="" ; AGENT="" ; KMS_ARN=""
if [[ -f "$OUTPUTS" ]]; then
  INSTANCE_ID="$(jq -r 'to_entries[] | select(.key|endswith("-ConnectInstance")) | .value.InstanceArn // empty' "$OUTPUTS" | head -n1)"
  INSTANCE_ID="${INSTANCE_ID##*/}"
  ASSISTANT="$(jq -r 'to_entries[] | select(.key|endswith("-Wisdom")) | .value.AssistantId // empty' "$OUTPUTS" | head -n1)"
  AGENT="$(jq -r 'to_entries[] | select(.key|endswith("-Wisdom")) | .value.OrchestrationAgentId // empty' "$OUTPUTS" | head -n1)"
  KMS_ARN="$(jq -r 'to_entries[] | select(.key|endswith("-ConnectInstance")) | .value.StorageKmsKeyArn // empty' "$OUTPUTS" | head -n1)"
fi
# fall back to lookup by alias
if [[ -z "$INSTANCE_ID" ]]; then
  INSTANCE_ID="$(aws connect list-instances --region "$REGION" \
    --query "InstanceSummaryList[?InstanceAlias=='${PREFIX}-${ACCOUNT}'].Id | [0]" --output text 2>/dev/null)"
  [[ "$INSTANCE_ID" == "None" ]] && INSTANCE_ID=""
fi
# API fallback for assistant/agent (the widget --exclusively deploy overwrites
# cdk-outputs.json, dropping the Wisdom keys — without these the pre-clean
# silently skips and cdk destroy hits DELETE_FAILED on the security profile)
if [[ -z "$ASSISTANT" ]]; then
  ASSISTANT="$(aws qconnect list-assistants --region "$REGION" \
    --query "assistantSummaries[?name=='${PREFIX}-assistant'].assistantId | [0]" --output text 2>/dev/null)"
  [[ "$ASSISTANT" == "None" ]] && ASSISTANT=""
fi
if [[ -z "$AGENT" && -n "$ASSISTANT" ]]; then
  AGENT="$(aws qconnect list-ai-agents --assistant-id "$ASSISTANT" --region "$REGION" \
    --query "aiAgentSummaries[?name=='${PREFIX}-orchestrator'].aiAgentId | [0]" --output text 2>/dev/null)"
  [[ "$AGENT" == "None" ]] && AGENT=""
fi

# --- 1. pre-clean: disassociate publish-created security-profile bindings ---
if [[ -n "$INSTANCE_ID" && -n "$ASSISTANT" && -n "$AGENT" ]]; then
  info "pre-clean: disassociating ai-agent security-profile bindings"
  SP="$(aws connect list-security-profiles --instance-id "$INSTANCE_ID" --region "$REGION" \
    --query "SecurityProfileSummaryList[?Name=='${PREFIX}-ai-agent'].Id | [0]" --output text 2>/dev/null)"
  if [[ -n "$SP" && "$SP" != "None" ]]; then
    BASE="arn:aws:wisdom:${REGION}:${ACCOUNT}:ai-agent/${ASSISTANT}/${AGENT}"
    VERSIONS="$(aws qconnect list-ai-agent-versions --assistant-id "$ASSISTANT" --ai-agent-id "$AGENT" \
      --region "$REGION" --query 'aiAgentVersionSummaries[].versionNumber' --output text 2>/dev/null || true)"
    # ONLY the base ARN + numbered versions (created outside CloudFormation by
    # the console/browser publish). $SAVED/$LATEST belong to the CDK custom
    # resource — removing them here makes its onDelete fail on templates
    # released before the InvalidParameterException ignore-guard fix.
    for SUFFIX in "" $VERSIONS; do
      ARN="$BASE"; [[ -n "$SUFFIX" ]] && ARN="$BASE:$SUFFIX"
      aws connect disassociate-security-profiles --instance-id "$INSTANCE_ID" \
        --entity-type AI_AGENT --entity-arn "$ARN" --security-profiles "Id=$SP" \
        --region "$REGION" >/dev/null 2>&1 && info "  disassociated ${ARN##*/}"
    done
    ok "security-profile bindings cleared"
  fi
fi

# --- 2. cdk destroy ----------------------------------------------------------
if aws cloudformation describe-stacks --stack-name "${PREFIX}-ConnectInstance" --region "$REGION" >/dev/null 2>&1; then
  info "cdk destroy --all (${PREFIX})"
  ( cd "$PROJECT_DIR" && \
    AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" CDK_DEFAULT_REGION="$REGION" \
    npx cdk destroy --all --force ) || warn "cdk destroy reported errors — sweeping anyway"
else
  info "stacks already gone — proceeding to sweep"
fi

# --- 2b. recover stacks stuck in DELETE_FAILED --------------------------------
# Custom resources (e.g. the security-profile disassociate on templates released
# before the ignore-guard fix) can wedge a stack. Retry the delete while
# retaining the failed logical resources — they hold no real infrastructure.
for STACK in $(aws cloudformation list-stacks --region "$REGION" \
    --query "StackSummaries[?starts_with(StackName,'${PREFIX}-') && StackStatus=='DELETE_FAILED'].StackName" --output text 2>/dev/null); do
  FAILED_RES="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
    --query "StackResources[?ResourceStatus=='DELETE_FAILED'].LogicalResourceId" --output text 2>/dev/null | tr '\t' ' ')"
  warn "retrying delete of $STACK (retaining stuck: $FAILED_RES)"
  # shellcheck disable=SC2086
  aws cloudformation delete-stack --stack-name "$STACK" --region "$REGION" \
    ${FAILED_RES:+--retain-resources $FAILED_RES} 2>/dev/null
  aws cloudformation wait stack-delete-complete --stack-name "$STACK" --region "$REGION" 2>/dev/null \
    && ok "$STACK deleted" || warn "$STACK still not deleted"
done

# --- 3. sweep retained resources --------------------------------------------
info "sweep: Connect instance"
if [[ -n "$INSTANCE_ID" ]]; then
  aws connect delete-instance --instance-id "$INSTANCE_ID" --region "$REGION" 2>/dev/null \
    && ok "instance $INSTANCE_ID deletion requested" \
    || info "  instance already gone or not deletable yet"
fi

info "sweep: S3 buckets (${PREFIX}-*)"
for B in $(aws s3api list-buckets --query "Buckets[?starts_with(Name,'${PREFIX}-')].Name" --output text 2>/dev/null); do
  info "  emptying $B (incl. versions)"
  # pure CLI version purge (no boto3 dependency): batch-delete versions + markers
  while : ; do
    BATCH="$(aws s3api list-object-versions --bucket "$B" --region "$REGION" --output json 2>/dev/null | \
      jq '{Objects: ([.Versions[]?, .DeleteMarkers[]?] | map({Key, VersionId}) | .[:1000]), Quiet: true}')"
    COUNT="$(echo "$BATCH" | jq '.Objects | length' 2>/dev/null)"
    [[ -z "$COUNT" || "$COUNT" == "0" || "$COUNT" == "null" ]] && break
    echo "$BATCH" > /tmp/.teardown-batch.json
    aws s3api delete-objects --bucket "$B" --delete file:///tmp/.teardown-batch.json --region "$REGION" >/dev/null 2>&1
  done
  rm -f /tmp/.teardown-batch.json
  aws s3api delete-bucket --bucket "$B" --region "$REGION" 2>/dev/null && ok "  deleted $B" || warn "  could not delete $B"
done

info "sweep: DynamoDB table ${PREFIX}-sap-orders"
aws dynamodb delete-table --table-name "${PREFIX}-sap-orders" --region "$REGION" >/dev/null 2>&1 \
  && ok "table deletion requested" || info "  table already gone"

if [[ -n "$KMS_ARN" ]]; then
  info "sweep: KMS key (7-day scheduled deletion)"
  aws kms schedule-key-deletion --key-id "$KMS_ARN" --pending-window-in-days 7 --region "$REGION" >/dev/null 2>&1 \
    && ok "key deletion scheduled" || info "  key already scheduled/gone"
fi

info "sweep: orphaned app-integrations MCP application"
# The <prefix>-mcp application can survive if the instance was deleted while the
# gateway stack still existed (its ApplicationAssociation has no delete API and
# only clears asynchronously after instance deletion propagates). Best effort;
# harmless/zero-cost if it lingers — re-run teardown later to retry.
for APP in $(aws appintegrations list-applications --region "$REGION" \
    --query "Applications[?Name=='${PREFIX}-mcp'].Arn" --output text 2>/dev/null); do
  aws appintegrations delete-application --arn "$APP" --region "$REGION" >/dev/null 2>&1 \
    && ok "deleted application ${PREFIX}-mcp" \
    || warn "application ${PREFIX}-mcp still has associations — retry after instance deletion propagates"
done

# --- 4. verify ---------------------------------------------------------------
info "verify"
LEFT_STACKS="$(aws cloudformation list-stacks --region "$REGION" \
  --query "length(StackSummaries[?starts_with(StackName,'${PREFIX}-') && StackStatus!='DELETE_COMPLETE'])" --output text 2>/dev/null)"
LEFT_BUCKETS="$(aws s3api list-buckets --query "length(Buckets[?starts_with(Name,'${PREFIX}-')])" --output text 2>/dev/null)"
echo "  remaining stacks: $LEFT_STACKS, remaining buckets: $LEFT_BUCKETS (instance deletion is async)"
[[ "$LEFT_STACKS" == "0" && "$LEFT_BUCKETS" == "0" ]] && ok "teardown complete" || warn "leftovers remain — re-run after a few minutes"
