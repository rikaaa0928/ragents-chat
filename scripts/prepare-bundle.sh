#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_WASM_DIR="${ROOT_DIR}/bundle/wasm"
mkdir -p "${BUNDLE_WASM_DIR}"

# 1. Build chatroom extension wasm
"${ROOT_DIR}/scripts/build-chatroom-wasm.sh"
cp "${ROOT_DIR}/extensions/chatroom/target/wasm32-wasip2/release/ragent_chatroom_extension.wasm" "${BUNDLE_WASM_DIR}/"

# 2. Copy standard ragents WASM extensions if available in sibling ../ragents or RAGENTS_SRC_DIR
RAGENTS_DIR="${RAGENTS_SRC_DIR:-${ROOT_DIR}/../ragents}"
if [ -d "${RAGENTS_DIR}/extensions" ]; then
  for ext in authn shell file_editor image_viewer skills compaction; do
    wasm_file="${RAGENTS_DIR}/extensions/${ext}/target/wasm32-wasip2/release/ragent_${ext}_extension.wasm"
    if [ -f "${wasm_file}" ]; then
      cp "${wasm_file}" "${BUNDLE_WASM_DIR}/"
    fi
  done
fi

echo "Prepared bundle WASM extensions in ${BUNDLE_WASM_DIR}:"
ls -lh "${BUNDLE_WASM_DIR}"
