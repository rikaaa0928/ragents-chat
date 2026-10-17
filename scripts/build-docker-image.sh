#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

# 1. Ensure WASM bundle is up to date
./scripts/prepare-bundle.sh

# 2. Build Linux binaries inside rust:latest sharing host ~/.cargo cache for fast compilation
RAGENTS_MOUNT_ARG=""
if [ -d "${ROOT_DIR}/../ragents" ]; then
  RAGENTS_MOUNT_ARG="-v $(cd "${ROOT_DIR}/../ragents" && pwd):/src/ragents"
fi

docker run --rm \
  -v "${HOME}/.cargo/registry:/usr/local/cargo/registry" \
  -v "${HOME}/.cargo/git:/usr/local/cargo/git" \
  -v "${ROOT_DIR}:/src/ragents-chat" \
  ${RAGENTS_MOUNT_ARG} \
  rust:latest sh -c '
    set -e
    export CARGO_TARGET_DIR=/src/ragents-chat/target/linux-cargo-cache
    cd /src/ragents-chat
    cargo build --release --bin ragents-chat --offline || cargo build --release --bin ragents-chat
    mkdir -p /src/ragents-chat/target/linux-bin
    if [ -d /src/ragents ]; then
      cd /src/ragents
      cargo build --release --bin ragents --bin ragents-core-worker --offline || cargo build --release --bin ragents --bin ragents-core-worker
      cp /src/ragents-chat/target/linux-cargo-cache/release/ragents \
         /src/ragents-chat/target/linux-cargo-cache/release/ragents-core-worker \
         /src/ragents-chat/target/linux-bin/
    elif [ ! -f /src/ragents-chat/target/linux-bin/ragents ] || [ ! -f /src/ragents-chat/target/linux-bin/ragents-core-worker ]; then
      apt-get update && apt-get install -y --no-install-recommends cmake
      cargo install --git https://github.com/rikaaa0928/ragents.git --branch main \
        ragents-cli ragents-core --target-dir /src/ragents-chat/target/linux-cargo-cache --root /usr/local
      cp /usr/local/bin/ragents /usr/local/bin/ragents-core-worker /src/ragents-chat/target/linux-bin/
    fi
    cp /src/ragents-chat/target/linux-cargo-cache/release/ragents-chat /src/ragents-chat/target/linux-bin/
  '

# 3. Ensure cached base runtime image `ragents-runtime-base:local` exists (Python3 + uv + git + curl + rg + jq + bwrap)
if ! docker image inspect ragents-runtime-base:local >/dev/null 2>&1; then
  docker build -t ragents-runtime-base:local - <<'EOF'
FROM debian:latest
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    python-is-python3 \
    git \
    curl \
    wget \
    jq \
    ripgrep \
    fd-find \
    procps \
    lsof \
    sqlite3 \
    bubblewrap \
    ca-certificates \
    openssh-client \
    unzip \
    zip \
    tar \
    gzip \
    xz-utils \
    build-essential \
    pkg-config \
    && pip3 install --no-cache-dir --break-system-packages uv \
    && rm -rf /var/lib/apt/lists/*
EOF
fi

# 4. Package `ragents-suite:local` on top of cached `ragents-runtime-base:local` (takes <2s)
docker build -t ragents-suite:local -f - "${ROOT_DIR}/target/linux-bin" <<'EOF'
FROM ragents-runtime-base:local
COPY ragents /usr/local/bin/ragents
COPY ragents-core-worker /usr/local/bin/ragents-core-worker
COPY ragents-chat /usr/local/bin/ragents-chat
RUN mkdir -p /var/lib/ragents/workspaces /var/lib/ragents/tmp /var/lib/ragents-chat
WORKDIR /var/lib/ragents/workspaces
EOF

echo "Successfully built image: ragents-suite:local"
