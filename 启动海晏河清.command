#!/bin/zsh
set -e
cd "${0:A:h}"
source scripts/node-env.zsh
if [[ ! -d backend/node_modules ]]; then npm --prefix backend ci --no-audit --no-fund; fi
if [[ ! -d frontend/node_modules ]]; then npm --prefix frontend ci --no-audit --no-fund; fi
if [[ ! -f frontend/dist/index.html ]]; then npm run build; fi
node scripts/launch.mjs
