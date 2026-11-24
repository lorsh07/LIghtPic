const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('./config');
const { createStorage } = require('./storage');
const t = require('./transform');

function createApp(overrides = {}) {
  const cfg = { ...config, ...overrides };
  const storage = createStorage(cfg.dataDir);
  const ready = storage.init();
  const app = express();
  app.disable('x-powered-by');

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

  // ---------- 업로드 API ----------
  app.post('/api/upload', (req, res, next) => {
    upload.array('images')(req, res, (err) => {
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

      res.set({
        'Content-Type': t.MIME[format],
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: etag,
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
      });
      if (negotiated) res.set('Vary', 'Accept');
      if (req.get('if-none-match') === etag) return res.status(304).end();

      let data = await storage.readCache(key, format);
      res.set('X-Cache', data ? 'HIT' : 'MISS');
      if (!data) {
        // 같은 변환 요청이 동시에 들어오면 한 번만 처리
        if (!inflight.has(key)) {
          inflight.set(key, (async () => {
            const master = await storage.readMaster(rec);
            const out = await t.transform(master, opts, format);
            await storage.writeCache(key, format, out.data);
            return out.data;
          })().finally(() => inflight.delete(key)));
        }
        data = await inflight.get(key);
      }
      return res.send(data);
    } catch (err) {
      return next(err);
    }
  });

  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

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
  return app;
}

module.exports = { createApp };
