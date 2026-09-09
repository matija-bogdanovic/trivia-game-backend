#!/usr/bin/env bash
#
# deploy.sh — package both functions and push the stack
#
#   ./infra/deploy.sh staging
#   ./infra/deploy.sh prod
#
# Replaces the hand-built zip and the hand-clicked console upload. The zips
# are built the same way they always were — from inside each directory, so the
# archive root holds index.mjs with no wrapping folder, which is what the
# runtime needs to find index.handler.
set -euo pipefail

ENV="${1:-staging}"
REGION="${AWS_REGION:-eu-west-3}"
STACK="ipakseokrece-${ENV}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
CODE_BUCKET="ipakseokrece-deploy-${ACCOUNT}-${REGION}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"

# a bucket to stage the code in; Lambda cannot take a >4KB zip inline
if ! aws s3api head-bucket --bucket "$CODE_BUCKET" 2>/dev/null; then
  echo "creating code bucket $CODE_BUCKET"
  aws s3api create-bucket --bucket "$CODE_BUCKET" --region "$REGION" \
    --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  aws s3api put-bucket-versioning --bucket "$CODE_BUCKET" \
    --versioning-configuration Status=Enabled
fi

# The key carries a content hash, which is what makes a code change actually
# deploy: CloudFormation only updates a function when its S3Key changes, so a
# fixed key would upload new bytes and leave the old ones running.
rest_zip="$(mktemp -d)/rest.zip"; ws_zip="$(mktemp -d)/ws.zip"
( cd "$ROOT/lambda"    && zip -qr "$rest_zip" ./*.mjs )
( cd "$ROOT/lambda-ws" && zip -qr "$ws_zip" index.mjs lib )
rest_key="code/rest-$(shasum -a 256 "$rest_zip" | cut -c1-12).zip"
ws_key="code/ws-$(shasum -a 256 "$ws_zip" | cut -c1-12).zip"
aws s3 cp "$rest_zip" "s3://$CODE_BUCKET/$rest_key" --only-show-errors
aws s3 cp "$ws_zip"   "s3://$CODE_BUCKET/$ws_key"   --only-show-errors
echo "packaged  rest=$rest_key  ws=$ws_key"

aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK" \
  --template-file "$HERE/template.yaml" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
      EnvironmentName="$ENV" \
      TablePrefix="${TABLE_PREFIX:-${ENV}-}" \
      AvatarBucketName="${AVATAR_BUCKET:-ipakseokrece-avatars-${ENV}}" \
      AllowedOrigin="${ALLOWED_ORIGIN:-http://localhost:3000}" \
      CodeBucket="$CODE_BUCKET" \
      RestCodeKey="$rest_key" \
      WsCodeKey="$ws_key" \
      VapidPublicKey="${VAPID_PUBLIC_KEY:-}" \
      VapidPrivateKey="${VAPID_PRIVATE_KEY:-}" \
      VapidSubject="${VAPID_SUBJECT:-mailto:matijabog45@icloud.com}"

echo
aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[].{Key:OutputKey,Value:OutputValue}" --output table
