# ACC 工作台生产环境 Docker 部署

本文面向把 Session 工作台上到公网或内网服务器。默认走 Docker Compose，发版用镜像替换实现热部署：数据卷不丢，容器整只换新。

裸机 systemd 见 [linux.md](./linux.md)。

## 1. 部署前先知道的约束

| 点 | 说明 |
|---|---|
| 单进程 | CycleTLS 会拉起一个 Go 子进程，**一个容器只跑一个 Node 进程**。不要用多 replica、不要用 PM2 cluster。 |
| 必须设口令 | 容器内绑定 `0.0.0.0`，不设 `WORKBENCH_PASSWORD` 会拒绝启动。 |
| Host 白名单 | 浏览器访问用的域名或公网 IP 必须写进 `ALLOWED_HOSTS`，否则返回 403。 |
| 内存任务会断 | 正在跑的取 Session / 验活任务在内存里。换容器后进行中的任务会中断；已结束且开启了 `PERSIST_DIR` 的摘要还在。 |
| 登录态会断 | 登录 cookie 存在进程内存，热更新后需要重新登录。用户账号、代理池、历史归档在数据卷里，会保留。 |
| Chrome | GPT 登录撞上 Cloudflare 时才起浏览器。镜像已带 Chrome，并加大了 `/dev/shm`。 |

持久化落在 Docker 卷 `acc-data` → 容器内 `/data`：

- `users.json`：管理员和普通用户
- `settings.json`：管理员配置的代理池
- `session-*.json` / `check-*.json`：任务摘要（不含密码）

## 2. 机器要求

- Linux x86_64（Chrome 官方源按 amd64 装）
- Docker Engine 24+、Docker Compose v2
- 内存建议 **4 GB** 起；要过 Cloudflare 再留余量
- 磁盘建议 **20 GB** 起（镜像 + 浏览器 + 归档）
- 出网能访问 mail.com、OpenAI，以及你配置的代理

本机先确认：

```bash
docker version
docker compose version
```

## 3. 首次部署（推荐：本机打包上传）

不必把整个仓库拷到服务器。`.claude`、测试、`node_modules` 都不需要。本机打一个几 MB 的发布包，上传后改口令再启动。

### 3.1 本机打包

在 Windows 项目根目录：

```powershell
powershell -ExecutionPolicy Bypass -File deploy/pack.ps1
```

产物在 `dist/acc-core-日期.tar.gz`。只要这个文件。

可选：本机已装 Docker Desktop（Linux 容器）时，连镜像一起打，服务器就不用现场构建：

```powershell
powershell -ExecutionPolicy Bypass -File deploy/pack.ps1 -WithImage
```

会多出一个较大的 `dist/acc-core-日期-image.tar`（含 Chrome，通常 1 GB 以上）。

### 3.2 上传并解压

```bash
sudo mkdir -p /opt
sudo tar -xzf acc-core-20260816-1628.tar.gz -C /opt
cd /opt/acc-core-20260816-1628
```

目录名以实际包名为准。有镜像包就放在同一目录。

也可用 git clone，效果一样，只是会带上用不到的文件：

```bash
sudo git clone <your-repo> /opt/acc-core
cd /opt/acc-core
```

### 3.3 写环境变量并启动

```bash
cp deploy/env.example deploy/.env
chmod 600 deploy/.env
```

至少改这几项：

```bash
WORKBENCH_PASSWORD=服务器上单独设的强口令
WORKBENCH_ADMIN_USER=admin
ALLOWED_HOSTS=workbench.example.com,203.0.113.10
SECURE_COOKIE=0
HOST_PORT=3780
MAX_CONCURRENCY=8
PW_CF_MAX=4
```

规则：

- `ALLOWED_HOSTS` 填用户浏览器地址栏里的主机名，逗号分隔，不要带 `http://` 和端口。
- 前面有 Nginx 且开了 HTTPS 时，设 `SECURE_COOKIE=1`。
- 直接把 `3780` 暴露到公网可以跑，但不建议；优先反代。

然后一条命令启动：

```bash
bash deploy/start.sh
```

没有预构建镜像时，会现场 `docker compose build`（首次 5–15 分钟，服务器要能访问外网）。有 `*-image.tar` 时会先导入镜像，跳过构建。

### 3.4 验收

```bash
docker compose -f deploy/docker-compose.yml ps
curl -sS http://127.0.0.1:3780/health
# 期望：{"ok":true}

docker compose -f deploy/docker-compose.yml logs -f --tail=100
```

日志里应出现类似：

```text
Session 工作台已启动：http://0.0.0.0:3780（已启用口令登录；结果目录 /data）
```

