export function isSessionHandshakeError(error) {
  const text = String(error?.message || error || '');
  if (/(429|rate[\s_-]*limit|too many|csrfToken)/i.test(text)) return false;
  return /(session 无 accessToken|token 可能已过期|token已过期|session 接口返回|未获取到完整 session|无 sessionToken|authorize URL 失败|csrf=true)/i.test(text);
}

export async function addWithSessionFallback({
  email,
  sessionToken = '',
  gptPassword = null,
  totpSecret = null,
  addPassword,
  login,
  checkAlive,
  newPassword,
  getOtp,
  proxy = null,
  log = () => {},
} = {}) {
  if (typeof addPassword !== 'function') throw new TypeError('addPassword 必须是函数');

  let token = String(sessionToken || '').trim();

  if (token && typeof checkAlive === 'function') {
    log('验证 Session…');
    const alive = await checkAlive({ email, sessionToken: token, totpSecret }, log, proxy);
    if (alive?.alive) {
      log('Session 有效');
    } else {
      const reason = alive?.reason || alive?.error || 'unknown';
      log(`Session 无效(${reason})，准备重新登录`);
      token = '';
    }
  }

  const runAdd = (nextToken) => addPassword(
    { email, sessionToken: nextToken, gptPassword, totpSecret },
    { newPassword, getOtp, proxy, totpSecret, log },
  );

  if (token) {
    try {
      const result = await runAdd(token);
      return { ...result, sessionToken: token, relogin: false };
    } catch (error) {
      if (typeof login !== 'function' || !isSessionHandshakeError(error)) throw error;
      log(`Session 添加密码失败，改用邮箱登录：${error.message}`);
    }
  }

  if (typeof login !== 'function') {
    throw new Error(String(sessionToken || '').trim() ? 'Session 无效且无法重新登录' : '缺少 Session');
  }

  log('使用邮箱验证码登录获取 Session…');
  let logged;
  try {
    logged = await login(
      { email, gptPassword, totpSecret },
      { password: gptPassword || null, getOtp, proxy, totpSecret, log },
    );
  } catch (error) {
    const message = String(error?.message || error || '登录失败');
    throw new Error(message.startsWith('重新登录失败') ? message : `重新登录失败：${message}`);
  }
  if (!logged?.sessionToken) throw new Error('登录成功但未返回 session');
  const result = await runAdd(logged.sessionToken);
  return { ...result, sessionToken: logged.sessionToken, relogin: true };
}
