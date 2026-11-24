# LightPic

이미지를 올리면 용량을 줄여 저장하고, 주소 하나로 원하는 크기와 형식(AVIF · WebP · JPEG · PNG)으로 변환해 주는 이미지 CDN입니다.

## 기능

- **업로드 시 경량화**: EXIF 방향을 보정하고, GPS 같은 메타데이터를 지우고, 긴 변 기준으로 리사이즈한 뒤 다시 압축해 저장합니다. 드래그앤드롭, 여러 장 동시 업로드, 클립보드 붙여넣기를 지원합니다.
- **실시간 변환 CDN**: `/cdn/{id}?w=800&f=webp`처럼 쿼리만 바꾸면 그 자리에서 변환합니다.
- **포맷 자동 선택**: `f=auto`(기본값)이면 브라우저의 `Accept` 헤더를 보고 AVIF → WebP → JPEG/PNG 순으로 고릅니다. 이때 `Vary: Accept` 헤더가 붙습니다.
- **캐시**: 변환 결과는 디스크에 캐시하고, 같은 요청이 동시에 들어오면 한 번만 처리합니다. 응답에는 `Cache-Control: public, max-age=31536000, immutable`과 `ETag`가 붙어 304 응답을 지원하므로 Cloudflare 같은 앞단 CDN에 그대로 올릴 수 있습니다.
- **URL 빌더 UI**: 가로·세로·형식·품질·맞춤을 고르면 주소를 만들어 주고, 실제 결과 용량과 원본 대비 절감률을 보여 줍니다. 무채색 디자인에 라이트·다크 모드를 지원하며, 글꼴 Pretendard는 npm 패키지에서 직접 서빙합니다(외부 CDN 불필요).

## 실행

```bash
npm install
npm start          # http://localhost:3000
npm test
```

Node.js 18.17 이상이 필요합니다.

## CDN 주소

```
GET /cdn/{id}
GET /cdn/{id}.webp?w=640
GET /cdn/{id}?w=800&h=600&fit=cover&q=75&f=avif
```

| 파라미터 | 설명 | 기본값 |
|---|---|---|
| `w`, `h` | 가로·세로 픽셀 (최대 4000). 원본보다 커지지 않음 | 원본 |
| `f` | `auto`, `avif`, `webp`, `jpeg`(`jpg`), `png` | `auto` |
| `q` | 품질 1–100 | `80` |
| `fit` | `inside`, `cover`, `contain`, `outside`, `fill` | `inside` |

반응형 이미지 예시:

```html
<img
  src="https://example.com/cdn/abc123def456?w=800"
  srcset="https://example.com/cdn/abc123def456?w=400 400w,
          https://example.com/cdn/abc123def456?w=800 800w,
          https://example.com/cdn/abc123def456?w=1600 1600w"
  sizes="(max-width: 800px) 100vw, 800px"
  alt="">
```

## API

### `POST /api/upload`

`multipart/form-data`

- `images`: 이미지 파일 (여러 개 가능)
- `maxDimension` (선택): 저장할 때 긴 변의 최대 픽셀 (기본 2560)
- `quality` (선택): 저장 품질 (기본 85)

```bash
curl -F "images=@photo.jpg" -F maxDimension=1920 http://localhost:3000/api/upload
```

응답 예시:

```json
{
  "results": [{
    "ok": true,
    "image": {
      "id": "r1eydyto3oih",
      "width": 2560, "height": 1920,
      "originalBytes": 6715020, "storedBytes": 580270,
      "url": "http://localhost:3000/cdn/r1eydyto3oih",
      "examples": { "webp": "...?f=webp", "avif": "...?f=avif", "thumbnail": "...?w=320&h=320&fit=cover" }
    }
  }]
}
```

### `GET /api/images/{id}`

이미지 메타데이터를 돌려줍니다.

## 환경 변수

| 이름 | 설명 | 기본값 |
|---|---|---|
| `PORT` | 포트 | `3000` |
| `DATA_DIR` | 원본·캐시 저장 위치 | `./data` |
| `PUBLIC_BASE_URL` | 응답에 넣을 주소의 기준 도메인 (예: `https://img.example.com`) | 요청 호스트 |
| `MAX_UPLOAD_MB` | 파일당 최대 크기 | `20` |
| `MAX_FILES` | 한 번에 올릴 수 있는 파일 수 | `10` |
| `DEFAULT_MAX_DIMENSION` | 업로드 시 기본 최대 크기 | `2560` |
| `MAX_TRANSFORM_DIMENSION` | 변환 시 허용하는 최대 크기 | `4000` |
| `DEFAULT_QUALITY` | CDN 변환 기본 품질 | `80` |

## 구조

```
server.js            서버 시작
src/app.js           Express 라우트 (업로드, 메타데이터, CDN)
src/transform.js     sharp 기반 변환·포맷 협상·파라미터 검증
src/storage.js       파일 시스템 저장소 (마스터 이미지, 메타데이터, 변환 캐시)
public/              웹 UI
test/                node:test + supertest 테스트
```

## 참고

- 움직이는 GIF는 첫 프레임만 사용합니다.
- 업로드에 인증이 없으므로, 공개 서버에 올린다면 인증이나 속도 제한(rate limit)을 앞단에 추가하세요.
- 변환 캐시(`data/cache`)는 지워도 다시 만들어집니다. 원본은 `data/masters`에 있습니다.
