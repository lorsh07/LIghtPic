const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('./config');
const { createStorage } = require('./storage');
const t = require('./transform');
const { createAuth } = require('./auth');
const { createLimiter, setRateHeaders, tooMany } = require('./rateLimit');

// TRUST_PROXY 값 해석: "1" → 1(프록시 단계 수), "true" → true, 그 외는 주소 목록 그대로
function parseTrustProxy(v) {
  if (v === undefined || v === null || v === '' || v === false || v === 'false') return false;
  if (v === true || v === 'true') return true;
  if (/^\d+$/.test(String(v))) return Number(v);
  return v;
}

const minutes = (n) => n * 60 * 1000;

function createApp(overrides = {}) {
  const cfg = { ...config, ...overrides };
  const storage = createStorage(cfg.dataDir);
  const ready = storage.init();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', parseTrustProxy(cfg.trustProxy));

  const auth = createAuth(cfg);
  if (!auth.enabled) {
    if (cfg.production) {
      throw new Error('운영 환경(NODE_ENV=production)에서는 UPLOAD_PASSWORD 또는 API_KEYS를 설정해야 합니다.');
    }
    if (!cfg.quiet) console.warn('[LightPic] 경고: 인증이 꺼져 있어 누구나 업로드할 수 있습니다. UPLOAD_PASSWORD 또는 API_KEYS를 설정하세요.');
  } else if (auth.passwordLogin && auth.ephemeralSecret && !cfg.quiet) {
    console.warn('[LightPic] SESSION_SECRET이 없어 임시 키를 사용합니다. 서버를 재시작하면 모두 로그아웃됩니다.');
  }

  const limiters = {
    login: createLimiter({ limit: cfg.rateLimitLogin, windowMs: minutes(15) }),
    uploads: createLimiter({ limit: cfg.rateLimitUploads, windowMs: minutes(60) }),
    transforms: createLimiter({ limit: cfg.rateLimitTransforms, windowMs: minutes(1) }),
  };

  const upload = multer({
    storage: multer.memoryStorage(),
    defParamCharset: 'utf8', // 한글 등 UTF-8 파일명
    limits: { fileSize: cfg.maxUploadBytes, files: cfg.maxFilesPerUpload },
  });

  const fileName = (f) => String(f.originalname || '').slice(0, 200);

  const baseUrl = (req) => cfg.publicBaseUrl || `${req.protocol}://${req.get('host')}`;

  const describe = (req, rec) => {
    const cdn = `${baseUrl(req)}/cdn/${rec.id}`;
    return {
      id: rec.id,
      name: rec.name,
      width: rec.width,
      height: rec.height,
      format: rec.ext,
      originalFormat: rec.originalFormat,
      originalWidth: rec.originalWidth,
      originalHeight: rec.originalHeight,
      originalBytes: rec.originalBytes,
      storedBytes: rec.storedBytes,
      createdAt: rec.createdAt,
      url: cdn,
      examples: {
        auto: cdn,
        webp: `${cdn}?f=webp`,
        avif: `${cdn}?f=avif`,
        thumbnail: `${cdn}?w=320&h=320&fit=cover`,
      },
    };
  };

  const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

  // 다른 사이트에서 보낸 POST 차단 (CSRF 방어. SameSite 쿠키와 함께 이중으로)
  const sameOrigin = (req, res, next) => {
    const origin = req.get('origin');
    if (origin) {
      let host;
      try { host = new URL(origin).host; } catch { host = null; }
      if (host !== req.get('host')) return res.status(403).json({ error: '허용되지 않은 출처의 요청입니다.' });
    }
    return next();
  };

  const requireAuth = (req, res, next) => {
    const user = auth.identify(req);
    if (!user) {
      res.set('WWW-Authenticate', 'Bearer realm="LightPic"');
      return res.status(401).json({ error: '로그인이 필요합니다.' });
    }
    req.user = user;
    return next();
  };

  // ---------- 인증 API ----------
  app.use('/api', noStore);

  app.get('/api/session', (req, res) => {
    const user = auth.identify(req);
    res.json({
      authRequired: auth.enabled,
      passwordLogin: auth.passwordLogin,
      authenticated: Boolean(user),
      via: user ? user.kind : null,
    });
  });

  app.post('/api/login', sameOrigin, express.json({ limit: '2kb' }), (req, res) => {
    if (!auth.passwordLogin) return res.status(404).json({ error: '비밀번호 로그인이 설정되어 있지 않습니다.' });
    const key = `ip:${req.ip}`;
    const before = limiters.login.peek(key);
    if (before.remaining <= 0) {
      return tooMany(res, before, `로그인 시도가 너무 많습니다. ${Math.ceil(before.retryAfter / 60)}분 뒤에 다시 시도해 주세요.`);
    }
    if (!auth.checkPassword(req.body && req.body.password)) {
      const s = limiters.login.consume(key);
      setRateHeaders(res, s);
      return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.', remaining: s.remaining });
    }
    limiters.login.reset(key);
    res.set('Set-Cookie', auth.loginCookie(req));
    return res.json({ ok: true });
  });

  app.post('/api/logout', sameOrigin, (req, res) => {
    res.set('Set-Cookie', auth.logoutCookie(req));
    res.json({ ok: true });
  });

  // ---------- 업로드 API ----------
  const uploadKey = (req) => (req.user.kind === 'anonymous' ? req.user.id : `${req.user.kind}:${req.user.id}`);

  app.post('/api/upload', sameOrigin, requireAuth, (req, res, next) => {
    // 본문을 받기 전에 먼저 한도를 확인
    const s = limiters.uploads.peek(uploadKey(req));
    if (s.remaining <= 0) {
      return tooMany(res, s, `업로드 한도(1시간에 ${s.limit}장)를 넘었습니다. ${Math.ceil(s.retryAfter / 60)}분 뒤에 다시 시도해 주세요.`);
    }
    return upload.array('images')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        const msg = {
          LIMIT_FILE_SIZE: `파일당 최대 ${Math.round(cfg.maxUploadBytes / 1048576)}MB까지 업로드할 수 있습니다.`,
          LIMIT_FILE_COUNT: `한 번에 최대 ${cfg.maxFilesPerUpload}개까지 업로드할 수 있습니다.`,
          LIMIT_UNEXPECTED_FILE: '파일 필드 이름은 "images"여야 합니다.',
        }[err.code] || err.message;
        return res.status(400).json({ error: msg });
      }
      if (err) return next(err);
      return handleUpload(req, res).catch(next);
    });
  });

  async function handleUpload(req, res) {
    await ready;
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: '이미지 파일을 선택해 주세요.' });

    const quota = limiters.uploads.consume(uploadKey(req), files.length);
    if (!quota.ok) {
      return tooMany(res, quota, `업로드 한도를 넘습니다. 지금은 ${quota.remaining}장까지 올릴 수 있습니다.`);
    }
    setRateHeaders(res, quota);

    const maxDimension = Math.min(
      Math.max(parseInt(req.body.maxDimension, 10) || cfg.defaultMaxDimension, 16),
      cfg.maxTransformDimension,
    );
    const quality = Math.min(Math.max(parseInt(req.body.quality, 10) || 85, 1), 100);

    const results = [];
    for (const file of files) {
      try {
        const master = await t.prepareMaster(file.buffer, { maxDimension, quality });
        const rec = await storage.saveImage(master.buffer, {
          name: fileName(file),
          ext: master.ext,
          width: master.width,
          height: master.height,
          hasAlpha: master.hasAlpha,
          originalFormat: master.originalFormat,
          originalWidth: master.originalWidth,
          originalHeight: master.originalHeight,
          originalBytes: file.size,
          storedBytes: master.buffer.length,
        });
        results.push({ ok: true, image: describe(req, rec) });
      } catch (err) {
        if (!err.status) console.error(err);
        results.push({ ok: false, name: fileName(file), error: err.status ? err.message : '이미지 처리 중 오류가 발생했습니다.' });
      }
    }
    const status = results.some((r) => r.ok) ? 201 : 400;
    return res.status(status).json({ results });
  }

  app.get('/api/images/:id', async (req, res, next) => {
    try {
      await ready;
      const rec = await storage.getMeta(req.params.id);
      if (!rec) return res.status(404).json({ error: '이미지를 찾을 수 없습니다.' });
      return res.json(describe(req, rec));
    } catch (err) {
      return next(err);
    }
  });

  // ---------- 이미지 CDN ----------
  // /cdn/:id            → Accept 헤더로 avif/webp/jpeg/png 자동 선택
  // /cdn/:id.webp       → 확장자로 포맷 지정
  // ?w=800&h=600&fit=cover&q=75&f=avif
  const inflight = new Map();

  app.get('/cdn/:file', async (req, res, next) => {
    try {
      await ready;
      const m = /^([0-9a-z]+)(?:\.([a-z]+))?$/.exec(req.params.file);
      if (!m || !storage.isValidId(m[1])) return res.status(404).json({ error: '이미지를 찾을 수 없습니다.' });
      const [, id, ext] = m;

      const { opts, errors } = t.parseTransform(req.query, {
        maxDimension: cfg.maxTransformDimension,
        defaultQuality: cfg.defaultQuality,
      });
      if (ext) {
        const f = t.normalizeFormat(ext);
        if (!f || f === 'auto') errors.push(`지원하지 않는 확장자입니다: .${ext}`);
        else opts.format = f;
      }
      if (errors.length) return res.status(400).json({ error: errors.join(' ') });

      const rec = await storage.getMeta(id);
      if (!rec) return res.status(404).json({ error: '이미지를 찾을 수 없습니다.' });

      const negotiated = opts.format === 'auto';
      const format = negotiated ? t.negotiateFormat(req.get('accept'), rec.hasAlpha) : opts.format;
      const key = t.cacheKey(id, opts, format);
      const etag = `"${key}"`;
      const setImageHeaders = () => {
        res.set({
          'Content-Type': t.MIME[format],
          'Cache-Control': 'public, max-age=31536000, immutable',
          ETag: etag,
          'Access-Control-Allow-Origin': '*',
          'X-Content-Type-Options': 'nosniff',
        });
        if (negotiated) res.set('Vary', 'Accept');
      };
      if (req.get('if-none-match') === etag) {
        setImageHeaders();
        return res.status(304).end();
      }

      let data = await storage.readCache(key, format);
      const hit = Boolean(data);
      if (!data) {
        // 같은 변환 요청이 동시에 들어오면 한 번만 처리
        if (!inflight.has(key)) {
          // 새 변환만 횟수 제한 (파라미터를 바꿔 가며 CPU를 소모시키는 요청 방지)
          const s = limiters.transforms.consume(`ip:${req.ip}`);
          if (!s.ok) return tooMany(res, s, '새 이미지 변환 요청이 너무 많습니다. 잠시 뒤에 다시 시도해 주세요.');
          inflight.set(key, (async () => {
            const master = await storage.readMaster(rec);
            const out = await t.transform(master, opts, format);
            await storage.writeCache(key, format, out.data);
            return out.data;
          })().finally(() => inflight.delete(key)));
        }
        data = await inflight.get(key);
      }
      setImageHeaders();
      res.set('X-Cache', hit ? 'HIT' : 'MISS');
      return res.send(data);
    } catch (err) {
      return next(err);
    }
  });

  // 웹폰트(Pretendard)를 직접 서빙 — 외부 CDN 의존 없음
  app.use('/fonts/pretendard', express.static(
    path.join(path.dirname(require.resolve('pretendard/package.json')), 'dist', 'web', 'variable'),
    { maxAge: '365d', immutable: true },
  ));
  // 화면 파일(HTML·CSS·JS)은 매번 바뀌었는지 확인하게 한다.
  // 배포 직후 새 HTML과 캐시된 옛 CSS가 섞여 화면이 깨지는 것을 막기 위함 (안 바뀌었으면 304로 짧게 응답)
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    setHeaders(res) { res.setHeader('Cache-Control', 'no-cache'); },
  }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    // 오류 응답이 CDN/브라우저에 캐시되지 않도록
    res.removeHeader('ETag');
    res.removeHeader('Vary');
    res.set('Cache-Control', 'no-store');
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  });

  app.locals.ready = ready;
  app.locals.limiters = limiters;
  return app;
}

module.exports = { createApp };
