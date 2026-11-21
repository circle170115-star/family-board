/*!
 * 우리 집 모아보드 · 거실 등원 보드 — 공통 수학 문제 엔진
 * assets/math-engine.js   ·   window.FamilyMathEngine
 *
 * ▶ 왜 한 파일인가
 *   index.html(assets/app.js · 모아보드 수학 놀이터)과
 *   living.html(assets/living.js · 거실 더하기·빼기 놀이)이 **같은 문제 규칙**을 쓰도록
 *   문제를 만드는 곳을 이 파일 하나로 모았습니다.
 *   단계(레벨)를 올리거나 범위를 바꿀 때는 아래 LEVEL_CONFIG 만 고치면 두 보드가 동시에 바뀝니다.
 *   UI(탭 이름·문제 화면 모양·점수·다음 문제 넘기기)는 각 보드 파일에 그대로 있습니다.
 *
 * ▶ 쓰는 법
 *   <script src="assets/math-engine.js?v=..."></script>   ← app.js / living.js 보다 먼저
 *   const q = FamilyMathEngine.generateQuestion("seungmin", prevKey);
 *   // q = { mode, child, a, b, op, answer, key, text, level, tab, options:[4개] }
 *   // prevKey 에 직전 문제의 q.key 를 넘기면 같은 식이 연속으로 나오지 않습니다.
 *   FamilyMathEngine.checkAnswer(q, 누른 번호)   // true / false
 *   FamilyMathEngine.levels()                    // [{id, child, tab, level, range}, ...]
 *
 * ▶ 현재 규칙 (2026-11-21)
 *   승민(5세) seungmin
 *     · 덧셈구구(합 9까지): a = 1~9, b = 0~(9-a) → 답 1~9
 *     · 뺄셈구구(9 이내):   a = 1~9, b = 1~a      → 답 0~8
 *     · 덧셈·뺄셈 50:50, 보기 4개는 0~9 안의 서로 다른 수
 *   다은(7세) daeun
 *     · 받아올림 없는 두 자리 덧셈: a = 10~89(a1 1~8, a0 0~9), b = 10~89(b1 1~(9-a1), b0 0~(9-a0)) → 합 20~99
 *     · 받아내림 없는 두 자리 뺄셈: a = 20~99(a1 2~9, a0 0~9), b = 10~89(b1 1~(a1-1), b0 0~a0) → 차 10~89
 *     · 덧셈·뺄셈 50:50, 보기 4개는 정답 ±1·±2·±10 중 0~99 안의 서로 다른 수
 *   두 단계 모두 직전 문제와 같은 식(a와 b와 연산자가 모두 같음)은 연속으로 나오지 않습니다.
 */
