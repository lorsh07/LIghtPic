(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const HISTORY_KEY = 'lightpic:history';
  const MAX_HISTORY = 50;

  const drop = $('#drop');
  const fileInput = $('#file');
  const quality = $('#quality');
  const qualityOut = $('#qualityOut');
  const progress = $('#progress');
  const progressText = $('#progressText');
  const errorBox = $('#error');
  const list = $('#list');
  const empty = $('#empty');
  const clearBtn = $('#clearHistory');
  const tpl = $('#cardTpl');

  const formatBytes = (n) => {
    if (!Number.isFinite(n)) return '-';
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(2)} MB`;
  };
  const savedPct = (from, to) => Math.floor((1 - to / from) * 100);

  // ---------- 브라우저 저장 목록 (실패해도 동작하도록) ----------
  const loadHistory = () => {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
  };
  const saveHistory = (items) => {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, MAX_HISTORY))); } catch { /* 무시 */ }
  };
  let history = loadHistory();

  function refreshEmpty() {
    const has = list.children.length > 0;
    empty.hidden = has;
    clearBtn.hidden = !has;
  }

  // ---------- 업로드 ----------
  const syncQuality = () => {
    qualityOut.textContent = quality.value;
    const pct = ((quality.value - quality.min) / (quality.max - quality.min)) * 100;
    quality.style.setProperty('--pct', `${pct}%`);
  };
  quality.addEventListener('input', syncQuality);
  syncQuality();

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.hidden = !msg;
  }

  function upload(files) {
    files = [...files].filter((f) => f.type.startsWith('image/') || /\.(heic|heif|avif)$/i.test(f.name));
    if (!files.length) return showError('이미지 파일만 업로드할 수 있습니다.');
    showError('');

    const form = new FormData();
    files.forEach((f) => form.append('images', f));
    form.append('maxDimension', $('input[name=maxDimension]:checked').value);
    form.append('quality', quality.value);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.responseType = 'json';
    progress.hidden = false;
    progress.style.setProperty('--p', '0%');
    progressText.textContent = `${files.length}개 업로드 중…`;

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const p = Math.round((e.loaded / e.total) * 100);
      progress.style.setProperty('--p', `${p}%`);
      if (p === 100) progressText.textContent = '최적화하는 중…';
    };
    xhr.onerror = () => { progress.hidden = true; showError('네트워크 오류로 업로드하지 못했습니다.'); };
    xhr.onload = () => {
      progress.hidden = true;
      const body = xhr.response || {};
      if (!body.results) return showError(body.error || `업로드 실패 (HTTP ${xhr.status})`);

      const failed = [];
      body.results.forEach((r) => {
        if (r.ok) {
          history = [r.image, ...history.filter((h) => h.id !== r.image.id)];
          list.prepend(renderCard(r.image, true));
        } else {
          failed.push(`${r.name}: ${r.error}`);
        }
      });
      saveHistory(history);
      refreshEmpty();
      showError(failed.join('\n'));
    };
    xhr.send(form);
  }

  fileInput.addEventListener('change', () => { upload(fileInput.files); fileInput.value = ''; });
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => { e.preventDefault(); upload(e.dataTransfer.files); });
  // 페이지 어디에 떨어뜨려도 브라우저가 파일을 열지 않도록
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  // 클립보드 붙여넣기 지원
  window.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) upload(files);
  });

  // ---------- 결과 카드 ----------
  function renderCard(img, fresh = false) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    if (fresh) node.classList.add('fresh');
    const cdn = img.url;

    $('.thumb', node).href = cdn;
    $('.thumb img', node).src = `${cdn}?w=480&h=480&fit=cover`;
    $('.name', node).textContent = img.name || img.id;
    $('.name', node).title = img.name || img.id;

    const resized = img.originalWidth !== img.width;
    $('.stats', node).innerHTML = [
      `원본 <b>${formatBytes(img.originalBytes)}</b> (${img.originalWidth}×${img.originalHeight}, ${img.originalFormat.toUpperCase()})`,
      `→ 저장 <b>${formatBytes(img.storedBytes)}</b>${resized ? ` (${img.width}×${img.height})` : ''}`,
      img.storedBytes < img.originalBytes ? `<span class="pill">−${savedPct(img.originalBytes, img.storedBytes)}%</span>` : '',
    ].join(' ');

    const inputs = {
      w: $('.b-w', node), h: $('.b-h', node), f: $('.b-f', node), q: $('.b-q', node), fit: $('.b-fit', node),
    };
    const urlBox = $('.url', node);
    const openLink = $('.open', node);
    const result = $('.result', node);

    const buildUrl = () => {
      const params = new URLSearchParams();
      ['w', 'h', 'q', 'fit'].forEach((k) => { if (inputs[k].value) params.set(k, inputs[k].value); });
      if (inputs.f.value !== 'auto') params.set('f', inputs.f.value);
      const qs = params.toString();
      return qs ? `${cdn}?${qs}` : cdn;
    };

    let timer;
    let seq = 0;
    const measure = async (url) => {
      const mine = ++seq;
      result.textContent = '변환 결과 확인 중…';
      try {
        // 실제 브라우저처럼 AVIF/WebP를 지원한다고 알려야 auto 형식이 제대로 선택됨
        const res = await fetch(url, { headers: { Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' } });
        if (mine !== seq) return;
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          result.textContent = body.error || `오류 (HTTP ${res.status})`;
          return;
        }
        const blob = await res.blob();
        if (mine !== seq) return;
        const fmt = (res.headers.get('content-type') || '').replace('image/', '').toUpperCase();
        const pct = savedPct(img.originalBytes, blob.size);
        result.innerHTML = `결과 <b>${fmt}</b> · <b>${formatBytes(blob.size)}</b>`
          + (pct > 0 ? ` <span class="pill">−${pct}%</span>` : '');
      } catch {
        if (mine === seq) result.textContent = '변환 결과를 불러오지 못했습니다.';
      }
    };

    const update = () => {
      const url = buildUrl();
      urlBox.value = url;
      openLink.href = url;
      clearTimeout(timer);
      timer = setTimeout(() => measure(url), 350);
    };
    Object.values(inputs).forEach((el) => el.addEventListener('input', update));
    update();

    urlBox.addEventListener('focus', () => urlBox.select());
    $('.copy', node).addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      try {
        await navigator.clipboard.writeText(urlBox.value);
      } catch {
        urlBox.select();
        document.execCommand('copy');
      }
      btn.textContent = '복사됨';
      setTimeout(() => { btn.textContent = '복사'; }, 1200);
    });

    $('.remove', node).addEventListener('click', () => {
      history = history.filter((h) => h.id !== img.id);
      saveHistory(history);
      node.remove();
      refreshEmpty();
    });

    return node;
  }

  clearBtn.addEventListener('click', () => {
    if (!confirm('목록을 비울까요? (서버의 이미지와 주소는 그대로 남습니다)')) return;
    history = [];
    saveHistory(history);
    list.replaceChildren();
    refreshEmpty();
  });

  history.forEach((img) => list.append(renderCard(img)));
  refreshEmpty();
})();
