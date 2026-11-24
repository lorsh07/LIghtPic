const crypto = require('crypto');

const COOKIE = 'lp_session';

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
// 길이가 달라도 시간이 일정하게 비교 (해시 후 비교)
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (!k) return;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* 무시 */ }
  });
  return out;
}

function createAuth(cfg) {
  const password = cfg.uploadPassword || '';
  const apiKeys = cfg.apiKeys || [];
  const enabled = Boolean(password || apiKeys.length);
  const ttlMs = cfg.sessionTtlHours * 3600 * 1000;

  // 비밀번호를 서명 키에 섞어서, 비밀번호를 바꾸면 기존 세션이 모두 무효가 되도록
  const secret = cfg.sessionSecret || crypto.randomBytes(32).toString('hex');
  const signingKey = crypto.createHmac('sha256', secret).update(`lightpic:${password}`).digest();
  const sign = (payload) => crypto.createHmac('sha256', signingKey).update(payload).digest('base64url');

  function issueSession() {
    const exp = Date.now() + ttlMs;
    const payload = `${exp}.${crypto.randomBytes(12).toString('base64url')}`;
    return `${payload}.${sign(payload)}`;
  }

  function verifySession(token) {
    if (!token || !password) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [exp, nonce, sig] = parts;
    if (!safeEqual(sig, sign(`${exp}.${nonce}`))) return null;
    if (!(Number(exp) > Date.now())) return null;
    return { kind: 'session', id: `s:${nonce}` };
  }

  function verifyApiKey(header) {
    const m = /^Bearer\s+(.+)$/i.exec(String(header || ''));
    if (!m) return null;
    const key = m[1].trim();
    const idx = apiKeys.findIndex((k) => safeEqual(k, key));
    // 요청 제한 키로 쓰기 위해 키 자체가 아닌 해시 일부를 식별자로 사용
    return idx >= 0 ? { kind: 'apiKey', id: `k:${sha256(key).toString('hex').slice(0, 16)}` } : null;
  }

  /** 요청의 사용자 식별. 인증이 꺼져 있으면 익명 사용자로 통과 */
  function identify(req) {
    if (!enabled) return { kind: 'anonymous', id: `ip:${req.ip}` };
    return verifyApiKey(req.get('authorization'))
      || verifySession(parseCookies(req.get('cookie'))[COOKIE]);
  }

  function checkPassword(input) {
    return Boolean(password) && typeof input === 'string' && safeEqual(input, password);
  }

  function cookieHeader(req, value, maxAgeSec) {
    const attrs = [
      `${COOKIE}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${maxAgeSec}`,
    ];
    if (req.secure) attrs.push('Secure');
    return attrs.join('; ');
  }

  const loginCookie = (req) => cookieHeader(req, issueSession(), Math.floor(ttlMs / 1000));
  const logoutCookie = (req) => cookieHeader(req, '', 0);

  return {
    enabled,
    passwordLogin: Boolean(password),
    ephemeralSecret: !cfg.sessionSecret,
    identify,
    checkPassword,
    loginCookie,
    logoutCookie,
  };
}

module.exports = { createAuth, parseCookies };
