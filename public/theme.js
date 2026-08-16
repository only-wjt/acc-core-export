// 在首屏绘制前定好主题，避免刷新或跳转时闪一下另一套配色。
// CSP 只允许同源脚本，所以这里必须是外部文件，不能写成内联 script。
(() => {
  const saved = localStorage.getItem('acc-core:theme');
  const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  document.documentElement.dataset.theme = saved === 'light' || saved === 'dark'
    ? saved
    : (prefersLight ? 'light' : 'dark');
})();
