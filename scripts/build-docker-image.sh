#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

# 1. Ensure WASM bundle is up to date
./scripts/prepare-bundle.sh

# 2. Build Linux binaries inside rust:latest sharing host ~/.cargo cache for fast offline/cached compilation
docker run --rm \
  -v "${HOME}/.cargo/registry:/usr/local/cargo/registry" \
  -v "${HOME}/.cargo/git:/usr/local/cargo/git" \
  -v "${ROOT_DIR}:/src/ragents-chat" \
  rust:latest sh -c '
    set -e
    apt-get update && apt-get install -y --no-install-recommends cmake
    export CARGO_TARGET_DIR=/tmp/linux-target
    cd /src/ragents-chat
    cargo build --release --bin ragents-chat --offline || cargo build --release --bin ragents-chat
    cargo install --git https://github.com/rikaaa0928/ragents.git --branch main \
      ragents-cli ragents-core --target-dir /tmp/linux-target --root /usr/local
    mkdir -p /src/ragents-chat/target/linux-bin
    cp /usr/local/bin/ragents /usr/local/bin/ragents-core-worker /tmp/linux-target/release/ragents-chat /src/ragents-chat/target/linux-bin/
    cp -r /etc/ssl/certs /src/ragents-chat/target/linux-bin/certs
  '

# 3. Package lightweight debian:latest runtime image `ragents-suite:local`
docker build -t ragents-suite:local -f - "${ROOT_DIR}/target/linux-bin" <<'EOF'
FROM debian:latest
COPY certs /etc/ssl/certs
COPY ragents /usr/local/bin/ragents
COPY ragents-core-worker /usr/local/bin/ragents-core-worker
COPY ragents-chat /usr/local/bin/ragents-chat
RUN mkdir -p /var/lib/ragents/workspaces /var/lib/ragents/tmp /var/lib/ragents-chat
WORKDIR /var/lib/ragents/workspaces
EOF

echo "Successfully built image: ragents-suite:local"
