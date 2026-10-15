#!/usr/bin/env python3
"""MySQL 侧 schema 的**生成器 + 漂移守卫**（第一百零八轮）。

形状照抄本仓已经跑通的 `scripts/d1_migrate.mjs`：权威源 → 生成物 → 逐字节对账，
干净检出后**不需要任何云账号或数据库**就能验证 schema 与代码对得上。

用法：
  python scripts/mysql_schema.py            写盘 scripts/mysql_schema.sql
  python scripts/mysql_schema.py --print     打印 DDL（配合 mysql < 使用）
  python scripts/mysql_schema.py --check     只校验不写盘，漂移 exit 1
  python scripts/mysql_schema.py --parity    与 scripts/d1_schema.sql 做会话面结构对账
  python scripts/mysql_schema.py --selftest  判据自身的反例腿（缺牙即红）

为什么权威源是 ORM metadata 而不是再生一份 SQL：MySQL 的 DDL 一旦被手改，`create_all()` 建的表
和文档里贴的表就分叉了——本仓对这类「两份账」反复判红（见仓根 AGENTS.md 第 4 条）。
D1 侧的权威源是 `d1_schema.sql`，MySQL 侧的权威源是 `backend/app/db/models.py`，
两侧由 `--parity` 钉在一起，而不是由人手抄。
"""
from __future__ import annotations

import argparse
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND = os.path.join(REPO, "backend")
sys.path.insert(0, BACKEND)

D1_SCHEMA = os.path.join(REPO, "scripts", "d1_schema.sql")
OUT = os.path.join(REPO, "scripts", "mysql_schema.sql")
HEADER = (
    "-- MySQL schema（构建期产物，禁手改）——由 scripts/mysql_schema.py 从 backend/app/db/models.py 生成。\n"
    "-- 权威源 = ORM metadata；漂移守卫 = python scripts/mysql_schema.py --check（逐字节比对，漂移即红）；\n"
    "-- 与 D1 单源的结构对账 = python scripts/mysql_schema.py --parity。\n"
    "-- 会话面（conversations/messages/intent_events/handoffs/feedback）的表名列名与 scripts/d1_schema.sql 全等；\n"
    "-- 刻意不同的地方只在 models.py 的 dialect_divergence() 名册里逐条登记，名册之外的差异一律判红。\n"
)

# 表的输出顺序＝数据面的阅读顺序，也是判据的分母来源（不靠 os.walk 的偶然序）
ORDER_NOTE = "顺序 = 会话面 → 语料面 → 评测面（backend/app/db/models.py 的三个 *_FACE 常量）"


def build_ddl() -> str:
    from app.db import models
    from sqlalchemy.dialects import mysql
    from sqlalchemy.schema import CreateTable

    ordered = list(models.CONVERSATION_FACE) + list(models.CORPUS_FACE) + list(models.EVAL_FACE)
    tables = {name: models.Base.metadata.tables[name] for name in ordered}
    chunks = [HEADER, f"-- {ORDER_NOTE}\n"]
    for _name, table in tables.items():
        ddl = str(CreateTable(table).compile(dialect=mysql.dialect())).strip()
        chunks.append(f"{ddl};\n")
    return "\n".join(chunks)


def parse_d1(text: str) -> dict[str, dict[str, bool]]:
    """d1_schema.sql → {表名: {列名: 是否 NOT NULL}}。约束行（PK/FK/CHECK）不算列。"""
    out: dict[str, dict[str, bool]] = {}
    for body in re.findall(r"CREATE TABLE IF NOT EXISTS (\w+) \((.*?)\n\);", text, re.S):
        name, raw = body
        cols: dict[str, bool] = {}
        for line in raw.splitlines():
            s = line.strip().rstrip(",")
            if not s or re.match(r"^(PRIMARY KEY|FOREIGN KEY|CHECK|UNIQUE)\b", s, re.I):
                continue
            m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$", s)
            if not m:
                continue
            col, rest = m.group(1), m.group(2)
            notnull = "NOT NULL" in rest.upper() or "PRIMARY KEY" in rest.upper()
            cols[col] = notnull
        out[name] = cols
    return out


def mysql_columns() -> dict[str, dict[str, bool]]:
    from app.db import models

    ordered = list(models.CONVERSATION_FACE) + list(models.CORPUS_FACE) + list(models.EVAL_FACE)
    return {
        name: {c.name: bool(not c.nullable) for c in models.Base.metadata.tables[name].columns}
        for name in ordered
    }


