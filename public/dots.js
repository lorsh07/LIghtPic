// 배경 점 격자 위로 빛이 파도처럼 지나가는 효과
(() => {
  const canvas = document.getElementById('dots');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');

  const GAP = 22; // 점 간격 (CSS px)
  const BASE_R = 0.9; // 기본 반지름
  const LEVELS = 12; // 밝기 단계 (같은 단계끼리 한 번에 그려서 빠르게)
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');

  let w = 0;
  let h = 0;
  let dpr = 1;
  let cols = 0;
  let rows = 0;
  let rgb = '0,0,0';
  let baseAlpha = 0.09;
  let peakAlpha = 0.5;
  let raf = 0;

  function readColors() {
    const s = getComputedStyle(document.documentElement);
    rgb = s.getPropertyValue('--dot-rgb').trim() || '0,0,0';
    baseAlpha = parseFloat(s.getPropertyValue('--dot-base')) || 0.09;
    peakAlpha = parseFloat(s.getPropertyValue('--dot-peak')) || 0.5;
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(w / GAP) + 1;
    rows = Math.ceil(h / GAP) + 1;
  }

  // 0~1 사이의 파도 세기. 왼쪽 위에서 오른쪽 아래로 빛의 띠가 굽이치며 지나간다
  function wave(x, y, t) {
    const along = x * 0.82 + y * 0.57; // 진행 방향(대각선)으로의 거리
    const bend = Math.sin(y * 0.006 - x * 0.002 + t * 0.6) * 70; // 띠를 물결 모양으로 휘게
    const v = (Math.sin((along + bend) * 0.0085 - t * 1.6) + 1) / 2;
    return v ** 5; // 마루 부분만 밝게
  }

  function draw(t) {
    ctx.clearRect(0, 0, w, h);
    const buckets = Array.from({ length: LEVELS }, () => []);
    const ox = (w - (cols - 1) * GAP) / 2;
    const oy = (h - (rows - 1) * GAP) / 2;

    for (let r = 0; r < rows; r++) {
      const y = oy + r * GAP;
      for (let c = 0; c < cols; c++) {
        const x = ox + c * GAP;
        const v = wave(x, y, t);
        buckets[Math.min(LEVELS - 1, Math.floor(v * LEVELS))].push(x, y);
      }
    }

    for (let i = 0; i < LEVELS; i++) {
      const pts = buckets[i];
      if (!pts.length) continue;
      const k = i / (LEVELS - 1);
      const radius = BASE_R + k * 0.9;
      const alpha = baseAlpha + (peakAlpha - baseAlpha) * k;

      // 밝은 점에는 은은한 번짐(빛)을 먼저 깐다
      if (k > 0.45) {
        ctx.fillStyle = `rgba(${rgb},${(alpha * 0.18).toFixed(3)})`;
        ctx.beginPath();
        for (let j = 0; j < pts.length; j += 2) {
          ctx.moveTo(pts[j] + radius * 3.2, pts[j + 1]);
          ctx.arc(pts[j], pts[j + 1], radius * 3.2, 0, Math.PI * 2);
        }
        ctx.fill();
      }

      ctx.fillStyle = `rgba(${rgb},${alpha.toFixed(3)})`;
      ctx.beginPath();
      for (let j = 0; j < pts.length; j += 2) {
        ctx.moveTo(pts[j] + radius, pts[j + 1]);
        ctx.arc(pts[j], pts[j + 1], radius, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  }

  function loop(now) {
    draw(now / 1000);
    raf = requestAnimationFrame(loop);
  }

  function start() {
    cancelAnimationFrame(raf);
    if (reduceMotion.matches) draw(2.4); // 움직임 줄이기: 멈춘 한 장면만
    else raf = requestAnimationFrame(loop);
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { resize(); start(); }, 100);
  });
  const onScheme = () => { readColors(); start(); };
  darkScheme.addEventListener?.('change', onScheme);
  reduceMotion.addEventListener?.('change', start);

  readColors();
  resize();
  start();
})();