(function (global) {
  "use strict";

  var ENGINE_VERSION = "20261121a";
  var DEFAULT_LEVEL = "seungmin";
  var OP = { plus: "+", minus: "−" };   /* 화면에 쓰는 기호 그대로 키로 씁니다 */

  /* ── 작은 도구 ───────────────────────────────────────────── */
  function randInt(min, max) {                 /* min~max (양 끝 포함) */
    return min + Math.floor(Math.random() * (max - min + 1));
  }
  function pickOne(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function keyOf(q) {
    return q.a + q.op + q.b;
  }

  /* ── 단계(레벨) 설정 — 문제 규칙을 바꾸는 유일한 곳 ───────────
     ops      : 나오는 연산자. 두 개를 같은 확률로 뽑으므로 50:50.
     build    : 연산자 하나를 받아 {a, b, op, answer} 를 만드는 함수.
     options  : 보기 4개 규칙. deltas 가 있으면 정답±d 로 헷갈리는 오답,
                없으면 min~max 안에서 서로 다른 수를 아무거나.
     범위(min/max)는 보기가 0~9(승민)와 0~99(다은)를 벗어나지 않게 잡습니다. */
  var LEVEL_CONFIG = {
    seungmin: {
      id: "seungmin",
      child: "승민",
      age: "5세",
      tab: "5세 · 덧셈·뺄셈(9까지)",
      level: "승민(5세) · 덧셈·뺄셈 9까지",
      range: "덧셈구구(합 9까지) · 뺄셈구구(9 이내)",
      ops: [OP.plus, OP.minus],
      options: { min: 0, max: 9, deltas: null },
      build: function (op) {
        if (op === OP.plus) {                   /* 덧셈구구: 합이 9까지 */
          var a = randInt(1, 9);                /* 1~9 */
          var b = randInt(0, 9 - a);            /* 0~(9-a) */
          return { a: a, b: b, op: OP.plus, answer: a + b };   /* 답 1~9 */
        }
        var x = randInt(1, 9);                  /* 뺄셈구구: 9 이내 */
        var y = randInt(1, x);                  /* 1~a */
        return { a: x, b: y, op: OP.minus, answer: x - y };    /* 답 0~8 */
      }
    },

    daeun: {
      id: "daeun",
      child: "다은",
      age: "7세",
      tab: "7세 · 받아올림·내림 없는 두 자리",
      level: "다은(7세) · 받아올림·내림 없는 두 자리",
      range: "받아올림 없는 두 자리 덧셈 · 받아내림 없는 두 자리 뺄셈",
      ops: [OP.plus, OP.minus],
      options: { min: 0, max: 99, deltas: [1, -1, 2, -2, 10, -10] },
      build: function (op) {
        if (op === OP.plus) {
          /* 각 자리 합이 9를 넘지 않게 → 받아올림 0 */
          var a1 = randInt(1, 8);               /* 십의 자리 1~8 */
          var a0 = randInt(0, 9);               /* 일의 자리 0~9 */
          var b1 = randInt(1, 9 - a1);          /* 십의 자리 1~(9-a1) */
          var b0 = randInt(0, 9 - a0);          /* 일의 자리 0~(9-a0) */
          var a = a1 * 10 + a0;                 /* 10~89 */
          var b = b1 * 10 + b0;                 /* 10~89 */
          return { a: a, b: b, op: OP.plus, answer: a + b };    /* 답 20~99 */
        }
        /* 각 자리에서 a0 >= b0, a1 > b1 → 받아내림 0, 답은 10 이상 */
        var s1 = randInt(2, 9);                 /* 십의 자리 2~9 */
        var s0 = randInt(0, 9);                 /* 일의 자리 0~9 */
        var t1 = randInt(1, s1 - 1);            /* 십의 자리 1~(a1-1) */
        var t0 = randInt(0, s0);                /* 일의 자리 0~a0 */
        var x = s1 * 10 + s0;                   /* 20~99 */
        var y = t1 * 10 + t0;                   /* 10~89 */
        return { a: x, b: y, op: OP.minus, answer: x - y };     /* 답 10~89 */
      }
    }
  };

  /* ── 보기 4개 (정답 + 오답 3개, 중복 없음) ─────────────────── */
  function buildOptions(cfg, answer) {
    var rule = cfg.options || {};
    var min = typeof rule.min === "number" ? rule.min : 0;
    var max = typeof rule.max === "number" ? rule.max : 99;
    var chosen = [answer];
    var used = {};
    used[answer] = true;

    if (rule.deltas && rule.deltas.length) {
      var near = shuffle(rule.deltas);
      for (var i = 0; i < near.length && chosen.length < 4; i++) {
        var v = answer + near[i];
        if (v < min || v > max || used[v]) continue;
        used[v] = true;
        chosen.push(v);
      }
    }
    var guard = 0;
    while (chosen.length < 4 && guard++ < 500) {
      var r = randInt(min, max);
      if (used[r]) continue;
      used[r] = true;
      chosen.push(r);
    }
    return shuffle(chosen);
  }

  /* ── 문제 하나 만들기 ─────────────────────────────────────── */
  function generateQuestion(mode, prevKey) {
    var cfg = LEVEL_CONFIG[mode] || LEVEL_CONFIG[DEFAULT_LEVEL];
    var prev = prevKey === undefined || prevKey === null ? "" : String(prevKey);
    var raw = null, key = "", tries = 0;

    do {
      raw = cfg.build(pickOne(cfg.ops));        /* 덧셈·뺄셈 50:50 */
      key = keyOf(raw);
    } while (prev && key === prev && ++tries < 40);   /* 직전 식 연속 중복 방지 */

    return {
      mode: cfg.id,
      child: cfg.child,
      age: cfg.age,
      a: raw.a,
      b: raw.b,
      op: raw.op,
      answer: raw.answer,
      key: key,
      text: raw.a + " " + raw.op + " " + raw.b,
      level: cfg.level,
      tab: cfg.tab,
      range: cfg.range,
      options: buildOptions(cfg, raw.answer)
    };
  }

  function checkAnswer(q, value) {
    if (!q) return false;
    return Number(value) === Number(q.answer);
  }

  /* 탭·안내 문구를 화면에서 한 번에 맞출 때 쓰는 목록 */
  function levels() {
    return Object.keys(LEVEL_CONFIG).map(function (k) {
      var c = LEVEL_CONFIG[k];
      return { id: c.id, child: c.child, age: c.age, tab: c.tab, level: c.level, range: c.range };
    });
  }

  global.FamilyMathEngine = {
    version: ENGINE_VERSION,
    LEVEL_CONFIG: LEVEL_CONFIG,
    DEFAULT_LEVEL: DEFAULT_LEVEL,
    generateQuestion: generateQuestion,
    checkAnswer: checkAnswer,
    levels: levels
  };
})(typeof window !== "undefined" ? window : this);