浏览器打开 `https://你的域名` 或 `http://服务器IP:3780`，用 `WORKBENCH_ADMIN_USER` / `WORKBENCH_PASSWORD` 登录。管理员可在「用户」页加普通账号并分配并发。

## 4. 热部署（日常发版）

热部署指：**不重建机器、不丢数据卷，用新镜像替换正在跑的容器**。

本服务不能多副本滚动，所以替换瞬间会有大约 20–60 秒不可用。进行中的任务会被打断。发版前先看有没有跑着的批量任务。

### 4.1 一键脚本

```bash
cd /opt/acc-core
bash deploy/hot-deploy.sh
```

脚本会：

1. `git pull --ff-only`（有 git 仓库时）
2. 把当前 `acc-core:latest` 打成 `acc-core:prev`，方便回滚
3. 重新 build 镜像
4. `up -d --wait` 替换容器并等健康检查
5. 清理悬空镜像

数据卷 `acc-data` 不会动。

### 4.2 再次打包上传

本机重新 `pack.ps1`，把新包传到服务器后覆盖解压（不会删掉已有的 `deploy/.env`）：

```bash
sudo tar -xzf acc-core-新日期.tar.gz -C /opt
cd /opt/acc-core-新日期
# 若 .env 在旧目录，拷过来：
# sudo cp /opt/acc-core-旧日期/deploy/.env deploy/.env
bash deploy/hot-deploy.sh
```

也可以解压到固定目录，避免每次换文件夹：

```bash
sudo mkdir -p /opt/acc-core
sudo tar -xzf acc-core-新日期.tar.gz --strip-components=1 -C /opt/acc-core
cd /opt/acc-core
bash deploy/hot-deploy.sh
```

### 4.3 手动逐步发版

适合要看构建日志、或代码已经用别的方式同步到机器上：

```bash
cd /opt/acc-core
# 如需拉代码：git pull --ff-only

docker tag acc-core:latest acc-core:prev || true
docker compose -f deploy/docker-compose.yml --env-file deploy/.env build
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --no-deps --wait
```

只改 `deploy/.env`、不改代码时，不必 build：

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

### 4.4 发版窗口建议

1. 通知使用方暂停新任务。
2. 打开工作台，确认没有进行中的批量任务。
3. 执行热部署。
4. 打 `/health`，再登录看历史和代理池是否还在。
5. 用一个测试号跑一次取 Session 或验活。

### 4.5 回滚

热部署脚本会保留上一版镜像 `acc-core:prev`：

```bash
cd /opt/acc-core
IMAGE_TAG=prev docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --no-deps --wait
```

回滚同样换容器、保留数据卷。用户表和代理池不会回到旧代码时期的内容。

### 4.6 为什么不用代码挂载 / nodemon

把源码 bind-mount 进容器再热重载，适合本机开发，不适合生产：

- CycleTLS 和 Chrome 子进程在进程退出时要干净关掉
- 依赖和浏览器版本必须跟镜像一起变
- 误改线上文件没有镜像可回滚

生产只发镜像。

## 5. 可选：Nginx 蓝绿（接近零停机）

如果不能接受几十秒中断，用 Nginx 切两个容器。仍是单进程模型，只是新旧各跑一只，切流后再停旧的。

1. 旧容器继续占 `127.0.0.1:3780`。
2. 新容器用另一端口启动，例如 `3781:3780`，先打它的 `/health`。
3. 把 [nginx.conf.example](./nginx.conf.example) 里的 `upstream` 改到 `127.0.0.1:3781`，`nginx -s reload`。
4. 观察几分钟后停掉旧容器。

注意：切流不会把旧容器内存里未完成的任务迁走。要等旧任务跑完再停，或接受那一批失败后重试。

## 6. Nginx 反代（推荐）

示例配置：[nginx.conf.example](./nginx.conf.example)。

容器只监听本机时，把 compose 的端口改成环回：

```yaml
ports:
  - "127.0.0.1:3780:3780"
```

并保证：

```bash
ALLOWED_HOSTS=workbench.example.com
SECURE_COOKIE=1
```

`HOST` 在 compose 里已经是 `0.0.0.0`（容器内）。对外是否暴露由宿主机端口映射和 Nginx 决定。

启用 HTTPS 后重载 Nginx，再热更新一次容器让 `SECURE_COOKIE` 生效。

登录、取码、过盾可能超过 60 秒，反代 `proxy_read_timeout` 建议不少于 `180s`。

## 7. 环境变量

