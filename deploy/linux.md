# Linux 部署

工作台默认只绑 `127.0.0.1`。上服务器时必须设访问口令，并显式放行 Host。

## 1. 机器准备

```bash
# Debian / Ubuntu
sudo apt-get update
sudo apt-get install -y curl ca-certificates gnupg
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Cloudflare 过盾需要系统 Chrome；找不到就跳过过盾
sudo apt-get install -y wget gnupg
wget -qO- https://dl.google.com/linux/linux_signing_key.pub | sudo gpg --dearmor -o /usr/share/keyrings/google-linux.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux.gpg] http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt-get update
sudo apt-get install -y google-chrome-stable
```

## 2. 安装项目

```bash
cd /opt
sudo git clone <your-repo> acc-core
sudo chown -R "$USER":"$USER" /opt/acc-core
cd /opt/acc-core
npm ci
npx playwright install --with-deps chromium
```

CycleTLS 会拉起一个 Go 子进程，一个 Node 进程只能跑一个实例。不要用多 worker 复制进程。

## 3. 环境变量

复制 `deploy/env.example` 为 `/etc/acc-core.env`，至少改这几项：

```bash
HOST=0.0.0.0
PORT=3780
WORKBENCH_ADMIN_USER=admin
WORKBENCH_PASSWORD=换成足够长的口令
ALLOWED_HOSTS=你的域名,服务器公网IP
PERSIST_DIR=/var/lib/acc-core
CHROME_PATH=/usr/bin/google-chrome-stable
```

绑定 `0.0.0.0` 却不设 `WORKBENCH_PASSWORD` 时，进程会拒绝启动。

前面用 Nginx 反代且开了 HTTPS 时，再加 `SECURE_COOKIE=1`。

## 4. systemd

```bash
sudo mkdir -p /var/lib/acc-core
sudo cp deploy/acc-core.service /etc/systemd/system/acc-core.service
sudo systemctl daemon-reload
sudo systemctl enable --now acc-core
sudo systemctl status acc-core
```

## 5. Docker

推荐先在本机打包再上传，不必把整个仓库拷到服务器。步骤见 [docker.md](./docker.md) 第 3 节。

生产环境 Docker、热部署、回滚和 Nginx 见 [docker.md](./docker.md)。

```bash
cp deploy/env.example deploy/.env
# 填写 WORKBENCH_PASSWORD、ALLOWED_HOSTS
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build --wait
```

日常发版：

```bash
bash deploy/hot-deploy.sh
```

## 6. 反代示例

```nginx
server {
  listen 443 ssl;
  server_name workbench.example.com;
  location / {
    proxy_pass http://127.0.0.1:3780;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

此时 `HOST=127.0.0.1`，`ALLOWED_HOSTS=workbench.example.com`，`WORKBENCH_PASSWORD` 仍要开。
