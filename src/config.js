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

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

Object.assign(module.exports, {
  production: process.env.NODE_ENV === 'production',
  // ---------- 인증 ----------
  // 웹 화면 로그인 비밀번호
  uploadPassword: process.env.UPLOAD_PASSWORD || '',
  // 스크립트/서버용 API 키 (쉼표로 여러 개). Authorization: Bearer <키>
  apiKeys: list(process.env.API_KEYS),
  // 세션 쿠키 서명 키. 비워 두면 시작할 때마다 새로 만들어져 재시작 시 로그아웃됨
  sessionSecret: process.env.SESSION_SECRET || '',
  sessionTtlHours: int(process.env.SESSION_TTL_HOURS, 24 * 7),
  // 리버스 프록시(Nginx, Cloudflare 등) 뒤에서 실제 IP를 쓰려면 설정 (예: 1, loopback)
  trustProxy: process.env.TRUST_PROXY || false,
  // ---------- 요청 횟수 제한 ----------
  // 로그인 실패: IP당 15분에 N회
  rateLimitLogin: int(process.env.RATE_LIMIT_LOGIN, 5),
  // 업로드: 사용자(또는 IP)당 1시간에 이미지 N장
  rateLimitUploads: int(process.env.RATE_LIMIT_UPLOADS, 100),
  // CDN 새 변환(캐시 MISS): IP당 1분에 N회. 캐시 HIT는 제한 없음
  rateLimitTransforms: int(process.env.RATE_LIMIT_TRANSFORMS, 60),
});
