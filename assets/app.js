/* 우리 집 모아보드 — app.js
   데이터는 data/board-data.json 한 곳에만 있습니다 (일정·급식·날씨 스냅샷·건강).
   급식은 NEIS Open API로 실시간 최신화(실패 시 board-data.json 폴백),
   날씨는 Open-Meteo 실시간 조회(실패 시 스냅샷 폴백). */
(async function () {
  "use strict";

  /* ───────────────────────── 데이터 로드 ───────────────────────── */
  let data;
  try {
    const res = await fetch("data/board-data.json?ts=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    data = await res.json();
  } catch (e) {
    document.body.insertAdjacentHTML(
      "afterbegin",
      '<div style="margin:16px auto;max-width:560px;padding:14px 16px;background:#FFF1EF;border:1px solid #F3CFCC;border-radius:14px;font:600 13px/1.5 sans-serif;color:#A3423D;text-align:center">보드 데이터를 불러올 수 없어요.<br><small>data/board-data.json 파일을 확인해 주세요.</small></div>'
    );
    return;
  }

  const HOLIDAYS = data.holidays || {};
  const SCHEDULES = data.schedules || [];
  const EVENTS = data.kindergartenEvents || [];
  const BOOK = data.bookRental || [];
  const SNACKS = data.kindergartenSnacks || {};
  const EVENING = data.eveningRoutine || null;
  const CHILD = {};
  (data.children || []).forEach((c) => (CHILD[c.id] = c));

  /* ───────────────────────── 날짜 유틸 ───────────────────────── */
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const parseISO = (s) => { const p = s.split("-").map(Number); return new Date(p[0], p[1] - 1, p[2]); };
  const WD = ["일", "월", "화", "수", "목", "금", "토"];
  const WDKEY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const holidayOf = (ds) => HOLIDAYS[ds] || null;

  const today = new Date();
  const todayStr = iso(today);

  /* ───────────────────────── 평일 격일 저녁 홈활동 ─────────────────────────
     미술·독서·수학·과학·보드게임 5과목을 "평일(월~금)만" 세어 격일로 돌립니다.
     기준일 2026-11-17(화) = 평일 0번째 → 🎨 미술, 11/18(수) 1번째 → 쉼,
     11/19(목) 2번째 → 📖 독서 … 이렇게 2주(평일 10일)에 5과목 한 바퀴.
     토·일은 세지 않아 주말에는 홈활동이 없고, 공휴일은 평일 그대로 세어
     리듬이 끊기지 않습니다. */
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
  function eveningSubject(ds) {
    const subs = EVENING && EVENING.subjects;
    if (!subs || !subs.length) return null;
    const step = EVENING.step || 2;
    const wi = weekdayIndexFromAnchor(ds);
    if (wi < 0 || wi % step !== 0) return null;
    return subs[Math.floor(wi / step) % subs.length];
  }
  function eveningItem(ds) {
    const subs = EVENING && EVENING.subjects;
    if (!subs || !subs.length) return null;
    const s = eveningSubject(ds);
    if (!s) return null;
    const next = subs[(subs.indexOf(s) + 1) % subs.length];
    return {
      type: "routine",
      time: EVENING.time || "20:00",
      title: s.emoji + " " + s.name,
      note: "다은·승민 함께 · 다음 홈활동은 " + next.emoji + " " + next.name,
      who: EVENING.target === "both" ? ["daeun", "seungmin"] : [EVENING.target || "daeun"],
    };
  }

  /* ───────────────────────── 차시 계산 ─────────────────────────
     공휴일(및 주말)을 제외하고 해당 월의 수업 요일만 순서대로 세어
     월 차시를 매깁니다. 어퍼룸 = 월 8차시(화·금), 다은 엘리하이 = 월 4차시(수, 홀짝),
     승민 엘리하이 = 월 4차시(화, 2027-01부터 전환). */
  function buildSessionMap(year, month1) {
    const first = new Date(year, month1 - 1, 1);
    const lastDay = new Date(year, month1, 0).getDate();
    const counters = {};
    const out = {};
    for (let d = 1; d <= lastDay; d++) {
      const date = new Date(year, month1 - 1, d);
      const ds = iso(date);
      const wdKey = WDKEY[date.getDay()];
      if (date.getDay() === 0 || date.getDay() === 6 || holidayOf(ds)) continue;
      SCHEDULES.forEach((s) => {
        if (!s.session || s.times[wdKey] == null) return;
        counters[s.id] = (counters[s.id] || 0) + 1;
        const n = counters[s.id];
        let item = { n, over: false, label: "", time: s.times[wdKey] };
        const ses = s.session;
        if (ses.kind === "monthly") {
          if (n > ses.perMonth) { item.over = true; item.label = "월 " + ses.perMonth + "차시 초과 · 휴강/보강 확인"; }
          else item.label = n + "/" + ses.perMonth + "차시";
        } else if (ses.kind === "oddEven") {
          if (n > ses.perMonth) { item.over = true; item.label = "월 " + ses.perMonth + "차시 초과 · 휴강/보강 확인"; }
          else {
            const half = n % 2 === 1 ? ses.odd : ses.even;
            item.time = half.time;
            item.label = n + "/" + ses.perMonth + "차시 · " + half.label;
          }
        } else if (ses.kind === "seungminTuesday") {
          const ym = year + "-" + pad(month1);
          if (n > ses.perMonth) { item.over = true; item.label = "월 " + ses.perMonth + "차시 초과 · 휴강/보강 확인"; }
          else if (ym >= ses.switchMonth) { item.label = n + "/" + ses.perMonth + "차시 · " + ses.after.label; }
          else { item.label = n + "/" + ses.perMonth + "차시 · " + (n === 1 ? ses.before.first.label : ses.before.rest.label); }
        }
        (out[ds] = out[ds] || {})[s.id] = item;
      });
    }
    return out;
  }
  const sessionCache = {};
  const sessionsFor = (y, m) => (sessionCache[y + "-" + m] = sessionCache[y + "-" + m] || buildSessionMap(y, m));

  /* ───────────────────────── 하루 일정 구성 ───────────────────────── */
  function dayItems(ds, filter) {
    const d = parseISO(ds);
    const wdKey = WDKEY[d.getDay()];
    const hol = holidayOf(ds);
    const items = [];
    if (hol) {
      items.push({ type: "holiday", name: hol.name, kind: hol.type });
      const holEv = eveningItem(ds);
      if (holEv) items.push(holEv);
      return items;
    }
    EVENTS.forEach((ev) => {
      if (ev.date !== ds) return;
      if (filter !== "all" && ev.child && ev.child !== filter) return;
      if (filter !== "all" && !ev.child) { /* 전체 대상 이벤트는 항상 표시 */ }
      items.push({ type: "event", time: null, title: ev.title, note: ev.detail, important: !!ev.important, who: ev.child });
    });
    BOOK.forEach((b) => {
      if (b.weekday !== wdKey) return;
      if (filter !== "all" && b.child && b.child !== filter) return;
      items.push({ type: "book", time: null, title: b.label, who: b.child });
    });
    SCHEDULES.forEach((s) => {
      if (filter !== "all" && s.child !== filter) return;
      const base = s.times[wdKey];
      if (base == null) return;
      const ses = sessionsFor(d.getFullYear(), d.getMonth() + 1)[ds];
      const si = ses ? ses[s.id] : null;
      if (si && si.over) {
        items.push({ type: "class", time: si.time, title: s.title, note: si.label, who: s.child, warn: true });
        return;
      }
      const time = si ? si.time : base;
      let note = s.note || "";
      if (si) note = note ? si.label + " · " + note : si.label;
      items.push({ type: "class", time, title: s.title, note, who: s.child });
    });
    const ev = eveningItem(ds);
    if (ev) items.push(ev);
    const untimed = (i) => i.type === "event" || i.type === "book";
    items.sort((a, b) => {
      if (untimed(a) !== untimed(b)) return untimed(a) ? -1 : 1;
      if (a.time && b.time) return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
      if (a.time) return 1;
      if (b.time) return -1;
      return 0;
    });
    return items;
  }

  /* ───────────────────────── 상태 ───────────────────────── */
  const state = {
    filter: "all",
    selected: todayStr,
    viewYear: today.getFullYear(),
    viewMonth: today.getMonth() + 1,
    mealDate: todayStr,
    mathMode: "seungmin",
  };

  const $ = (id) => document.getElementById(id);

  /* ───────────────────────── 상단 ───────────────────────── */
  function renderTop() {
    const d = parseISO(todayStr);
    const hol = holidayOf(todayStr);
    $("todayLine").textContent =
      today.getMonth() + 1 + "월 " + today.getDate() + "일 " + WD[d.getDay()] + "요일 · " + data.family.location.name +
      (hol ? " · 오늘은 " + hol.name : "");
    $("updatedAt").textContent = "마지막 업데이트 " + (data.meta ? data.meta.updatedAt.replace("T", " ").slice(0, 16) : "—");
    $("growthNote").textContent = data.growthNote || "";
  }

  /* ───────────────────────── 날씨 카드 ───────────────────────── */
  const COND = {
    "Clear": ["☀️", "맑음"], "Mostly Clear": ["🌤️", "대체로 맑음"], "Partly Cloudy": ["⛅", "구름 조금"],
    "Mostly Cloudy": ["☁️", "구름 많음"], "Cloudy": ["☁️", "흐림"], "Drizzle": ["🌦️", "보슬비"],
    "Rain": ["🌧️", "비"], "Heavy Rain": ["🌧️", "강한 비"], "Flurries": ["🌨️", "눈 날림"],
    "Snow": ["❄️", "눈"], "Foggy": ["🌫️", "안개"],
  };
  const wmo = (c) => {
    if (c === 0) return ["☀️", "맑음"];
    if (c === 1 || c === 2) return ["🌤️", "대체로 맑음"];
    if (c === 3) return ["☁️", "흐림"];
    if (c === 45 || c === 48) return ["🌫️", "안개"];
    if (c >= 51 && c <= 57) return ["🌦️", "보슬비"];
    if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return ["🌧️", "비"];
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return ["🌨️", "눈"];
    if (c >= 95) return ["⛈️", "뇌우"];
    return ["☁️", "—"];
  };
  function outfitTip(minC, highC, pop, condLabel) {
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
  function renderWeather(d) {
    const nowC = d.now, days = d.days || [];
    const cc = nowC.emoji ? [nowC.emoji, nowC.condition] : (COND[nowC.condition] || ["🌡️", nowC.condition]);
    const air = d.air || {};
    const airGrade = air.pm10 ? air.pm10.grade : null;
    const airClass = airGrade === "좋음" ? "" : airGrade === "보통" ? "warn" : "bad";
    const t1 = days[0] || {};
    const t2 = days[1] || {};
    const c1 = t1.emoji ? [t1.emoji, t1.condition] : (COND[t1.condition] || ["🌡️", ""]);
    const c2 = t2.emoji ? [t2.emoji, t2.condition] : (COND[t2.condition] || ["🌡️", ""]);
    $("weatherBody").innerHTML =
      '<div class="wx-top">' +
        '<div class="wx-emoji">' + cc[0] + "</div>" +
        '<div class="wx-now">' +
          '<div class="wx-temp">' + Math.round(nowC.temp) + "°<small>C</small></div>" +
          '<div class="wx-cond">' + cc[1] + " · 체감 " + Math.round(nowC.feels) + "°</div>" +
          '<div class="wx-place">📍 ' + data.family.location.name + "</div>" +
        "</div>" +
        (airGrade
          ? '<div class="wx-air"><span class="air-pill ' + airClass + '">미세먼지 ' + airGrade + "</span>" +
            (air.pm25 ? '<span class="air-pill ' + airClass + '">초미세 ' + air.pm25.grade + "</span>" : "") + "</div>"
          : "") +
      "</div>" +
      '<div class="wx-stats">' +
        '<div class="wx-stat"><span>최고</span><b>' + Math.round(t1.high) + "°</b></div>" +
        '<div class="wx-stat"><span>최저</span><b>' + Math.round(t1.low) + "°</b></div>" +
        '<div class="wx-stat"><span>강수확률</span><b>' + t1.precip + "%</b></div>" +
      "</div>" +
      '<div class="outfit">' +
        '<div class="outfit-h">🎒 등원 옷차림 추천</div>' +
        "<p>" + outfitTip(t1.low, t1.high, t1.precip, c1[1]) + "</p>" +
      "</div>" +
      (t2.date
        ? '<div class="wx-tomorrow"><em>내일</em> ' + c2[0] + " " + c2[1] + " · " + Math.round(t2.low) + "°~" + Math.round(t2.high) + "° · 강수 " + t2.precip + "%</div>"
        : "");
  }
  function fetchT(url, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms || 7000);
    return fetch(url, { signal: ctl.signal }).finally(() => clearTimeout(t));
  }
  async function loadLiveWeather() {
    const loc = data.family.location;
    const url =
      "https://api.open-meteo.com/v1/forecast?latitude=" + loc.lat + "&longitude=" + loc.lon +
      "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m" +
      "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
      "&timezone=Asia%2FSeoul&forecast_days=8";
    const r = await fetchT(url, 7000);
    if (!r.ok) throw new Error("open-meteo " + r.status);
    const j = await r.json();
    const days = j.daily.time.map((t, i) => ({
      date: t,
      condition: wmo(j.daily.weather_code[i])[1],
      emoji: wmo(j.daily.weather_code[i])[0],
      high: Math.round(j.daily.temperature_2m_max[i]),
      low: Math.round(j.daily.temperature_2m_min[i]),
      precip: j.daily.precipitation_probability_max[i] == null ? 0 : j.daily.precipitation_probability_max[i],
    }));
    const cur = j.current;
    const live = {
      now: {
        temp: Math.round(cur.temperature_2m),
        feels: Math.round(cur.apparent_temperature),
        condition: wmo(cur.weather_code)[1],
        emoji: wmo(cur.weather_code)[0],
        humidity: cur.relative_humidity_2m,
        windKmh: Math.round(cur.wind_speed_10m),
      },
      days,
      air: data.weather.air,
      live: true,
    };
    renderWeather(live);
    $("weatherSrc").textContent = "실시간 · Open-Meteo";
    window.__wxLive = live;
  }
  function weatherFallback() {
    renderWeather(data.weather);
    $("weatherSrc").textContent = "스냅샷 · " + (data.weather.obsTime || "").slice(5, 10).replace("-", ".");
  }

  /* ───────────────────────── 선택한 날 카드 ───────────────────────── */
  function renderDay() {
    const ds = state.selected;
    const d = parseISO(ds);
    const isToday = ds === todayStr;
    $("dayTitle").textContent = isToday ? "오늘의 일정" : "그날의 일정";
    $("dayChip").textContent = d.getMonth() + 1 + "월 " + d.getDate() + "일 " + WD[d.getDay()] + "요일";
    const items = dayItems(ds, state.filter);
    const hol = items.filter((i) => i.type === "holiday")[0] || null;
    const rests = hol ? items.filter((i) => i.type !== "holiday") : items;

    if (hol) {
      $("dayBody").innerHTML =
        '<div class="day-holiday">🕯️ 공휴일 · 수업 없음 <span>' + hol.name +
        " — 피아노·어퍼룸·화상수업·유치원 하원 픽업이 모두 쉬어요</span></div>" +
        (rests.length
          ? '<ul class="tl">' + rests.map(tlItem).join("") + "</ul>" +
            '<div class="day-sum"><span>저녁 홈활동은 <b>공휴일에도 그대로</b></span><span>일정 <b>' + rests.length + "건</b></span></div>"
          : "") +
        snackHtml(ds);
      return;
    }
    if (!items.length) {
      $("dayBody").innerHTML =
        '<div class="empty-day">이 날은 학원·화상수업이 없어요 🎈<br><small style="color:#A9B8CC">자유 놀이 · 산책 어때요?</small></div>' + snackHtml(ds);
      return;
    }
    const alert = items.filter((i) => i.important);
    let html = "";
    alert.forEach((a) => {
      html += '<div class="day-alert">⚠️ ' + a.title + " — " + a.note + "</div>";
    });
    html += '<ul class="tl">' + items.map(tlItem).join("") + "</ul>";
    html += snackHtml(ds);
    const kids = state.filter === "all" ? "다은 · 승민" : CHILD[state.filter].name;
    html += '<div class="day-sum"><span>표시: <b>' + kids + "</b></span><span>일정 <b>" + items.length + "건</b></span></div>";
    $("dayBody").innerHTML = html;
  }
  function tlItem(i) {
    const ids = Array.isArray(i.who) ? i.who : i.who ? [i.who] : [];
    const both = ids.length > 1;
    const who = ids.length === 1 ? CHILD[ids[0]] : null;
    const tag = both
      ? '<span class="tag both">다은·승민 공통</span>'
      : who
      ? '<span class="tag ' + who.id + '">' + who.name + " (" + who.ageLabel + ")</span>"
      : "";
    const badge = i.warn ? '<span class="tag warn">' + i.note + "</span>" : "";
    const time = i.time
      ? i.time
      : i.type === "event"
      ? "유치원"
      : i.type === "book"
      ? "도서"
      : "하루";
    return (
      '<li class="tl-item' + (both ? " child-both" : who ? " child-" + who.id : " untimed") + '">' +
      '<span class="tl-time">' + time + "</span>" +
      '<div class="tl-main"><div class="tl-title">' + i.title + " " + tag +
      (i.warn ? "" : " " + badge) +
      "</div>" +
      (i.note && !i.warn ? '<div class="tl-note">' + i.note + "</div>" : "") +
      "</div></li>"
    );
  }
  function snackHtml(ds) {
    const s = SNACKS[ds];
    if (!s) return "";
    return (
      '<div class="snack"><div class="snack-h">🍪 방과후과정 간식</div><p>' + s.join(" · ") + "</p></div>"
    );
  }

  /* ───────────────────────── 급식 카드 ───────────────────────── */
  function weekDates(ds) {
    const d = parseISO(ds);
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const out = [];
    for (let i = 0; i < 7; i++) {
      const x = new Date(monday);
      x.setDate(monday.getDate() + i);
      out.push(iso(x));
    }
    return out;
  }
  function renderMealTabs() {
    const days = weekDates(state.selected);
    if (!days.includes(state.mealDate)) state.mealDate = state.selected;
    $("mealBody").innerHTML =
      '<div class="meal-tabs">' +
      days
        .map((ds) => {
          const d = parseISO(ds);
          const has = (data.meals[ds] || SNACKS[ds]) ? true : false;
          return (
            '<button class="meal-tab' + (ds === state.mealDate ? " is-on" : "") + '" data-date="' + ds + '" type="button">' +
            "<b>" + WD[d.getDay()] + "</b><span>" + (d.getMonth() + 1) + "/" + d.getDate() + (has ? " 🍱" : "") + "</span></button>"
          );
        })
        .join("") +
      "</div>" +
      '<div id="mealDetail"></div>';
    document.querySelectorAll(".meal-tab").forEach((b) =>
      b.addEventListener("click", () => {
        state.mealDate = b.dataset.date;
        renderMealTabs();
        renderMealDetail();
      })
    );
    renderMealDetail();
  }
  function renderMealDetail() {
    const ds = state.mealDate;
    const d = parseISO(ds);
    const m = data.meals[ds];
    const s = SNACKS[ds];
    const el = $("mealDetail");
    if (!m && !s) {
      el.innerHTML = '<div class="meal-empty">' + (d.getMonth() + 1) + "월 " + d.getDate() + "일 (" + WD[d.getDay()] + ") 급식·간식 정보가 없어요 — 주말·공휴일·방학일 수 있어요.</div>";
      return;
    }
    let html = "";
    if (m) {
      html +=
        '<ul class="menu-list">' +
        m.menu
          .map(
            (it) =>
              "<li><span>" + it.name + "</span>" +
              (it.allergy && it.allergy.length ? '<span class="al">' + it.allergy.join("·") + "</span>" : "") +
              "</li>"
          )
          .join("") +
        "</ul>" +
        '<div class="meal-meta"><b>' + m.meal + "</b><span>" + (m.calories || "") + "</span><span>숫자 = 알레르기 번호</span></div>";
    }
    if (s) {
      html += '<div class="snack"><div class="snack-h">🍪 방과후과정 간식 (' + (d.getMonth() + 1) + "/" + d.getDate() + ")</div><p>" + s.join(" · ") + "</p></div>";
    }
    el.innerHTML = html;
  }
  function cleanMenuJS(item) {
    item = item.trim();
    let allergy = [];
    const m = item.match(/\s*\(([0-9.]+)\)\s*$/);
    if (m) {
      allergy = m[1].split(".").filter(Boolean).map(Number);
      item = item.slice(0, m.index).trim();
    }
    item = item.replace(/\s*(nbs|nb|m|n)\s*$/i, "");
    item = item.replace(/\s+[1-3]\s*$/, "");
    return { name: item.replace(/&amp;/g, "&").trim(), allergy };
  }
  async function loadLiveMeals() {
    const n = data.school.neis;
    const y = today.getFullYear(), m = today.getMonth();
    const from = y + pad(m + 1) + "01";
    const to = y + pad(m + 1) + new Date(y, m + 1, 0).getDate();
    const url =
      "https://open.neis.go.kr/hub/mealServiceDietInfo?Type=json&pIndex=1&pSize=100" +
      "&ATPT_OFCDC_SC_CODE=" + n.atptOfcdcScCode + "&SD_SCHUL_CODE=" + n.schulCode +
      "&MLSV_FROM_YMD=" + from + "&MLSV_TO_YMD=" + to;
    const r = await fetchT(url, 7000);
    if (!r.ok) throw new Error("neis " + r.status);
    const j = await r.json();
    const rows = j && j.mealServiceDietInfo && j.mealServiceDietInfo[1] && j.mealServiceDietInfo[1].row;
    if (!rows) throw new Error("neis empty");
    let count = 0;
    rows.forEach((row) => {
      const ymd = row.MLSV_YMD;
      const key = ymd.slice(0, 4) + "-" + ymd.slice(4, 6) + "-" + ymd.slice(6, 8);
      data.meals[key] = {
        menu: row.DDISH_NM.split("<br/>").filter((x) => x.trim()).map(cleanMenuJS),
        calories: (row.CAL_INFO || "").trim(),
        meal: row.MMEAL_SC_NM,
        source: "NEIS",
      };
      count++;
    });
    $("mealSrc").textContent = "NEIS 실시간 ✓ (" + count + "끼)";
    renderMealTabs();
  }

  /* ───────────────────────── 달력 ───────────────────────── */
  function renderCalendar() {
    const y = state.viewYear, m = state.viewMonth;
    $("calMonth").textContent = y + "년 " + m + "월";
    $("calDow").innerHTML = WD.map((w, i) => '<span class="' + (i === 0 ? "sun" : i === 6 ? "sat" : "") + '">' + w + "</span>").join("");
    const first = new Date(y, m - 1, 1);
    const startPad = first.getDay(); // 일요일 시작 (헤더 WD = 일 월 화 수 목 금 토)
    const lastDay = new Date(y, m, 0).getDate();
    const prevLast = new Date(y, m - 1, 0).getDate();
    const cells = [];
    for (let i = startPad; i > 0; i--) cells.push(new Date(y, m - 1, -i + 1));
    for (let d = 1; d <= lastDay; d++) cells.push(new Date(y, m - 1, d));
    while (cells.length % 7 !== 0) cells.push(new Date(y, m, cells.length - startPad - lastDay + 1));
    const ses = sessionsFor(y, m);
    $("calGrid").innerHTML = cells
      .map((d) => {
        const ds = iso(d);
        const inMonth = d.getMonth() + 1 === m;
        const hol = holidayOf(ds);
        const isToday = ds === todayStr;
        const isSel = ds === state.selected;
        let cls = "cell";
        if (!inMonth) cls += " is-out";
        if (d.getDay() === 0 || d.getDay() === 6) cls += " is-weekend";
        if (hol) cls += " is-holiday";
        if (isToday) cls += " is-today";
        if (isSel) cls += " is-selected";
        const daySes = ses[ds] || {};
        const chips = [];
        const dots = [];
        Object.keys(daySes).forEach((sid) => {
          const s = SCHEDULES.find((x) => x.id === sid);
          if (state.filter !== "all" && s.child !== state.filter) return;
          chips.push('<span class="cell-item ' + s.child + '">' + s.title.replace("병설유치원 ", "") + (daySes[sid].over ? " ⚠️" : "") + "</span>");
          if (!dots.includes(s.child)) dots.push(s.child);
        });
        EVENTS.forEach((ev) => {
          if (ev.date !== ds) return;
          if (state.filter !== "all" && ev.child && ev.child !== state.filter) return;
          chips.push('<span class="cell-item ' + (ev.important ? "warn" : "event") + '">' + (ev.important ? "⚠️ " : "") + ev.title + "</span>");
          dots.push("event");
        });
        const evs = eveningSubject(ds);
        if (evs) {
          chips.unshift('<span class="cell-item both">' + evs.emoji + " " + evs.name + "</span>");
          dots.push("both");
        }
        return (
          '<button class="' + cls + '" data-date="' + ds + '" type="button" aria-label="' + ds + '">' +
          '<span class="dnum">' + d.getDate() + "</span>" +
          (hol ? '<span class="hname">' + hol.name + "</span>" : "") +
          '<span class="cell-items">' + chips.slice(0, 3).join("") + (chips.length > 3 ? '<span class="cell-item">+' + (chips.length - 3) + "</span>" : "") + "</span>" +
          '<span class="dots">' + [...new Set(dots)].map((x) => '<i class="dot dot-' + x + '"></i>').join("") + "</span>" +
          "</button>"
        );
      })
      .join("");
    document.querySelectorAll(".cell").forEach((c) =>
      c.addEventListener("click", () => {
        state.selected = c.dataset.date;
        state.mealDate = c.dataset.date;
        renderDay();
        renderCalendar();
        renderMealTabs();
        renderWeek();
        if (window.innerWidth < 660) $("dayCard").scrollIntoView({ behavior: "smooth", block: "start" });
      })
    );
  }

  /* ───────────────────────── 주간 시간표 ───────────────────────── */
  function renderWeek() {
    const rows = ["mon", "tue", "wed", "thu", "fri"];
    const week = weekDates(state.selected);
    const wStart = parseISO(week[0]), wEnd = parseISO(week[6]);
    const range = (wStart.getMonth() + 1) + "/" + wStart.getDate() + " ~ " + (wEnd.getMonth() + 1) + "/" + wEnd.getDate();
    const head = "<tr><th>" + range + "</th>" + (data.children || []).map((c) => {
      if (state.filter !== "all" && state.filter !== c.id) return "";
      return '<th class="' + c.id + '">' + c.name + " (" + c.ageLabel + ")</th>";
    }).join("") + "</tr>";
    let body = "";
    const monday = wStart;
    rows.forEach((wd, idx) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + idx);
      const ds = iso(d);
      const hol = holidayOf(ds);
      const ses = sessionsFor(d.getFullYear(), d.getMonth() + 1);
      let row = "<tr><th>" + WD[idx + 1] + "</th>";
      (data.children || []).forEach((c) => {
        if (state.filter !== "all" && state.filter !== c.id) return;
        if (hol) {
          row += '<td><div class="wk-hol">' + hol.name + " · 수업 없음</div></td>";
          return;
        }
        const lines = [];
        SCHEDULES.filter((s) => s.child === c.id && s.times[wd] != null).forEach((s) => {
          const si = (ses[ds] || {})[s.id];
          const time = si ? si.time : s.times[wd];
          let badge = "";
          if (si && si.over) badge = '<small class="warn">휴강확인</small>';
          else if (si) badge = "<small>" + si.label + "</small>";
          lines.push(
            '<div class="wk-line"><b>' + time + "</b> " + s.title.replace("병설유치원 ", "") + " " + badge +
            (s.note ? "<em> " + s.note + "</em>" : "") +
            "</div>"
          );
        });
        row += "<td>" + (lines.join("") || '<span style="color:#C3CEDD;font-weight:700;font-size:11px">—</span>') + "</td>";
      });
      body += row + "</tr>";
    });
    const evDays = week
      .map((ds, i) => {
        const s = eveningSubject(ds);
        return (
          '<span class="ev-day' + (s ? " is-on" : "") + (ds === todayStr ? " is-today" : "") + '">' +
          "<em>" + WD[(i + 1) % 7] + "</em><b>" +
          (s ? '<span class="ev-emoji">' + s.emoji + '</span><span class="ev-name">' + s.name + "</span>" : "—") +
          "</b></span>"
        );
      })
      .join("");
    $("weekBody").innerHTML =
      '<table class="week-table"><thead>' + head + "</thead><tbody>" + body + "</tbody></table>" +
      '<div class="ev-week"><div class="ev-week-h">🌙 저녁 ' + ((EVENING && EVENING.time) || "20:00") +
      ' · 평일 격일 홈활동 (다은·승민 공통)</div><div class="ev-days">' + evDays + "</div></div>" +
      '<div class="week-more">공휴일에는 수업이 자동으로 쉬어요 · 다은 엘리하이는 매월 1·3차시 18:10 단독, 2·4차시 18:20 격주 · 어퍼룸은 월 8차시, 엘리하이는 월 4차시로 공휴일을 뺀 수업일 기준으로 자동 계산돼요. 저녁 홈활동은 평일(월~금)만 세어 격일로 돌아가요 — 토·일은 쉽니다.</div>';
  }

  /* ───────────────────────── 성장 기록 ───────────────────────── */
  function renderGrowth() {
    const g = data.growth || [];
    $("growthBody").innerHTML =
      '<div class="growth-grid">' +
      g
        .map((k) => {
          const c = CHILD[k.child] || { name: k.child, ageLabel: "", id: k.child };
          if (state.filter !== "all" && state.filter !== k.child) return "";
          const recs = (k.records || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1));
          const last = recs[0];
          const lastH = last && last.height ? last.height : null;
          const lastW = last && last.weight ? last.weight : null;
          const bmi = lastH && lastW ? (lastW / Math.pow(lastH / 100, 2)).toFixed(1) : null;
          return (
            '<div class="kid-card ' + c.id + '">' +
            '<div class="kid-head"><span class="kid-name">' + c.name + '<span class="age">' + c.ageLabel + "</span></span>" +
            '<span class="kid-badge">' + (c.grade || "") + "</span></div>" +
            '<div class="stat-row">' +
              '<div class="stat"><b class="' + (lastH ? "" : "empty") + '">' + (lastH ? lastH + "cm" : "— cm") + "</b><span>키</span></div>" +
              '<div class="stat"><b class="' + (lastW ? "" : "empty") + '">' + (lastW ? lastW + "kg" : "— kg") + "</b><span>몸무게</span></div>" +
              '<div class="stat"><b class="' + (bmi ? "" : "empty") + '">' + (bmi ? bmi : "—") + "</b><span>BMI</span></div>" +
            "</div>" +
            (recs.length
              ? '<ul class="record-list">' + recs.slice(0, 6).map((r) => "<li><span>" + r.date + "</span><span>" + (r.height ? r.height + "cm" : "") + (r.weight ? " · " + r.weight + "kg" : "") + (r.note ? " · " + r.note : "") + "</span></li>").join("") + "</ul>"
              : '<div class="record-empty">아직 기록이 없어요 📏<br>채팅으로 키·몸무게를 알려주시면 날짜와 함께 바로 넣어 드려요!</div>') +
            "</div>"
          );
        })
        .join("") +
      "</div>" +
      '<div class="growth-foot">💡 <b>채팅으로 키·몸무게를 알려주면 바로 업데이트됩니다</b> — 예: "다은 121cm 22kg" · 영유아검진 결과도 기록해 드려요</div>';
  }

  /* ───────────────────────── 강서 인근 체험 예약 ───────────────────────── */
  // 2026-11-18 각 기관 공식 페이지에서 직접 확인한 내용만 넣었습니다.
  const RESERVE = [
    {
      emoji: "🧸",
      name: "서울형 키즈카페 시립 화곡점",
      area: "강서구 화곡 · 우장산역 인근",
      tone: "pink",
      badge: "매주 화 09:00 오픈",
      fit: "다은·승민 둘 다 대상(4~12세)",
      lines: [
        "매주 화요일 9시에 다음 주 화~다다음 주 월 이용분이 열려요. 강서구는 1그룹이라 09:00부터!",
        "아동 5,000원 · 보호자 1명 동반 / 다둥이행복카드 가정은 아동 무료(서울시민)",
        "미끄럼방지 양말 필수(보호자도 양말) · 음식·음료 반입 불가라 텀블러 챙기기 · 일·공휴일 휴관"
      ],
      href: "https://umppa.seoul.go.kr/icare/user/kidsCafe/BD_selectKidsCafeView.do?q_fcltyId=GS241101",
      alt: "https://umppa.seoul.go.kr/icare/user/kidsCafe/BD_selectKidsCafeList.do",
      altLabel: "다른 키즈카페 보기"
    },
    {
      emoji: "🌿",
      name: "서울식물원",
      area: "강서구 마곡 · 마곡동로 161",
      tone: "mint",
      badge: "동절기 09:30~17:00",
      fit: "어린이 2,000원 · 월 휴관",
      lines: [
        "11~2월은 매표·입장 마감이 16:00이고, 월요일 휴관이에요(공휴일이면 다음날).",
        "교육·문화 프로그램은 홈페이지 '교육신청'에서 목록을 보고, 실제 신청은 서울시 공공서비스예약(yeyak) 선착순으로 해요.",
        "겨울축제 〈헤세의 정원〉 관련 프로그램도 교육신청에서 확인할 수 있어요. 5·7세는 초등 대상 '어린이정원학교'보다 가족 프로그램이 맞아요."
      ],
      href: "https://botanicpark.seoul.go.kr/front/participation/eduList.do",
      alt: "https://yeyak.seoul.go.kr/",
      altLabel: "공공서비스예약(yeyak)"
    },
    {
      emoji: "✈️",
      name: "국립항공박물관 어린이공항체험",
      area: "강서구 공항동 · 하늘길 117",
      tone: "blue",
      badge: "화~일 10:00~18:00",
      fit: "만 48개월~미취학 = 둘 다 OK",
      lines: [
        "전시 관람은 무료, 3층 어린이공항체험만 2,000원·45분이에요.",
        "회차당 온라인 13명 + 현장 5명. 온라인 잔여분은 당일 10시부터 현장 발권으로 풀려요.",
        "오전 회차는 일찍 마감되고 오후가 여유로운 편 · 월요일 휴관·입장마감 17:30"
      ],
      href: "https://aviation.mayeye.net/kor/30/expReservation/calendar?gcode=gcode4",
      alt: "https://www.aviation.or.kr/",
      altLabel: "박물관 홈페이지"
    },
    {
      emoji: "📚",
      name: "강서구립 도서관 프로그램",
      area: "우장산숲속 · 마곡열린도서관 등",
      tone: "lilac",
      badge: "프로그램별 접수 · 선착순",
      fit: "우장산숲속도서관은 도보권",
      lines: [
        "'독서·문화·행사 신청'에서 도서관별 프로그램을 접수해요(온라인·방문·선착순 혼합).",
        "마곡열린도서관은 2026.11.14 개관한 AI 특화 도서관이고, 정기휴관은 금요일이에요.",
        "다둥이행복카드 소지 가정은 수강료 감면 대상이라 등본·카드를 챙겨 도서관에 신청해요."
      ],
      href: "https://lib.gangseo.seoul.kr/LibProgramInfo",
      alt: "https://lib.gangseo.seoul.kr/GangseoLibrary",
      altLabel: "도서관 안내"
    },
    {
      emoji: "🎨",
      name: "겸재정선미술관",
      area: "강서구 가양동 · 양천로47길 36",
      tone: "cream",
      badge: "어린이 프로그램 사전접수",
      fit: "2층 진경문화체험실 상시 무료",
      lines: [
        "2층 진경문화체험실에서 퍼즐·탁본·따라그리기 무료 체험. '어린이 겸재 진경교실'은 강서구 문화시설 통합운영시스템에서 접수해요.",
        "만 6세 미만·다둥이행복카드 무료 / 성인 1,000원 · 매월 2·4주 토요일은 무료관람.",
        "월요일 휴관 · 관람 10:00~18:00(입장마감 17:00) · 11/28~29 '별별체험'도 열려요."
      ],
      href: "https://culture.gangseo.seoul.kr/gsfc/education/list.do",
      alt: "https://culture.gangseo.seoul.kr/gsfc/main/contents.do?menuNo=800108",
      altLabel: "관람 안내"
    },
    {
      emoji: "🔭",
      name: "국립어린이과학관",
      area: "종로구 창경궁로 215 · 나들이 코스",
      tone: "blue",
      badge: "관람일 14일 전 0시 오픈",
      fit: "천체투영관 연나이 4세 이상",
      lines: [
        "관람일 14일 전 0시부터 인터넷 예매가 열려요(하루씩 자동 연장). 상설전시관 주말은 인터넷 75%만 풀려요.",
        "천체투영관·빛놀이터는 인터넷 100% 예약. 4~6세는 보호자 표를 따로 사야 해요.",
        "월요일 휴관(공휴일이면 화요일) · 09:30~17:30(입장마감 16:30)"
      ],
      href: "https://www.sciencecenter.go.kr/csc/reserve/reserve-guide",
      alt: "",
      altLabel: ""
    }
  ];

  function renderReserve() {
    $("reserveBody").innerHTML =
      '<div class="res-grid">' +
      RESERVE.map((c) =>
        '<article class="res-card ' + (c.tone || "") + '">' +
          '<div class="res-head"><span class="res-ico">' + c.emoji + '</span>' +
            '<div class="res-title"><b>' + c.name + '</b><span>' + c.area + '</span></div></div>' +
          '<div class="res-tags"><span class="res-badge">⏰ ' + c.badge + '</span>' +
            (c.fit ? '<span class="res-fit">' + c.fit + '</span>' : '') + "</div>" +
          '<ul class="res-lines">' + c.lines.map((l) => "<li>" + l + "</li>").join("") + "</ul>" +
          '<div class="res-actions">' +
            '<a class="res-go" href="' + c.href + '" target="_blank" rel="noopener">바로가기 ↗</a>' +
            (c.alt ? '<a class="res-alt" href="' + c.alt + '" target="_blank" rel="noopener">' + c.altLabel + '</a>' : '') +
          "</div>" +
        "</article>"
      ).join("") +
      "</div>" +
      '<div class="res-foot">🎟️ 예약 오픈 시간·요금은 기관 사정으로 바뀔 수 있어요 — 링크에서 최신 공지를 확인하세요 · 2026.11.18 기준 확인</div>';
  }

  /* ───────────────────────── 수학 놀이터 ─────────────────────────
     문제 출제 규칙은 거실 보드(living.html)와 **같은 엔진** assets/math-engine.js 한 곳에 있습니다.
     (승민 5세 → 덧셈구구 합 9까지 · 뺄셈구구 9 이내 / 다은 7세 → 받아올림·내림 없는 두 자리)
     여기서는 엔진이 만든 문제를 화면에 그리고 채점만 합니다. */
  const math = { answer: null, q: null, lastKey: "", score: { right: 0, total: 0 } };
  /* 수놀이 학습 기록 전송 — 거실 보드(living.js)와 같은 주소·같은 규칙입니다.
     아이가 답을 누를 때마다 익명 기록 한 줄을 보내고(개인정보 없음), 실패는 놀이에 영향을 주지 않습니다. */
  const MATH_LOG_URL = "https://pogeun-mailbox.daseung2024.workers.dev/api/math-log";
  function mathLog(q, chosen) {
    if (!q) return;
    try {
      fetch(MATH_LOG_URL, {
        method: "POST",
        mode: "cors",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          child: q.mode,
          board: "family",
          op: q.op,
          a: q.a,
          b: q.b,
          answer: q.answer,
          chosen: chosen,
          is_correct: chosen === q.answer ? 1 : 0
        })
      }).catch(() => {});
    } catch (e) { /* 기록을 못 보내도 놀이는 계속 */ }
  }
  function mathGen() {
    const eng = window.FamilyMathEngine;
    if (!eng) { console.error("수학 문제 엔진(assets/math-engine.js)을 불러오지 못했어요"); return; }
    const q = eng.generateQuestion(state.mathMode, math.lastKey);
    math.lastKey = q.key;
    math.answer = q.answer;
    math.q = q;
    const a = q.a, b = q.b, op = q.op;
    const level = q.level;
    const arr = q.options;
    $("mathLevel").textContent = level;
    $("mathBody").innerHTML =
      '<div class="q-box" id="qBox"><span class="spark-burst" id="burst">🎉</span>' +
      '<div class="q-level">' + level + "</div>" +
      '<div class="q-text">' + a + '<span class="op">' + (op === "+" ? "+" : "−") + "</span>" + b + " = ?</div>" +
      '<div class="opts">' + arr.map((o) => '<button class="opt" data-v="' + o + '" type="button">' + o + "</button>").join("") + "</div>" +
      '<div class="q-feedback" id="qFb">정답을 골라 보세요!</div></div>' +
      '<div class="math-foot"><span class="sc"> 맞힌 문제 <b id="scR">' + math.score.right + '</b> / 시도 <b id="scT">' + math.score.total + "</b></span>" +
      '<button class="next-btn" id="nextQ" type="button">다음 문제 →</button></div>';
    document.querySelectorAll(".opt").forEach((o) =>
      o.addEventListener("click", () => {
        const v = Number(o.dataset.v);
        const q = math.q;
        const fb = $("qFb");
        const box = $("qBox");
        document.querySelectorAll(".opt").forEach((x) => (x.disabled = true));
        math.score.total++;
        try { mathLog(q, v); } catch (e) { /* 전송 실패는 채점·진행에 영향을 주지 않습니다 */ }
        if (v === math.answer) {
          o.classList.add("correct");
          box.classList.add("pop");
          $("burst").classList.add("on");
          fb.textContent = "정답! 정말 잘했어요 🎉";
          math.score.right++;
        } else {
          o.classList.add("wrong");
          box.classList.add("shake");
          document.querySelector('.opt[data-v="' + math.answer + '"]').classList.add("correct");
          fb.textContent = "앗, 다시 해볼까요? 정답은 " + math.answer + "!";
          fb.classList.add("wrong");
        }
        $("scR").textContent = math.score.right;
        $("scT").textContent = math.score.total;
        setTimeout(mathGen, v === math.answer ? 1100 : 1900);
      })
    );
    $("nextQ").addEventListener("click", mathGen);
  }

  /* ───────────────────────── 필터 · 새로고침 ───────────────────────── */
  document.querySelectorAll("#childFilter .seg-btn").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("#childFilter .seg-btn").forEach((x) => x.classList.remove("is-on"));
      b.classList.add("is-on");
      state.filter = b.dataset.filter;
      renderDay();
      renderCalendar();
      renderWeek();
      renderGrowth();
    })
  );
  $("refreshBtn").addEventListener("click", async () => {
    const btn = $("refreshBtn");
    btn.classList.add("busy");
    try {
      const res = await fetch("data/board-data.json?ts=" + Date.now(), { cache: "no-store" });
      if (res.ok) {
        const fresh = await res.json();
        if (fresh && fresh.meals) { data = fresh; }
      }
    } catch (e) {}
    try { await loadLiveMeals(); } catch (e) { $("mealSrc").textContent = "스냅샷 데이터"; }
    try { await loadLiveWeather(); } catch (e) { weatherFallback(); }
    renderTop();
    renderDay();
    renderMealTabs();
    renderCalendar();
    renderWeek();
    renderReserve();
    renderGrowth();
    btn.classList.remove("busy");
  });

  $("prevMonth").addEventListener("click", () => {
    state.viewMonth--; if (state.viewMonth < 1) { state.viewMonth = 12; state.viewYear--; }
    renderCalendar(); renderWeek();
  });
  $("nextMonth").addEventListener("click", () => {
    state.viewMonth++; if (state.viewMonth > 12) { state.viewMonth = 1; state.viewYear++; }
    renderCalendar(); renderWeek();
  });
  $("goToday").addEventListener("click", () => {
    state.viewYear = today.getFullYear();
    state.viewMonth = today.getMonth() + 1;
    state.selected = todayStr;
    state.mealDate = todayStr;
    renderDay(); renderCalendar(); renderMealTabs(); renderWeek();
  });

  document.querySelectorAll(".math-tab").forEach((t) =>
    t.addEventListener("click", () => {
      document.querySelectorAll(".math-tab").forEach((x) => x.classList.remove("is-on"));
      t.classList.add("is-on");
      state.mathMode = t.dataset.mode;
      mathGen();
    })
  );

  /* ───────────────────────── 렌더 ───────────────────────── */
  renderTop();
  weatherFallback();
  renderDay();
  renderMealTabs();
  renderCalendar();
  renderWeek();
  renderReserve();
  renderGrowth();
  mathGen();

  $("footAttr").innerHTML =
    '<a href="https://developer.apple.com/weatherkit/data-source-attribution/" target="_blank" rel="noopener"> Apple Weather</a>' +
    (data.weather && data.weather.air ? ' <a href="https://www.airkorea.or.kr/" target="_blank" rel="noopener">AirKorea</a>' : "") +
    ' <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a>' +
    ' <a href="https://open.neis.go.kr/" target="_blank" rel="noopener">NEIS 나이스</a>';

  /* 실시간 갱신 (실패 시 스냅샷 유지) */
  loadLiveWeather().catch(() => weatherFallback());
  loadLiveMeals().catch(() => { $("mealSrc").textContent = "스냅샷 데이터"; });
})();
