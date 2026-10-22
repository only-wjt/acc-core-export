#!/usr/bin/env node
/**
 * ACC 核心协议层示例入口
 *
 * 演示如何独立调用邮箱登录/收信 与 GPT 登录/session/AT/2FA 各能力，
 * 不依赖数据库、存储层，账号从命令行 JSON 传入。
 *
 * 用法：
 *   node examples/demo.mjs mail-login   '{"email":"x@mail.com","password":"pw"}'
 *   node examples/demo.mjs mail-otp     '{"email":"x@mail.com","password":"pw"}'
 *   node examples/demo.mjs gpt-login    '{"email":"x","gptPassword":"pw","totpSecret":"BASE32"}'
 *   node examples/demo.mjs gpt-at       '{"sessionToken":"eyJ..."}'
 *   node examples/demo.mjs gpt-check    '{"email":"x","sessionToken":"eyJ..."}'
 *   node examples/demo.mjs gpt-enable   '{"email":"x","gptPassword":"pw","sessionToken":"eyJ..."}'
 *   node examples/demo.mjs gpt-disable  '{"email":"x","gptPassword":"pw","totpSecret":"BASE32","sessionToken":"eyJ..."}'
 *   node examples/demo.mjs gpt-chgpw    '{"email":"x","gptPassword":"old","totpSecret":"BASE32","newPassword":"new"}'
 *   node examples/demo.mjs gpt-addpw    '{"email":"x@mail.com","mailPassword":"mail","newPassword":"new"}'
 *   node examples/demo.mjs totp         '{"totpSecret":"BASE32"}'
 *
 * 可选：设置代理  PROXY='http://user:pass@host:port'（各能力都会透传）。
 */

import * as mail from '../src/mail.js';
import * as gpt from '../src/gpt-session.js';

const log = (...a) => console.log('[demo]', ...a);
const proxyUrl = process.env.PROXY || null;
// gpt-session / mail 的 proxy 参数接受 { url } 或直接 url 字符串，视具体实现而定；
// 这里传字符串，若你的代理需要对象格式请按 ctls.js 约定改写。
const proxy = proxyUrl ? proxyUrl : null;

async function main() {
  const cmd = process.argv[2];
  const arg = process.argv[3] ? JSON.parse(process.argv[3]) : {};
  if (!cmd) {
    console.error('缺少子命令，见文件头注释');
    process.exit(2);
  }

  switch (cmd) {
    // ── 邮箱 ──────────────────────────────────────────────
    case 'mail-login': {
      // 登录并取一次会话（验证账号密码可用）
      const r = await mail.loginResult(arg.email, arg.password, proxy);
      log('mail loginResult:', r);
      break;
    }
    case 'mail-list': {
      // 收件箱列表
      const items = await mail.listMail(arg.email, arg.password, { proxy, size: 20 });
      log(`收到 ${items.length} 封，最近几封：`);
      for (const m of items.slice(0, 5)) log(' -', m.subject || m.id);
      break;
    }
    case 'mail-otp': {
      // 收信取 OTP（等待最新验证码，默认 5 分钟内）
      const otp = await mail.waitForOTP(arg.email, arg.password, { proxy, maxMs: 180000 });
      log('OTP =', otp);
      break;
    }

    // ── GPT ───────────────────────────────────────────────
    case 'gpt-login': {
      // 用密码 + TOTP（或邮箱 OTP）登录，返回 sessionToken / accessToken
      const account = { email: arg.email, gptPassword: arg.gptPassword, totpSecret: arg.totpSecret };
      const res = await gpt.login(account, {
        password: arg.gptPassword,
        totpSecret: arg.totpSecret,
        // 无 TOTP 时用邮箱 OTP：getOtp 从邮箱取码
        getOtp: arg.totpSecret ? undefined : async () =>
          mail.waitForOTP(arg.email, arg.mailPassword, { proxy, maxMs: 180000 }),
        proxy,
        log,
      });
      log('sessionToken:', res.sessionToken?.slice(0, 40) + '…');
      log('accessToken :', res.accessToken?.slice(0, 40) + '…');
      break;
    }
    case 'gpt-at': {
      // 用 sessionToken 换 accessToken
      const { accessToken } = await gpt.getAccessToken(arg.sessionToken, proxy);
      log('accessToken:', accessToken?.slice(0, 60) + '…');
      break;
    }
    case 'gpt-check': {
      // 验活：检查订阅状态
      const r = await gpt.checkAlive({ email: arg.email, sessionToken: arg.sessionToken }, log, proxy);
      log('checkAlive:', r);
      break;
    }
    case 'gpt-enable': {
      // 创建新 2FA（enableMfa 内部会 re-login 满足 recent_auth）
      const r = await gpt.enableMfa(
        { email: arg.email, gptPassword: arg.gptPassword, sessionToken: arg.sessionToken },
        {
          password: arg.gptPassword,
          getOtp: arg.mailPassword
            ? async () => mail.waitForOTP(arg.email, arg.mailPassword, { proxy, maxMs: 180000 })
            : undefined,
          proxy,
          log,
        }
      );
      log('新 totpSecret:', r.totpSecret);
      break;
    }
    case 'gpt-disable': {
      // 删除 2FA
      const r = await gpt.disableMfa(
        { email: arg.email, gptPassword: arg.gptPassword, totpSecret: arg.totpSecret, sessionToken: arg.sessionToken },
        { password: arg.gptPassword, totpSecret: arg.totpSecret, proxy, log }
      );
      log('disableMfa:', r);
      break;
    }
    case 'gpt-chgpw': {
      // 改 GPT 密码
      const r = await gpt.changePassword(
        { email: arg.email, gptPassword: arg.gptPassword, totpSecret: arg.totpSecret },
        {
          currentPassword: arg.gptPassword,
          newPassword: arg.newPassword,
          totpSecret: arg.totpSecret,
          getOtp: arg.mailPassword
            ? async () => mail.waitForOTP(arg.email, arg.mailPassword, { proxy, maxMs: 180000 })
            : undefined,
          proxy,
          log,
        }
      );
      log('changePassword:', r);
      break;
    }
    case 'gpt-addpw': {
      const r = await gpt.addPassword(
        { email: arg.email, totpSecret: arg.totpSecret },
        {
          newPassword: arg.newPassword,
          getOtp: async () => mail.waitForOTP(arg.email, arg.mailPassword, { proxy, maxMs: 180000 }),
          totpSecret: arg.totpSecret,
          proxy,
          log,
        }
      );
      log('addPassword:', r);
      break;
    }
    case 'totp': {
      // 由 TOTP secret 计算当前 6 位验证码
      log('code =', gpt.totpCode(arg.totpSecret));
      break;
    }

    default:
      console.error('未知子命令:', cmd);
      process.exit(2);
  }

  // ctls 会开着 CycleTLS 连接，跑完主动退出
  process.exit(0);
}

main().catch((e) => {
  console.error('[demo] 失败:', e?.stack || e);
  process.exit(1);
});
