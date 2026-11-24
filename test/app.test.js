const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const request = require('supertest');
const { createApp } = require('../src/app');

let app;
let dataDir;
let jpeg;
let png;

const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightpic-test-'));
  app = createApp({ dataDir, publicBaseUrl: '' });
  await app.locals.ready;
  // 노이즈가 섞인 큰 사진 대용 이미지
  jpeg = await sharp({ create: { width: 3200, height: 2000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } })
    .jpeg({ quality: 98 }).toBuffer();
  png = await sharp({ create: { width: 400, height: 300, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } })
    .png().toBuffer();
});

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

async function uploadOne(buf, name, fields = {}) {
  let req = request(app).post('/api/upload').attach('images', buf, name);
  for (const [k, v] of Object.entries(fields)) req = req.field(k, String(v));
  const res = await req.expect(201);
  assert.equal(res.body.results[0].ok, true);
  return res.body.results[0].image;
}

test('업로드 시 긴 변을 maxDimension으로 줄이고 용량이 줄어든다', async () => {
  const img = await uploadOne(jpeg, 'photo.jpg', { maxDimension: 1920 });
  assert.equal(img.width, 1920);
  assert.equal(img.height, 1200);
  assert.equal(img.originalWidth, 3200);
  assert.ok(img.storedBytes < img.originalBytes);
  assert.match(img.url, /\/cdn\/[0-9a-z]{12}$/);
});

test('한글 파일명이 유지된다', async () => {
  const img = await uploadOne(png, '사진.png');
  assert.equal(img.name, '사진.png');
});

test('CDN: f, w 파라미터로 변환하고 캐시한다', async () => {
  const img = await uploadOne(jpeg, 'a.jpg');
  const url = `/cdn/${img.id}?w=500&f=webp`;
  const r1 = await request(app).get(url).buffer().parse(binary).expect(200);
  assert.equal(r1.headers['content-type'], 'image/webp');
  assert.equal(r1.headers['x-cache'], 'MISS');
  assert.match(r1.headers['cache-control'], /immutable/);
  const meta = await sharp(r1.body).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 500);

  const r2 = await request(app).get(url).expect(200);
  assert.equal(r2.headers['x-cache'], 'HIT');

  await request(app).get(url).set('If-None-Match', r1.headers.etag).expect(304);
});

test('CDN: f=auto는 Accept 헤더로 포맷을 고른다', async () => {
  const img = await uploadOne(jpeg, 'b.jpg');
  const avif = await request(app).get(`/cdn/${img.id}?w=200`).set('Accept', 'image/avif,image/webp,*/*').expect(200);
  assert.equal(avif.headers['content-type'], 'image/avif');
  assert.equal(avif.headers.vary, 'Accept');
  const webp = await request(app).get(`/cdn/${img.id}?w=200`).set('Accept', 'image/webp,*/*').expect(200);
  assert.equal(webp.headers['content-type'], 'image/webp');
  const old = await request(app).get(`/cdn/${img.id}?w=200`).set('Accept', '*/*').expect(200);
  assert.equal(old.headers['content-type'], 'image/jpeg');
});

test('CDN: 투명 PNG는 구형 브라우저에 PNG로 보낸다', async () => {
  const img = await uploadOne(png, 't.png');
  const res = await request(app).get(`/cdn/${img.id}`).set('Accept', '*/*').expect(200);
  assert.equal(res.headers['content-type'], 'image/png');
});

test('CDN: 확장자로 포맷을 지정하고 cover로 자른다', async () => {
  const img = await uploadOne(jpeg, 'c.jpg');
  const res = await request(app).get(`/cdn/${img.id}.jpg?w=100&h=100&fit=cover`).buffer().parse(binary).expect(200);
  assert.equal(res.headers['content-type'], 'image/jpeg');
  const meta = await sharp(res.body).metadata();
  assert.deepEqual([meta.width, meta.height], [100, 100]);
});

test('CDN: 원본보다 크게 늘리지 않는다', async () => {
  const img = await uploadOne(png, 'small.png');
  const res = await request(app).get(`/cdn/${img.id}?w=3000&f=png`).buffer().parse(binary).expect(200);
  assert.equal((await sharp(res.body).metadata()).width, 400);
});

test('잘못된 파라미터와 없는 이미지는 거부한다', async () => {
  const img = await uploadOne(png, 'x.png');
  await request(app).get(`/cdn/${img.id}?w=abc`).expect(400);
  await request(app).get(`/cdn/${img.id}?f=bmp`).expect(400);
  await request(app).get(`/cdn/${img.id}.exe`).expect(400);
  await request(app).get('/cdn/zzzzzzzzzzzz').expect(404);
  await request(app).get('/cdn/..%2f..%2fetc').expect(404);
});

test('이미지가 아닌 파일은 업로드를 거부한다', async () => {
  const res = await request(app).post('/api/upload').attach('images', Buffer.from('hello'), 'a.txt').expect(400);
  assert.equal(res.body.results[0].ok, false);
  await request(app).post('/api/upload').expect(400);
});

test('메타데이터 API', async () => {
  const img = await uploadOne(png, 'm.png');
  const res = await request(app).get(`/api/images/${img.id}`).expect(200);
  assert.equal(res.body.id, img.id);
  await request(app).get('/api/images/nope').expect(404);
});
