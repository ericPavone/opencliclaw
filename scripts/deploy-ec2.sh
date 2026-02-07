#!/bin/bash
# deploy-ec2.sh - Runs on EC2 as claw user
#
# Called by deploy_eric.sh (Mac) or manually: bash /home/claw/deploy.sh [install-path]
#
# Expects /tmp/openclaw-dist.tar.gz (built dist/ from Mac) to already be uploaded.
#
# Flow:
#   1. git clone --depth 1 into temp dir
#   2. Copy production files (extensions, skills, assets, openclaw.mjs, package.json) to install dir
#   3. Extract dist/ from uploaded tarball into install dir
#   4. Strip workspace:* and devDependencies
#   5. npm install --omit=dev (root + memory-mongodb)
#   6. Cleanup temp dir + tarball
#   7. Restart gateway

set -u

REPO_URL="https://github.com/ericPavone/opencliclaw.git"
DEFAULT_INSTALL_DIR="$HOME/.nvm/versions/node/v24.13.0/lib/node_modules/openclaw"
INSTALL_DIR="${1:-$DEFAULT_INSTALL_DIR}"
DIST_TARBALL="/tmp/openclaw-dist.tar.gz"
TMPDIR=$(mktemp -d /tmp/openclaw-clone-XXXX)

echo "==> Install dir: $INSTALL_DIR"

# --- 1. Clone ---
echo "==> Cloning repo (shallow)..."
git clone --depth 1 "$REPO_URL" "$TMPDIR"

# --- 2. Copy production files from clone ---
echo "==> Copying production files..."
cp -a "$TMPDIR/extensions/"  "$INSTALL_DIR/extensions/"
cp -a "$TMPDIR/skills/"      "$INSTALL_DIR/skills/"
cp -a "$TMPDIR/assets/"      "$INSTALL_DIR/assets/"
cp    "$TMPDIR/openclaw.mjs" "$INSTALL_DIR/openclaw.mjs"
cp    "$TMPDIR/package.json" "$INSTALL_DIR/package.json"

# --- 3. Extract dist/ from Mac build ---
if [ -f "$DIST_TARBALL" ]; then
  echo "==> Extracting dist/ from Mac build..."
  tar xzf "$DIST_TARBALL" -C "$INSTALL_DIR"
else
  echo "ERROR: $DIST_TARBALL not found. Run deploy_eric.sh from Mac first."
  rm -rf "$TMPDIR"
  exit 1
fi

# --- 4. Strip devDependencies + workspace:* ---
echo "==> Stripping devDependencies and workspace:* refs..."
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('$INSTALL_DIR/package.json', 'utf8'));
  delete pkg.devDependencies;
  fs.writeFileSync('$INSTALL_DIR/package.json', JSON.stringify(pkg, null, 2) + '\n');
"

for ext_pkg in "$INSTALL_DIR/extensions/"*/package.json; do
  [ -f "$ext_pkg" ] || continue
  node -e "
    const fs = require('fs');
    const p = '$ext_pkg';
    const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
    let changed = false;
    for (const s of ['dependencies', 'devDependencies']) {
      if (!pkg[s]) continue;
      for (const [k, v] of Object.entries(pkg[s])) {
        if (String(v).startsWith('workspace:')) { delete pkg[s][k]; changed = true; }
      }
      if (Object.keys(pkg[s]).length === 0) { delete pkg[s]; changed = true; }
    }
    if (changed) fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
  " 2>/dev/null || true
done

# --- 5. Install runtime deps ---
echo "==> Installing root dependencies..."
cd "$INSTALL_DIR"
npm install --omit=dev || true

if [ -d "$INSTALL_DIR/extensions/memory-mongodb" ]; then
  echo "==> Installing memory-mongodb dependencies..."
  cd "$INSTALL_DIR/extensions/memory-mongodb"
  npm install --omit=dev || true
fi

# --- 6. Cleanup ---
echo "==> Cleaning up..."
rm -rf "$TMPDIR" 2>/dev/null || true

echo ""
echo "==> Install complete! Gateway restart must be done as ec2-user (has sudo)."
exit 0
