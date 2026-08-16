const form = document.querySelector('#loginForm');
const button = document.querySelector('#loginButton');
const errorNode = document.querySelector('#loginError');

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('#themeLabel').textContent = theme === 'light' ? '白天' : '夜间';
  document.querySelector('#themeToggle').title = theme === 'light' ? '切换到夜间外观' : '切换到白天外观';
}

applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

document.querySelector('#themeToggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  localStorage.setItem('acc-core:theme', next);
  applyTheme(next);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = document.querySelector('#loginUsername').value.trim();
  const password = document.querySelector('#loginPassword').value;
  if (!username || !password) {
    errorNode.textContent = '请填写用户名和口令';
    return;
  }

  errorNode.textContent = '';
  button.disabled = true;
  button.textContent = '正在登录…';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '登录失败');
    window.location.replace('/');
  } catch (error) {
    errorNode.textContent = error.message;
    button.disabled = false;
    button.textContent = '进入工作台';
    document.querySelector('#loginPassword').focus();
  }
});

document.querySelector('#loginUsername').focus();
