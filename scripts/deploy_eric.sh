#!/bin/bash
# deploy_eric.sh - Build locally (Mac) and deploy to EC2
#
# Usage:
#   ./scripts/deploy_eric.sh [install-path]
#
# Flow:
#   1. pnpm build (local)
#   2. scp dist/ tarball to EC2
#   3. SSH → sudo su - claw → run /home/claw/deploy.sh (clones repo, merges dist/, installs)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

EC2_HOST="99.81.140.192"
EC2_KEY="$HOME/.ssh/open_claw.pem"
EC2_USER="ec2-user"
DEFAULT_INSTALL_DIR="/home/claw/.nvm/versions/node/v24.13.0/lib/node_modules/openclaw"
INSTALL_DIR="${1:-$DEFAULT_INSTALL_DIR}"

cd "$ROOT"

echo "==> Building locally..."
pnpm build

echo "==> Packing dist/..."
COPYFILE_DISABLE=1 tar czf /tmp/openclaw-dist.tar.gz dist/

echo "==> Uploading dist/ to EC2..."
scp -i "$EC2_KEY" /tmp/openclaw-dist.tar.gz "${EC2_USER}@${EC2_HOST}:/tmp/openclaw-dist.tar.gz"
rm -f /tmp/openclaw-dist.tar.gz

echo "==> Updating deploy script on EC2..."
scp -i "$EC2_KEY" "$SCRIPT_DIR/deploy-ec2.sh" "${EC2_USER}@${EC2_HOST}:/tmp/deploy-ec2.sh"
ssh -i "$EC2_KEY" "${EC2_USER}@${EC2_HOST}" \
  "sudo cp /tmp/deploy-ec2.sh /home/claw/deploy.sh && sudo chown claw:claw /home/claw/deploy.sh && sudo chmod +x /home/claw/deploy.sh && rm -f /tmp/deploy-ec2.sh"

echo "==> Running deploy on EC2 as claw..."
ssh -i "$EC2_KEY" "${EC2_USER}@${EC2_HOST}" \
  "sudo su - claw -c 'bash /home/claw/deploy.sh $INSTALL_DIR'"

echo "==> Restarting gateway..."
ssh -i "$EC2_KEY" "${EC2_USER}@${EC2_HOST}" \
  "rm -f /tmp/openclaw-dist.tar.gz; sudo systemctl restart openclaw-gateway && sleep 2 && sudo systemctl status openclaw-gateway --no-pager -l | head -15"

echo ""
echo "==> Done!"
    