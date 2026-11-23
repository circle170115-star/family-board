#!/usr/bin/env python3
"""거실 보드 '📖 오늘의 읽을거리' 날짜별 보관함(아카이브) 관리.

매일 새벽 04:00 생성분이 어제 읽을거리를 지우지 않도록, 그날의 그림·오디오를
`assets/reading/archive/YYYY-MM-DD/` 에 그대로 남기고 `data/reading-archive.json`
(최신순 전체 호수 목록)을 갱신합니다.

사용법 (저장소 루트에서):

  # 오늘 만든 읽을거리를 보관 폴더로 복사하고 목록에 올린다 (매일 04:00 생성 직후)
  python3 tools/reading_archive.py snapshot

  # 특정 날짜를 다른 날짜로 저장하고 싶을 때
  python3 tools/reading_archive.py snapshot --date 2026-11-25

  # 지난 호를 git 히스토리에서 되살린다 (JSON 은 --json-from 커밋의 board-data.json)
  python3 tools/reading_archive.py recover --date 2026-11-21 --commit 43679b6

  # 폴더만 보고 목록을 다시 만든다 (수동 복구용)
  python3 tools/reading_archive.py rebuild-index --issues 2026-11-21=1 2026-11-22=2

경로 규칙
  assets/reading/panelN-crop.png   → assets/reading/archive/<date>/panelN-crop.png
  assets/reading/word-banner.png   → assets/reading/archive/<date>/word-banner.png
  assets/reading/audio/x.mp3       → assets/reading/archive/<date>/audio/x.mp3
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import date as _date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
READING = "assets/reading"
ARCHIVE_REL = os.path.join(READING, "archive")
INDEX_REL = os.path.join("data", "reading-archive.json")
BOARD_REL = os.path.join("data", "board-data.json")

AUDIO_KEYS = (
    "audio", "meaningAudio", "bgmAudio", "songAudio",
    "koIntroAudio", "koTipAudio",
)


def p(rel):
    return os.path.join(ROOT, rel)


def rel(path):
    return os.path.relpath(path, ROOT).replace(os.sep, "/")


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(tmp, path)


# ── readingPoster 안의 모든 파일 경로 ────────────────────────────────
def asset_paths(poster):
    """poster 안에서 참조하는 이미지·오디오 경로 목록 (원본 경로)."""
    out = []
    pv = poster.get("proverb") or {}
    wd = poster.get("word") or {}
    if poster.get("image"):
        out.append(poster["image"])
    for k in ("audio", "meaningAudio", "bgmAudio", "songAudio"):
        if pv.get(k):
            out.append(pv[k])
    for panel in pv.get("panels") or []:
        if panel.get("image"):
            out.append(panel["image"])
        if panel.get("audio"):
            out.append(panel["audio"])
    for k in ("audio", "bannerImage", "koIntroAudio", "koTipAudio", "songAudio"):
        if wd.get(k):
            out.append(wd[k])
    for ex in wd.get("examples") or []:
        for k in ("audio", "koAudio"):
            if ex.get(k):
                out.append(ex[k])
    seen, uniq = set(), []
    for x in out:
        if x not in seen:
            seen.add(x)
            uniq.append(x)
    return uniq


def to_archive_path(src, date_str):
    """assets/reading/... → assets/reading/archive/<date>/..."""
    s = src.replace("\\", "/")
    if not s.startswith(READING + "/"):
        return src                      # 이미 외부 주소 등은 그대로
    if s.startswith(ARCHIVE_REL.replace("\\", "/") + "/"):
        return src                      # 이미 보관 경로
    tail = s[len(READING) + 1:]
    return "/".join([ARCHIVE_REL.replace("\\", "/"), date_str, tail])


def rewrite_paths(poster, date_str):
    """깊은 복사본의 모든 경로를 보관 폴더 기준으로 바꿉니다."""
    import copy
    out = copy.deepcopy(poster)
    pv = out.get("proverb")
    if isinstance(pv, dict):
        for k in ("audio", "meaningAudio", "bgmAudio", "songAudio"):
            if pv.get(k):
                pv[k] = to_archive_path(pv[k], date_str)
        for panel in pv.get("panels") or []:
            for k in ("image", "audio"):
                if panel.get(k):
                    panel[k] = to_archive_path(panel[k], date_str)
    wd = out.get("word")
    if isinstance(wd, dict):
        for k in ("audio", "bannerImage", "koIntroAudio", "koTipAudio", "songAudio"):
            if wd.get(k):
                wd[k] = to_archive_path(wd[k], date_str)
        for ex in wd.get("examples") or []:
            for k in ("audio", "koAudio"):
                if ex.get(k):
                    ex[k] = to_archive_path(ex[k], date_str)
    if out.get("image"):
        out["image"] = to_archive_path(out["image"], date_str)
    return out


# ── 배지 문구 정리 — 보관함에서는 '오늘의'를 떼고 '속담 · N호'로 ────────
def normalize_badges(poster, issue_no):
    pv = poster.get("proverb")
    wd = poster.get("word")
    if issue_no:
        if isinstance(pv, dict):
            pv["badge"] = "속담 · %d호" % issue_no
        if isinstance(wd, dict):
            wd["badge"] = "영단어 · %d호" % issue_no
    return poster


# ── 목록(인덱스) ─────────────────────────────────────────────────
def load_index():
    path = p(INDEX_REL)
    if not os.path.exists(path):
        return {"updatedAt": "", "note": "거실 보드 '📖 오늘의 읽을거리' 날짜별 보관함 — 최신 호가 맨 위. tools/reading_archive.py 가 갱신합니다.", "items": []}
    idx = read_json(path)
    idx.setdefault("items", [])
    return idx


def save_index(idx):
    items = [it for it in idx.get("items", []) if it.get("date")]
    items.sort(key=lambda it: it.get("date", ""), reverse=True)
    idx["items"] = items
    idx["updatedAt"] = _date.today().isoformat()
    write_json(p(INDEX_REL), idx)


def upsert(idx, item):
    idx["items"] = [it for it in idx.get("items", []) if it.get("date") != item["date"]]
    idx["items"].append(item)


def next_issue_no(idx, date_str):
    """이미 있는 호수는 그대로, 새 날짜는 가장 큰 호수 + 1 (날짜 순서가 더 자연스러움)."""
    for it in idx.get("items", []):
        if it.get("date") == date_str and it.get("issueNo"):
            return it["issueNo"]
    if not idx["items"]:
        return 1
    return max(int(it.get("issueNo") or 0) for it in idx["items"]) + 1


# ── snapshot: 지금 작업 트리의 읽을거리를 보관 폴더로 ────────────────
def cmd_snapshot(args):
    board = read_json(p(BOARD_REL))
    poster = board.get("readingPoster") or {}
    if not isinstance(poster, dict) or not poster.get("date"):
        sys.exit("board-data.json 의 readingPoster.date 가 없습니다.")
    date_str = args.date or str(poster["date"])[:10]
    poster = dict(poster)
    poster["date"] = date_str

    idx = load_index()
    issue_no = args.issue or next_issue_no(idx, date_str)
    archive = p(os.path.join(ARCHIVE_REL, date_str))

    copied, missing = 0, []
    for src in asset_paths(poster):
        if not src.startswith(READING + "/"):
            continue
        sp = p(src)
        if not os.path.exists(sp):
            missing.append(src)
            continue
        dst = p(to_archive_path(src, date_str))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.abspath(sp) != os.path.abspath(dst):
            shutil.copy2(sp, dst)
        copied += 1

    item = rewrite_paths(poster, date_str)
    item["date"] = date_str
    item["issueNo"] = issue_no
    normalize_badges(item, issue_no)
    upsert(idx, item)
    save_index(idx)

    print("보관 완료: %s (%d호) · 파일 %d개 → %s" % (date_str, issue_no, copied, rel(archive)))
    if missing:
        print("  ⚠ 원본에 없어 건너뜀: " + ", ".join(missing))


# ── recover: git 히스토리에서 지난 호 되살리기 ────────────────────────
def git_show(sha, path):
    r = subprocess.run(["git", "show", "%s:%s" % (sha, path)], cwd=ROOT,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if r.returncode != 0:
        return None
    return r.stdout


def cmd_recover(args):
    date_str = args.date
    sha = args.commit
    json_sha = args.json_from or sha
    raw = git_show(json_sha, BOARD_REL.replace(os.sep, "/"))
    if raw is None:
        sys.exit("커밋 %s 에서 %s 를 찾지 못했습니다." % (json_sha, BOARD_REL))
    poster = (json.loads(raw.decode("utf-8")).get("readingPoster") or {})
    if not isinstance(poster, dict) or not poster.get("proverb") and not poster.get("word"):
        sys.exit("커밋 %s 의 readingPoster 가 비어 있습니다." % json_sha)
    poster = dict(poster)
    poster["date"] = date_str

    idx = load_index()
    issue_no = args.issue or next_issue_no(idx, date_str)

    saved, missing = 0, []
    for src in asset_paths(poster):
        if not src.startswith(READING + "/"):
            continue
        data = git_show(sha, src)
        if data is None:
            missing.append(src)
            continue
        dst = p(to_archive_path(src, date_str))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "wb") as f:
            f.write(data)
        saved += 1

    item = rewrite_paths(poster, date_str)
    item["date"] = date_str
    item["issueNo"] = issue_no
    normalize_badges(item, issue_no)
    upsert(idx, item)
    save_index(idx)

    print("복원 완료: %s (%d호) · 파일 %d개" % (date_str, issue_no, saved))
    if missing:
        print("  ⚠ 그 커밋에 없던 파일: " + ", ".join(missing))


# ── rebuild-index: 폴더 기준으로 목록 다시 만들기 ────────────────────
def cmd_rebuild(args):
    issue_map = {}
    for pair in args.issues or []:
        d, n = pair.split("=")
        issue_map[d] = int(n)
    folder = p(ARCHIVE_REL)
    dates = sorted([d for d in os.listdir(folder) if re.match(r"^\d{4}-\d{2}-\d{2}$", d)], reverse=True) if os.path.isdir(folder) else []
    idx = load_index()
    have = {it["date"]: it for it in idx.get("items", [])}
    items = []
    for d in dates:
        if d in have:
            items.append(have[d])
    idx["items"] = items
    save_index(idx)
    print("목록 정리: %d개 호수 (%s)" % (len(items), ", ".join(dates)))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("snapshot", help="지금 읽을거리를 날짜별 보관 폴더로 복사하고 목록에 올림")
    s.add_argument("--date")
    s.add_argument("--issue", type=int)
    s.set_defaults(func=cmd_snapshot)

    r = sub.add_parser("recover", help="git 히스토리의 지난 호를 보관 폴더로 되살림")
    r.add_argument("--date", required=True)
    r.add_argument("--commit", required=True)
    r.add_argument("--json-from")
    r.add_argument("--issue", type=int)
    r.set_defaults(func=cmd_recover)

    b = sub.add_parser("rebuild-index", help="보관 폴더만 보고 목록을 정리")
    b.add_argument("--issues", nargs="*")
    b.set_defaults(func=cmd_rebuild)

    args = ap.parse_args()
    os.chdir(ROOT)
    args.func(args)


if __name__ == "__main__":
    main()
