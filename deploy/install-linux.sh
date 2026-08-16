#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "项目目录：$ROOT"
echo "1) npm ci"
echo "2) npx playwright install --with-deps chromium"
echo "3) 复制 deploy/env.example 到 /etc/acc-core.env 并填写 WORKBENCH_PASSWORD"
echo "4) 复制 deploy/acc-core.service 到 /etc/systemd/system/ 后 enable --now"
echo
echo "详细步骤见 deploy/linux.md"
