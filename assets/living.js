/* 거실 등원 보드 — living.js
   data/board-data.json 한 파일만 읽어서 오늘 날짜·우장산동 날씨/옷차림·다은·승민 일정·
   저녁 홈활동·급식·간식을 자동 반영합니다. (매일 06:00 아침 브리핑이 이 파일을 갱신)
   체크 상태와 칭찬 스티커는 이 기기 브라우저의 localStorage 에만 저장됩니다. */
(async function () {
  "use strict";

  const $ = (s, r) => (r || document).querySelector(s);
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const parseISO = (s) => { const p = String(s).split("-").map(Number); return new Date(p[0], p[1] - 1, p[2]); };
  const WD = ["일", "월", "화", "수", "목", "금", "토"];
  const WDKEY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const STORE_KEY = "familyLivingBoard.v1";
  const ST_ICONS = ["⭐", "💖", "🦕"];
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

  const COND = {
    "Clear": ["☀️", "맑음"], "Mostly Clear": ["🌤️", "대체로 맑음"], "Partly Cloudy": ["⛅", "구름 조금"],
    "Mostly Cloudy": ["☁️", "구름 많음"], "Cloudy": ["☁️", "흐림"], "Drizzle": ["🌦️", "보슬비"],
    "Rain": ["🌧️", "비"], "Heavy Rain": ["🌧️", "강한 비"], "Flurries": ["🌨️", "눈 날림"],
    "Snow": ["❄️", "눈"], "Foggy": ["🌫️", "안개"], "Thunderstorm": ["⛈️", "뇌우"],
  };

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
  function blankChecks() {
    const o = {};
    CHILDREN.forEach((c) => { o[c.id] = { morning: [], evening: [], awarded: { morning: "", evening: "" } }; });
    return o;
  }
  function blankCheck() { return { morning: [], evening: [], awarded: { morning: "", evening: "" } }; }

  function loadStore() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch (e) { s = null; }
    if (!s || typeof s !== "object") s = {};
    if (typeof s.sound !== "boolean") s.sound = true;
    s.stickers = s.stickers && typeof s.stickers === "object" ? s.stickers : {};
    CHILDREN.forEach((c) => {
      const n = parseInt(s.stickers[c.id], 10);
      s.stickers[c.id] = Number.isFinite(n) && n > 0 ? n : 0;
    });
    /* 날짜가 바뀌면 체크만 새로 — 누적 스티커는 그대로 */
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
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* 저장 불가 모드 */ } }
  function ensureCheck(cid) {
    if (!store.checks[cid]) store.checks[cid] = blankCheck();
    return store.checks[cid];
  }

  /* ───────────── 체크리스트 정의 ───────────── */
  function bookForToday(cid, ds) {
    const wk = weekdayKey(ds);
    return BOOK.find((b) => b.weekday === wk && b.child === cid) || null;
  }
  function buildChecklists(cid, ds) {
    const morning = [
      { id: "wash", e: "🪥", t: "세수하고 양치하기" },
      { id: "clothes", e: "👕", t: "오늘 옷 입기" },
      { id: "meal", e: "🍚", t: "아침 밥 먹기" },
      { id: "bag", e: "🎒", t: "가방·물통 챙기기" },
    ];
    if (bookForToday(cid, ds)) morning.push({ id: "book", e: "📚", t: "도서대여 가방 챙기기" });
    morning.push({ id: "shoes", e: "👟", t: "신발 신고 출발!" });

    const act = eveningActivity(ds);
    const evening = [
      { id: "hands", e: "🧼", t: "손 씻기" },
      { id: "unpack", e: "🎒", t: "가방·물통 꺼내기" },
      act ? { id: "fun", e: act.emoji, t: "오늘 밤은 " + act.name + " 놀이!" } : { id: "fun", e: "🧸", t: "오늘 밤은 자유놀이!" },
      { id: "brush", e: "🪥", t: "양치하고 꿈나라 준비" },
    ];
    return { morning: morning, evening: evening };
  }
  function progressOf(cid, part, lists) {
    const items = (lists || buildChecklists(cid, todayStr))[part] || [];
    const arr = (ensureCheck(cid)[part]) || [];
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
    if (isRestDay(ds)) return '<i>🌴 오늘은 쉬는 날</i>';
    const items = childTodayItems(cid, ds);
    if (!items.length) return "<i>오늘은 따로 일정이 없어요</i>";
    return items
      .slice(0, 4)
      .map((i) => (i.time ? '<i>' + esc(i.time) + "</i> " : "") + esc(i.text))
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

  /* ───────────── 아이 카드 ───────────── */
  const state = { tab: {} };
  function defaultTab() { const h = new Date().getHours(); return h >= 17 || h < 4 ? "evening" : "morning"; }
  const tabOf = (cid) => state.tab[cid] || defaultTab();

  function stepsHTML(items, arr) {
    return (
      '<ul class="steps">' +
      items
        .map((i) => {
          const on = arr.indexOf(i.id) >= 0;
          return (
            '<li><button type="button" class="step' + (on ? " is-done" : "") + '" data-id="' + i.id + '" aria-pressed="' + on + '">' +
            '<span class="step-emoji">' + i.e + "</span>" +
            '<span class="step-label">' + esc(i.t) + "</span>" +
            '<span class="step-check">✓</span>' +
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
    if (!html) {
      html = '<div class="st-row">' + Array.from({ length: 10 }, () => '<i class="st"></i>').join("") + "</div>";
    }
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
    const emoji = c.id === "seungmin" ? "🌱" : "🌸";
    const grade = String(c.grade || "").split(" (")[0];
    return (
      '<div class="kid-head">' +
        '<div class="kid-avatar">' + emoji + "</div>" +
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
        stepsHTML(items, arr) +
      "</div>" +
      '<div class="kid-foot">' +
        '<div class="st-head"><span class="st-star">⭐</span><span class="st-num">' + st + '</span><span class="st-unit">개</span></div>' +
        '<div class="st-board">' + stickerRows(st) + "</div>" +
      "</div>"
    );
  }
  function renderKids() {
    const grid = $("#childGrid");
    if (!CHILDREN.length) { grid.innerHTML = '<div class="lv-error">아이 정보가 아직 없어요.<br><small>data/board-data.json 의 children 을 확인해 주세요.</small></div>'; return; }
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
  function paintStep(btn, on) {
    btn.classList.toggle("is-done", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  function toggleStep(cid, part, id, btn) {
    const c = ensureCheck(cid);
    const arr = c[part];
    const at = arr.indexOf(id);
    if (at >= 0) { arr.splice(at, 1); paintStep(btn, false); tapSound(false); }
    else { arr.push(id); paintStep(btn, true); tapSound(true); }
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
      const face = c.id === "seungmin" ? "🌱" : "🌸";
      return (
        '<div class="lv-set"><span>' + face + " " + esc(c.name) + " 스티커</span>" +
        '<span class="mini">' +
          '<button class="num-btn" type="button" data-minus="' + esc(c.id) + '" aria-label="' + esc(c.name) + ' 스티커 줄이기">−</button>' +
          '<b class="st-num-b">' + (store.stickers[c.id] || 0) + "</b>" +
          '<button class="num-btn" type="button" data-plus="' + esc(c.id) + '" aria-label="' + esc(c.name) + ' 스티커 늘리기">+</button>' +
        "</span></div>"
      );
    }).join("");
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
    const d = new Date();
    const next = iso(d);
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
    if (iso(d) !== todayStr) dayRollover();
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
      const step = e.target.closest(".step");
      if (step) {
        const kid = step.closest(".kid");
        const body = step.closest(".kid-body");
        if (!kid || !body) return;
        toggleStep(kid.dataset.child, body.dataset.part, step.dataset.id, step);
      }
    });

    $("#soundBtn").addEventListener("click", () => {
      setSound(!store.sound);
      if (store.sound) tapSound(true);
      toast(store.sound ? "효과음을 켰어요 🔊" : "효과음을 껐어요 🔇");
    });
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
    $("#resetBtn").addEventListener("click", () => {
      if (!window.confirm("오늘 체크를 모두 지울까요? (칭찬 스티커는 그대로 남아요)")) return;
      store.checks = blankChecks();
      save();
      renderKids();
      toast("오늘 체크를 초기화했어요");
    });
    $("#reloadBtn").addEventListener("click", async () => { await refreshData(true); openGear(false); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") openGear(false); });
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
