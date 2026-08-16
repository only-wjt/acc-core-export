#!/usr/bin/env bash
# 服务器一键启动。在发布包根目录执行：bash deploy/start.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/deploy/.env"
COMPOSE=(docker compose -f "$ROOT/deploy/docker-compose.yml" --env-file "$ENV_FILE")

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$ROOT/deploy/env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "已生成 $ENV_FILE"
  echo "请先填写 WORKBENCH_PASSWORD 和 ALLOWED_HOSTS，再重新执行：bash deploy/start.sh"
  exit 1
fi

if grep -Eq '^WORKBENCH_PASSWORD=\s*$' "$ENV_FILE" \
  || grep -Fq '换成足够长的口令' "$ENV_FILE"; then
  echo "请先改 $ENV_FILE 里的 WORKBENCH_PASSWORD，不要用示例口令"
  exit 1
fi

load_image() {
  local file="$1"
  echo "导入镜像：$file"
  case "$file" in
    *.tar.gz) gzip -dc "$file" | docker load ;;
    *) docker load -i "$file" ;;
  esac
}

IMAGE_FILE=""
for candidate in \
  "$ROOT"/acc-core-*-image.tar.gz \
  "$ROOT"/acc-core-*-image.tar \
  "$ROOT"/dist/acc-core-*-image.tar.gz \
  "$ROOT"/dist/acc-core-*-image.tar
do
  if [[ -f "$candidate" ]]; then
    IMAGE_FILE="$candidate"
    break
  fi
done

if [[ -n "$IMAGE_FILE" ]]; then
  load_image "$IMAGE_FILE"
  "${COMPOSE[@]}" up -d --no-deps --wait --remove-orphans
else
  echo "未找到预构建镜像，开始现场构建（首次 5–15 分钟，服务器需能访问外网）"
  "${COMPOSE[@]}" up -d --build --wait --remove-orphans
fi

echo
"${COMPOSE[@]}" ps
echo
curl -sS http://127.0.0.1:3780/health || true
echo
echo "工作台已启动。浏览器打开 http://服务器IP:3780 ，用 deploy/.env 里的管理员账号登录。"
