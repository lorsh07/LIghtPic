const path = require('path');

const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);

module.exports = {
  port: int(process.env.PORT, 3000),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')),
  // 공개 URL의 기준 주소 (CDN 앞단을 둘 경우 그 도메인으로 지정)
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  maxUploadBytes: int(process.env.MAX_UPLOAD_MB, 20) * 1024 * 1024,
  maxFilesPerUpload: int(process.env.MAX_FILES, 10),
  // 업로드 시 원본을 이 크기(긴 변 기준)로 줄여서 저장
  defaultMaxDimension: int(process.env.DEFAULT_MAX_DIMENSION, 2560),
  // CDN 변환 시 허용하는 최대 가로/세로
  maxTransformDimension: int(process.env.MAX_TRANSFORM_DIMENSION, 4000),
  defaultQuality: int(process.env.DEFAULT_QUALITY, 80),
};
