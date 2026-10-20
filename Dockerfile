FROM debian:latest

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl wget jq ripgrep fd-find procps lsof sqlite3 bubblewrap \
    ca-certificates openssh-client unzip zip tar gzip xz-utils pkg-config \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv python-is-python3 \
    && pip3 install --no-cache-dir --break-system-packages uv \
    && rm -rf /var/lib/apt/lists/*

COPY target/linux-bin/ragents /usr/local/bin/ragents
COPY target/linux-bin/ragents-core-worker /usr/local/bin/ragents-core-worker
COPY target/linux-bin/ragents-chat /usr/local/bin/ragents-chat

# Container-internal directories for SQLite databases, workspaces, and temp directories
RUN mkdir -p /var/lib/ragents/workspaces /var/lib/ragents/tmp /var/lib/ragents-chat

WORKDIR /var/lib/ragents/workspaces
