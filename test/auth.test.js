const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const request = require('supertest');
const { createApp } = require('../src/app');
const { createLimiter } = require('../src/rateLimit');

const dirs = [];
let png;

function makeApp(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightpic-auth-'));
  dirs.push(dataDir);
  return createApp({
    dataDir,
    publicBaseUrl: '',
    uploadPassword: 'correct horse',
    apiKeys: ['key-one', 'key-two'],
    sessionSecret: 'test-secret',
    quiet: true,
    ...overrides,
  });
}

before(async () => {
  png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#888' } }).png().toBuffer();
});
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const sessionCookie = (res) => (res.headers['set-cookie'] || []).find((c) => c.startsWith('lp_session='))?.split(';')[0];

describe('인증', () => {
  test('로그인 없이 업로드하면 401', async () => {
    const app = makeApp();
    await request(app).post('/api/upload').attach('images', png, 'a.png').expect(401);
    const s = await request(app).get('/api/session').expect(200);
    assert.deepEqual(s.body, { authRequired: true, passwordLogin: true, authenticated: false, via: null });
  });

  test('비밀번호 로그인 → 쿠키로 업로드 → 로그아웃', async () => {
    const app = makeApp();
    await request(app).post('/api/login').send({ password: 'wrong' }).expect(401);
    const login = await request(app).post('/api/login').send({ password: 'correct horse' }).expect(200);
    const raw = login.headers['set-cookie'][0];
    assert.match(raw, /HttpOnly/);
    assert.match(raw, /SameSite=Strict/);
    const cookie = sessionCookie(login);

    const s = await request(app).get('/api/session').set('Cookie', cookie).expect(200);
    assert.equal(s.body.authenticated, true);
    assert.equal(s.body.via, 'session');
    await request(app).post('/api/upload').set('Cookie', cookie).attach('images', png, 'a.png').expect(201);

    const out = await request(app).post('/api/logout').set('Cookie', cookie).expect(200);
    assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
  });

  test('위조하거나 다른 키로 서명한 쿠키는 거부', async () => {
    const app = makeApp();
    const cookie = sessionCookie(await request(app).post('/api/login').send({ password: 'correct horse' }));
    const [name, value] = cookie.split('=');
    const [exp, nonce, sig] = value.split('.');
    const forged = `${name}=${Number(exp) + 999999}.${nonce}.${sig}`;
    await request(app).post('/api/upload').set('Cookie', forged).attach('images', png, 'a.png').expect(401);

    // 비밀번호가 바뀌면 기존 세션 무효
    const other = makeApp({ uploadPassword: 'new password' });
    await request(other).post('/api/upload').set('Cookie', cookie).attach('images', png, 'a.png').expect(401);
  });

  test('API 키(Bearer)로 업로드', async () => {
    const app = makeApp();
    await request(app).post('/api/upload').set('Authorization', 'Bearer key-two').attach('images', png, 'a.png').expect(201);
    await request(app).post('/api/upload').set('Authorization', 'Bearer nope').attach('images', png, 'a.png').expect(401);
  });

  test('CDN 주소는 로그인 없이 열린다', async () => {
    const app = makeApp();
    const up = await request(app).post('/api/upload').set('Authorization', 'Bearer key-one').attach('images', png, 'a.png').expect(201);
    const { id } = up.body.results[0].image;
    await request(app).get(`/cdn/${id}?w=32`).expect(200);
    await request(app).get(`/api/images/${id}`).expect(200);
  });

  test('다른 출처(Origin)에서 온 POST는 403', async () => {
    const app = makeApp();
    await request(app).post('/api/login').set('Origin', 'https://evil.example').send({ password: 'correct horse' }).expect(403);
    await request(app).post('/api/upload').set('Origin', 'https://evil.example').set('Authorization', 'Bearer key-one')
      .attach('images', png, 'a.png').expect(403);
  });

  test('운영 환경에서 인증 설정이 없으면 시작하지 않는다', () => {
    assert.throws(() => makeApp({ production: true, uploadPassword: '', apiKeys: [] }), /UPLOAD_PASSWORD/);
    assert.doesNotThrow(() => makeApp({ production: true }));
  });

  test('API 응답은 캐시하지 않는다', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/session');
    assert.equal(res.headers['cache-control'], 'no-store');
  });
});

