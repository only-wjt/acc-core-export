// 统一的后端请求封装：401 自动回登录页，错误消息优先取服务端返回。

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    window.location.replace('/login');
    throw new Error('登录已过期，正在跳转登录页');
  }
  if (!response.ok) {
    const message = data.error || data.errors?.map((item) => `第 ${item.line || '?'} 行：${item.message}`).join('；') || '请求失败';
    throw new Error(message);
  }
  return data;
}

export {
  request,
};
