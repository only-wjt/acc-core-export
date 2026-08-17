# 开放 API（CDK 对接）

给外部系统用的接口，和网页工作台分开。鉴权用 API Key，不用登录 cookie。

前缀：`/openapi/v1`

## 1. 拿到密钥

每名登录用户在工作台「开放 API」页自己创建密钥，**不要多人共用一把**。完整 Key 只显示一次。

也可在 `deploy/.env` 写 `OPENAPI_KEY=...` 作为管理员兜底密钥。

管理员在「设置 → 通用设置」里规定**每个用户**最多几把密钥、每分钟最多几次。这是单用户上限，不是全站合计。普通用户只能设到这个数以下；管理员自己的次数可以单独设得更高。超限返回 `429`。

工作台同一页里有封装好的接口文档，可直接复制 curl。

## 2. 怎么调

```http
Authorization: Bearer <API_Key>
Content-Type: application/json
```

也可以用 `X-Api-Key: <API_Key>`。

开放接口不走 `ALLOWED_HOSTS`。工作台页面仍然要白名单。

任务结果在内存里大约保留 30 分钟，请在任务结束后尽快拉取。

## 3. 接口

### 探活（不用 Key）

```http
GET /openapi/v1/health
```

```json
{ "ok": true, "authRequired": true }
```

### 校验 Key

```http
GET /openapi/v1/me
```

```json
{ "name": "cdk-prod", "concurrency": 4 }
```

### 批量取 Session

提交后立刻返回任务 id，再轮询。

```http
POST /openapi/v1/sessions
```

```json
{
  "accounts": [
    { "email": "a@mail.com", "gptPassword": "gpt密码", "mailPassword": "邮箱密码" }
  ]
}
```

默认只取 Session，不自动查套餐、不自动取消续费。需要随任务取消续费时再传 `"cancelRenewal": true`。

也兼容工作台那行文本：

```json
{ "input": "a@mail.com----gpt密码----邮箱密码" }
```

响应 `202`：

```json
{
  "id": "任务id",
  "kind": "session",
  "status": "running",
  "counts": { "total": 1, "pending": 1, "running": 0, "success": 0, "failed": 0, "cancelled": 0 },
  "items": [
    { "email": "a@mail.com", "status": "pending", "sessionJson": null }
  ]
}
```

轮询：

```http
GET /openapi/v1/sessions/{id}
```

`status` 为 `completed` / `cancelled` 时结束。成功的账号 `sessionJson` 会有值。

取消：

```http
POST /openapi/v1/sessions/{id}/cancel
```

### 批量验活

```http
POST /openapi/v1/checks
```

```json
{
  "items": [
    { "email": "a@mail.com", "sessionToken": "eyJ..." }
  ]
}
```

轮询：`GET /openapi/v1/checks/{id}`

### TOTP

```http
POST /openapi/v1/totp
{ "totpSecret": "BASE32SECRET" }
```

### 邮箱取码

```http
POST /openapi/v1/mail/otp
{ "email": "a@mail.com", "password": "邮箱密码", "wait": false }
```

`wait: true` 时最多等 60 秒。

## 4. CDK 调用示例

```bash
BASE=https://workbench.example.com
KEY=你的API_Key

curl -sS "$BASE/openapi/v1/me" -H "Authorization: Bearer $KEY"

JOB=$(curl -sS "$BASE/openapi/v1/sessions" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"accounts":[{"email":"a@mail.com","gptPassword":"gpt","mailPassword":"mail"}]}')

echo "$JOB"
# 用返回的 id 轮询 GET /openapi/v1/sessions/{id}
# 直到 status=completed，从 items[].sessionJson 取结果
```

代理池仍由工作台管理员在「设置」里统一配置，开放接口不能自己改代理。并发数按这把 Key 的配额，不能由请求方抬高。
