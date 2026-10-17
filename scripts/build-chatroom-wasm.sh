#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

cargo build \
    --manifest-path "$project_dir/extensions/chatroom/Cargo.toml" \
    --target wasm32-wasip2 \
    --release

echo "$project_dir/extensions/chatroom/target/wasm32-wasip2/release/ragent_chatroom_extension.wasm"
