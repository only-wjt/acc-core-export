#!/usr/bin/env bash
# 生产热部署：保留 /data 卷，重建镜像并替换容器。
# 用法：在仓库根目录执行  bash deploy/hot-deploy.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE=(docker compose -f "$ROOT/deploy/docker-compose.yml" --env-file "$ROOT/deploy/.env")
IMAGE="acc-core:latest"

if [[ ! -f "$ROOT/deploy/.env" ]]; then
  echo "缺少 deploy/.env，先复制 deploy/env.example 并填写 WORKBENCH_PASSWORD"
  exit 1
fi

cd "$ROOT"

if [[ -d .git ]] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git pull --ff-only
fi

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker tag "$IMAGE" acc-core:prev
  echo "已把当前镜像标记为 acc-core:prev，回滚：IMAGE_TAG=prev ${COMPOSE[*]} up -d"
fi

"${COMPOSE[@]}" build
"${COMPOSE[@]}" up -d --no-deps --wait --remove-orphans
docker image prune -f

echo "热部署完成。健康检查：curl -sS http://127.0.0.1:3780/health"
