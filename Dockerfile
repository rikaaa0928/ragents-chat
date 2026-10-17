FROM rust:latest AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY web ./web

RUN cargo build --release --bin ragents-chat --target-dir /app/target && \
    cargo install --git https://github.com/rikaaa0928/ragents.git --branch main \
        ragents-cli ragents-core --target-dir /app/target --root /usr/local && \
    cp /app/target/release/ragents-chat /usr/local/bin/ragents-chat

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

COPY --from=builder /usr/local/bin/ragents /usr/local/bin/ragents
COPY --from=builder /usr/local/bin/ragents-core-worker /usr/local/bin/ragents-core-worker
COPY --from=builder /usr/local/bin/ragents-chat /usr/local/bin/ragents-chat

# Container-internal directories for SQLite databases, workspaces, and temp directories
RUN mkdir -p /var/lib/ragents/workspaces /var/lib/ragents/tmp /var/lib/ragents-chat

WORKDIR /var/lib/ragents/workspaces
