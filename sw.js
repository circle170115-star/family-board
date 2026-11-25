/* 거실 등원 보드 — 서비스 워커 (앱 설치용)
 *
 * 원칙
 *  - living.html · assets/living.css · assets/living.js · data/board-data.json · manifest 는
 *    **항상 네트워크 우선**. 아침 06:00 브리핑이 갱신한 내용이 캐시에 가려지지 않게 한다.
 *    (네트워크가 죽었을 때만 마지막으로 받아 둔 사본을 쓴다)
 *  - 읽을거리 발음 MP3 도 **항상 네트워크 우선**. 날마다 예문이 바뀌는데 같은 파일명을
 *    쓰면 캐시에 남은 어제 음성이 들리므로, 오디오는 캐시보다 네트워크를 먼저 본다.
 *  - 그림·아이콘은 캐시 우선 + 뒤에서 조용히 갱신(용량이 크고 거의 안 바뀐다).
 *  - 그 밖의 요청(모아보드 index.html 등)은 손대지 않고 브라우저에 그대로 맡긴다.
 *  - api.open-meteo.com(실시간 날씨)은 **절대 캐시하지 않는다**. 보드가 어제 기온을
 *    보여 주면 안 되므로, 외부 주소는 아래 fetch 처리에서 그대로 네트워크로 보낸다.
 */

"use strict";

const CACHE = "family-living-v22-20261126a";

/* 설치할 때 미리 받아 둘 것 — 하나가 실패해도 설치 자체는 계속한다 */
const PRECACHE = [
  "living.html",
  "assets/living.css",
  "assets/living.js",
  "assets/kr-holidays.js",
  "assets/math-engine.js",
  "manifest-living.json",
  "assets/icons/icon-192.png",
  "assets/icons/icon-512.png",
  "assets/icons/icon-maskable-512.png",
  "assets/reading/audio/listen.mp3",
  "assets/reading/audio/listen-ex1.mp3",
  "assets/reading/audio/listen-ex2.mp3",
  "assets/reading/audio/listen-ex3.mp3",
  "assets/reading/audio/listen-ko-intro.mp3",
  "assets/reading/audio/listen-ko-ex1.mp3",
  "assets/reading/audio/listen-ko-ex2.mp3",
  "assets/reading/audio/listen-ko-ex3.mp3",
  "assets/reading/audio/listen-ko-tip.mp3",
  "assets/reading/audio/proverb-20261126-title.mp3",
  "assets/reading/audio/proverb-20261126-p1.mp3",
  "assets/reading/audio/proverb-20261126-p2.mp3",
  "assets/reading/audio/proverb-20261126-p3.mp3",
  "assets/reading/audio/proverb-20261126-p4.mp3",
  "assets/reading/audio/proverb-20261126-meaning.mp3",
  "assets/reading/audio/bgm-gentle-story.mp3",
];

/* 네트워크 우선 대상 (정규식, 경로 기준) */
const NETWORK_FIRST = [
  /\/living\.html$/,
  /\/assets\/living\.(css|js)$/,
  /\/assets\/kr-holidays\.js$/,
  /\/assets\/math-engine\.js$/,
  /\/data\/board-data\.json$/,
  /\/data\/reading-archive\.json$/,
  /\/manifest-living\.json$/,
  /\/assets\/reading\/audio\/.*\.mp3$/,
  /\/assets\/reading\/archive\/.*\.mp3$/,
];

const CACHE_FIRST = /\.(png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf)$/i;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        PRECACHE.map((path) =>
          cache.add(new Request(new URL(path, self.registration.scope).href, { cache: "reload" })).catch(() => {})
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) return; // Pretendard CDN · api.open-meteo.com(실시간 날씨) 등은 캐시 없이 그대로

  const path = url.pathname;
  const key = url.origin + path; // 쿼리(?v=20261119k)는 무시하고 경로로 저장

  if (NETWORK_FIRST.some((re) => re.test(path))) {
    event.respondWith(networkFirst(req, key));
    return;
  }
  if (CACHE_FIRST.test(path)) {
    event.respondWith(staleWhileRevalidate(event, req, key));
  }
});

async function networkFirst(req, key) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(key, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = (await cache.match(key, { ignoreSearch: true })) || (await cache.match(req, { ignoreSearch: true }));
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(event, req, key) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(key, { ignoreSearch: true });
  const update = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(key, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  event.waitUntil(update.catch(() => {}));
  if (hit) return hit;
  const res = await update;
  return res || Response.error();
}
