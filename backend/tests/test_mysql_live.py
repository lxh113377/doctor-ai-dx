"""MySQL 持久化面·真连判据（第一百零八轮）。

前提：`MYSQL_TEST_URL` 指向一个**可弃置**的测试库（CI 用 service container；本机用
docker-compose.mysql.yml 起的一次性实例）。未设 ⇒ 印 SKIP 并明写「本维未验」，既不计 PASS
也不许让整个套件假绿——没验就是没验，这是本仓对「能力句必须带行为回执」的底线。

套件自带清理：写入用 `r108-` 前缀的会话 id，结束前删净；不碰库里的其它数据。
"""
import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import engine as db_engine  # noqa: E402
from app.db import models  # noqa: E402
from app.db import repository as repo

passed = failed = skipped = 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print("  PASS", name)
    else:
        failed += 1
        print("  FAIL", name + (f" :: {detail}" if detail else ""))


def skip(name, reason):
    global skipped
    skipped += 1
    print(f"  SKIP {name} :: {reason}（本维未验，不计绿）")


url = (os.getenv("MYSQL_TEST_URL") or "").strip()
eng, reason = db_engine.current_engine()

if not url:
    skip("全部真连腿", "MYSQL_TEST_URL 未设")
else:
    os.environ["PERSIST_BACKEND"] = "mysql"
    os.environ["MYSQL_URL"] = url
    os.environ.setdefault("ENV_ROLE", "development")
    eng, reason = db_engine.current_engine()
    check("L1 开关全开 ⇒ 引擎可用且 reason 为空", eng is not None and reason == "", reason)

    if eng is not None:
        from sqlalchemy import text as sql_text

        created = db_engine.create_all(eng)
        check("L2 create_all 建出的表与声明一致",
              sorted(created) == sorted(models.Base.metadata.tables), str(created))

        conv = f"r108-{uuid.uuid4().hex[:12]}"
        writes = [
            repo.save_message(conv, f"{conv}-m1", "user", "压榨样胸痛冒冷汗，快不行了", red_flag=1),
            repo.save_intent_event(conv, f"{conv}-e1", "red_flag", 1.0, '["胸痛"]'),
            repo.open_handoff(conv, f"{conv}-h1", "RED_FLAG", "红旗命中", "digest"),
            repo.save_feedback(conv, f"{conv}-f1", 5, "useful", "清晰"),
        ]
        check("L3 五类写操作全部成功", all(w.ok for w in writes),
              str([(w.ok, w.reason) for w in writes]))

        t = repo.conversation_transcript(conv)
        check("L4 会话读回完整且 turn_count 推进",
              t is not None and t["conversation"]["turn_count"] == 1
              and t["conversation"]["handed_off"] == 1 and t["conversation"]["satisfaction"] == 5,
              str(None if t is None else t["conversation"]))
        check("L5 消息/事件/转人工/反馈各就位",
              t is not None and len(t["messages"]) == 1 and len(t["intent_events"]) == 1
              and len(t["handoffs"]) == 1 and t["feedback"]["score"] == 5,
              str(None if t is None else "shape"))
        check("L6 中文与红旗位不丢",
              t is not None and "压榨样胸痛" in t["messages"][0]["content"]
              and t["messages"][0]["red_flag"] == 1,
              str(None if t is None else t["messages"][0]["content"][:12]))

        bad = repo.save_feedback(conv, f"{conv}-f2", 9)
        check("L7 越界评分被拒且 reason 可归因", not bad.ok and "SCORE_OUT_OF_RANGE" in bad.reason,
              f"{bad.ok} {bad.reason}")

        # 清理：只删本套件自己写入的行（断言范围=自己动过的面）
        with eng.begin() as conn:
            conn.execute(sql_text(
                "DELETE FROM intent_events WHERE conversation_id = :c"), {"c": conv})
            conn.execute(sql_text("DELETE FROM handoffs WHERE conversation_id = :c"), {"c": conv})
            conn.execute(sql_text("DELETE FROM feedback WHERE conversation_id = :c"), {"c": conv})
            conn.execute(sql_text("DELETE FROM messages WHERE conversation_id = :c"), {"c": conv})
            conn.execute(sql_text("DELETE FROM conversations WHERE id = :c"), {"c": conv})
        check("L8 清理后读回为 None", repo.conversation_transcript(conv) is None, "")

unverified = "（本维未验：MYSQL_TEST_URL 未设，只跑了 SKIP 声明腿）" if not url else ""
print(f"MYSQL-LIVE: pass={passed} fail={failed} skip={skipped}{unverified}")
print(f"[GATE:mysql-live-{'pass' if failed == 0 else 'fail'}]")
sys.exit(1 if failed else 0)
