# ACC 核心协议层（独立包）

从 accounthub 抽取的**纯协议层**，覆盖两块能力：

- **邮箱**：登录、收信、取 OTP、改密（mail.com IMAP/HTTP 协议实现）
- **GPT（ChatGPT/OpenAI）**：登录、取 session、取 accessToken、验活、创建/删除/修改 2FA、改密

不含数据库、存储层、路由，账号信息由调用方传入。可直接 `import` 进你自己的脚本或服务。

## 目录

```
src/                 15 个核心文件（完整依赖闭包，零 store 依赖）
  mail.js            邮箱登录/收信/OTP/改密
  gpt-session.js     GPT login/getAccessToken/checkAlive/enableMfa/disableMfa/changePassword/totpCode
  ctls.js            CycleTLS 请求层（Chrome TLS 指纹）
  cf-solver.js       Cloudflare challenge 过盾（仅 GPT 登录遇 CF 时用到 playwright）
  sentinel.js        OpenAI Sentinel/so token
  fingerprint.js     指纹分配
  ...                其余为上述的依赖
examples/
  demo.mjs           示例入口：命令行演示各能力怎么调
```

## 安装

```bash
npm install
# playwright 首次需装浏览器（仅 GPT 登录过 Cloudflare 时用到；纯邮箱/session 操作不需要）
npx playwright install chromium
```

## 本地 Session 工作台

项目内置了一个默认只监听 `127.0.0.1` 的工作台：取 Session、验活、TOTP、收信、2FA、改密。本机模式下账号和结果只留在当前进程内存；上服务器时必须设口令，并可用 `PERSIST_DIR` 把任务摘要落到磁盘（不含密码）。

```bash
npm install
npm run web
```

浏览器打开 `http://127.0.0.1:3780`，每行可使用任一格式：

```text
邮箱----GPT密码----邮箱密码
邮箱:邮箱密码
```

点击“开始获取”后，程序会登录 GPT，并在需要时自动从同一 mail.com 邮箱读取验证码。成功结果会按账号逐条展示，同时尽可能查询套餐、有效状态、到期时间、剩余时间、自动续费、最近付款和脱敏支付方式。右上角一键复制及下载仍只包含原始 `sessionJson`，每行一个；套餐查询失败不会影响已生成的 Session。

注意：

- 仅用于你本人或明确授权的账号。
- 单次最多 100 个账号；并发数按账号分配（普通用户默认 1，管理员为上限 20），过高并发容易触发 mail.com 或 OpenAI 风控。
- 代理池每行一条，支持 `http://`、`https://`、`socks4://`、`socks5://` 和 `socks5h://`；常见的 `socks://...#备注` 会自动转为 `socks5://` 并移除备注。
- 每个账号会随机选择一条代理，并在 GPT 登录和邮箱取码全过程固定使用该代理。
- 页面刷新、关闭服务或任务清理后，输入与结果会消失；设置 `PERSIST_DIR` 后会额外归档任务摘要。
- 可用 `PORT=其他端口 npm run web` 调整端口。绑定非本机地址时必须设置 `WORKBENCH_PASSWORD`（管理员口令）。
- 启用口令后，用管理员登录可在「用户」页添加普通账号并分配并发数。普通用户只能看自己的历史，管理员能看全部。
- Linux / systemd 见 `deploy/linux.md`。
- 生产 Docker 与热部署见 `deploy/docker.md`。
- 打包上传：本机执行 `powershell -File deploy/pack.ps1`，把 `dist/acc-core-*.tar.gz` 传到服务器后 `bash deploy/start.sh`。
- 外部 CDK 对接见 `deploy/openapi.md`（`/openapi/v1`，API Key）。

## 快速上手

```bash
# 邮箱：登录验证
node examples/demo.mjs mail-login '{"email":"x@mail.com","password":"pw"}'
# 邮箱：收信取最新 OTP
node examples/demo.mjs mail-otp   '{"email":"x@mail.com","password":"pw"}'

# GPT：TOTP 登录，返回 sessionToken + accessToken
node examples/demo.mjs gpt-login  '{"email":"x","gptPassword":"pw","totpSecret":"BASE32SECRET"}'
# GPT：sessionToken 换 accessToken
node examples/demo.mjs gpt-at     '{"sessionToken":"eyJ..."}'
# GPT：验活
node examples/demo.mjs gpt-check  '{"email":"x","sessionToken":"eyJ..."}'
# GPT：创建新 2FA
node examples/demo.mjs gpt-enable '{"email":"x","gptPassword":"pw","sessionToken":"eyJ..."}'
# GPT：删除 2FA
node examples/demo.mjs gpt-disable '{"email":"x","gptPassword":"pw","totpSecret":"BASE32","sessionToken":"eyJ..."}'
# GPT：改密
node examples/demo.mjs gpt-chgpw  '{"email":"x","gptPassword":"old","totpSecret":"BASE32","newPassword":"new"}'
# 本地算 TOTP 码
node examples/demo.mjs totp       '{"totpSecret":"BASE32"}'
```

设置代理（各能力都会透传）：

```bash
PROXY='http://user:pass@host:port' node examples/demo.mjs gpt-login '{...}'
```

## 直接在代码里用

```js
import * as mail from './src/mail.js';
import * as gpt  from './src/gpt-session.js';

// 邮箱收 OTP
const otp = await mail.waitForOTP(email, mailPassword, { proxy, maxMs: 180000 });

// GPT 登录
const { sessionToken, accessToken } = await gpt.login(
  { email, gptPassword, totpSecret },
  { password: gptPassword, totpSecret, proxy, log: console.log }
);

// 换 accessToken
const { accessToken: at } = await gpt.getAccessToken(sessionToken, proxy);

// 2FA 增删改
const { totpSecret: newSecret } = await gpt.enableMfa({ email, gptPassword, sessionToken }, { password: gptPassword, proxy });
await gpt.disableMfa({ email, gptPassword, totpSecret, sessionToken }, { password: gptPassword, totpSecret, proxy });
await gpt.changePassword({ email, gptPassword, totpSecret }, { currentPassword: gptPassword, newPassword, totpSecret, proxy });
```

## 可选环境变量

全部有默认值，一般不用设：

| 变量 | 默认 | 说明 |
|------|------|------|
| `MAX_CONCURRENCY` | 36 | 全局并发上限 |
| `MAIL_LOGIN_CONCURRENCY` | =MAX | 邮箱登录并发 |
| `MAIL_LOGIN_GAP_MS` | 0 | 邮箱登录间隔 |
| `PW_CF_MAX` | =MAX | Cloudflare 过盾并发 |

## 说明

- 从 accounthub `server/src` 抽取，函数签名与线上一致。
- `ctls.js` 在 import 时初始化 CycleTLS（占用固定端口），一个进程只跑一个实例。
- 只有 GPT 登录撞上 Cloudflare challenge 时才会拉起 playwright；纯邮箱操作与 session/AT/2FA 不需要浏览器。
