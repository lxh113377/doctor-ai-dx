#!/usr/bin/env python3
"""语料与评测结果 → MySQL 导入器 + 回读对账（第一百零八轮）。

单源纪律（仓根 AGENTS.md 第 4 条 / #92）：`data/*.json` 是**唯一权威源**，本脚本只做
「权威源 → 派生下游」的单向灌库。库里**不承载任何编辑动作**——要改语料去改 JSON，
再跑 `npm --prefix frontend run kb:export` 与本脚本重灌；谁往库里写语料谁就是
在造第二份真值，`--verify` 与 CI 判据都会红。

形状（实测，六份全为单文档 dict）：元数据键 = `schema_version` 与 `_` 前缀键，
其余顶层键视作 payload；payload 逐键落行，`entry_key=<顶层键名>`、`seq=列表内序号`
（标量取 0）。评测面默认不灌，只吃显式传入的 `--eval` 报告，防把大仓之外的东西静默搬进来。

用法：
  python scripts/mysql_load_corpus.py --load                 # 全量重灌 + 回读对账（一条命令闭环）
  python scripts/mysql_load_corpus.py --verify               # 只对账不写（rc=1 点名漂移键）
  python scripts/mysql_load_corpus.py --status               # 读数：每面行数与指纹
  python scripts/mysql_load_corpus.py --load --eval <report.json> [--eval ...]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import UTC, datetime

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "backend"))

DATA_DIR = os.path.join(REPO, "data")
META_KEYS = {"schema_version"}
# 评测行不该有"匿名 run"：没给 run_id 就自己从文件名+内容指纹造一个，重复导入同一份文件幂等。
RUN_ID_SUFFIX_LEN = 8


def now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def canonical(payload) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def rows_for_file(path: str, corpus_sha: str) -> list[dict]:
    """单份语料 JSON → corpus_entries 行集。形状断言写在这里，不在调用方。"""
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    doc = json.loads(raw)
    if not isinstance(doc, dict):
        raise ValueError(f"{os.path.basename(path)} 顶层应为 dict（实测 {type(doc).__name__}）")
    source = os.path.basename(path)
    out: list[dict] = []
    for key, val in doc.items():
        if key in META_KEYS or key.startswith("_"):
            continue
        items = val if isinstance(val, list) else [val]
        for seq, item in enumerate(items):
            payload = canonical(item)
            title = None
            if isinstance(item, dict):
                title = item.get("title") or item.get("name") or None
            out.append({
                "source_file": source, "entry_key": key, "seq": seq,
                "title": title if isinstance(title, str) else None,
                "payload": payload, "payload_sha256": sha(payload), "corpus_sha256": corpus_sha,
            })
    if not out:
        raise ValueError(f"{source} 没有可识别的 payload 键（全是元数据）——空行集不得静默过")
    return out


def eval_rows(paths: list[str]) -> tuple[list[dict], list[dict]]:
    """评测报告 → (eval_reports 行, eval_case_modes 行)。"""
    reports, cases = [], []
    for path in paths:
        with open(path, "rb") as f:
            raw_bytes = f.read()
        digest = hashlib.sha256(raw_bytes).hexdigest()
        doc = json.loads(raw_bytes.decode("utf-8"))
        stem = os.path.splitext(os.path.basename(path))[0]
        run_id = f"{stem}-{digest[:RUN_ID_SUFFIX_LEN]}"
        mode_by_case = doc.get("mode_by_case") or {}
        reports.append({
            "run_id": run_id,
            "report_file": os.path.basename(path),
            "report_sha256": digest,
            "report_date": doc.get("date"),
            "base": doc.get("base"),
            "case_count": len(mode_by_case),
            "summary": canonical(doc),
            "created_at": now(),
        })
        for case_id, info in mode_by_case.items():
            cases.append({
                "run_id": run_id, "case_id": case_id,
                "mode": str(info.get("mode", "")),
                "abstain": 1 if info.get("abstain") else 0,
                "cause": info.get("cause") or None,
                "has_cause_field": 1 if info.get("has_cause_field") else 0,
            })
    return reports, cases


def engine_or_exit():
    from app.db import engine as db_engine

    eng, reason = db_engine.current_engine()
    if eng is None:
        print(f"FAIL 引擎不可用：{reason}")
        print("[GATE:mysql-corpus-fail]")
        sys.exit(1)
    return eng


def collect(source_files: list[str], eval_paths: list[str]) -> dict[str, list[dict]]:
    from app.db.models import CorpusEntry

    rows: dict[str, list[dict]] = {}
    for path in source_files:
        with open(path, "rb") as f:
            corpus_sha = hashlib.sha256(f.read()).hexdigest()
        for r in rows_for_file(path, corpus_sha):
            assert all(k in CorpusEntry.__table__.columns for k in r), f"行字段越界：{sorted(r)}"
            rows.setdefault("corpus", []).append(r)
    reports, cases = eval_rows(eval_paths)
    rows["eval_reports"], rows["eval_case_modes"] = reports, cases
    return rows


def load(rows: dict[str, list[dict]]) -> int:
    from app.db.models import CorpusEntry, EvalCaseMode, EvalReport
    from sqlalchemy import delete, insert

    eng = engine_or_exit()
    total = 0
    with eng.begin() as conn:
        sources = sorted({r["source_file"] for r in rows["corpus"]})
        for s in sources:  # 按文件整体替换：语料重灌必须幂等，禁 append 出第二份账
            conn.execute(delete(CorpusEntry).where(CorpusEntry.source_file == s))
        run_ids = [r["run_id"] for r in rows["eval_reports"]]
        for rid in run_ids:
            conn.execute(delete(EvalCaseMode).where(EvalCaseMode.run_id == rid))
            conn.execute(delete(EvalReport).where(EvalReport.run_id == rid))
        if rows["corpus"]:
            # Core insert（表级 insert）不走 ORM 默认值 ⇒ loaded_at 必须在这里补；
            # 第一次真灌就因缺这列被 MySQL 1364 拒（建表时 NOT NULL），整事务回滚。
            stamp = now()
            conn.execute(insert(CorpusEntry),
                         [{**r, "loaded_at": stamp} for r in rows["corpus"]])
            total += len(rows["corpus"])
        if rows["eval_reports"]:
            conn.execute(insert(EvalReport), rows["eval_reports"])
            conn.execute(insert(EvalCaseMode), rows["eval_case_modes"])
            total += len(rows["eval_reports"]) + len(rows["eval_case_modes"])
    return total


def verify(source_files: list[str]) -> tuple[int, list[str]]:
    """回读对账：逐文件逐键比对条数与 payload 指纹。返回 (比对数, 失败项)。"""
    from app.db.models import CorpusEntry
    from sqlalchemy import select

    eng = engine_or_exit()
    fails: list[str] = []
    checked = 0
    with eng.connect() as conn:
        for path in source_files:
            source = os.path.basename(path)
            with open(path, "rb") as f:
                file_sha = hashlib.sha256(f.read()).hexdigest()
            expected = rows_for_file(path, file_sha)
            stored = conn.execute(
                select(CorpusEntry.entry_key, CorpusEntry.seq, CorpusEntry.payload_sha256,
                       CorpusEntry.corpus_sha256)
                .where(CorpusEntry.source_file == source)
            ).all()
            got = {(k, s): (h, c) for k, s, h, c in stored}
            want = {(r["entry_key"], r["seq"]): (r["payload_sha256"], file_sha) for r in expected}
            checked += 1
            if len(got) != len(want):
                fails.append(f"{source}: 行数 源{len(want)} ≠ 库{len(got)}")
            for key, (h, c) in want.items():
                if key not in got:
                    fails.append(f"{source}:{key[0]}[{key[1]}] 库里缺失")
                    continue
                if got[key][0] != h:
                    fails.append(f"{source}:{key[0]}[{key[1]}] 指纹漂移 源{h[:12]} ≠ 库{got[key][0][:12]}")
                if got[key][1] != c:
                    fails.append(f"{source}:{key[0]}[{key[1]}] 整文件指纹漂移（库是旧一版语料）")
            for key in sorted(set(got) - set(want)):
                fails.append(f"{source}:{key[0]}[{key[1]}] 库里多出（库侧被手写？）")
    return checked, fails


def status(source_files: list[str]) -> int:
    from app.db.models import CorpusEntry, EvalCaseMode, EvalReport
    from sqlalchemy import func, select

    eng = engine_or_exit()
    with eng.connect() as conn:
        corpus = conn.execute(
            select(CorpusEntry.source_file, func.count())
            .group_by(CorpusEntry.source_file).order_by(CorpusEntry.source_file)
        ).all()
        print(f"corpus_entries 共 {sum(n for _, n in corpus)} 行 / {len(corpus)} 面")
        for s, n in corpus:
            print(f"  {s}: {n} 行")
        print(f"eval_reports {conn.execute(select(func.count()).select_from(EvalReport)).scalar()} 行 / "
              f"eval_case_modes {conn.execute(select(func.count()).select_from(EvalCaseMode)).scalar()} 行")
    declared_faces = {os.path.basename(p) for p in source_files}
    stored_faces = {s for s, _ in corpus}
    missing = sorted(declared_faces - stored_faces)
    if missing:
        print(f"WARN 权威面在盘上但库里没有：{missing}（先 --load）")
        print("[GATE:mysql-corpus-fail]")
        return 1
    print("[GATE:mysql-corpus-status-pass]")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--load", action="store_true")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--eval", action="append", default=[], help="评测报告 JSON 路径（可重复）")
    ap.add_argument("--data-dir", default=DATA_DIR)
    args = ap.parse_args()
    if not (args.load or args.verify or args.status):
        ap.error("需要 --load / --verify / --status 之一")

    data_files = sorted(
        os.path.join(args.data_dir, n) for n in os.listdir(args.data_dir) if n.endswith(".json")
    )
    if not data_files:
        print(f"FAIL 语料目录为空：{args.data_dir}")
        print("[GATE:mysql-corpus-fail]")
        return 1
    rows = collect(data_files, args.eval)

    if args.load:
        n = load(rows)
        print(f"已灌 {n} 行（corpus {len(rows['corpus'])} / reports {len(rows['eval_reports'])} / "
              f"case_modes {len(rows['eval_case_modes'])}）")
    if args.verify or args.load:
        checked, fails = verify(data_files)
        for f in fails:
            print(f"  FAIL {f}")
        verdict = "pass" if not fails and checked == len(data_files) else "fail"
        print(f"VERIFY: {checked}/{len(data_files)} 面对账 rc={0 if verdict == 'pass' else 1}")
        print(f"[GATE:mysql-corpus-{verdict}]")
        return 0 if verdict == "pass" else 1

    return status(data_files)


if __name__ == "__main__":
    sys.exit(main())
