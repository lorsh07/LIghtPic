const crypto = require('crypto');
const sharp = require('sharp');

const OUTPUT_FORMATS = ['avif', 'webp', 'jpeg', 'png'];
const FIT_MODES = ['cover', 'contain', 'inside', 'outside', 'fill'];
const MIME = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
};
// 입력으로 허용하는 포맷 (sharp metadata().format 기준)
const INPUT_FORMATS = ['jpeg', 'png', 'webp', 'avif', 'heif', 'gif', 'tiff'];

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function normalizeFormat(f) {
  if (!f) return null;
  const v = String(f).toLowerCase();
  if (v === 'jpg') return 'jpeg';
  if (v === 'auto' || OUTPUT_FORMATS.includes(v)) return v;
  return undefined; // 잘못된 값
}

/**
 * 쿼리 파라미터를 검증된 변환 옵션으로 바꾼다.
 * 지원: w, h, q, f(auto|avif|webp|jpeg|png), fit
 */
function parseTransform(query, { maxDimension, defaultQuality }) {
  const errors = [];
  const opts = { width: null, height: null, quality: defaultQuality, format: 'auto', fit: 'inside' };

  const dim = (key, name) => {
    if (query[key] === undefined || query[key] === '') return null;
    const n = Number(query[key]);
    if (!Number.isInteger(n) || n <= 0) {
      errors.push(`${name}은(는) 양의 정수여야 합니다.`);
      return null;
    }
    return clamp(n, 1, maxDimension);
  };
  opts.width = dim('w', 'w');
  opts.height = dim('h', 'h');

  if (query.q !== undefined && query.q !== '') {
    const q = Number(query.q);
    if (!Number.isInteger(q)) errors.push('q는 1~100 사이의 정수여야 합니다.');
    else opts.quality = clamp(q, 1, 100);
  }

  if (query.f !== undefined && query.f !== '') {
    const f = normalizeFormat(query.f);
    if (!f) errors.push(`f는 auto, ${OUTPUT_FORMATS.join(', ')} 중 하나여야 합니다.`);
    else opts.format = f;
  }

  if (query.fit !== undefined && query.fit !== '') {
    const fit = String(query.fit).toLowerCase();
    if (!FIT_MODES.includes(fit)) errors.push(`fit은 ${FIT_MODES.join(', ')} 중 하나여야 합니다.`);
    else opts.fit = fit;
  }

  return { opts, errors };
}

/** Accept 헤더를 보고 브라우저가 지원하는 가장 가벼운 포맷을 고른다. */
function negotiateFormat(acceptHeader, hasAlpha) {
  const accept = String(acceptHeader || '').toLowerCase();
  if (accept.includes('image/avif')) return 'avif';
  if (accept.includes('image/webp')) return 'webp';
  return hasAlpha ? 'png' : 'jpeg';
}

function encode(pipeline, format, quality) {
  switch (format) {
    case 'avif':
      // AVIF는 같은 q에서 WebP/JPEG보다 화질이 높게 나오므로 살짝 낮춘다
      return pipeline.avif({ quality: clamp(quality - 15, 1, 100), effort: 4 });
    case 'webp':
      return pipeline.webp({ quality, effort: 4 });
    case 'png':
      return pipeline.png({ compressionLevel: 9, palette: quality < 100, quality, effort: 7 });
    case 'jpeg':
    default:
      return pipeline.jpeg({ quality, mozjpeg: true, progressive: true });
  }
}

/** 업로드된 원본을 검사하고, 회전 보정/메타데이터 제거/리사이즈한 마스터 이미지를 만든다. */
async function prepareMaster(buffer, { maxDimension, quality }) {
  let meta;
  try {
    meta = await sharp(buffer).metadata();
  } catch {
    throw Object.assign(new Error('이미지 파일을 읽을 수 없습니다.'), { status: 400 });
  }
  if (!INPUT_FORMATS.includes(meta.format)) {
    throw Object.assign(new Error(`지원하지 않는 형식입니다: ${meta.format}`), { status: 415 });
  }

  // 원본 포맷을 최대한 유지 (heif/tiff/gif는 웹 친화적인 포맷으로 저장)
  const masterFormat = { jpeg: 'jpeg', png: 'png', webp: 'webp', avif: 'avif' }[meta.format]
    || (meta.hasAlpha ? 'png' : 'jpeg');

  const pipeline = sharp(buffer)
    .rotate() // EXIF 방향 보정 후 메타데이터는 제거됨
    .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true });

  const { data, info } = await encode(pipeline, masterFormat, quality).toBuffer({ resolveWithObject: true });

  // 다시 인코딩한 결과가 원본보다 크고 크기 변화도 없다면 원본(회전만 보정)을 쓴다
  let out = { data, info };
  if (data.length > buffer.length && info.width === meta.width && !meta.orientation) {
    out = { data: buffer, info: { width: meta.width, height: meta.height, size: buffer.length } };
  }

  return {
    buffer: out.data,
    ext: masterFormat,
    width: out.info.width,
    height: out.info.height,
    hasAlpha: Boolean(meta.hasAlpha),
    originalFormat: meta.format,
    originalWidth: meta.width,
    originalHeight: meta.height,
  };
}

async function transform(masterBuffer, { width, height, fit, quality }, format) {
  let pipeline = sharp(masterBuffer);
  if (width || height) {
    pipeline = pipeline.resize({
      width: width || undefined,
      height: height || undefined,
      fit,
      withoutEnlargement: true,
    });
  }
  const { data, info } = await encode(pipeline, format, quality).toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function cacheKey(id, opts, format) {
  const raw = [id, opts.width || 0, opts.height || 0, opts.fit, opts.quality, format].join('|');
  return crypto.createHash('sha1').update(raw).digest('hex');
}

module.exports = {
  OUTPUT_FORMATS,
  MIME,
  parseTransform,
  normalizeFormat,
  negotiateFormat,
  prepareMaster,
  transform,
  cacheKey,
};
