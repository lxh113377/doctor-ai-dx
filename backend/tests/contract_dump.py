"""双端契约测试·Python 侧 dump：对黄金用例集（31 例）跑本端确定性输出（无 Key → rule-fallback），以 JSON 输出到 stdout。
由 frontend/tests/contract_parity.mjs 以子进程调用，禁止手改口径。
用法：python tests/contract_dump.py
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.pop("DEEPSEEK_API_KEY", None)  # 强制无 Key 降级，保证确定性

from app.services import engine  # noqa: E402

FIXTURE = Path(__file__).resolve().parents[2] / "frontend" / "tests" / "fixtures" / "eval_cases.json"


def main() -> None:
    suite = json.loads(FIXTURE.read_text(encoding="utf-8"))
    records = []
    for item in suite["cases"]:
        case_id = item.get("case_id") or "c1"
        history = [{"role": "user", "content": a} for a in item["answers"]]
        dx = engine.build_diagnosis(case_id, history)
        workup = engine.build_workup(case_id, history, dx)
        report = engine.build_report(case_id, history, dx)
        records.append({"id": item["id"], "dx": dx, "workup": workup, "report": report})
    json.dump(records, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
