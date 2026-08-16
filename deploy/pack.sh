#!/usr/bin/env bash
# 打生产发布包：只含运行所需文件。
# 用法：bash deploy/pack.sh [--with-image]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M)"
DIST="$ROOT/dist"
NAME="acc-core-$STAMP"
STAGE="$DIST/$NAME"
ARCHIVE="$DIST/$NAME.tar.gz"
WITH_IMAGE=0

if [[ "${1:-}" == "--with-image" ]]; then
  WITH_IMAGE=1
fi

rm -rf "$STAGE"
mkdir -p "$STAGE/deploy"

cp -R "$ROOT/src" "$ROOT/server" "$ROOT/public" "$STAGE/"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/.dockerignore" "$STAGE/"
cp "$ROOT/deploy/Dockerfile" \
   "$ROOT/deploy/docker-compose.yml" \
   "$ROOT/deploy/env.example" \
   "$ROOT/deploy/start.sh" \
   "$ROOT/deploy/hot-deploy.sh" \
   "$ROOT/deploy/nginx.conf.example" \
   "$ROOT/deploy/openapi.md" \
   "$STAGE/deploy/"

cat > "$STAGE/START.txt" <<'EOF'
解压后：

  tar -xzf acc-core-*.tar.gz -C /opt
  cd /opt/acc-core-*
  cp deploy/env.example deploy/.env
  # 编辑 deploy/.env：WORKBENCH_PASSWORD、ALLOWED_HOSTS
  bash deploy/start.sh

若同时上传了 *-image.tar.gz，start.sh 会先 load 镜像，不再现场构建。
EOF

mkdir -p "$DIST"
tar -czf "$ARCHIVE" -C "$DIST" "$NAME"
rm -rf "$STAGE"

echo "发布包：$ARCHIVE  ($(du -h "$ARCHIVE" | awk '{print $1}'))"

if [[ "$WITH_IMAGE" -eq 1 ]]; then
  docker compose -f "$ROOT/deploy/docker-compose.yml" build
  IMAGE_ARCHIVE="$DIST/$NAME-image.tar.gz"
  docker save acc-core:latest | gzip > "$IMAGE_ARCHIVE"
  echo "镜像包：$IMAGE_ARCHIVE  ($(du -h "$IMAGE_ARCHIVE" | awk '{print $1}'))"
fi

echo "把这个包传到服务器即可，不必上传整个仓库。"
