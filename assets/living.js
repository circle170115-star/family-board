/* 거실 등원 보드 — living.js
   data/board-data.json 한 파일만 읽어서 오늘 날짜·우장산동 날씨/옷차림·다은·승민 일정·
   저녁 홈활동·급식·간식을 자동 반영합니다. (매일 06:00 아침 브리핑이 이 파일을 갱신)
   체크·칭찬 스티커·출발 시각은 이 기기 브라우저의 localStorage 에만 저장됩니다. */
(async function () {
  "use strict";

  const $ = (s, r) => (r || document).querySelector(s);
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const parseISO = (s) => { const p = String(s).split("-").map(Number); return new Date(p[0], p[1] - 1, p[2]); };
  const WD = ["일", "월", "화", "수", "목", "금", "토"];
  const WDKEY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const STORE_KEY = "familyLivingBoard.v1";
  const FOCUS_KEY = "familyFocusMode.v1";
  const ST_ICONS = ["⭐", "💖", "🦕"];
  const PREP_START = 7 * 60 + 30;   /* 아침 준비 시작 07:30 */
  const DEFAULT_DEPARTURE = "08:40"; /* 평일 기본 출발 시각 (2026-11-20 09:00 → 08:40) */
  const DEFAULT_DEP_MIN = 8 * 60 + 40;
  /* ⏰ 등원 준비 알람 — ① 08:00 시작 ② 08:20 경고(출발 20분 전). 각각 08:00~08:09 / 08:20~08:29 사이 하루 한 번 */
  const ALARMS = [
    { key: "start", hm: 8 * 60, grace: 10, kind: "start" },
    { key: "warn", hm: 8 * 60 + 20, grace: 10, kind: "warn" },
  ];
  const DEFAULTS_REV = 2;           /* 기본값 개정 번호 — 예전 기본값이 저장돼 있으면 한 번만 새 기본값으로 옮깁니다 */
  const DAY_END = 3 * 60;           /* 출발 3시간 뒤부터는 '오늘 등원 끝' 표시 */
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

  const COND = {
    "Clear": ["☀️", "맑음"], "Mostly Clear": ["🌤️", "대체로 맑음"], "Partly Cloudy": ["⛅", "구름 조금"],
    "Mostly Cloudy": ["☁️", "구름 많음"], "Cloudy": ["☁️", "흐림"], "Drizzle": ["🌦️", "보슬비"],
    "Rain": ["🌧️", "비"], "Heavy Rain": ["🌧️", "강한 비"], "Flurries": ["🌨️", "눈 날림"],
    "Snow": ["❄️", "눈"], "Foggy": ["🌫️", "안개"], "Thunderstorm": ["⛈️", "뇌우"],
  };

  /* ───────────── PWA: 홈 화면/앱 설치용 서비스 워커 ─────────────
     living.html 은 네트워크 우선으로 받아 오고(sw.js), 그림·아이콘만 캐싱합니다. */
  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    const run = () => {
      navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(() => { /* 등록 실패는 보드 사용에 영향 없음 */ });
    };
    if (document.readyState === "complete") run();
    else window.addEventListener("load", run, { once: true });
  }
  registerServiceWorker();

  /* ───────────── 데이터 ───────────── */
  async function fetchData() {
    const res = await fetch("data/board-data.json?ts=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  let data = null;
  let CHILDREN = [], HOLIDAYS = {}, SCHEDULES = [], EVENTS = [], BOOK = [], MEALS = {}, SNACKS = {}, EVENING = null, PLACE = "우리 동네";
  function derive() {
    CHILDREN = data.children || [];
    HOLIDAYS = data.holidays || {};
    SCHEDULES = data.schedules || [];
    EVENTS = data.kindergartenEvents || [];
    BOOK = data.bookRental || [];
    MEALS = data.meals || {};
    SNACKS = data.kindergartenSnacks || {};
    EVENING = data.eveningRoutine || null;
    PLACE = (data.family && data.family.location && data.family.location.name) || PLACE;
  }

  /* ───────────── 날짜·요일 도우미 ───────────── */
  let todayStr = iso(new Date());
  const weekdayKey = (ds) => WDKEY[parseISO(ds).getDay()];
  const isRestDay = (ds) => {
    if (HOLIDAYS[ds]) return true;
    const w = parseISO(ds).getDay();
    return w === 0 || w === 6;
  };

  /* 평일(월~금)만 세어 격일로 도는 저녁 홈활동 — index.html 과 같은 계산식 */
  function weekdayIndexFromAnchor(ds) {
    if (!EVENING || !EVENING.anchor) return -1;
    const a = parseISO(EVENING.anchor);
    const b = parseISO(ds);
    if (b < a) return -1;
    if (b.getDay() === 0 || b.getDay() === 6) return -1;
    const total = Math.round((b - a) / 86400000);
    const fullWeeks = Math.floor(total / 7);
    let n = fullWeeks * 5;
    const cur = new Date(a);
    cur.setDate(a.getDate() + fullWeeks * 7);
    for (let i = 0; i <= total - fullWeeks * 7; i++) {
      const wd = cur.getDay();
      if (wd !== 0 && wd !== 6) n++;
      cur.setDate(cur.getDate() + 1);
    }
    return n - 1;
  }
  function eveningActivity(ds) {
    const subs = EVENING && EVENING.subjects;
    if (!subs || !subs.length) return null;
    const step = EVENING.step || 2;
    const wi = weekdayIndexFromAnchor(ds);
    if (wi < 0 || wi % step !== 0) return null;
    return subs[Math.floor(wi / step) % subs.length] || null;
  }

  /* ───────────── 저장소 (localStorage) ───────────── */
  let store = null;
  function blankCheck() { return { morning: [], evening: [], awarded: { morning: "", evening: "" } }; }
  function blankChecks() {
    const o = {};
    CHILDREN.forEach((c) => { o[c.id] = blankCheck(); });
    return o;
  }
  function loadStore() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch (e) { s = null; }
    if (!s || typeof s !== "object") s = {};
    if (typeof s.sound !== "boolean") s.sound = true;
    if (typeof s.alarm !== "boolean") s.alarm = true;      /* ⏰ 08:00 · 08:20 알람 (기본 켜짐) */
    s.alarmDoneBySlot = s.alarmDoneBySlot && typeof s.alarmDoneBySlot === "object" ? s.alarmDoneBySlot : {};  /* 슬롯별 마지막으로 울린 날짜 */
    if (typeof s.departure !== "string" || !/^\d{1,2}:\d{2}$/.test(s.departure)) s.departure = DEFAULT_DEPARTURE;
    s.departureByDate = s.departureByDate && typeof s.departureByDate === "object" ? s.departureByDate : {};
    s.stickers = s.stickers && typeof s.stickers === "object" ? s.stickers : {};
    /* 기본값 개정(rev 2, 2026-11-20): 평일 기본 출발이 09:00 → 08:40 으로 바뀌었습니다.
       이 기기에 예전 기본값 09:00 이 그대로 저장돼 있으면 새 기본값으로 옮깁니다.
       부모님이 직접 고른 다른 시각은 그대로 두고, 개정 번호를 남겨 다시는 건드리지 않습니다. */
    if (parseInt(s.defaultsRev, 10) !== DEFAULTS_REV) {
      if (s.departure === "09:00") s.departure = DEFAULT_DEPARTURE;
      Object.keys(s.departureByDate).forEach((k) => { if (s.departureByDate[k] === "09:00") delete s.departureByDate[k]; });
      s.defaultsRev = DEFAULTS_REV;
    }
    CHILDREN.forEach((c) => {
      const n = parseInt(s.stickers[c.id], 10);
      s.stickers[c.id] = Number.isFinite(n) && n > 0 ? n : 0;
    });
    /* 날짜가 바뀌면 체크만 새로 — 누적 스티커와 출발 시각 설정은 그대로 */
    if (s.date !== todayStr) {
      s.date = todayStr;
      s.checks = blankChecks();
    }
    s.checks = s.checks && typeof s.checks === "object" ? s.checks : {};
    CHILDREN.forEach((c) => {
      const cur = s.checks[c.id];
      if (!cur || !Array.isArray(cur.morning) || !Array.isArray(cur.evening) || !cur.awarded) s.checks[c.id] = blankCheck();
    });
    return s;
  }
  function save() {
    if (store) {
      /* 오래된 날짜별 출발 시각은 정리 */
      const keys = Object.keys(store.departureByDate || {});
      keys.forEach((k) => { if (k < todayStr) delete store.departureByDate[k]; });
    }
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* 저장 불가 모드 */ }
  }
  function ensureCheck(cid) {
    if (!store.checks[cid]) store.checks[cid] = blankCheck();
    return store.checks[cid];
  }

  /* ───────────── 체크리스트 정의 (큰 그림 타일) ───────────── */
  function bookForToday(cid, ds) {
    const wk = weekdayKey(ds);
    return BOOK.find((b) => b.weekday === wk && b.child === cid) || null;
  }
  /* 캐릭터·타일 일러스트 (assets/illustrations/*.png — 배경 투명 PNG) */
  const ILL_DIR = "assets/illustrations/";
  const ILL_FUN = { "미술": "tile-fun-art", "독서": "tile-fun-read", "수학": "tile-fun-math", "과학": "tile-fun-science", "보드게임": "tile-fun-board" };
  const avatarOf = (cid) => (cid === "daeun" || cid === "seungmin" ? ILL_DIR + cid + "-avatar.png" : "");
  /* 타일 일러스트 톤 — 다은 = 핑크·코랄, 승민 = 스카이블루·블루 (없으면 원본 그린) */
  const ILL_TONE = { daeun: "-pink", seungmin: "-blue" };
  const ILL_VER = "20261119b";
  const illImg = (name, cid) =>
    '<img src="' + ILL_DIR + name + (ILL_TONE[cid] || "") + ".png?v=" + ILL_VER + '" alt="" aria-hidden="true" draggable="false" decoding="async">';

  function buildChecklists(cid, ds) {
    /* 아침 준비 — 머리 빗기·묶기는 다은이만 */
    const morning = [
      { id: "wash", ill: "tile-wash", t: "세수·양치하기" },
      { id: "clothes", ill: "tile-clothes", t: "옷 입기" },
    ];
    if (cid === "daeun") morning.push({ id: "hair", ill: "tile-hair", t: "머리 빗기·묶기" });
    morning.push({ id: "meal", ill: "tile-meal", t: "아침 먹기" });
    morning.push({ id: "bag", ill: "tile-bag", t: "가방·물통" });
    if (bookForToday(cid, ds)) morning.push({ id: "book", ill: "tile-book", t: "도서대여 가방" });
    morning.push({ id: "shoes", ill: "tile-shoes", t: "신발 신고 출발!" });

    /* 저녁 루틴 — 두 아이 모두 8개 (엘리하이 학습·정리·씻기·옷 갈아입기 포함) */
    const act = eveningActivity(ds);
    const evening = [
      { id: "hands", ill: "tile-hands", t: "손 씻기" },
      { id: "unpack", ill: "tile-unpack", t: "가방 정리" },
      act ? { id: "fun", ill: ILL_FUN[act.name] || "tile-fun-free", t: act.name + " 놀이!" } : { id: "fun", ill: "tile-fun-free", t: "자유놀이!" },
      { id: "study", ill: "tile-study", t: "엘리하이 오늘의 학습" },
      { id: "tidy", ill: "tile-tidy", t: "놀이한 거 정리하기" },
      { id: "shower", ill: "tile-shower", t: "씻기" },
      { id: "pajamas", ill: "tile-pajamas", t: "옷 갈아입기" },
      { id: "brush", ill: "tile-brush", t: "양치하고 자기" },
    ];
    return { morning: morning, evening: evening };
  }
  function progressOf(cid, part, lists) {
    const items = (lists || buildChecklists(cid, todayStr))[part] || [];
    const arr = ensureCheck(cid)[part] || [];
    const done = items.filter((i) => arr.indexOf(i.id) >= 0).length;
    return { done: done, total: items.length };
  }

  /* 아이별 오늘 일정 한 줄 */
  function childTodayItems(cid, ds) {
    const wk = weekdayKey(ds);
    const out = [];
    EVENTS.forEach((e) => { if (e.date === ds && e.child === cid) out.push({ time: null, text: e.title }); });
    BOOK.forEach((b) => { if (b.weekday === wk && b.child === cid) out.push({ time: null, text: b.label }); });
    SCHEDULES.forEach((s) => {
      if (s.child !== cid) return;
      const t = s.times[wk];
      if (t) out.push({ time: t, text: String(s.title).replace("병설유치원 ", "") });
    });
    out.sort((a, b) => (a.time ? 1 : 0) - (b.time ? 1 : 0) || (String(a.time) < String(b.time) ? -1 : 1));
    return out;
  }
  function childTodayText(cid, ds) {
    if (isRestDay(ds)) return "<i>🌴 오늘은 쉬는 날</i>";
    const items = childTodayItems(cid, ds);
    if (!items.length) return "<i>오늘은 따로 일정이 없어요</i>";
    return items
      .slice(0, 4)
      .map((i) => (i.time ? "<i>" + esc(i.time) + "</i> " : "") + esc(i.text))
      .join(" · ");
  }

  /* ───────────── 날씨 · 옷차림 ───────────── */
  function outfitTip(minC, pop) {
    if (!Number.isFinite(minC)) return "날씨 정보를 확인해 주세요";
    let tip;
    if (minC >= 20) tip = "반팔로도 시원해요";
    else if (minC >= 15) tip = "긴팔 한 장이면 충분해요";
    else if (minC >= 8) tip = "얇은 겉옷(가디건·후드)을 챙겨요";
    else if (minC >= 0) tip = "따뜻한 외투(자켓·코트)가 필요해요";
    else tip = "패딩·장갑·목도리까지 꼼꼼히! 새벽이 더 추워요";
    if (pop >= 60) tip += " · 우산 필수! ☂️";
    else if (pop >= 30) tip += " · 우산 하나쯤은 챙겨요";
    return tip;
  }
  function todayWeather() {
    const w = data.weather || {};
    const n = w.now || {};
    const days = w.days || [];
    const dd = days.find((x) => x.date === todayStr) || days[0] || {};
    const nc = COND[n.condition] || ["🌡️", n.condition || ""];
    const dc = COND[dd.condition] || ["🌡️", dd.condition || ""];
    return { now: n, nc: nc, day: dd, dc: dc, air: w.air || {} };
  }
  function renderHead() {
    const d = new Date();
    $("#dateLine").textContent = d.getFullYear() + "년 " + (d.getMonth() + 1) + "월 " + d.getDate() + "일 " + WD[d.getDay()] + "요일 · " + PLACE;

    const w = todayWeather();
    const n = w.now, dd = w.day;
    const temp = Number(n.temp);
    let wx = w.nc[0] + ' <em>' + (Number.isFinite(temp) ? Math.round(temp) + "°" : "—") + "</em> " + esc(w.nc[1]);
    if (Number.isFinite(Number(n.feels))) wx += " (체감 " + Math.round(Number(n.feels)) + "°)";
    if (Number.isFinite(Number(dd.high)) && Number.isFinite(Number(dd.low))) {
      wx += " · 최고 " + Math.round(dd.high) + "° / 최저 " + Math.round(dd.low) + "°";
    }
    if (Number.isFinite(Number(dd.precip))) wx += " · 강수 " + dd.precip + "%";
    if (dd.condition) wx += " · " + w.dc[0] + " " + esc(w.dc[1]);
    $("#wxLine").innerHTML = wx;
    $("#outfitLine").innerHTML = "🎒 등원 옷차림 · <b>" + esc(outfitTip(Number(dd.low), Number(dd.precip))) + "</b>";
  }

  /* ───────────── 오늘 유치원 소식 칩 ───────────── */
  function mainDish(menu) {
    const names = (menu || []).map((m) => m.name).filter(Boolean);
    const skip = /(밥|죽|국|탕|김치|우유|요구르트|요쿠르트|샐러드|나물|무침)/;
    const main = /(불고기|갈비|탕수|치킨|돈까스|까스|스테이크|함박|조기|생선|오징어|새우|두부|계란|달걀|만두|볶음|구이|찜|덮밥|카레|짜장|파스타|스파게티|떡볶이|핫도그|피자|불백|제육)/;
    const hit = names.find((x) => main.test(x)) || names.find((x) => !skip.test(x)) || names[0] || "";
    return { hit: hit, count: names.length };
  }
  function chipsHTML() {
    const ds = todayStr;
    const wk = weekdayKey(ds);
    const chips = [];
    const hol = HOLIDAYS[ds];
    if (hol) chips.push({ cls: "warn", text: "🏖️ " + hol.name + " · 등원 없음" });
    else if (isRestDay(ds)) chips.push({ cls: "warn", text: "🏖️ 주말 · 등원 없음" });

    EVENTS.forEach((e) => {
      if (e.date !== ds) return;
      chips.push({
        cls: e.important || e.kind === "alert" ? "warn" : "",
        text: (e.important ? "⚠️ " : "🎈 ") + e.title + (e.detail ? " · " + e.detail : ""),
      });
    });
    BOOK.forEach((b) => {
      if (b.weekday !== wk) return;
      const nm = b.child ? ((CHILDREN.find((c) => c.id === b.child) || {}).name || "") : "";
      chips.push({ cls: "mint", text: "📚 " + b.label + (nm ? " (" + nm + ")" : "") });
    });
    const meal = MEALS[ds];
    if (meal && meal.menu && meal.menu.length) {
      const m = mainDish(meal.menu);
      chips.push({ cls: "", text: "🍱 급식 " + (m.hit || "메뉴 확인") + (m.count > 1 ? " 외 " + (m.count - 1) + "가지" : "") });
    }
    const sn = SNACKS[ds];
    if (Array.isArray(sn) && sn.length) chips.push({ cls: "", text: "🍪 간식 " + sn.join(" · ") });
    const air = (data.weather && data.weather.air) || {};
    if (air.pm10 && air.pm10.grade) {
      chips.push({ cls: air.pm10.grade === "나쁨" || air.pm10.grade === "매우나쁨" ? "warn" : "", text: "😷 미세먼지 " + air.pm10.grade });
    }
    return chips.map((c) => '<span class="chip ' + c.cls + '">' + esc(c.text) + "</span>").join("");
  }
  function renderChips() { $("#chipRow").innerHTML = chipsHTML(); }

  /* ───────────── 출발 시각 · 카운트다운 ───────────── */
  function parseHM(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
    if (!m) return null;
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }
  const hhmm = (min) => pad(Math.floor(min / 60)) + ":" + pad(min % 60);

  /* 오늘 유치원 안내문의 "등원 시간 10시부터로 조정" 같은 문구에서 등원 시각을 읽습니다 */
  function arrivalOverride() {
    const ev = EVENTS.find((e) => e.date === todayStr && e.detail && /등원\s*시간/.test(e.detail));
    if (!ev) return null;
    const m = /(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/.exec(ev.detail);
    if (!m) return null;
    const h = +m[1];
    if (h > 23) return null;
    return h * 60 + (m[2] ? +m[2] : 0);
  }
  function departureInfo() {
    /* 우선순위: 오늘 직접 설정 > 등원 시각에서 자동(15분 전 출발) > 평소 출발 시각 */
    const byDate = (store.departureByDate || {})[todayStr];
    const manual = parseHM(byDate);
    const arr = arrivalOverride();
    if (manual != null) return { min: manual, src: "manual", arrival: arr };
    if (arr != null) return { min: Math.max(0, arr - 15), src: "auto", arrival: arr };
    return { min: parseHM(store.departure) || DEFAULT_DEP_MIN, src: "default", arrival: null };
  }
  function leftText(m) {
    if (m >= 60) {
      const h = Math.floor(m / 60), r = m % 60;
      return h + "시간" + (r ? " " + r + "분" : "");
    }
    return m + "분";
  }
  function renderCountdown() {
    const box = $("#countdown");
    if (!box) return;
    const dep = departureInfo();
    const d = new Date();
    const cur = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
    const left = dep.min - cur;
    const tEl = $("#cdTime"), uEl = $("#cdUnit"), fEl = $("#cdFill"), mEl = $("#cdMeta"), titleEl = $("#cdTitle"), track = $("#cdTrack");

    const metas = ["목표 출발 " + hhmm(dep.min)];
    if (dep.src === "auto" && dep.arrival != null) metas.push("등원 " + hhmm(dep.arrival) + "에 맞춤");
    else if (dep.src === "manual") metas.push("설정한 시각");
    mEl.textContent = metas.join(" · ");

    box.classList.remove("is-green", "is-orange", "is-red", "is-done");
    const windowMin = Math.max(20, dep.min - PREP_START);
    let pct = left <= 0 ? 0 : Math.max(0, Math.min(100, (left / windowMin) * 100));
    fEl.style.width = pct.toFixed(1) + "%";

    if (isRestDay(todayStr)) {
      box.classList.add("is-done");
      titleEl.textContent = "오늘은";
      tEl.textContent = "쉬는 날";
      uEl.textContent = "푹 쉬어요 🌴";
      mEl.textContent = HOLIDAYS[todayStr] ? HOLIDAYS[todayStr].name + " · 등원 없음" : "주말 · 등원 없음";
      fEl.style.width = "100%";
      pct = 100;
      if (track) track.setAttribute("aria-valuenow", "100");
      return;
    }

    if (cur > dep.min + DAY_END) {
      box.classList.add("is-done");
      titleEl.textContent = "오늘 등원";
      tEl.textContent = "끝!";
      uEl.textContent = "내일도 화이팅 🌙";
      fEl.style.width = "100%";
      pct = 100;
    } else if (left <= 0) {
      box.classList.add("is-red");
      titleEl.textContent = "출발 시간";
      tEl.textContent = Math.max(1, Math.ceil(-left)) + "분";
      uEl.textContent = "지났어요! 서둘러요 🏃";
      fEl.style.width = "0%";
      pct = 0;
    } else {
      const m = Math.ceil(left);
      if (m <= 10) box.classList.add("is-red");
      else if (m <= 20) box.classList.add("is-orange");
      else box.classList.add("is-green");
      titleEl.textContent = "출발까지";
      tEl.textContent = leftText(m);
      uEl.textContent = "남았어요!";
    }
    if (track) track.setAttribute("aria-valuenow", String(Math.round(pct)));
  }

  /* ───────────── 등원 시간대 자동 전환 설정 (index.html 과 공유) ───────────── */
  function focusCfg() {
    let c = null;
    try { c = JSON.parse(localStorage.getItem(FOCUS_KEY) || "null"); } catch (e) { c = null; }
    if (!c || typeof c !== "object") c = { enabled: true };
    if (typeof c.enabled !== "boolean") c.enabled = true;
    return c;
  }
  function setFocus(on) {
    try { localStorage.setItem(FOCUS_KEY, JSON.stringify({ enabled: !!on })); } catch (e) { /* noop */ }
    renderSettings();
    toast(on ? "등원 시간대 자동 전환을 켰어요 🌞" : "등원 시간대 자동 전환을 껐어요");
  }

  /* ───────────── 아이 카드 ───────────── */
  const state = { tab: {} };
  function defaultTab() { const h = new Date().getHours(); return h >= 17 || h < 4 ? "evening" : "morning"; }
  const tabOf = (cid) => state.tab[cid] || defaultTab();

  function tilesHTML(items, arr, cid) {
    return (
      '<ul class="tiles" data-n="' + items.length + '">' +
      items
        .map((i) => {
          const on = arr.indexOf(i.id) >= 0;
          return (
            '<li><button type="button" class="tile' + (on ? " is-done" : "") + '" data-id="' + i.id + '" aria-pressed="' + on + '">' +
            '<span class="tile-emoji" aria-hidden="true">' + illImg(i.ill, cid) + "</span>" +
            '<span class="tile-label">' + esc(i.t) + "</span>" +
            '<span class="tile-badge" aria-hidden="true">✓ 완료!</span>' +
            "</button></li>"
          );
        })
        .join("") +
      "</ul>"
    );
  }
  function tabHTML(part, label, p, current) {
    const done = p.total > 0 && p.done === p.total;
    return (
      '<button type="button" class="kid-tab' + (part === current ? " is-on" : "") + (done ? " is-done" : "") + '" data-part="' + part + '" role="tab" aria-selected="' + (part === current) + '">' +
      label + " <b>" + p.done + "/" + p.total + "</b></button>"
    );
  }
  function stickerRows(total) {
    const t = Math.max(0, parseInt(total, 10) || 0);
    const shown = Math.min(t, 20);
    const start = t - shown;
    let html = "";
    for (let r = 0; r < 2; r++) {
      const from = start + r * 10;
      if (from >= t) break;
      let cells = "";
      for (let i = from; i < from + 10; i++) {
        const on = i < t;
        cells += '<i class="st' + (on ? " on" : "") + '">' + (on ? ST_ICONS[Math.floor(i / 10) % 3] : "") + "</i>";
      }
      html += '<div class="st-row">' + cells + "</div>";
    }
    if (!html) html = '<div class="st-row">' + Array.from({ length: 10 }, () => '<i class="st"></i>').join("") + "</div>";
    if (t > 20) html += '<div class="st-more">앞에서 ' + (t - 20) + "개 더 모았어요</div>";
    return html;
  }
  function kidHTML(c) {
    ensureCheck(c.id);
    const lists = buildChecklists(c.id, todayStr);
    const part = tabOf(c.id);
    const items = lists[part] || lists.morning;
    const arr = ensureCheck(c.id)[part] || [];
    const pm = progressOf(c.id, "morning", lists);
    const pe = progressOf(c.id, "evening", lists);
    const st = store.stickers[c.id] || 0;
    const face = avatarOf(c.id);
    const grade = String(c.grade || "").split(" (")[0];
    return (
      '<div class="kid-head">' +
        '<div class="kid-avatar" aria-hidden="true">' + (face ? '<img src="' + face + '" alt="" draggable="false">' : "") + "</div>" +
        '<div style="min-width:0;flex:1">' +
          '<div class="kid-name"><h2>' + esc(c.name) + "</h2><span>" + esc(c.ageLabel || "") + (grade ? " · " + esc(grade) : "") + "</span></div>" +
          '<div class="kid-today">' + childTodayText(c.id, todayStr) + "</div>" +
        "</div>" +
      "</div>" +
      '<div class="kid-tabs" role="tablist" aria-label="' + esc(c.name) + ' 준비 선택">' +
        tabHTML("morning", "🌞 아침 준비", pm, part) +
        tabHTML("evening", "🌙 저녁 루틴", pe, part) +
      "</div>" +
      '<div class="kid-body" data-part="' + part + '">' +
        (isRestDay(todayStr) && part === "morning" ? '<p class="kid-rest">🌴 오늘은 쉬는 날이에요 · 등원 준비는 없어요</p>' : "") +
        tilesHTML(items, arr, c.id) +
      "</div>" +
      '<div class="kid-foot">' +
        '<div class="st-head"><span class="st-star" aria-hidden="true">⭐</span><span class="st-num">' + st + '</span><span class="st-unit">개</span></div>' +
        '<div class="st-board">' + stickerRows(st) + "</div>" +
      "</div>"
    );
  }
  function renderKids() {
    const grid = $("#childGrid");
    if (!CHILDREN.length) {
      grid.innerHTML = '<div class="lv-error">아이 정보가 아직 없어요.<br><small>data/board-data.json 의 children 을 확인해 주세요.</small></div>';
      return;
    }
    grid.innerHTML = CHILDREN.map((c) => '<section class="kid" data-child="' + esc(c.id) + '" aria-label="' + esc(c.name) + '">' + kidHTML(c) + "</section>").join("");
  }
  function renderKid(cid) {
    const c = CHILDREN.find((x) => x.id === cid);
    const el = document.querySelector('.kid[data-child="' + cid + '"]');
    if (!c || !el) return;
    el.innerHTML = kidHTML(c);
  }
  function refreshBadges(cid) {
    const el = document.querySelector('.kid[data-child="' + cid + '"]');
    if (!el) return;
    const lists = buildChecklists(cid, todayStr);
    ["morning", "evening"].forEach((part) => {
      const p = progressOf(cid, part, lists);
      const btn = el.querySelector('.kid-tab[data-part="' + part + '"]');
      if (!btn) return;
      const b = btn.querySelector("b");
      if (b) b.textContent = p.done + "/" + p.total;
      btn.classList.toggle("is-done", p.total > 0 && p.done === p.total);
    });
  }

  /* ───────────── 소리 (Web Audio) ───────────── */
  let _ctx = null;
  function audio() {
    if (!_ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      try { _ctx = new C(); } catch (e) { return null; }
    }
    if (_ctx.state === "suspended") { try { _ctx.resume(); } catch (e) { /* noop */ } }
    return _ctx;
  }
  function tone(freq, delay, dur, type, vol) {
    const c = _ctx;
    if (!c) return;
    const o = c.createOscillator();
    const g = c.createGain();
    const t0 = c.currentTime + delay;
    o.type = type || "sine";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol || 0.15, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(c.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.06);
  }
  function tapSound(on) {
    if (!store.sound || !audio()) return;
    if (on) { tone(1046.5, 0, 0.26, "sine", 0.13); tone(1568, 0.085, 0.3, "sine", 0.09); }
    else { tone(440, 0, 0.16, "sine", 0.08); }
  }
  function cheer() {
    if (!store.sound || !audio()) return;
    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => tone(f, i * 0.1, 0.42, "triangle", 0.11));
  }
  function setSound(on) {
    store.sound = !!on;
    save();
    const btn = $("#soundBtn");
    btn.textContent = on ? "🔊" : "🔇";
    btn.classList.toggle("is-off", !on);
    btn.setAttribute("aria-label", on ? "효과음 끄기" : "효과음 켜기");
    const sw = $("#soundSwitch");
    if (sw) {
      sw.textContent = on ? "켜짐" : "꺼짐";
      sw.classList.toggle("off", !on);
      sw.setAttribute("aria-pressed", String(!!on));
    }
  }

  /* ───────────── 축하 · 폭죽 · 토스트 ───────────── */
  let celebrateT = null, toastT = null;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove("show"), 2400);
  }
  function confetti() {
    const box = $("#confetti");
    const colors = ["#F7C948", "#F28DA0", "#7FB3F0", "#8FD6B0", "#C7A7F2", "#FFB067"];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 72; i++) {
      const s = document.createElement("i");
      s.className = "cf";
      s.style.left = (Math.random() * 100).toFixed(2) + "%";
      s.style.background = colors[i % colors.length];
      s.style.animationDuration = (1.9 + Math.random() * 1.7).toFixed(2) + "s";
      s.style.animationDelay = (Math.random() * 0.45).toFixed(2) + "s";
      s.style.setProperty("--dx", ((Math.random() - 0.5) * 170).toFixed(0) + "px");
      s.style.width = (7 + Math.random() * 7).toFixed(0) + "px";
      s.style.height = (10 + Math.random() * 10).toFixed(0) + "px";
      frag.appendChild(s);
    }
    box.appendChild(frag);
    setTimeout(() => { box.innerHTML = ""; }, 4400);
  }
  function celebrate(cid, part) {
    const c = CHILDREN.find((x) => x.id === cid);
    const nm = c ? c.name : "";
    const label = part === "morning" ? "아침 등원 준비" : "저녁 루틴";
    const el = $("#celebrate");
    el.querySelector("b").textContent = "🎉 " + nm + "이 " + label + " 완성!";
    el.querySelector("span").textContent = "칭찬 스티커 +1 ⭐ 정말 잘했어요!";
    el.classList.add("show");
    clearTimeout(celebrateT);
    celebrateT = setTimeout(() => el.classList.remove("show"), 3800);
    confetti();
  }

  /* ───────────── 체크 동작 ───────────── */
  function paintTile(btn, on) {
    btn.classList.toggle("is-done", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  function toggleStep(cid, part, id, btn) {
    const c = ensureCheck(cid);
    const arr = c[part];
    const at = arr.indexOf(id);
    if (at >= 0) { arr.splice(at, 1); paintTile(btn, false); tapSound(false); }
    else { arr.push(id); paintTile(btn, true); tapSound(true); }
    save();
    refreshBadges(cid);
    if (at < 0) maybeAward(cid, part);
  }
  function maybeAward(cid, part) {
    const lists = buildChecklists(cid, todayStr);
    const p = progressOf(cid, part, lists);
    if (!p.total || p.done !== p.total) return;
    const c = ensureCheck(cid);
    if (c.awarded[part] === todayStr) { toast("오늘 스티커는 이미 받았어! 그래도 최고야 ⭐"); return; }
    c.awarded[part] = todayStr;
    store.stickers[cid] = (store.stickers[cid] || 0) + 1;
    save();
    renderKid(cid);          // 스티커판 갱신 (체크 상태 유지)
    renderPanel();
    celebrate(cid, part);
    cheer();
  }

  /* ───────────── 부모님 설정 패널 ───────────── */
  function renderPanel() {
    const box = $("#stRows");
    if (!box) return;
    box.innerHTML = CHILDREN.map((c) => {
      const face = avatarOf(c.id);
      return (
        '<div class="lv-set"><span>' + (face ? '<img class="face-ico" src="' + face + '" alt="" aria-hidden="true">' : "") + esc(c.name) + " 스티커</span>" +
        '<span class="mini">' +
          '<button class="num-btn" type="button" data-minus="' + esc(c.id) + '" aria-label="' + esc(c.name) + ' 스티커 줄이기">−</button>' +
          '<b class="st-num-b">' + (store.stickers[c.id] || 0) + "</b>" +
          '<button class="num-btn" type="button" data-plus="' + esc(c.id) + '" aria-label="' + esc(c.name) + ' 스티커 늘리기">+</button>' +
        "</span></div>"
      );
    }).join("");
    renderSettings();
  }
  function renderSettings() {
    const depToday = $("#depToday"), depDefault = $("#depDefault"), fs = $("#focusSwitch");
    if (depToday && document.activeElement !== depToday) depToday.value = hhmm(departureInfo().min);
    if (depDefault && document.activeElement !== depDefault) depDefault.value = store.departure;
    if (fs) {
      const on = focusCfg().enabled;
      fs.textContent = on ? "켜짐" : "꺼짐";
      fs.classList.toggle("off", !on);
      fs.setAttribute("aria-pressed", String(on));
    }
  }
  function adjustSticker(cid, delta) {
    const cur = parseInt(store.stickers[cid] || 0, 10) || 0;
    store.stickers[cid] = Math.max(0, cur + delta);
    save();
    renderKid(cid);
    renderPanel();
  }
  function openGear(open) {
    const p = $("#gearPanel");
    p.hidden = !open;
    if (open) renderPanel();
  }

  /* ───────────── 전체 새로고침 · 날짜 넘김 ───────────── */
  function renderAll() {
    renderHead();
    renderChips();
    renderKids();
    renderPanel();
    renderCountdown();
  }
  async function refreshData(notify) {
    try {
      data = await fetchData();
      derive();
      renderAll();
      if (notify) toast("보드 데이터를 새로 불러왔어요");
    } catch (e) {
      if (notify) toast("데이터를 불러오지 못했어요 · 잠시 뒤 다시 시도해요");
    }
  }
  function dayRollover() {
    const next = iso(new Date());
    if (next === todayStr) return;
    todayStr = next;
    store.date = todayStr;
    store.checks = blankChecks();
    save();
    renderAll();
    toast("새로운 하루! 오늘 체크를 새로 시작해요 🌞");
    refreshData(false);
  }
  function tick() {
    const d = new Date();
    $("#clockHM").textContent = pad(d.getHours()) + ":" + pad(d.getMinutes());
    $("#clockSec").textContent = pad(d.getSeconds());
    if (iso(d) !== todayStr) { dayRollover(); return; }
    checkAlarm(d);
    renderCountdown();
  }

  /* ───────────── ⏰ 등원 준비 알람 (평일 08:00 · 08:20) ─────────────
     ① 08:00 시작 차임 — 맑은 도-미-솔-도
     ② 08:20 경고 차임 — 두 번 반복되는 또렷한 딩동댕 (출발 20분 전)
     주말·공휴일에는 울리지 않고, 두 알람 모두 하루 한 번만 울립니다. */
  function alarmOn() { return store.alarm !== false; }
  function renderAlarmBtn() {
    const on = alarmOn();
    const btn = $("#alarmBtn");
    if (btn) {
      btn.textContent = on ? "🔔" : "🔕";
      btn.classList.toggle("is-off", !on);
      btn.title = on ? "등원 알람 켜짐 · 평일 8:00 / 8:20 (누르면 끄기)" : "등원 알람 꺼짐 (누르면 켜기)";
      btn.setAttribute("aria-label", on ? "등원 알람 끄기" : "등원 알람 켜기");
      btn.setAttribute("aria-pressed", String(on));
    }
    const sw = $("#alarmSwitch");
    if (sw) {
      sw.textContent = on ? "켜짐" : "꺼짐";
      sw.classList.toggle("off", !on);
      sw.setAttribute("aria-pressed", String(on));
    }
    const hint = $("#alarmHint");
    if (hint) hint.textContent = on ? "평일 8:00 · 8:20" : "꺼짐";
  }
  function setAlarm(on) {
    store.alarm = !!on;
    save();
    renderAlarmBtn();
  }
  /* ① 08:00 시작 — 맑은 차임벨 도(C5)-미(E5)-솔(G5)-높은 도(C6), 약 2.8초 */
  function chimeStart() {
    if (!audio()) return false;
    [
      [523.25, 0.00, 1.5, 0.085],
      [659.25, 0.30, 1.5, 0.090],
      [783.99, 0.60, 1.6, 0.095],
      [1046.5, 0.95, 2.0, 0.105],
    ].forEach((n) => {
      tone(n[0], n[1], n[2], "sine", n[3]);
      tone(n[0] * 2, n[1], n[2] * 0.8, "sine", n[3] * 0.32);  /* 한 옥타브 위로 은은하게 */
    });
    return true;
  }
  /* ② 08:20 경고 — 또렷한 딩동댕(G5-B5-D6)을 두 번, 삼각파로 밝고 분명하게 */
  function chimeWarn() {
    if (!audio()) return false;
    const beat = [[880, 0.00, 0.30, 0.10], [1174.66, 0.18, 0.30, 0.10], [1567.98, 0.36, 0.55, 0.11]];
    [0, 0.95].forEach((off) => beat.forEach((n) => {
      tone(n[0], off + n[1], n[2], "triangle", n[3]);
      tone(n[0] * 2, off + n[1], n[2] * 0.7, "sine", n[3] * 0.26);
    }));
    return true;
  }
  function playAlarm(kind) { return kind === "warn" ? chimeWarn() : chimeStart(); }
  function showAlarmBanner(kind) {
    const b = $("#alarmBanner");
    if (!b) return;
    const isWarn = kind === "warn";
    const dep = hhmm(departureInfo().min);
    const ico = b.querySelector(".alarm-ico");
    const title = b.querySelector(".alarm-title");
    const sub = b.querySelector(".alarm-sub");
    if (ico) ico.textContent = isWarn ? "⚠️" : "⏰";
    if (title) title.textContent = isWarn ? "오전 8시 20분!" : "오전 8시예요!";
    if (sub) {
      const warnLeft = Math.max(0, departureInfo().min - (8 * 60 + 20));
      sub.textContent = isWarn
        ? "출발까지 " + warnLeft + "분 남았어요 · " + dep + " 출발"
        : "다은·승민 등원 준비 시작할 시간이에요 · 출발 " + dep;
    }
    b.classList.toggle("is-warn", isWarn);
    b.classList.remove("show");
    void b.offsetWidth;
    b.classList.add("show");
    clearTimeout(showAlarmBanner.timer);
    showAlarmBanner.timer = setTimeout(() => b.classList.remove("show"), isWarn ? 15000 : 12000);
  }
  function hideAlarmBanner() {
    const b = $("#alarmBanner");
    if (b) b.classList.remove("show");
    clearTimeout(showAlarmBanner.timer);
  }
  function checkAlarm(d) {
    if (!alarmOn() || isRestDay(todayStr)) return;   /* 주말·공휴일은 등원이 없어요 */
    const cur = d.getHours() * 60 + d.getMinutes();
    ALARMS.forEach((a) => {
      if (cur < a.hm || cur >= a.hm + a.grace) return;
      if (store.alarmDoneBySlot[a.key] === todayStr) return;
      store.alarmDoneBySlot[a.key] = todayStr;
      save();
      const rang = playAlarm(a.kind);
      showAlarmBanner(a.kind);
      if (!rang) toast("⏰ " + (a.kind === "warn" ? "오전 8시 20분" : "오전 8시") + "! 소리는 화면을 한 번 누르면 나요");
    });
  }
  /* 브라우저는 첫 터치·클릭 전에는 소리를 막습니다. 첫 조작에서 오디오를 한 번 깨워 둡니다. */
  function primeAudio() {
    const c = audio();
    if (!c) return;
    try { c.resume(); } catch (e) { /* noop */ }
    tone(1046.5, 0, 0.05, "sine", 0.0001);
  }
  function wireAudioUnlock() {
    const run = () => { primeAudio(); };
    ["pointerdown", "touchstart", "keydown"].forEach((ev) => {
      document.addEventListener(ev, run, { once: true, passive: true });
    });
  }

  /* ───────────── 이벤트 ───────────── */
  function wire() {
    $("#childGrid").addEventListener("click", (e) => {
      const tab = e.target.closest(".kid-tab");
      if (tab) {
        const cid = tab.closest(".kid").dataset.child;
        state.tab[cid] = tab.dataset.part;
        renderKid(cid);
        return;
      }
      const tile = e.target.closest(".tile");
      if (tile) {
        const kid = tile.closest(".kid");
        const body = tile.closest(".kid-body");
        if (!kid || !body) return;
        toggleStep(kid.dataset.child, body.dataset.part, tile.dataset.id, tile);
      }
    });

    $("#soundBtn").addEventListener("click", () => {
      setSound(!store.sound);
      if (store.sound) tapSound(true);
      toast(store.sound ? "효과음을 켰어요 🔊" : "효과음을 껐어요 🔇");
    });

    /* ⏰ 등원 알람 — 헤더 종버튼·설정 토글·두 가지 소리 테스트 */
    function toggleAlarm() {
      const on = !alarmOn();
      setAlarm(on);
      if (on) { primeAudio(); chimeStart(); toast("등원 알람을 켰어요 🔔 (평일 8:00 · 8:20)"); }
      else { toast("등원 알람을 껐어요 🔕"); }
    }
    const alarmBtn = $("#alarmBtn");
    if (alarmBtn) alarmBtn.addEventListener("click", toggleAlarm);
    const alarmSwitch = $("#alarmSwitch");
    if (alarmSwitch) alarmSwitch.addEventListener("click", toggleAlarm);
    [
      ["#alarmTestStart", "start", "8시 시작음"],
      ["#alarmTestWarn", "warn", "8시 20분 경고음"],
    ].forEach((t) => {
      const btn = $(t[0]);
      if (!btn) return;
      btn.addEventListener("click", () => {
        primeAudio();
        if (!playAlarm(t[1])) { toast("이 브라우저에서는 소리를 낼 수 없어요"); return; }
        showAlarmBanner(t[1]);
        toast(t[2] + " — 평일 8:00/8:20에 이렇게 울려요");
      });
    });
    const banner = $("#alarmBanner");
    if (banner) banner.addEventListener("click", hideAlarmBanner);
    $("#gearBtn").addEventListener("click", () => openGear(true));
    $("#closeGear").addEventListener("click", () => openGear(false));
    $("#gearPanel").addEventListener("click", (e) => {
      if (e.target.id === "gearPanel") { openGear(false); return; }
      const plus = e.target.closest("[data-plus]");
      const minus = e.target.closest("[data-minus]");
      if (plus) { adjustSticker(plus.dataset.plus, 1); return; }
      if (minus) { adjustSticker(minus.dataset.minus, -1); return; }
    });
    $("#soundSwitch").addEventListener("click", () => { setSound(!store.sound); if (store.sound) tapSound(true); });
    $("#focusSwitch").addEventListener("click", () => setFocus(!focusCfg().enabled));
    $("#offToday").addEventListener("click", () => {
      try { localStorage.setItem("familyFocusOffDate", todayStr); } catch (e) { /* noop */ }
      toast("오늘은 모아보드를 열어도 자동 전환하지 않아요");
    });
    $("#depToday").addEventListener("change", (e) => {
      const v = e.target.value;
      if (parseHM(v) == null) { e.target.value = hhmm(departureInfo().min); return; }
      store.departureByDate[todayStr] = hhmm(parseHM(v));
      save();
      renderCountdown();
      renderSettings();
      toast("오늘 출발 시각을 " + hhmm(parseHM(v)) + "로 맞췄어요 🚀");
    });
    function nudge(kind, delta) {
      const cur = kind === "today" ? departureInfo().min : (parseHM(store.departure) || DEFAULT_DEP_MIN);
      const next = Math.min(23 * 60 + 55, Math.max(0, cur + delta));
      if (kind === "today") store.departureByDate[todayStr] = hhmm(next);
      else store.departure = hhmm(next);
      save();
      renderCountdown();
      renderSettings();
      toast((kind === "today" ? "오늘 " : "평소 ") + "출발 시각 " + hhmm(next));
    }
    $("#depTodayMinus").addEventListener("click", () => nudge("today", -5));
    $("#depTodayPlus").addEventListener("click", () => nudge("today", 5));
    $("#depDefaultMinus").addEventListener("click", () => nudge("default", -5));
    $("#depDefaultPlus").addEventListener("click", () => nudge("default", 5));
    $("#depAuto").addEventListener("click", () => {
      delete store.departureByDate[todayStr];
      save();
      renderCountdown();
      renderSettings();
      toast("오늘은 자동 출발 시각으로 돌아갔어요");
    });
    $("#depDefault").addEventListener("change", (e) => {
      const v = e.target.value;
      if (parseHM(v) == null) { e.target.value = store.departure; return; }
      store.departure = hhmm(parseHM(v));
      save();
      renderCountdown();
      renderSettings();
      toast("평소 출발 시각을 " + store.departure + "로 저장했어요");
    });
    $("#resetBtn").addEventListener("click", () => {
      if (!window.confirm("오늘 체크를 모두 지울까요? (칭찬 스티커는 그대로 남아요)")) return;
      store.checks = blankChecks();
      save();
      renderKids();
      toast("오늘 체크를 초기화했어요");
    });
    $("#reloadBtn").addEventListener("click", async () => { await refreshData(true); openGear(false); });
    wireHomeLock();
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") openGear(false); });
  }

  /* ───────────── 🏠 전체 모아보드 — 2초 길게 누르기 잠금 ─────────────
     아이가 짧게 눌러 다른 페이지로 나가는 일을 막습니다.
     어른이 2초 이상 누르고 있으면 모아보드(index.html)로 이동합니다. */
  const HOME_HOLD_MS = 2000;
  function wireHomeLock() {
    const home = $("#homeLink");
    if (!home) return;

    let timer = null;
    let armed = false;      /* 지금 누르고 있는 중 */
    let navigated = false;  /* 이번 누름에서 이미 이동했는지 */
    let lastTouchEnd = 0;   /* 터치 뒤에 따라오는 마우스 이벤트를 무시하려고 */

    function cleanup() {
      if (timer) { clearTimeout(timer); timer = null; }
      armed = false;
      home.classList.remove("is-holding");
      home.removeAttribute("aria-busy");
    }
    function go() {
      if (navigated) return;
      navigated = true;
      cleanup();
      /* 모아보드로 돌아갈 때는 이번 세션 동안 자동 전환을 하지 않습니다 */
      try { sessionStorage.setItem("familyLivingBypass", "1"); } catch (e) { /* noop */ }
      location.assign(home.getAttribute("href") || "index.html");
    }
    function start() {
      if (armed || navigated) return;
      armed = true;
      home.classList.add("is-holding");
      home.setAttribute("aria-busy", "true");
      timer = setTimeout(go, HOME_HOLD_MS);
    }
    function end(showHint) {
      const wasArmed = armed;
      const fired = navigated;
      cleanup();
      if (!wasArmed || fired) return;
      if (showHint) toast("어른용: 2초 길게 누르면 전체 보드로 이동해요");
    }

    /* 터치 (태블릿) */
    home.addEventListener("touchstart", (e) => {
      if (e.touches && e.touches.length > 1) return;  /* 손가락 여러 개는 무시 */
      e.preventDefault();                             /* 길게 눌러도 메뉴·복사가 뜨지 않게 */
      start();
    }, { passive: false });
    home.addEventListener("touchend", (e) => {
      lastTouchEnd = Date.now();
      e.preventDefault();
      end(true);
    }, { passive: false });
    home.addEventListener("touchcancel", () => {
      lastTouchEnd = Date.now();
      end(false);
    });

    /* 마우스 (PC·태블릿 트랙패드) */
    home.addEventListener("mousedown", (e) => {
      if (Date.now() - lastTouchEnd < 800) return;
      if (typeof e.button === "number" && e.button !== 0) return;
      e.preventDefault();
      start();
    });
    home.addEventListener("mouseup", () => {
      if (Date.now() - lastTouchEnd < 800) return;
      end(true);
    });
    home.addEventListener("mouseleave", () => end(false));

    /* 길게 눌러도 브라우저 메뉴(새 탭에서 열기 등)가 뜨지 않게 */
    home.addEventListener("contextmenu", (e) => e.preventDefault());

    /* 짧은 탭·클릭으로는 절대 이동하지 않습니다 (키보드·보조기기만 예외) */
    home.addEventListener("click", (e) => {
      e.preventDefault();
      if (e.detail === 0) go();
    });
  }

  /* ───────────── 시작 ───────────── */
  try {
    data = await fetchData();
  } catch (e) {
    $("#childGrid").innerHTML = '<div class="lv-error">보드 데이터를 불러오지 못했어요.<br><small>data/board-data.json 파일을 확인해 주세요.</small></div>';
    $("#wxLine").textContent = "날씨 정보를 불러오지 못했어요";
    return;
  }
  derive();
  todayStr = iso(new Date());
  store = loadStore();
  setSound(store.sound);
  renderAlarmBtn();
  wireAudioUnlock();
  renderAll();
  wire();
  tick();
  setInterval(tick, 1000);
  setInterval(() => { if (iso(new Date()) !== todayStr) dayRollover(); }, 20000);
  setInterval(() => refreshData(false), 10 * 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (iso(new Date()) !== todayStr) dayRollover();
    else refreshData(false);
  });
})();
