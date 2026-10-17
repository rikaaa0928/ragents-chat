# syntax=docker/dockerfile:1
FROM rust:latest AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY web ./web

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/app/target \
    cargo build --release --bin ragents-chat --target-dir /app/target && \
    cargo install --git https://github.com/rikaaa0928/ragents.git --branch main \
        ragents-cli ragents-core --target-dir /app/target --root /usr/local && \
    cp /app/target/release/ragents-chat /usr/local/bin/ragents-chat

FROM debian:latest
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/bin/ragents /usr/local/bin/ragents
COPY --from=builder /usr/local/bin/ragents_core_worker /usr/local/bin/ragents_core_worker
COPY --from=builder /usr/local/bin/ragents-chat /usr/local/bin/ragents-chat

# Container-internal directories for SQLite databases, workspaces, and temp directories
RUN mkdir -p /var/lib/ragents/workspaces /var/lib/ragents/tmp /var/lib/ragents-chat

WORKDIR /var/lib/ragents/workspaces
