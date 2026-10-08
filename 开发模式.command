#!/bin/zsh
set -e
cd "${0:A:h}"
source scripts/node-env.zsh
npm run dev
