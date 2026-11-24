// 라이트/다크 모드 전환 버튼
(() => {
  const KEY = 'lightpic:theme';
  const root = document.documentElement;
  const btn = document.getElementById('themeToggle');
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const metas = [...document.querySelectorAll('meta[name="theme-color"]')];
  const metaDefaults = metas.map((m) => m.content);
  const COLORS = { light: '#f5f5f7', dark: '#000000' };

  const systemTheme = () => (system.matches ? 'dark' : 'light');
  const current = () => root.dataset.theme || systemTheme();

  function render() {
    const dark = current() === 'dark';
    const label = dark ? '라이트 모드로 전환' : '다크 모드로 전환';
    btn.classList.toggle('is-dark', dark);
    btn.setAttribute('aria-label', label);
    btn.title = label;
    // 모바일 브라우저 주소창 색도 맞춘다
    metas.forEach((m, i) => { m.content = root.dataset.theme ? COLORS[root.dataset.theme] : metaDefaults[i]; });
  }

  function choose(theme) {
    // 기기 설정과 같은 쪽을 고르면 저장하지 않고 다시 기기 설정을 따른다
    if (theme === systemTheme()) {
      delete root.dataset.theme;
      try { localStorage.removeItem(KEY); } catch { /* 무시 */ }
    } else {
      root.dataset.theme = theme;
      try { localStorage.setItem(KEY, theme); } catch { /* 무시 */ }
    }
    render();
  }

  btn.addEventListener('click', () => choose(current() === 'dark' ? 'light' : 'dark'));
  system.addEventListener?.('change', render);
  render();
})();
