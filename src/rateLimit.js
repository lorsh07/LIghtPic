/**
 * 메모리 기반 고정 윈도 요청 제한기.
 * 서버 한 대 기준이며, 여러 대로 늘릴 경우 Redis 같은 공유 저장소로 바꿔야 한다.
 */
function createLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map(); // key -> { count, resetAt }

  const entry = (key) => {
    const t = now();
    let e = hits.get(key);
    if (!e || e.resetAt <= t) {
      e = { count: 0, resetAt: t + windowMs };
      hits.set(key, e);
    }
    return e;
  };

  const status = (e) => ({
    limit,
    remaining: Math.max(0, limit - e.count),
    retryAfter: Math.max(1, Math.ceil((e.resetAt - now()) / 1000)),
  });

  // 오래된 항목 정리 (프로세스 종료를 막지 않도록 unref)
  const sweep = setInterval(() => {
    const t = now();
    for (const [k, e] of hits) if (e.resetAt <= t) hits.delete(k);
  }, Math.min(windowMs, 60_000));
  sweep.unref?.();

  return {
    /** 남은 횟수만 확인 (차감하지 않음) */
    peek(key) {
      return status(entry(key));
    },
    /** cost만큼 차감. 남은 횟수가 부족하면 차감하지 않고 ok:false */
    consume(key, cost = 1) {
      const e = entry(key);
      if (e.count + cost > limit) return { ok: false, ...status(e) };
      e.count += cost;
      return { ok: true, ...status(e) };
    },
    reset(key) {
      hits.delete(key);
    },
    stop() {
      clearInterval(sweep);
    },
  };
}

function setRateHeaders(res, s) {
  res.set('RateLimit-Limit', String(s.limit));
  res.set('RateLimit-Remaining', String(s.remaining));
  res.set('RateLimit-Reset', String(s.retryAfter));
}

function tooMany(res, s, message) {
  setRateHeaders(res, s);
  res.set('Retry-After', String(s.retryAfter));
  res.set('Cache-Control', 'no-store');
  return res.status(429).json({ error: message, retryAfter: s.retryAfter });
}

module.exports = { createLimiter, setRateHeaders, tooMany };