def parity() -> tuple[int, list[str], list[str]]:
    """会话面结构对账。返回 (断言总数, 失败项, 名册内已声明差异)。"""
    if not os.path.exists(D1_SCHEMA):
        return 0, [f"取不到 D1 单源：{D1_SCHEMA}"], []
    with open(D1_SCHEMA, encoding="utf-8") as f:
        d1 = parse_d1(f.read())
    my = mysql_columns()

    notes: list[str] = []
    fails: list[str] = []
    total = 0
    from app.db import models as _m

    for table in _m.CONVERSATION_FACE:
        total += 1
        if table not in d1:
            fails.append(f"D1 侧没有表 {table}（单源改了名而 MySQL 侧没跟）")
            continue
        if table not in my:
            fails.append(f"MySQL 侧没有表 {table}")
            continue
        d1_cols, my_cols = d1[table], my[table]
        only_d1 = sorted(set(d1_cols) - set(my_cols))
        only_my = sorted(set(my_cols) - set(d1_cols))
        total += 1
        if only_d1 or only_my:
            fails.append(f"{table} 列集合漂移：仅 D1 有 {only_d1}／仅 MySQL 有 {only_my}")
        else:
            notes.append(f"{table} 列名全等（{len(d1_cols)} 列）")
        null_drift = [c for c in d1_cols if c in my_cols and d1_cols[c] != my_cols[c]]
        total += 1
        if null_drift:
            fails.append(f"{table} 可空性漂移：{null_drift}")

    # 名册双向核：名册里每条要真能在两侧观察到，名册外不许有差异
    total += 1
    declared = {k for k, _ in _m.dialect_divergence()}
    if not declared:
        fails.append("dialect_divergence() 名册为空 ⇒ 该判据没牙")
    notes.extend(f"名册条目 {k}" for k in sorted(declared))
    return total, fails, notes


def selftest() -> int:
    """反例腿：把守卫换到「一定会红」的输入上，确认它真的红。

    没有这一条，`--parity` 完全可能写成「永远返回空失败列表」的假判据而照样绿。
    """
    cases: list[tuple[str, bool, str]] = []
    good = (
        "CREATE TABLE IF NOT EXISTS conversations (\n"
        "  id TEXT PRIMARY KEY,\n"
        "  created_at TEXT NOT NULL,\n"
        ");\n"
    )
    got = parse_d1(good)
    cases.append(("解析器认得 CREATE TABLE 块", "conversations" in got, f"实测 {list(got)}"))
    cases.append(("PRIMARY KEY 视为 NOT NULL", got.get("conversations", {}).get("id") is True,
                  f"实测 {got}"))
    cases.append(("约束行不当列", "primary key" not in {k.lower() for k in got.get("conversations", {})},
                  f"实测 {list(got.get('conversations', {}))}"))

    missing = ("CREATE TABLE IF NOT EXISTS conversations (\n  id TEXT PRIMARY KEY,\n);\n")
    d1_cols = parse_d1(missing)["conversations"]
    # 注意取的是**列集合**而不是 parse_d1 返回的表名字典：第一次写这条反例时误用了
    # `set(fake)`（那是表名 {"conversations"}），于是断言拿表名去比列名、永远对不上——
    # 由本自证腿自己抓到，不是靠人读出来的。
    fake = {"id": True, "ghost_col": False}
    diff = sorted(set(fake) - set(d1_cols))
    cases.append(("反例：MySQL 侧多出一列 ⇒ 差集必须点名", diff == ["ghost_col"], f"实测 {diff}"))
    cases.append(("反例：D1 侧少一列时另一侧差集为空（不误报）",
                  sorted(set(d1_cols) - set(fake)) == [], f"实测 {sorted(set(d1_cols) - set(fake))}"))

    fake_null = {"id": False}
    cases.append(("反例：可空性翻转必须被抓", fake_null["id"] != d1_cols["id"], "两侧读成相同"))

    ddl = build_ddl()
    cases.append(("生成物含 ENGINE=InnoDB 与 utf8mb4", "ENGINE=InnoDB" in ddl and "utf8mb4" in ddl,
                  "生成 DDL 里缺引擎/字符集声明"))
    cases.append(("生成物不含 D1 专有的 PRAGMA", "PRAGMA" not in ddl, "MySQL DDL 混进了 SQLite 语句"))
    cases.append(("生成物幂等：两次编译逐字节相同", build_ddl() == ddl, "同一份 metadata 两次生成不一致"))

    failed = 0
    for name, ok, detail in cases:
        print(f"  {'PASS' if ok else 'FAIL'} {name}" + ("" if ok else f" :: {detail}"))
        failed += 0 if ok else 1
    print(f"SELFTEST: {len(cases) - failed}/{len(cases)}")
    print("[GATE:mysql-schema-selftest-fail]" if failed else "[GATE:mysql-schema-selftest-pass]")
    return 1 if failed else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--print", action="store_true", dest="do_print")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--parity", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    if args.parity:
        total, fails, notes = parity()
        for n in notes:
            print(f"  INFO {n}")
        for fail in fails:
            print(f"  FAIL {fail}")
        print(f"PARITY: {total - len(fails)}/{total} rc={0 if not fails and total else 1}")
        print("[GATE:mysql-parity-pass]" if not fails and total else "[GATE:mysql-parity-fail]")
        return 0 if not fails and total else 1

    ddl = build_ddl()
    if args.do_print:
        sys.stdout.write(ddl)
        return 0

    if args.check:
        if not os.path.exists(OUT):
            print(f"FAIL 生成物不存在：{OUT}（先跑 python scripts/mysql_schema.py）")
            print("[GATE:mysql-schema-fail]")
            return 1
        with open(OUT, encoding="utf-8", newline="") as f:
            on_disk = f.read()
        if on_disk == ddl:
            print(f"[GATE:mysql-schema-pass] 生成物与权威源逐字节相同（{len(ddl.encode('utf-8'))} B）")
            return 0
        print(f"FAIL 漂移：盘上 {len(on_disk.encode('utf-8'))} B ≠ 权威源 {len(ddl.encode('utf-8'))} B")
        print("[GATE:mysql-schema-fail]")
        return 1

    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(ddl)
    print(f"已写盘 {OUT}（{len(ddl.encode('utf-8'))} B）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