| 变量 | 生产要求 | 说明 |
|---|---|---|
| `WORKBENCH_PASSWORD` | 必填 | 管理员口令。每次进程启动会按这个口令重写管理员哈希。 |
| `WORKBENCH_ADMIN_USER` | 建议 | 管理员用户名，默认 `admin`。 |
| `ALLOWED_HOSTS` | 必填 | 允许的 Host，逗号分隔。 |
| `SECURE_COOKIE` | HTTPS 时 `1` | 给登录 cookie 加 `Secure`。 |
| `HOST_PORT` | 按需 | 宿主机映射端口，默认 `3780`。 |
| `MAX_CONCURRENCY` | 建议压低 | 协议层全局并发上限，默认镜像外层建议 `8`。 |
| `PW_CF_MAX` | 建议压低 | 同时过 Cloudflare 的浏览器上下文数。 |
| `IMAGE_TAG` | 发版/回滚 | 使用的镜像标签，默认 `latest`。 |
| `OPENAPI_KEY` | CDK 对接时建议 | 开放 API 密钥，见 [openapi.md](./openapi.md)。 |
| `OPENAPI_CORS` | 按需 | 默认 `*`。 |
| `PERSIST_DIR` | 不要改 | compose 固定为 `/data`。 |
| `CHROME_PATH` | 不要改 | compose 固定为镜像内 Chrome。 |

可选、一般不用动：`MAIL_LOGIN_CONCURRENCY`、`MAIL_LOGIN_GAP_MS`、`PW_HCAPTCHA_MAX`、`BATCH_CONCURRENCY`。硬上限 200。

改口令：改 `deploy/.env` 里的 `WORKBENCH_PASSWORD`，再 `up -d` 重启容器。普通用户不受影响。

## 8. 备份与数据

备份数据卷：

```bash
docker run --rm \
  -v acc-core_acc-data:/data \
  -v /opt/acc-core-backup:/backup \
  alpine tar czf /backup/acc-data-$(date +%F).tar.gz -C /data .
```

compose 已固定项目名为 `acc-core`，卷名就是 `acc-core_acc-data`。可用 `docker volume ls | grep acc-data` 确认。

恢复时停容器，把归档解回该卷，再启动。

`deploy/.env` 含口令，权限保持 `600`，不要提交到 git（已在 `.gitignore`）。

## 9. 日常运维

```bash
# 状态
docker compose -f deploy/docker-compose.yml ps

# 日志
docker compose -f deploy/docker-compose.yml logs -f --tail=200

# 重启（不重建镜像）
docker compose -f deploy/docker-compose.yml --env-file deploy/.env restart

# 停止
docker compose -f deploy/docker-compose.yml stop

# 进入容器看数据
docker compose -f deploy/docker-compose.yml exec workbench ls -l /data
```

容器已设 `restart: unless-stopped`，机器重启后会自己起来。`stop_grace_period` 为 20 秒，给 CycleTLS 发 `SIGTERM` 做清理。

## 10. 故障排查

| 现象 | 先查 |
|---|---|
| 容器起不来，日志提到 `WORKBENCH_PASSWORD` | `deploy/.env` 没填口令，或 compose 没加 `--env-file`。 |
| 页面 403「仅允许本机或 ALLOWED_HOSTS」 | `ALLOWED_HOSTS` 与浏览器 Host 不一致。反代必须把 `Host` 传给后端。 |
| 登录后 cookie 丢了 | HTTPS 未设 `SECURE_COOKIE=1`，或反代没传 `X-Forwarded-Proto`。 |
| 健康检查一直 unhealthy | `docker compose logs`。常见是首次 Chrome/依赖没装完，或端口被占。 |
| GPT 登录过不了 Cloudflare | 容器里 `echo $CHROME_PATH` 应为 `/usr/bin/google-chrome-stable`。内存不够或 `shm_size` 被改小也会失败。 |
| 热更新后用户/代理池没了 | 没用项目自带的 named volume，或手动删过 `docker volume rm`。 |
| 并发一高就 429 / 代理失败 | 把 `MAX_CONCURRENCY`、`PW_CF_MAX` 降下来，并检查代理池。 |

本机没有浏览器也能探活：

```bash
curl -sS -H 'Host: 127.0.0.1' http://127.0.0.1:3780/health
```

从外网用域名探活时，Host 必须在白名单内。

## 11. 上线检查清单

- [ ] `deploy/.env` 已设强口令，权限 `600`
- [ ] `ALLOWED_HOSTS` 含正式域名（及如需直连的 IP）
- [ ] 只对内网或 Nginx 暴露 `3780`，不要把 Docker 端口裸奔到 `0.0.0.0`（除非短期调试）
- [ ] HTTPS 时 `SECURE_COOKIE=1`
- [ ] `curl /health` 返回 `{"ok":true}`
- [ ] 管理员能登录，用户和代理池重启后还在
- [ ] 已演练一次 `bash deploy/hot-deploy.sh` 和 `IMAGE_TAG=prev` 回滚
- [ ] 已有数据卷备份
- [ ] 并发先按保守值跑，再按风控情况上调