describe('요청 횟수 제한', () => {
  test('로그인 실패가 쌓이면 429, 올바른 비밀번호도 막힌다', async () => {
    const app = makeApp({ rateLimitLogin: 3 });
    for (let i = 0; i < 3; i++) await request(app).post('/api/login').send({ password: 'x' }).expect(401);
    const res = await request(app).post('/api/login').send({ password: 'correct horse' }).expect(429);
    assert.ok(Number(res.headers['retry-after']) > 0);
  });

  test('로그인에 성공하면 실패 횟수가 초기화된다', async () => {
    const app = makeApp({ rateLimitLogin: 3 });
    await request(app).post('/api/login').send({ password: 'x' }).expect(401);
    await request(app).post('/api/login').send({ password: 'x' }).expect(401);
    await request(app).post('/api/login').send({ password: 'correct horse' }).expect(200);
    await request(app).post('/api/login').send({ password: 'x' }).expect(401);
    await request(app).post('/api/login').send({ password: 'x' }).expect(401);
    await request(app).post('/api/login').send({ password: 'correct horse' }).expect(200);
  });

  test('업로드 한도는 이미지 장수 기준', async () => {
    const app = makeApp({ rateLimitUploads: 3 });
    const auth = ['Authorization', 'Bearer key-one'];
    const r1 = await request(app).post('/api/upload').set(...auth).attach('images', png, 'a.png').attach('images', png, 'b.png').expect(201);
    assert.equal(r1.headers['ratelimit-remaining'], '1');
    // 남은 1장보다 많이 올리면 거부 (처리하지 않음)
    await request(app).post('/api/upload').set(...auth).attach('images', png, 'a.png').attach('images', png, 'b.png').expect(429);
    await request(app).post('/api/upload').set(...auth).attach('images', png, 'c.png').expect(201);
    await request(app).post('/api/upload').set(...auth).attach('images', png, 'd.png').expect(429);
    // 다른 키는 별도 한도
    await request(app).post('/api/upload').set('Authorization', 'Bearer key-two').attach('images', png, 'e.png').expect(201);
  });

  test('CDN은 새 변환만 제한하고 캐시된 결과는 계속 제공', async () => {
    const app = makeApp({ rateLimitTransforms: 2 });
    const up = await request(app).post('/api/upload').set('Authorization', 'Bearer key-one').attach('images', png, 'a.png').expect(201);
    const { id } = up.body.results[0].image;
    await request(app).get(`/cdn/${id}?w=10&f=png`).expect(200);
    await request(app).get(`/cdn/${id}?w=11&f=png`).expect(200);
    const blocked = await request(app).get(`/cdn/${id}?w=12&f=png`).expect(429);
    assert.equal(blocked.headers['cache-control'], 'no-store');
    assert.match(blocked.headers['content-type'], /json/);
    assert.equal(blocked.headers['x-cache'], undefined);
    const hit = await request(app).get(`/cdn/${id}?w=10&f=png`).expect(200);
    assert.equal(hit.headers['x-cache'], 'HIT');
  });
});

test('limiter: 윈도가 지나면 초기화', () => {
  let now = 0;
  const l = createLimiter({ limit: 2, windowMs: 1000, now: () => now });
  assert.equal(l.consume('a').ok, true);
  assert.equal(l.consume('a').ok, true);
  assert.equal(l.consume('a').ok, false);
  assert.equal(l.consume('a', 1).retryAfter, 1);
  now = 1001;
  assert.equal(l.consume('a').ok, true);
  assert.equal(l.consume('b', 3).ok, false);
  l.stop();
});
