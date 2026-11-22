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
    /* 유치원 휴원일(재량휴원일·방학 등) — 어느 키로 들어와도 읽습니다 */
    CLOSED = closedDaysOf(data.closedDays || data.restDays || data.휴원일 || null);
  }

  /* ───────────── 검증용(부모님은 쓰지 않아요) ─────────────
     주소에 debug=1 이 있을 때만 동작합니다.
       · living.html?debug=1               → 창에 __livingDebug 를 열어 오늘 판별·체크리스트를 확인
       · living.html?debug=1&now=2026-11-21T08:00:20  → 시계를 그 시각부터 흐르게 해
         주말·공휴일 8:00 에 알람이 울리지 않는지, 평일 8:00 에는 울리는지 확인합니다. */
  const QS = new URLSearchParams(location.search || "");
  const DEBUG = QS.get("debug") === "1";
  if (DEBUG) {
    const fake = QS.get("now");
    const at = fake ? Date.parse(fake) : NaN;
    if (Number.isFinite(at)) {
      const Real = Date;
      const off = at - Real.now();
      class FakeDate extends Real {
        constructor(...a) { if (a.length) super(...a); else super(Real.now() + off); }
        static now() { return Real.now() + off; }
      }
      window.Date = FakeDate;
    }
  }

  /* ───────────── 날짜·요일 도우미 ───────────── */
  let todayStr = iso(new Date());
  const weekdayKey = (ds) => WDKEY[parseISO(ds).getDay()];

  /* 쉬는 날 판별 — ① board-data 의 휴원일·공휴일 ② 내장 2026~2028 법정공휴일·대체공휴일 표 ③ 토·일
     (assets/kr-holidays.js → window.KRHolidays, 없으면 토·일만) */
  const KR = (typeof window !== "undefined" && window.KRHolidays) || null;
  let CLOSED = {};   /* board-data.json 의 휴원일(closedDays / restDays) */
  function closedDaysOf(raw) {
    const out = {};
    if (Array.isArray(raw)) {
      raw.forEach((x) => {
        const ds = typeof x === "string" ? x : (x && (x.date || x.ds));
        if (ds) out[String(ds).slice(0, 10)] = (x && x.name) || "휴원일";
      });
    } else if (raw && typeof raw === "object") {
      Object.keys(raw).forEach((k) => { out[k] = (raw[k] && raw[k].name) || "휴원일"; });
    }
    return out;
  }
  function isRestDay(ds) {
    if (!ds) return false;
    if (CLOSED[ds] || HOLIDAYS[ds]) return true;
    if (KR) return KR.isRestDay(ds);
    const w = parseISO(ds).getDay();
    return w === 0 || w === 6;
  }
  /* 쉬는 날 이름 — 휴원일 > board-data 공휴일 > 내장 공휴일 표 > '토요일/일요일' */
  function restName(ds) {
    if (CLOSED[ds]) return CLOSED[ds];
    if (HOLIDAYS[ds] && HOLIDAYS[ds].name) return HOLIDAYS[ds].name;
    if (KR && KR.nameOf(ds)) return KR.nameOf(ds);
    const w = parseISO(ds).getDay();
    return w === 0 ? "일요일" : w === 6 ? "토요일" : "";
  }

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

  /* 체크리스트 — 등원일(평일)과 쉬는 날(주말·공휴일)의 루틴이 다릅니다.
     · 등원일 아침: 세수·양치 → 옷 → (다은)머리 → 아침 → 가방·물통 → (도서대여) → 출발
     · 등원일 저녁: 손 씻기 → 가방 정리 → 오늘의 놀이 → 엘리하이 학습 → 정리 → 씻고 로션 → 옷 갈아입기 → 양치
     · 쉬는 날 아침: 세수·양치 → 옷 → (다은)머리 → 아침 → 책상 정리 → 아침 책 읽기
     · 쉬는 날 저녁: 손 씻기 → 가족 놀이 → 저녁 책 읽기 → 정리 → 씻고 로션 → 옷 갈아입기 → 양치 */
  function buildChecklists(cid, ds) {
    const rest = isRestDay(ds);

    /* 아침 준비 — 머리 빗기·묶기는 다은이만 */
    const morning = [
      { id: "wash", ill: "tile-wash", t: "세수·양치하기" },
      { id: "clothes", ill: "tile-clothes", t: "옷 입기" },
    ];
    if (cid === "daeun") morning.push({ id: "hair", ill: "tile-hair", t: "머리 빗기·묶기" });
    morning.push({ id: "meal", ill: "tile-meal", t: "아침 먹기" });
    if (rest) {
      /* 쉬는 날에는 가방·물통·도서대여·출발 대신 집안 루틴 */
      morning.push({ id: "desk", ill: "tile-tidy", t: "책상 정리하기" });
      morning.push({ id: "am-read", ill: "tile-fun-read", t: "아침 책 읽기" });
    } else {
      morning.push({ id: "bag", ill: "tile-bag", t: "가방·물통" });
      if (bookForToday(cid, ds)) morning.push({ id: "book", ill: "tile-book", t: "도서대여 가방" });
      morning.push({ id: "shoes", ill: "tile-shoes", t: "신발 신고 출발!" });
    }

    /* 저녁 루틴 */
    const evening = [{ id: "hands", ill: "tile-hands", t: "손 씻기" }];
    if (rest) {
      /* 쉬는 날 — 학원·엘리하이 학습은 없고, 상의해서 정하는 가족 놀이와 책 읽기 */
      evening.push({ id: "family", ill: "tile-fun-board", t: "가족 놀이!" });
      evening.push({ id: "pm-read", ill: "tile-fun-read", t: "저녁 책 읽기" });
    } else {
      const act = eveningActivity(ds);
      evening.push({ id: "unpack", ill: "tile-unpack", t: "가방 정리" });
      evening.push(act ? { id: "fun", ill: ILL_FUN[act.name] || "tile-fun-free", t: act.name + " 놀이!" } : { id: "fun", ill: "tile-fun-free", t: "자유놀이!" });
      evening.push({ id: "study", ill: "tile-study", t: "엘리하이 오늘의 학습" });
    }
    evening.push({ id: "tidy", ill: "tile-tidy", t: "놀이한 거 정리하기" });
    evening.push({ id: "shower", ill: "tile-shower", t: "씻고 로션 바르기" });
    evening.push({ id: "pajamas", ill: "tile-pajamas", t: "옷 갈아입기" });
    evening.push({ id: "brush", ill: "tile-brush", t: "양치하고 자기" });
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
    if (isRestDay(ds)) {
      const nm = restName(ds);
      chips.push({ cls: "warn", text: "🏖️ " + (hol && hol.name ? hol.name : nm) + " · 쉬는 날(등원 없음)" });
    }

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
    const icoEl = $(".cd-ico");

    if (isRestDay(todayStr)) {
      /* 주말·공휴일 — 등원이 없으니 남은 시간·출발 압박 대신 쉬는 날 문구 */
      box.classList.add("is-done");
      if (icoEl) icoEl.textContent = "🌴";
      titleEl.textContent = "주말·공휴일";
      tEl.textContent = "쉬는 날";
      uEl.textContent = "";
      mEl.textContent = (restName(todayStr) || "주말") + " · 등원 없이 푹 쉬어요";
      fEl.style.width = "100%";
      pct = 100;
      if (track) track.setAttribute("aria-valuenow", "100");
      return;
    }
    if (icoEl && icoEl.textContent !== "🚀") icoEl.textContent = "🚀";

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
        (isRestDay(todayStr) && part === "morning" ? '<p class="kid-rest">🌴 쉬는 날 아침 루틴이에요 · 천천히 해도 좋아요</p>' : "") +
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

  /* ───────────── ➕ 더하기·빼기 놀이 (전체화면) ─────────────
     승민(5세)은 교재의 **덧셈구구(합이 9까지)** 와 **뺄셈구구(9 이내)** 안에서만 문제가 나옵니다.
       · 덧셈: 1 + 0 … 9 + 0  (a = 1~9, b = 0~(9−a), 답 1~9)
       · 뺄셈: 1 − 1 … 9 − 9  (a = 1~9, b = 1~a, 답 0~8)
       · 덧셈·뺄셈을 반반 섞고, 바로 앞 문제와 같은 식은 다시 내지 않습니다.
     다은(7세)은 **받아올림 없는 두 자릿수 덧셈**과 **받아내림 없는 두 자릿수 뺄셈**입니다.
     두 단계 모두 규칙은 모아보드와 함께 쓰는 공통 엔진(assets/math-engine.js → LEVEL_CONFIG)에 있습니다.
     보기 4개 중 정답 고르기, 맞히면 1.1초·틀리면 1.9초 뒤 다음 문제.
     거실 태블릿에서 승민이가 직접 누를 수 있게 숫자·보기를 화면 크기에 맞춰 크게 띄웁니다.
     보드 데이터를 못 불러와도 놀이는 열리도록 데이터 요청 전에 먼저 연결합니다. */
  const gp = { mode: "seungmin", open: false, answer: null, right: 0, total: 0, streak: 0, busy: false, timer: null, last: "" };
  function gpSound(freqs, gap, dur, type, vol) {
    if (store && store.sound === false) return;   /* ⚙️ 효과음 꺼짐을 그대로 따릅니다 */
    if (!audio()) return;
    freqs.forEach((f, i) => tone(f, i * gap, dur, type, vol));
  }
  function gpTabs() {
    document.querySelectorAll("#gamePanel .gp-tab").forEach((t) => {
      const on = t.dataset.mode === gp.mode;
      t.classList.toggle("is-on", on);
      t.setAttribute("aria-pressed", String(on));
    });
  }
  function gpNew() {
    clearTimeout(gp.timer);
    /* 문제 규칙은 모아보드와 **같은 엔진** assets/math-engine.js 한 곳에 있습니다.
       (승민 5세 → 덧셈구구 합 9까지 · 뺄셈구구 9 이내 / 다은 7세 → 받아올림·내림 없는 두 자리)
       여기서는 엔진이 만든 문제를 화면에 그리고 채점만 합니다. */
    const eng = window.FamilyMathEngine;
    if (!eng) { toast("수학 문제를 불러오지 못했어요 — 새로고침해 주세요"); return; }
    const q = eng.generateQuestion(gp.mode, gp.last);
    gp.last = q.key;
    gp.answer = q.answer;
    gp.busy = false;
    const a = q.a, b = q.b, op = q.op;
    const arr = q.options;
    const body = $("#gpBody");
    if (!body) return;
    body.innerHTML =
      '<div class="gq-box" id="gqBox">' +
        '<span class="gq-burst" id="gqBurst" aria-hidden="true">🎉</span>' +
        '<div class="gq-text">' + a + '<span class="op">' + (op === "+" ? "+" : "−") + "</span>" + b + " = ?</div>" +
        '<div class="gq-opts">' + arr.map((o) => '<button class="gopt" type="button" data-v="' + o + '">' + o + "</button>").join("") + "</div>" +
        '<div class="gq-fb" id="gqFb" role="status" aria-live="polite">정답을 골라 보세요!</div>' +
      "</div>" +
      '<div class="gp-foot">' +
        '<span class="gp-streak" id="gpStreak">' + (gp.streak > 1 ? "연속 " + gp.streak + "문제! 🔥" : "천천히 골라도 좋아요") + "</span>" +
        '<button class="gp-next" id="gpNext" type="button">다음 문제 →</button>' +
      "</div>";
    body.querySelectorAll(".gopt").forEach((o) => o.addEventListener("click", () => gpAnswer(Number(o.dataset.v), o)));
    $("#gpNext").addEventListener("click", gpNew);
  }
  function gpAnswer(v, btn) {
    if (gp.busy) return;
    gp.busy = true;
    const box = $("#gqBox"), fb = $("#gqFb");
    document.querySelectorAll("#gpBody .gopt").forEach((b) => (b.disabled = true));
    gp.total++;
    const ok = v === gp.answer;
    if (ok) {
      btn.classList.add("correct");
      box.classList.add("pop");
      const burst = $("#gqBurst");
      if (burst) burst.classList.add("on");
      fb.textContent = "정답! 정말 잘했어요 🎉";
      gp.right++;
      gp.streak++;
      gpSound([880, 1174.66, 1567.98], 0.09, 0.34, "triangle", 0.1);
    } else {
      btn.classList.add("wrong");
      box.classList.add("shake");
      const right = document.querySelector('#gpBody .gopt[data-v="' + gp.answer + '"]');
      if (right) right.classList.add("correct");
      fb.textContent = "앗, 다시 해볼까요? 정답은 " + gp.answer + "!";
      fb.classList.add("wrong");
      gp.streak = 0;
      gpSound([392], 0, 0.22, "sine", 0.09);
    }
    $("#gpRight").textContent = gp.right;
    $("#gpTotal").textContent = gp.total;
    const st = $("#gpStreak");
    if (st) st.textContent = ok ? (gp.streak > 1 ? "연속 " + gp.streak + "문제! 🔥" : "잘했어요! ⭐") : "괜찮아요, 다음 문제!";
    gp.timer = setTimeout(gpNew, ok ? 1100 : 1900);
  }
  function gpOpen() {
    const panel = $("#gamePanel");
    if (!panel) return;
    gp.mode = "seungmin";   /* 승민이가 눌렀을 때 언제나 자기 놀이(덧셈구구·뺄셈구구)로 시작 — 다은이는 안에서 탭 */
    gp.last = "";
    gpTabs();
    panel.hidden = false;
    gp.open = true;
    document.body.classList.add("is-playing");
    primeAudio();          /* 태블릿에서 누른 김에 소리 잠금을 풀어 둡니다 */
    gpNew();
  }
  function gpClose() {
    const panel = $("#gamePanel");
    if (!panel || !gp.open) return;
    panel.hidden = true;
    gp.open = false;
    clearTimeout(gp.timer);
    gp.timer = null;
    document.body.classList.remove("is-playing");
    const btn = $("#playBtn");
    if (btn) btn.focus({ preventScroll: true });
  }
  function initGame() {
    const panel = $("#gamePanel"), btn = $("#playBtn");
    if (!panel || !btn) return;
    btn.addEventListener("click", gpOpen);
    const close = $("#gpClose");
    if (close) close.addEventListener("click", gpClose);
    document.querySelectorAll("#gamePanel .gp-tab").forEach((t) =>
      t.addEventListener("click", () => {
        if (gp.mode === t.dataset.mode) return;
        gp.mode = t.dataset.mode;
        gpTabs();
        gpNew();
      })
    );
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && gp.open) gpClose(); });
  }

  /* ───────────── 📖 오늘의 읽을거리 (전체화면 모달 · 속담/영단어 2탭) ─────────────
     data/board-data.json 의 readingPoster 를 읽어 두 탭을 그립니다.
       "readingPoster": {
         "date": "2026-11-22",
         "proverb": { badge, title, subtitle, summary,
                      panels:[{num,speech,caption,image}], meaning, promise },
         "word":    { badge, word, meaning, bannerImage, audio,
                      examples:[{num,en,ko,audio,highlight}], tip }
       }
     · 속담 탭 — 제목·뜻·4컷 만화·오늘의 약속 (기본 탭)
     · 영단어 탭 — 큰 단어/예문을 터치하면 원어민 발음 MP3 재생 + 반짝임,
       🔊 영어만 듣기 = 단어 → 예문1 → 2 → 3 (0.7초 간격, ⏹ 멈춤 토글)
       🎬 영상으로 듣기 = 한국어 설명 + 원어민 영어 (탭 안에서 재생, 끝나면 그림 화면 복귀)
     · MP3 가 없거나 재생에 실패하면 window.speechSynthesis(en-US, rate 0.9) 로 자동 대체
     proverb·word 가 모두 비어 있으면 안내 카드를 띄웁니다. */
  const RD_ICO = "assets/reading/ico/";
  const rd = { open: false, tab: "proverb" };
  const rda = { audio: null, seq: false, seqId: 0, timer: 0, el: null, sayId: 0 };

  function readingData() {
    const rp = (data && data.readingPoster) || null;
    if (!rp) return { date: "", title: "", sub: "", img: "", proverb: null, word: null, stale: false };
    if (typeof rp === "string") return { date: "", title: "", sub: "", img: rp, proverb: null, word: null, stale: false };
    const date = rp.date ? String(rp.date).slice(0, 10) : "";
    const proverb = rp.proverb && typeof rp.proverb === "object" ? rp.proverb : null;
    const word = rp.word && typeof rp.word === "object" ? rp.word : null;
    return {
      date: date,
      title: rp.title || (proverb && proverb.title) || "",
      sub: rp.subtitle || rp.sub || "",
      img: rp.image || rp.src || rp.url || "",
      proverb: proverb,
      word: word,
      stale: !!date && date !== todayStr,
    };
  }
  function renderReadingCard() {
    const p = readingData();
    const sub = $("#readSub"), btn = $("#readBtn");
    if (sub) sub.textContent = p.title || "오늘의 포스터 보기";
    if (btn) {
      const what = p.proverb && p.word ? "오늘의 속담·영단어" : p.proverb ? "오늘의 속담" : p.word ? "오늘의 영단어" : "오늘의 포스터";
      btn.title = "오늘의 읽을거리 · " + what + " 화면 가득 보기";
    }
  }
  function readingEmptyHTML() {
    return (
      '<div class="rd-empty">' +
        '<div class="rd-empty-ico" aria-hidden="true">📖</div>' +
        '<h3>오늘의 읽을거리를 준비하고 있어요</h3>' +
        '<p>매일 아침 새 읽을거리가 이 자리에 <b>화면 가득</b> 떠요.<br>속담 4컷 만화 · 터치로 듣는 그림 영단어</p>' +
        '<span class="rd-empty-tip">🌱 읽을거리가 확정되면 바로 여기에 나타나요</span>' +
      "</div>"
    );
  }

  /* 예문 속에 오늘의 단어(또는 highlight 낱말)만 노랗게 표시 */
  function rdHighlight(text, list) {
    const s = String(text == null ? "" : text);
    const words = (Array.isArray(list) ? list : []).filter(Boolean).map(String);
    if (!words.length) return esc(s);
    const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    let re;
    try { re = new RegExp("\\b(" + pattern + ")\\b", "g"); } catch (e) { return esc(s); }
    let out = "", last = 0, m;
    while ((m = re.exec(s))) {
      out += esc(s.slice(last, m.index)) + '<span class="hl">' + esc(m[0]) + "</span>";
      last = m.index + m[0].length;
      if (re.lastIndex === m.index) re.lastIndex++;
    }
    return out + esc(s.slice(last));
  }

  function rdProverbHTML(pv) {
    /* 컷마다 한국어 이야기 MP3(proverb-YYYYMMDD-pN.mp3)를 붙여, 그림을 눌러도 들을 수 있게 합니다.
       왼쪽 영역(배지·제목·한 줄 요약)을 누르면 속담 제목 음성(pv.audio),
       뜻 카드는 pv.meaningAudio, 약속 카드는 약속 글을 한국어 음성으로 읽어 줍니다. */
    const pvTitleText = [pv.title, pv.subtitle, pv.summary].filter(Boolean).join(". ");
    const panels = (Array.isArray(pv.panels) ? pv.panels : []).slice(0, 4).map((p, i) => {
      const n = p.num != null ? p.num : i + 1;
      const koText = [p.speech, p.caption].filter(Boolean).join(" ");
      return (
        '<div class="pv-panel is-tappable" role="button" tabindex="0"' +
          ' data-rd-ko-audio="' + esc(p.audio || "") + '" data-rd-ko-text="' + esc(koText) + '"' +
          ' aria-label="' + esc(n + "컷 이야기 듣기 · " + koText) + '">' +
          '<div class="pv-ph">' +
            (p.image ? '<img src="' + esc(p.image) + '" alt="' + esc((pv.title || "속담") + " " + n + "컷 만화") + '" decoding="async">' : "") +
            '<div class="pv-num">' + esc(n) + "</div>" +
            (p.speech ? '<div class="pv-bub b' + (i + 1) + '">' + esc(p.speech) + "</div>" : "") +
            '<span class="pv-spk" aria-hidden="true">🔊</span>' +
          "</div>" +
          '<div class="pv-cap">' + esc(p.caption || "") + "</div>" +
        "</div>"
      );
    }).join("");
    const minis =
      (pv.meaning ? '<div class="pv-mini a is-tappable" role="button" tabindex="0" data-rd-ko-audio="' + esc(pv.meaningAudio || "") + '" data-rd-ko-text="' + esc(pv.meaning) + '" aria-label="속담 뜻풀이 듣기"><h4><img src="' + RD_ICO + 'speech.png" alt="">이런 뜻이에요</h4><p>' + esc(pv.meaning) + "</p></div>" : "") +
      (pv.promise ? '<div class="pv-mini b is-tappable" role="button" tabindex="0" data-rd-ko-text="' + esc(pv.promise) + '" aria-label="오늘의 약속 듣기"><h4><img src="' + RD_ICO + 'star.png" alt="">오늘의 약속</h4><p>' + esc(pv.promise) + "</p></div>" : "");
    return (
      '<section class="rd-poster is-proverb" aria-label="오늘의 속담">' +
        '<div class="pv-left is-tappable" role="button" tabindex="0"' +
          ' data-rd-ko-audio="' + esc(pv.audio || "") + '" data-rd-ko-text="' + esc(pvTitleText) + '"' +
          ' aria-label="' + esc("속담 제목과 뜻 듣기 · " + pvTitleText) + '">' +
          '<div class="pv-spark" aria-hidden="true"><img src="' + RD_ICO + 'sparkle.png" alt=""><img src="' + RD_ICO + 'star.png" alt=""><img src="' + RD_ICO + 'sparkle.png" alt=""></div>' +
          '<span class="rd-badge"><img src="' + RD_ICO + 'book.png" alt="">' + esc(pv.badge || "오늘의 속담") + "</span>" +
          '<h3 class="pv-title"><em>' + esc(pv.title || "") + "</em></h3>" +
          (pv.subtitle ? '<p class="pv-sub">' + esc(pv.subtitle) + "</p>" : "") +
          (pv.summary ? '<div class="pv-summary"><img src="' + RD_ICO + 'speech.png" alt=""><span>' + esc(pv.summary) + "</span></div>" : "") +
          (minis ? '<div class="pv-minis">' + minis + "</div>" : "") +
          '<span class="pv-tap-hint" aria-hidden="true">👆 그림도, 제목도 누르면 이야기를 들려줘요</span>' +
        "</div>" +
        '<div class="pv-right">' +
          '<div class="rd-sec"><img src="' + RD_ICO + 'palette.png" alt=""><b>4컷 만화로 배워요</b><span class="line"></span>' +
            '<button class="rd-play" type="button" data-rd-play="proverb" aria-label="속담 4컷을 영상처럼 크게 보면서 한국어 이야기 듣기"><span aria-hidden="true">🎬</span> 영상으로 듣기</button>' +
          "</div>" +
          '<div class="pv-comic">' + panels + "</div>" +
        "</div>" +
      "</section>"
    );
  }

  function rdWordHTML(wd) {
    const word = String(wd.word || "");
    /* 왼쪽 영역(그림 배너·뜻 칩·기억 쏙 한마디)을 누르면 한국어 설명 음성을 읽어 줍니다.
       큰 영어 단어와 예문 카드는 지금처럼 원어민 영어 발음이 먼저입니다. */
    const koIntroAudio = wd.koIntroAudio || "";
    const koIntroText = wd.koIntroText || ("오늘의 영단어는 " + word + (wd.meaning ? ", " + wd.meaning : "") + "예요. 그림을 보면서 같이 연습해 볼까요?");
    const koTipText = wd.koTipText || wd.tip || "";
    const letters = word.split("").map((ch, i) => '<i class="w' + ((i % 4) + 1) + '">' + esc(ch) + "</i>").join("");
    const examples = (Array.isArray(wd.examples) ? wd.examples : []).map((e, i) => {
      const n = e.num != null ? e.num : i + 1;
      const en = rdHighlight(e.en, (Array.isArray(e.highlight) && e.highlight.length ? e.highlight : [word]));
      return (
        '<button class="wd-ex" type="button"' +
          ' data-rd-audio="' + esc(e.audio || "") + '" data-rd-text="' + esc(e.en || "") + '"' +
          ' aria-label="' + esc((e.en || "") + " · " + (e.ko || "") + " 발음 듣기") + '">' +
          '<span class="n" aria-hidden="true">' + esc(n) + "</span>" +
          '<span class="txt"><span class="en">' + en + '</span><span class="ko">' + esc(e.ko || "") + "</span></span>" +
          '<span class="spk" aria-hidden="true">🔊</span>' +
        "</button>"
      );
    }).join("");
    return (
      '<section class="rd-poster is-word" aria-label="오늘의 영단어">' +
        '<div class="wd-left" data-rd-ko-audio="' + esc(koIntroAudio) + '" data-rd-ko-text="' + esc(koIntroText) + '">' +
          '<span class="rd-badge"><img src="' + RD_ICO + 'sprout.png" alt="">' + esc(wd.badge || "오늘의 영단어") + "</span>" +
          '<button class="wd-hero" type="button"' +
            ' data-rd-audio="' + esc(wd.audio || "") + '" data-rd-text="' + esc(word) + '"' +
            ' aria-label="' + esc(word + " 발음 듣기") + '">' +
            '<img src="' + RD_ICO + 'sprout.png" alt="">' +
            '<span class="wd-word">' + letters + "</span>" +
            '<img src="' + RD_ICO + 'sun.png" alt="">' +
          "</button>" +
          '<div class="wd-mean-row">' +
            (wd.meaning ? '<span class="wd-mean is-tappable" role="button" tabindex="0"' +
              ' data-rd-ko-audio="' + esc(koIntroAudio) + '" data-rd-ko-text="' + esc(koIntroText) + '"' +
              ' aria-label="' + esc(wd.meaning + " 한국어 설명 듣기") + '">' + esc(wd.meaning) + "</span>" : "") +
            '<span class="wd-hint">👆 단어는 영어로, 그림은 한국어로 들려줘요</span>' +
          "</div>" +
          (wd.bannerImage ? '<div class="wd-banner is-tappable" role="button" tabindex="0"' +
            ' data-rd-ko-audio="' + esc(koIntroAudio) + '" data-rd-ko-text="' + esc(koIntroText) + '"' +
            ' aria-label="' + esc("그림으로 듣는 한국어 설명 · " + (wd.meaning || word)) + '">' +
            '<img src="' + esc(wd.bannerImage) + '" alt="' + esc(word + (wd.meaning ? " 그림: " + wd.meaning : " 낱말 그림")) + '" decoding="async"></div>' : "") +
          (wd.tip ? '<div class="wd-tip is-tappable" role="button" tabindex="0"' +
            ' data-rd-ko-audio="' + esc(wd.koTipAudio || "") + '" data-rd-ko-text="' + esc(koTipText) + '"' +
            ' aria-label="' + esc("기억 쏙 한마디 한국어 설명 듣기 · " + koTipText) + '">' +
            '<img src="' + RD_ICO + 'bulb.png" alt=""><div><b>기억 쏙 한마디</b><p>' + rdHighlight(wd.tip, [word]) + "</p></div></div>" : "") +
        "</div>" +
        '<div class="wd-right">' +
          '<div class="rd-sec"><img src="' + RD_ICO + 'book.png" alt=""><b>따라 읽어 봐요</b><span class="line"></span></div>' +
          '<div class="wd-tools">' +
            '<button class="wd-all" id="rdListenAll" type="button" aria-pressed="false" aria-label="영어만 듣기 — 단어와 예문 3개를 원어민 발음으로 이어서 듣기"><span aria-hidden="true">🔊</span> 영어만 듣기</button>' +
            '<button class="rd-play is-word" type="button" data-rd-play="word" aria-label="오늘의 영단어를 한국어 설명과 원어민 발음이 함께 나오는 영상으로 듣기"><span aria-hidden="true">🎬</span> 영상으로 듣기</button>' +
            '<span class="wd-tools-note">단어·예문은 원어민 발음, 그림·뜻·한마디는 한국어 설명이 나와요</span>' +
          "</div>" +
          '<div class="wd-cards">' + examples + "</div>" +
        "</div>" +
      "</section>"
    );
  }

  function renderReadingStage() {
    const stage = $("#rdStage");
    if (!stage) return;
    const p = readingData();
    stage.classList.toggle("is-card", !(p.proverb || p.word));
    if (p.proverb || p.word) {
      stage.innerHTML = (p.proverb ? rdProverbHTML(p.proverb) : "") + (p.word ? rdWordHTML(p.word) : "");
      setReadingTab(p.proverb ? "proverb" : "word");
      return;
    }
    if (p.img) {
      stage.innerHTML = '<img class="rd-img" id="rdImg" src="' + esc(p.img) + '" alt="' + esc(p.title || "오늘의 읽을거리 포스터") + '">';
      const img = $("#rdImg");
      if (img) img.addEventListener("error", () => { stage.classList.add("is-card"); stage.innerHTML = readingEmptyHTML(); }, { once: true });
      return;
    }
    stage.innerHTML = readingEmptyHTML();
  }

  /* ── 탭 ── */
  function setReadingTab(tab) {
    const panel = $("#readingPanel");
    if (!panel) return;
    /* 탭을 직접 고르면 재생 중인 영상을 멈추고 그 탭의 그림 화면으로 돌아갑니다 */
    if (th.open) thClose(true);
    const hasPv = !!$("#rdStage .rd-poster.is-proverb");
    const hasWd = !!$("#rdStage .rd-poster.is-word");
    let next = tab === "word" ? "word" : "proverb";
    if (next === "word" && !hasWd) next = "proverb";
    if (next === "proverb" && !hasPv && hasWd) next = "word";
    if (rd.tab !== next) rdHardStop();
    rd.tab = next;
    panel.dataset.tab = next;
    document.querySelectorAll("#readingPanel .rd-tab").forEach((b) => {
      const on = b.dataset.tab === next;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    });
    const stage = $("#rdStage");
    if (stage) stage.setAttribute("aria-labelledby", next === "word" ? "rdTabWord" : "rdTabProverb");
  }

  /* ── 발음 재생 (MP3 → 실패하면 Web Speech) — lang 로 한국어(ko-KR)·영어(en-US) 선택 ── */
  const rdSpeak = (text, cb, lang) => {
    const S = window.speechSynthesis;
    if (!S || !window.SpeechSynthesisUtterance || !text) { if (cb) cb(); return; }
    const L = lang || "en-US";
    const head = L.slice(0, 2).toLowerCase();
    try {
      S.cancel();
      const u = new SpeechSynthesisUtterance(String(text));
      u.lang = L;
      u.rate = head === "ko" ? 0.94 : 0.9;
      u.pitch = 1;
      const voices = (S.getVoices() || []).filter((v) => new RegExp("^" + head, "i").test(v.lang || ""));
      const pick = voices.filter((v) => String(v.lang || "").toLowerCase().indexOf(L.toLowerCase()) === 0)[0] || voices[0];
      if (pick) u.voice = pick;
      let done = false;
      let guard = 0;
      const once = () => { if (done) return; done = true; clearTimeout(guard); if (cb) cb(); };
      guard = setTimeout(once, Math.max(1600, String(text).length * 140) + 2500);
      u.onend = once;
      u.onerror = once;
      S.speak(u);
    } catch (e) { if (cb) cb(); }
  };

  function rdClearSaying() {
    if (rda.el) { rda.el.classList.remove("is-saying"); rda.el = null; }
  }
  function rdListenBtn(playing) {
    const b = $("#rdListenAll");
    if (!b) return;
    b.classList.toggle("is-playing", !!playing);
    b.setAttribute("aria-pressed", playing ? "true" : "false");
    b.innerHTML = playing ? '<span aria-hidden="true">⏹</span> 멈춤' : '<span aria-hidden="true">🔊</span> 영어만 듣기';
  }
  /* 완전 정지 — 닫기·탭 전환·⏹ 멈춤 */
  function rdHardStop() {
    rda.seqId++;
    rda.seq = false;
    clearTimeout(rda.timer);
    rda.timer = 0;
    rda.sayId++;
    if (rda.audio) {
      try { rda.audio.pause(); rda.audio.currentTime = 0; } catch (e) { /* noop */ }
      rda.audio.onended = null;
      rda.audio.onerror = null;
    }
    if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch (e) { /* noop */ } }
    rdClearSaying();
    rdListenBtn(false);
  }
  /* 한 조각 재생 — el 에 반짝임, 끝나면 onDone (lang: 한국어 이야기는 "ko-KR") */
  function rdSay(el, src, text, onDone, lang) {
    const id = ++rda.sayId;
    rdClearSaying();
    if (el) { el.classList.add("is-saying"); rda.el = el; }
    let done = false;
    const finish = () => {
      if (done || id !== rda.sayId) return;
      done = true;
      if (el) el.classList.remove("is-saying");
      if (rda.el === el) rda.el = null;
      if (onDone) onDone();
    };
    if (!src) { rdSpeak(text, finish, lang); return; }
    if (!rda.audio) {
      rda.audio = new Audio();
      rda.audio.preload = "auto";
    }
    const a = rda.audio;
    a.onended = finish;
    a.onerror = () => { a.onerror = null; rdSpeak(text, finish, lang); };
    try {
      a.src = src;
      a.currentTime = 0;
    } catch (e) { rdSpeak(text, finish, lang); return; }
    let pr = null;
    try { pr = a.play(); } catch (e) { a.onerror = null; rdSpeak(text, finish, lang); return; }
    if (pr && typeof pr.catch === "function") {
      pr.catch(() => { if (id !== rda.sayId) return; a.onerror = null; rdSpeak(text, finish, lang); });
    }
  }
  function rdSeqItems() {
    const out = [];
    const hero = $("#rdStage .wd-hero");
    if (hero) out.push({ el: hero, src: hero.dataset.rdAudio || "", text: hero.dataset.rdText || "" });
    document.querySelectorAll("#rdStage .wd-ex").forEach((b) => {
      out.push({ el: b, src: b.dataset.rdAudio || "", text: b.dataset.rdText || "" });
    });
    return out;
  }
  function rdPlayAll() {
    if (rda.seq) { rdHardStop(); return; }
    rdHardStop();
    const items = rdSeqItems();
    if (!items.length) return;
    const gen = rda.seqId;
    rda.seq = true;
    rdListenBtn(true);
    const step = (i) => {
      if (!rda.seq || gen !== rda.seqId) return;
      if (i >= items.length) { rda.seq = false; rdListenBtn(false); return; }
      const it = items[i];
      rda.timer = 0;
      rdSay(it.el, it.src, it.text, () => {
        if (!rda.seq || gen !== rda.seqId) return;
        rda.timer = setTimeout(() => step(i + 1), 700);
      });
    };
    step(0);
  }

  function openReading() {
    const panel = $("#readingPanel");
    if (!panel) return;
    if (th.open) thClose(true);
    const p = readingData();
    const sEl = $("#rdSub");
    if (sEl) {
      let label = "";
      if (p.stale) label = "지난 읽을거리 · " + p.date;
      else if (p.date) {
        const d = parseISO(p.date);
        label = "오늘 · " + (d.getMonth() + 1) + "월 " + d.getDate() + "일";
      }
      sEl.textContent = label;
      sEl.classList.toggle("is-stale", !!p.stale);
    }
    renderReadingStage();
    panel.hidden = false;
    rd.open = true;
    document.body.classList.add("is-reading");
    primeAudio();
    const c = $("#rdClose");
    if (c) c.focus({ preventScroll: true });
  }
  function closeReading() {
    const panel = $("#readingPanel");
    if (!panel || !rd.open) return;
    if (th.open) thClose(true);
    rdHardStop();
    panel.hidden = true;
    rd.open = false;
    document.body.classList.remove("is-reading");
    const btn = $("#readBtn");
    if (btn) btn.focus({ preventScroll: true });
  }
  function initReading() {
    const btn = $("#readBtn"), panel = $("#readingPanel");
    if (!btn || !panel) return;
    btn.addEventListener("click", openReading);
    const close = $("#rdClose");
    if (close) close.addEventListener("click", closeReading);
    document.querySelectorAll("#readingPanel .rd-tab").forEach((b) => {
      b.addEventListener("click", () => setReadingTab(b.dataset.tab));
    });
    /* 포스터 바깥 여백을 눌러도 닫힙니다 */
    panel.addEventListener("click", (e) => { if (e.target === panel) closeReading(); });

    /* 🎬 탭 안의 '영상으로 듣기' — 누른 탭의 영상이 그 탭 자리에서 시작됩니다 */
    wireTheater();

    const stage = $("#rdStage");
    if (stage) {
      /* 그림·뜻풀이를 누르면 그 장면의 한국어 이야기가 바로 나옵니다 */
      const tapKo = (el) => {
        const k = el.closest("[data-rd-ko-audio],[data-rd-ko-text]");
        if (!k) return;
        const src = k.dataset.rdKoAudio || "";
        const text = k.dataset.rdKoText || "";
        if (!src && !text) return;
        if (rda.seq) rdHardStop();
        rdSay(k, src, text, null, "ko-KR");
      };
      stage.addEventListener("click", (e) => {
        const b = e.target.closest(".wd-ex, .wd-hero");
        if (b) {
          const src = b.dataset.rdAudio || "";
          const text = b.dataset.rdText || "";
          if (!src && !text) return;
          if (rda.seq) rdHardStop();
          rdSay(b, src, text, null);
          return;
        }
        tapKo(e.target);
      });
      /* 키보드(Enter·Space)로도 같은 소리가 나게 — 그림·왼쪽 영역·뜻·약속 카드 */
      stage.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
        const t = e.target.closest ? e.target.closest("[data-rd-ko-audio],[data-rd-ko-text]") : null;
        if (!t) return;
        if (t.getAttribute("role") !== "button" && String(t.tagName || "").toLowerCase() !== "button") return;
        e.preventDefault();
        tapKo(t);
      });
      stage.addEventListener("click", (e) => {
        if (e.target.closest("#rdListenAll")) { rdPlayAll(); return; }
        const pb = e.target.closest("[data-rd-play]");
        if (pb) thOpen(pb.dataset.rdPlay === "word" ? "word" : "proverb");
      });
    }
    document.addEventListener("keydown", (e) => {
      if (!rd.open) return;
      if (e.key === "Escape") {
        if (th.open) { thClose(); return; }
        closeReading();
        return;
      }
      if (th.open) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const tabs = $("#readingPanel .rd-tabs");
        if (!tabs || !tabs.contains(document.activeElement)) return;
        e.preventDefault();
        setReadingTab(rd.tab === "proverb" ? "word" : "proverb");
        const on = $("#readingPanel .rd-tab.is-on");
        if (on) on.focus({ preventScroll: true });
      }
    });
  }

  /* ───────────── 🎬 탭 안 영상 모드(자동 재생) ─────────────
     탭 옆 버튼이 아니라, 각 탭 본문 안의 '🎬 영상으로 듣기' 버튼으로 시작합니다.
     영상은 모달 전체를 덮지 않고 읽을거리 본문(탭 아래 무대) 자리에서만 재생되며,
     끝나거나 멈추면 그 탭의 기본 그림 화면으로 돌아갑니다.

       · 속담 영상: 제목 카드 → 1~4컷(Ken Burns 줌·팬 + 하단 큰 자막) → 뜻·오늘의 약속
       · 영단어 영상: 큰 단어+뜻 → 배너 그림+예문1 → 예문2 → 예문3 → 기억 쏙 한마디
         (한국어 설명 ko-KR → 원어민 영어 en-US 를 번갈아 재생, 화면 아래 자막으로 표시)
       · 소리: MP3(proverb-YYYYMMDD-*.mp3 · {word}.mp3 · {word}-exN.mp3 · {word}-ko-*.mp3)
               → 재생이 안 되면 speechSynthesis(한국어 ko-KR · 영어 en-US)
       · 한 장이 끝나면 0.38초 쉬고 저절로 다음 장으로 넘어갑니다.
       · 큰 컬: ⏹ 멈추기 · 🔊 이 장면 다시 듣기 · ↺ 처음부터 · ✕ 이미지로 돌아가기
     data/board-data.json 의 audio·meaningAudio·ko*Audio 만 있으면 새 읽을거리도 그대로 동작합니다. */
  const th = { open: false, mode: "", i: 0, gen: 0, timer: 0, at: 0, audio: null, slides: [], dotEls: [] };
  const TH_GAP = 380;   /* 장과 장 사이 숨 쉬는 시간(ms) */
  const TH_MIN = { cover: 3200, panel: 2200, meaning: 3000, word: 3000, banner: 3200, ex: 2800, tip: 3000 };

  /* 문장들을 한 줄로 — 이미 있는 마침표·느낌표를 살리고 끝에만 한 번 붙입니다 */
  const rdSentence = (arr) => {
    const parts = arr.filter(Boolean).map((s) => String(s).trim().replace(/[.。!?！?]+$/, ""));
    return parts.length ? parts.join(". ") + "." : "";
  };

  /* 한 장 안에서 소리 조각(한국어 설명 → 원어민 영어)을 이어 붙일 때 씁니다 */
  const thPart = (audio, text, lang) => ({ audio: audio || "", text: text || "", lang: lang || "ko-KR" });
  const thParts = (s) => (Array.isArray(s.parts) && s.parts.length ? s.parts : [thPart(s.audio, s.text, s.lang)]);

  function thProverbSlides(pv) {
    const out = [];
    if (!pv) return out;
    const title = String(pv.title || "오늘의 속담");
    out.push({
      kind: "cover", lang: "ko-KR",
      audio: pv.audio || "",
      text: rdSentence([title, pv.subtitle, pv.summary]),
      html: () =>
        '<div class="th-cover">' +
          '<span class="th-badge">' + esc(pv.badge || "오늘의 속담") + "</span>" +
          '<h3 class="th-title"><em>' + esc(title) + "</em></h3>" +
          (pv.subtitle ? '<p class="th-sub">' + esc(pv.subtitle) + "</p>" : "") +
          (pv.summary ? '<p class="th-sum">' + esc(pv.summary) + "</p>" : "") +
          '<span class="th-cue" aria-hidden="true">🔊 소리를 켜고 같이 봐요</span>' +
        "</div>",
    });
    (Array.isArray(pv.panels) ? pv.panels : []).slice(0, 4).forEach((pn, i) => {
      const n = pn.num != null ? pn.num : i + 1;
      const img = pn.image || "";
      out.push({
        kind: "panel", lang: "ko-KR",
        audio: pn.audio || "",
        text: [pn.speech, pn.caption].filter(Boolean).join(" "),
        html: () =>
          '<figure class="th-shot kb' + ((i % 4) + 1) + '">' +
            (img ? '<img src="' + esc(img) + '" alt="' + esc(title + " " + n + "컷 그림") + '" decoding="async">' : "") +
            '<span class="th-num">' + esc(n) + "</span>" +
            '<figcaption class="th-cap">' +
              (pn.speech ? '<b class="th-speech">' + esc(pn.speech) + "</b>" : "") +
              (pn.caption ? '<span class="th-caption">' + esc(pn.caption) + "</span>" : "") +
            "</figcaption>" +
          "</figure>",
      });
    });
    if (pv.meaning || pv.promise) {
      out.push({
        kind: "meaning", lang: "ko-KR",
        audio: pv.meaningAudio || "",
        text: rdSentence([pv.meaning, pv.promise]),
        html: () =>
          '<div class="th-mean">' +
            (pv.meaning ? '<div class="th-card a"><b>📖 이런 뜻이에요</b><p>' + esc(pv.meaning) + "</p></div>" : "") +
            (pv.promise ? '<div class="th-card b"><b>⭐ 오늘의 약속</b><p>' + esc(pv.promise) + "</p></div>" : "") +
          "</div>",
      });
    }
    return out;
  }

  /* 영단어 영상 — 한국어 설명(ko-KR)과 원어민 영어(en-US)가 번갈아 나옵니다.
       큰 단어 + 뜻 → [한국어로 소개] → [share]
       배너 그림 + 예문 1 → [그림 설명·첫 번째 문장] → [Let's share.]
       예문 2 → [두 번째 문장 설명] → [We share toys.]  … 마지막 기억 쏙 한마디
     한국어 음성은 data 의 koIntroAudio · examples[].koAudio · koTipAudio 를 쓰고,
     없으면 koIntroText/koScript/화면 글자로 말합니다. */
  function thWordSlides(wd) {
    const out = [];
    if (!wd) return out;
    const word = String(wd.word || "");
    const meaning1 = wd.meaning ? String(wd.meaning).split("·")[0].trim() : "";
    const letters = () =>
      word.split("").map((ch, i) =>
        '<i class="w' + ((i % 4) + 1) + '" style="animation-delay:' + (i * 0.09).toFixed(2) + 's">' + esc(ch) + "</i>"
      ).join("");
    const introText = wd.koIntroText ||
      ("오늘의 영단어는 " + word + (meaning1 ? ", " + meaning1 + "라는 뜻이에요." : "예요.") + " 따라 해 볼까요?");
    out.push({
      kind: "word",
      parts: [thPart(wd.koIntroAudio, introText, "ko-KR"), thPart(wd.audio, word, "en-US")],
      html: () =>
        '<div class="th-cover is-word">' +
          '<span class="th-badge is-word">' + esc(wd.badge || "오늘의 영단어") + "</span>" +
          '<div class="th-word">' + letters() + "</div>" +
          (wd.meaning ? '<p class="th-mean-pill">' + esc(wd.meaning) + "</p>" : "") +
          '<span class="th-cue" aria-hidden="true">🇰🇷 설명 듣고 🔊 따라 말해 봐요</span>' +
        "</div>",
    });
    (Array.isArray(wd.examples) ? wd.examples : []).forEach((e, i) => {
      const n = e.num != null ? e.num : i + 1;
      const hl = (Array.isArray(e.highlight) && e.highlight.length ? e.highlight : [word]);
      const koText = e.koScript || (n + "번째 문장! " + (e.ko || ""));
      const parts = [thPart(e.koAudio, koText, "ko-KR"), thPart(e.audio, e.en || "", "en-US")];
      const enHTML =
        '<p class="th-ex-en">' + rdHighlight(e.en || "", hl) + "</p>" +
        (e.ko ? '<p class="th-ex-ko">' + esc(e.ko) + "</p>" : "");
      if (i === 0 && wd.bannerImage) {
        /* 첫 예문은 배너 그림 위에 크게 얹어, 그림을 보며 문장을 듣게 합니다 */
        out.push({
          kind: "banner", parts: parts,
          html: () =>
            '<div class="th-banner is-ex">' +
              '<img src="' + esc(wd.bannerImage) + '" alt="' + esc(word + (wd.meaning ? " 그림: " + wd.meaning : " 낱말 그림")) + '" decoding="async">' +
              '<div class="th-bex-card"><span class="th-ex-n">' + esc(n) + '</span><div class="th-bex-txt">' + enHTML + '</div></div>' +
            "</div>",
        });
        return;
      }
      out.push({
        kind: "ex", parts: parts,
        html: () =>
          '<div class="th-ex">' +
            '<span class="th-ex-n">' + esc(n) + "</span>" +
            enHTML +
          "</div>",
      });
    });
    if (wd.tip) {
      const tipText = wd.koTipText || ("기억 쏙 한마디! " + String(wd.tip));
      out.push({
        kind: "tip",
        parts: [thPart(wd.koTipAudio, tipText, "ko-KR")],
        html: () =>
          '<div class="th-mean">' +
            '<div class="th-card b"><b>💡 기억 쏙 한마디</b><p>' + rdHighlight(wd.tip, [word]) + "</p></div>" +
          "</div>",
      });
    }
    return out;
  }

  function thStopAudio() {
    if (th.audio) {
      try {
        th.audio.onended = null;
        th.audio.onerror = null;
        th.audio.pause();
        th.audio.currentTime = 0;
      } catch (e) { /* noop */ }
    }
    if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch (e) { /* noop */ } }
  }
  /* 지금 재생 중인 것 모두 멈추기(+ 진행 중이던 대기·콜백 무효화) */
  function thStopAll() {
    th.gen++;
    clearTimeout(th.timer);
    th.timer = 0;
    thStopAudio();
  }

  function thSpeak(s, done) {
    const gen = th.gen;
    const S = window.speechSynthesis;
    const text = String(s.text || "");
    if (!S || !window.SpeechSynthesisUtterance || !text) { if (done) done(); return; }
    const L = s.lang || "ko-KR";
    const head = L.slice(0, 2).toLowerCase();
    try {
      S.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = L;
      u.rate = head === "ko" ? 0.94 : 0.9;
      u.pitch = 1;
      const voices = (S.getVoices() || []).filter((v) => new RegExp("^" + head, "i").test(v.lang || ""));
      const pick = voices.filter((v) => String(v.lang || "").toLowerCase().indexOf(L.toLowerCase()) === 0)[0] || voices[0];
      if (pick) u.voice = pick;
      let guard = 0;
      const once = () => {
        clearTimeout(guard);
        u.onend = null; u.onerror = null;
        if (gen !== th.gen) return;
        if (done) done();
      };
      guard = setTimeout(once, Math.max(6000, text.length * 300 + 5000));
      u.onend = once;
      u.onerror = once;
      S.speak(u);
    } catch (e) { if (done) done(); }
  }

  /* 한 장 재생 — MP3 → 실패하면 화면 글자를 읽어 줌. 끝나면 finish() */
  function thSay(s, done) {
    const gen = th.gen;
    let fired = false;
    let guard = 0;
    const finish = () => {
      if (fired || gen !== th.gen) return;
      fired = true;
      clearTimeout(guard);
      thStopAudio();
      if (done) done();
    };
    /* 소리가 시작되지 않거나 끝났다는 신호가 오지 않아도 화면이 멈춰 있지 않게 */
    guard = setTimeout(finish, 26000);
    thStopAudio();
    const say = () => thSpeak(s, finish);
    if (!s.audio) { say(); return; }
    if (!th.audio) {
      th.audio = new Audio();
      th.audio.preload = "auto";
    }
    const a = th.audio;
    a.onended = finish;
    a.onerror = () => { a.onerror = null; say(); };
    try {
      a.src = s.audio;
      a.currentTime = 0;
    } catch (e) { a.onerror = null; say(); return; }
    let pr = null;
    try { pr = a.play(); } catch (e) { a.onerror = null; say(); return; }
    if (pr && typeof pr.catch === "function") {
      pr.catch(() => { if (fired) return; a.onerror = null; say(); });
    }
  }

  function thPaint(s) {
    const screen = $("#thScreen");
    if (!screen) return;
    screen.dataset.kind = s.kind;
    screen.innerHTML = '<div class="th-slide is-' + s.kind + '">' + s.html() + "</div>";
  }
  function thDots(k) {
    const box = $("#thDots");
    if (!box) return;
    if (box.dataset.n !== String(th.slides.length)) {
      box.dataset.n = String(th.slides.length);
      box.innerHTML = th.slides.map((s, i) =>
        '<button class="th-dot" type="button" data-i="' + i + '" aria-label="' + (i + 1) + '번째 장면 보기"></button>'
      ).join("");
      th.dotEls = Array.prototype.slice.call(box.querySelectorAll(".th-dot"));
    }
    th.dotEls.forEach((b, i) => {
      b.classList.toggle("is-on", i === k);
      b.classList.toggle("is-done", i < k);
      if (i === k) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    });
  }
  function thSetNow() {
    const el = $("#thNow");
    if (!el) return;
    const name = th.mode === "word" ? "🌱 영단어 영상" : "📖 속담 영상";
    const i = Math.min(th.i + 1, th.slides.length);
    el.textContent = th.slides.length ? name + " · " + i + "/" + th.slides.length : name;
  }
  /* 지금 나오는 소리가 한국어 설명인지 원어민 영어인지 화면 아래에 알려 줍니다 */
  function thSetSub(p) {
    const el = $("#thSub");
    if (!el) return;
    if (!p || !p.text) {
      el.hidden = true;
      el.innerHTML = "";
      el.dataset.lang = "";
      return;
    }
    const ko = String(p.lang || "").toLowerCase().indexOf("ko") === 0;
    el.hidden = false;
    el.dataset.lang = ko ? "ko" : "en";
    el.innerHTML =
      '<span class="th-lang">' + (ko ? "한국어 설명" : "English") + "</span>" +
      '<span class="th-txt">' + esc(p.text) + "</span>";
  }

  function thStep(k) {
    if (!th.open) return;
    if (k >= th.slides.length) { thFinish(); return; }
    const gen = th.gen;
    const s = th.slides[k];
    th.i = k;
    thPaint(s);
    thDots(k);
    thSetNow();
    th.at = Date.now();
    const go = () => {
      if (gen !== th.gen) return;
      const left = Math.max(0, (TH_MIN[s.kind] || 0) - (Date.now() - th.at));
      th.timer = setTimeout(() => {
        if (gen !== th.gen) return;
        thStep(k + 1);
      }, left + TH_GAP);
    };
    /* 한 장 안의 소리 조각들을 순서대로 — 한국어 설명이 끝나면 바로 원어민 발음 */
    const parts = thParts(s);
    /* 소리가 둘 이상 번갈아 나오는 장면(영단어)만 아래 자막 줄을 씁니다 */
    const showSub = parts.length > 1;
    let idx = 0;
    const next = () => {
      if (gen !== th.gen) return;
      if (idx >= parts.length) { thSetSub(null); go(); return; }
      const p = parts[idx++];
      thSetSub(showSub ? p : null);
      thSay(p, next);
    };
    next();
  }

  function thPlay(mode) {
    const p = readingData();
    const slides = mode === "word" ? thWordSlides(p.word) : thProverbSlides(p.proverb);
    thStopAll();
    if (!slides.length) {
      const other = mode === "word" ? "proverb" : "word";
      if ((other === "word" && p.word) || (other === "proverb" && p.proverb)) { thPlay(other); return; }
      th.mode = mode;
      th.slides = [];
      thPaintEmptyTheater();
      return;
    }
    th.mode = mode;
    th.slides = slides;
    th.i = 0;
    thDots(0);
    thStep(0);
  }

  function thPaintEmptyTheater() {
    const screen = $("#thScreen");
    if (screen) {
      screen.dataset.kind = "none";
      screen.innerHTML =
        '<div class="th-cover"><span class="th-badge">오늘의 읽을거리</span>' +
        '<h3 class="th-title"><em>영상 준비 중이에요</em></h3>' +
        '<p class="th-sum">매일 아침 새 속담과 영단어 영상이 이 자리에 떠요.</p></div>';
    }
    const box = $("#thDots");
    if (box) { box.dataset.n = "0"; box.innerHTML = ""; th.dotEls = []; }
    thSetNow();
  }

  /* 영상이 끝났을 때 — 다 봤어요 카드를 잠깐 보여 주고 그 탭의 그림 화면으로 돌아갑니다 */
  function thFinish() {
    const gen = th.gen;
    thStopAudio();
    thSetSub(null);
    const p = readingData();
    const screen = $("#thScreen");
    if (!screen) return;
    thDots(th.slides.length);
    thSetNow();
    const isWord = th.mode === "word";
    const title = isWord ? (p.word ? String(p.word.word || "") : "") : (p.proverb ? String(p.proverb.title || "") : "");
    screen.dataset.kind = "bye";
    screen.innerHTML =
      '<div class="th-cover is-bye">' +
        '<span class="th-badge">🎉 다 봤어요</span>' +
        '<h3 class="th-title"><em>' + esc(title) + "</em></h3>" +
        (isWord && p.word && p.word.meaning ? '<p class="th-sum">' + esc(p.word.meaning) + "</p>" : "") +
        '<span class="th-cue">잠깐 뒤에 그림 화면으로 돌아가요</span>' +
      "</div>";
    th.timer = setTimeout(() => {
      if (gen !== th.gen || !th.open) return;
      thClose();
    }, 2400);
  }

  /* 영상은 모달 전체를 덮지 않고, 읽을거리 본문(탭 아래 무대) 자리에서만 재생됩니다. */
  function thOpen(mode) {
    const theater = $("#rdTheater"), stage = $("#rdStage");
    if (!theater || !stage) return;
    const p = readingData();
    let m = mode === "word" ? "word" : "proverb";
    if (m === "word" && !p.word) m = p.proverb ? "proverb" : "word";
    if (m === "proverb" && !p.proverb && p.word) m = "word";
    rdHardStop();
    setReadingTab(m);   /* 재생되는 영상과 탭 표시를 맞춥니다 */
    th.open = true;
    stage.hidden = true;
    theater.hidden = false;
    theater.dataset.mode = m;
    primeAudio();
    const exit = $("#thExit");
    if (exit) exit.focus({ preventScroll: true });
    thPlay(m);
  }
  function thClose(silent) {
    const theater = $("#rdTheater"), stage = $("#rdStage");
    if (!theater) return;
    thStopAll();
    thSetSub(null);
    th.open = false;
    theater.hidden = true;
    if (stage) stage.hidden = false;
    const screen = $("#thScreen");
    if (screen) screen.innerHTML = "";
    if (silent) return;
    const pbs = document.querySelectorAll("#rdStage [data-rd-play]");
    let pb = null;
    Array.prototype.forEach.call(pbs, (b) => { if (!pb && b.offsetParent) pb = b; });
    if (pb) pb.focus({ preventScroll: true });
  }

  function wireTheater() {
    const byId = (id) => $("#" + id);
    const stop = byId("thStop"), exit = byId("thExit");
    if (stop) stop.addEventListener("click", thClose);
    if (exit) exit.addEventListener("click", thClose);
    const replay = byId("thReplay");
    if (replay) replay.addEventListener("click", () => {
      if (!th.open || !th.slides.length) return;
      thStopAll();
      thStep(Math.min(th.i, th.slides.length - 1));
    });
    const restart = byId("thRestart");
    if (restart) restart.addEventListener("click", () => {
      if (!th.open) return;
      thPlay(th.mode === "word" ? "word" : "proverb");
    });
    const dots = byId("thDots");
    if (dots) dots.addEventListener("click", (e) => {
      const d = e.target.closest(".th-dot");
      if (!d || !th.open) return;
      const k = Number(d.dataset.i);
      if (!isFinite(k) || k < 0 || k >= th.slides.length) return;
      thStopAll();
      thStep(k);
    });
  }


  /* ───────────── 📺 주말 TV 30분 타이머 (쉬는 날에만) ─────────────
     주말·공휴일(isRestDay)에만 상단 1/3 에 세 번째 카드로 뜹니다.
     30분(1800초) 카운트다운 · ▶ 시작/⏸ 멈춤 토글 · 오늘 다 봄(바로 잠금) · ↺ 초기화(30분 복구).
     남은 시간은 날짜와 함께 localStorage 에 저장해 새로고침·화면 꺼짐에도 이어지고,
     00:00 이 되면 차임벨 + 종료 배너("⏰ 오늘 TV 30분 끝! 이제 눈 쉬자")를 띄웁니다. */
  const TV_KEY = "familyTv.v1";
  const TV_TOTAL = 30 * 60;              /* 30분 = 1800초 */
  const tv = { left: TV_TOTAL, running: false, done: false, endAt: 0, notified: false, saveT: 0, endedAway: false };

  function tvSave() {
    try {
      localStorage.setItem(TV_KEY, JSON.stringify({
        date: todayStr, total: TV_TOTAL, left: tv.left,
        running: tv.running, done: tv.done, endAt: tv.endAt, notified: tv.notified,
      }));
    } catch (e) { /* 저장이 안 돼도 화면은 동작 */ }
  }
  function tvLoad() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(TV_KEY) || "null"); } catch (e) { s = null; }
    /* 다른 날이거나 타이머 길이가 바뀌었으면 오늘 30분으로 새로 시작 */
    if (!s || s.date !== todayStr || Number(s.total) !== TV_TOTAL) {
      tv.left = TV_TOTAL; tv.running = false; tv.done = false; tv.endAt = 0; tv.notified = false; tv.endedAway = false;
      return;
    }
    tv.done = !!s.done;
    tv.notified = !!s.notified;
    tv.running = !!s.running && !tv.done;
    tv.endAt = Number(s.endAt) || 0;
    tv.left = Math.max(0, Math.min(TV_TOTAL, Number(s.left) || 0));
    tv.endedAway = false;
    if (tv.running) {
      if (!tv.endAt) { tv.running = false; tv.left = TV_TOTAL; }
      else tv.left = Math.max(0, Math.ceil((tv.endAt - Date.now()) / 1000));
    }
    if (tv.left <= 0 && (tv.running || tv.done)) {
      /* 화면이 궴 있던 사이에 30분이 다 지났으면 돌아왔 때 한 번 알려 줍니다 */
      tv.endedAway = !tv.done && !tv.notified;
      tv.left = 0; tv.running = false; tv.done = true;
    }
  }
  function tvRemain() {
    if (tv.done) return 0;
    if (tv.running && tv.endAt) return Math.max(0, Math.ceil((tv.endAt - Date.now()) / 1000));
    return tv.left;
  }
  function tvPaint() {
    const card = $("#tvCard");
    if (!card) return;
    const left = tvRemain();
    const tEl = $("#tvTime"), sEl = $("#tvStatus"), fEl = $("#tvFill"), bar = $("#tvBar");
    const tg = $("#tvToggle"), dn = $("#tvDoneBtn");
    if (tEl) tEl.textContent = pad(Math.floor(left / 60)) + ":" + pad(left % 60);
    if (fEl) fEl.style.width = Math.max(0, Math.min(100, (left / TV_TOTAL) * 100)).toFixed(2) + "%";
    if (bar) bar.setAttribute("aria-valuenow", String(left));
    card.classList.toggle("is-running", tv.running && !tv.done);
    card.classList.toggle("is-done", tv.done);
    if (sEl) {
      if (tv.done) sEl.textContent = "오늘은 다 봤어요 · 내일 또!";
      else if (tv.running) sEl.textContent = "보는 중… 남은 시간";
      else if (left < TV_TOTAL) sEl.textContent = "잠깐 멈춤";
      else sEl.textContent = "30분 타이머";
    }
    if (tg) {
      tg.textContent = tv.done ? "다 봤어요" : tv.running ? "⏸ 멈춤" : left < TV_TOTAL ? "▶ 이어서" : "▶ 시작";
      tg.disabled = !!tv.done;
    }
    if (dn) dn.disabled = !!tv.done;
  }
  function showTvBanner() {
    const b = $("#tvBanner");
    if (!b) return;
    b.classList.remove("show");
    void b.offsetWidth;
    b.classList.add("show");
    clearTimeout(showTvBanner.timer);
    showTvBanner.timer = setTimeout(() => b.classList.remove("show"), 15000);
  }
  function hideTvBanner() {
    const b = $("#tvBanner");
    if (b) b.classList.remove("show");
    clearTimeout(showTvBanner.timer);
  }
  function tvStart() {
    if (tv.done) return;
    if (tv.left <= 0) tv.left = TV_TOTAL;
    tv.running = true;
    tv.endAt = Date.now() + tv.left * 1000;
    tvSave(); tvPaint(); primeAudio();
  }
  function tvPause() {
    tv.left = tvRemain();
    tv.running = false; tv.endAt = 0;
    tvSave(); tvPaint();
  }
  function tvFinish(byTimer) {
    tv.left = 0; tv.running = false; tv.endAt = 0; tv.done = true;
    if (byTimer) tv.notified = true;
    tvSave(); tvPaint();
    if (byTimer) {
      const rang = chimeWarn();   /* 8:20 경고와 같은 또렷한 딩동댕 두 번 */
      showTvBanner();
      if (!rang) toast("⏰ 오늘 TV 30분 끝! 이제 눈 쉬자 👀");
    }
  }
  function tvTick() {
    if (!tv.running) return;
    const left = tvRemain();
    if (left <= 0) { tvFinish(true); return; }
    tv.left = left;
    tvPaint();
    if (!tv.saveT || Date.now() - tv.saveT > 10000) { tv.saveT = Date.now(); tvSave(); }
  }
  function renderTV() {
    const card = $("#tvCard");
    if (!card) return;
    /* 주말·공휴일(쉬는 날)에만 보이고, 평일에는 2장으로 돌아갑니다 */
    const rest = isRestDay(todayStr);
    card.hidden = !rest;
    const mid = card.closest ? card.closest(".lv-topmid") : null;
    if (mid) mid.classList.toggle("has-tv", rest);
    tvPaint();
  }
  function initTV() {
    const card = $("#tvCard");
    if (!card) return;
    tvLoad();
    const tg = $("#tvToggle"), dn = $("#tvDoneBtn"), rs = $("#tvResetBtn");
    if (tg) tg.addEventListener("click", () => { if (tv.running) tvPause(); else tvStart(); });
    if (dn) dn.addEventListener("click", () => {
      if (tv.done) return;
      tvFinish(false);
      toast("오늘 TV 30분은 여기까지! 이제 눈 쉬자 👀");
    });
    if (rs) rs.addEventListener("click", () => {
      tv.left = TV_TOTAL; tv.running = false; tv.done = false; tv.endAt = 0; tv.notified = false;
      tvSave(); tvPaint();
      toast("TV 타이머를 30분으로 되돌렸어요 ↺");
    });
    const banner = $("#tvBanner");
    if (banner) banner.addEventListener("click", hideTvBanner);
    renderTV();
    if (tv.endedAway) {
      tv.endedAway = false;
      tv.notified = true;
      tvSave();
      showTvBanner();
      chimeWarn();
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
    renderReadingCard();
    renderTV();
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
    tvLoad();          /* 날짜가 바뀌면 TV 타이머도 오늘 30:00 으로 */
    renderAll();
    renderAlarmBtn();
    if (isRestDay(todayStr)) hideAlarmBanner();   /* 어제 남은 알람 배너가 쉬는 날에 남지 않게 */
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
    tvTick();
  }

  /* ───────────── ⏰ 등원 준비 알람 (평일 08:00 · 08:20) ─────────────
     ① 08:00 시작 차임 — 맑은 도-미-솔-도
     ② 08:20 경고 차임 — 두 번 반복되는 또렷한 딩동댕 (출발 20분 전)
     주말·공휴일에는 울리지 않고, 두 알람 모두 하루 한 번만 울립니다. */
  function alarmOn() { return store.alarm !== false; }
  /* 오늘 등원 알람이 울리는 날인가 — 평일(등원일)만 */
  function alarmDayToday() { return !isRestDay(todayStr); }
  function renderAlarmBtn() {
    const on = alarmOn();
    const restDay = !alarmDayToday();
    const btn = $("#alarmBtn");
    if (btn) {
      btn.textContent = on ? "🔔" : "🔕";
      btn.classList.toggle("is-off", !on);
      btn.title = restDay
        ? "오늘은 쉬는 날(주말·공휴일) · 등원 알람이 울리지 않아요"
        : on ? "등원 알람 켜짐 · 평일 8:00 / 8:20 (누르면 끄기)" : "등원 알람 꺼짐 (누르면 켜기)";
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
    if (hint) hint.textContent = !on ? "꺼짐" : restDay ? "오늘은 쉬는 날 · 알람 없음" : "평일 8:00 · 8:20";
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
    /* 주말·공휴일(그리고 휴원일)에는 배너도 차임벨도 내지 않습니다.
       (⚙️ 알람 소리 미리 듣기 버튼은 부모님이 직접 누를 때만 배너를 보여 줍니다) */
    if (isRestDay(todayStr)) return;
    if (!alarmOn()) return;
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
  /* 놀이 화면은 보드 데이터와 상관없이 한 번에 열 수 있게 먼저 연결합니다 */
  initGame();
  initReading();
  initTV();
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
  /* 검증용 — 주소에 debug=1 이 있을 때만 열립니다 (보드 화면에는 영향 없음) */
  if (DEBUG) {
    window.__livingDebug = {
      today: todayStr,
      isRestDay: isRestDay,
      restName: restName,
      holiday: (ds) => (KR ? KR.nameOf(ds) : ""),
      buildChecklists: buildChecklists,
      alarmShowing: () => { const b = $("#alarmBanner"); return !!b && b.classList.contains("show"); },
      alarmDone: () => JSON.parse(JSON.stringify(store.alarmDoneBySlot || {})),
      departure: () => departureInfo(),
    };
  }
  setInterval(tick, 1000);
  setInterval(() => { if (iso(new Date()) !== todayStr) dayRollover(); }, 20000);
  setInterval(() => refreshData(false), 10 * 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (iso(new Date()) !== todayStr) dayRollover();
    else refreshData(false);
  });
})();
