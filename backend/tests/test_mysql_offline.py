"""MySQL 持久化面·离线判据（第一百零八轮）：不连任何数据库也能验的那一半。

覆盖四件事：
  1) 缺省关闭＝现状零变化（开关语义 + 三种关闭态的可归因 reason）；
  2) R196 环境隔离红线：dev/staging 连 production 库必须在建引擎前被拦；
  3) 语料行的派生规则（元数据键剔除 / seq / payload 指纹）——用临时夹具，不读本仓 data/；
  4) ORM 侧的形状自证（表数 / 引擎与字符集选项 / 方言差异名册非空）。
"""
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import engine as db_engine  # noqa: E402
from app.db import models  # noqa: E402
from app.db.engine import PROD_NAME_RE, database_name, redline_reason  # noqa: E402

passed = failed = 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print("  PASS", name)
    else:
        failed += 1
        print("  FAIL", name + (f" :: {detail}" if detail else ""))


# ---- 1) 缺省关闭：开关三态必须各自可归因（先把两个变量清干净，防本机环境串味） ----
for _k in ("PERSIST_BACKEND", "MYSQL_URL"):
    os.environ.pop(_k, None)
eng, reason = db_engine.current_engine()
check("S1 缺省关闭且 reason=SWITCH_OFF", eng is None and reason.startswith("SWITCH_OFF"), reason)
check("S2 关闭态 db_status 不虚报表", db_engine.db_status()["available"] is False
      and db_engine.db_status()["tables"] == [], str(db_engine.db_status()))

os.environ["PERSIST_BACKEND"] = "mysql"
os.environ.pop("MYSQL_URL", None)
eng, reason = db_engine.current_engine()
check("S3 开关开了但缺 URL ⇒ URL_MISSING", eng is None and reason.startswith("URL_MISSING"), reason)

os.environ["MYSQL_URL"] = "postgresql://x/y"
eng, reason = db_engine.current_engine()
check("S4 非 mysql 前缀 ⇒ URL_DIALECT", eng is None and reason.startswith("URL_DIALECT"), reason)
os.environ.pop("PERSIST_BACKEND", None)
os.environ.pop("MYSQL_URL", None)

# ---- 2) R196 红线：dev 角色连 prod 库名必须被拦在建引擎之前 ----
check("R1 prod 库名正则认得三形态",
      all(PROD_NAME_RE.search(n) for n in ("foo_prod", "production_core", "线上库")), "")
check("R2 普通库名不误伤", not PROD_NAME_RE.search("doctor_ai_dx_dev"), "")
check("R3 dev+prod库名 ⇒ REDLINE_REFUSED",
      bool(redline_reason("mysql://u:p@h/prod_core", "development")), "")
check("R4 production 角色⇄prod库名放行（红线只拦角色错配）",
      redline_reason("mysql://u:p@h/prod_core", "production") == "", "")
check("R5 库名提取不吃 query 串",
      database_name("mysql://u:p@h:3306/doctor_ai_dx_dev?charset=utf8mb4") == "doctor_ai_dx_dev",
      database_name("mysql://u:p@h:3306/doctor_ai_dx_dev?charset=utf8mb4"))

# ---- 3) 语料派生规则：临时夹具（不读本仓 data/，防把机器状态当输入） ----
import importlib.util  # noqa: E402

_loader_path = Path(__file__).resolve().parents[2] / "scripts" / "mysql_load_corpus.py"
loader = None
if _loader_path.exists():
    _spec = importlib.util.spec_from_file_location("mysql_load_corpus", _loader_path)
    if _spec is not None and _spec.loader is not None:
        loader = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(loader)
if loader is None:
    print("  SKIP 语料派生腿 :: scripts/mysql_load_corpus.py 不在仓库根可见范围（镜像内）→ 该腿未验")
else:
    fixture = {
        "schema_version": 7,
        "_provenance": {"note": "元数据键必须被剔除"},
        "entries": [{"id": "k1", "title": "发热"}, {"id": "k2", "title": "腹泻"}],
        "negation_window_chars": 12,
    }
    with tempfile.TemporaryDirectory() as td:
        p = os.path.join(td, "fixture.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(fixture, f, ensure_ascii=False)
        rows = loader.rows_for_file(p, "c" * 64)
        keys = {(r["entry_key"], r["seq"]) for r in rows}
        check("C1 元数据键（schema_version/_前缀）不落行",
              all(not k[0].startswith("_") and k[0] != "schema_version" for k in keys), str(sorted(keys)))
        check("C2 列表按 seq 展开", ("entries", 0) in keys and ("entries", 1) in keys, str(sorted(keys)))
        check("C3 标量取 seq=0", ("negation_window_chars", 0) in keys, str(sorted(keys)))
        check("C4 title 取 title 字段", any(r["title"] == "发热" for r in rows), str([r["title"] for r in rows]))
        check("C5 payload 为规范化 JSON 且带指纹",
              all(r["payload_sha256"] == loader.sha(r["payload"]) for r in rows), "")
        check("C6 行字段与 ORM 列完全对齐",
              all(set(r) == {"source_file", "entry_key", "seq", "title", "payload",
                             "payload_sha256", "corpus_sha256"} for r in rows), str(sorted(rows[0])))
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"schema_version": 7}, f, ensure_ascii=False)
        try:
            loader.rows_for_file(p, "c" * 64)
            check("C7 全元数据文档必须显式失败（空行集不得静默过）", False, "未抛异常")
        except ValueError:
            check("C7 全元数据文档必须显式失败（空行集不得静默过）", True, "")

# ---- 4) ORM 形状自证 ----
check("M1 八张表全在（5 会话 + 1 语料 + 2 评测）",
      len(models.Base.metadata.tables) == 8, str(sorted(models.Base.metadata.tables)))
opts = [t.dialect_kwargs for t in models.Base.metadata.tables.values()]
check("M2 每张表都钉 InnoDB+utf8mb4",
      all(o.get("mysql_engine") == "InnoDB" and o.get("mysql_charset") == "utf8mb4" for o in opts), str(opts[:1]))
check("M3 方言差异名册非空（判据没名册就没牙）", len(models.dialect_divergence()) >= 1, "")
check("M4 corpus 主键含 entry_key（多顶层键 seq 各自从 0 起数）",
      {c.name for c in models.Base.metadata.tables["corpus_entries"].primary_key.columns}
      == {"source_file", "entry_key", "seq"}, "")

print(f"MYSQL-OFFLINE: {passed}/{passed + failed}")
print(f"[GATE:mysql-offline-{'pass' if failed == 0 else 'fail'}]")
sys.exit(1 if failed else 0)
