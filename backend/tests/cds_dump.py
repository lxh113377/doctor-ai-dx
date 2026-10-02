"""CDS Hooks·Python 侧 dump（第八十五轮），由 frontend/tests/cds_guard.mjs 以子进程调用。

只给事实、不给结论（同 red_flag_dump.py 的分工）：断言全部留在 JS 守卫里，本件负责
① 目录生成物的本体 ② 经真路由（TestClient 走 HTTP 栈）得到的 discovery/cards/rejects。
这样比较的是**双端各自的对外行为**，而不是两端各自调同一个纯函数——后者测不到挂载与响应形。

用法：python tests/cds_dump.py
输出：stdout 一段 JSON（末行；禁止混印其它文本）。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
# 红线一的实证位：本件在**无密钥**环境下跑，若适配层偷偷依赖模型，卡片就会在双端比对里塌掉。
os.environ.pop("DEEPSEEK_API_KEY", None)

from app import cds_services  # noqa: E402
from app.main import app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

FIXTURE = Path(__file__).resolve().parents[2] / "frontend" / "tests" / "fixtures" / "cds_cases.json"


def hook_body(service: str, context: dict[str, Any]) -> dict[str, Any]:
    return {"hook": "patient-view", "hookInstance": f"dump-{service}", "context": context}


def main() -> int:
    spec = json.loads(FIXTURE.read_text(encoding="utf-8"))
    client = TestClient(app)

    disc = client.get("/cds-services")
    out: dict[str, Any] = {
        "catalog": {
            "schema_version": cds_services.CDS_SCHEMA,
            "spec_version": cds_services.CDS_SPEC_VERSION,
            "source": cds_services.CDS_SOURCE,
            "urgencies": cds_services.CDS_URGENCIES,
            "indicator_map": cds_services.CDS_INDICATOR_MAP,
            "services": cds_services.CDS_SERVICES,
            "override_reasons": cds_services.CDS_OVERRIDE_REASONS,
            "summary_templates": cds_services.CDS_SUMMARY_TEMPLATES,
            "detail_templates": cds_services.CDS_DETAIL_TEMPLATES,
        },
        "discovery": {
            "status": disc.status_code,
            "content_type": disc.headers.get("content-type", ""),
            "body": disc.json() if disc.status_code == 200 else disc.text,
            "request_id": disc.headers.get("x-request-id", ""),
        },
        "cards": {},
        "rejects": {},
        "probe": {},
    }

    for case in spec["cases"]:
        res = client.post(f"/cds-services/{case['service']}", json=hook_body(case["service"], case["context"]))
        out["cards"][case["id"]] = {
            "status": res.status_code,
            "body": res.json() if res.status_code == 200 else res.text,
        }

    for rej in spec["rejects"]:
        res = client.post(f"/cds-services/{rej['service']}", json=rej["body"])
        body: Any
        try:
            body = res.json()
        except ValueError:
            body = res.text
        out["rejects"][rej["id"]] = {"status": res.status_code, "body": body,
                                      "request_id": res.headers.get("x-request-id", "")}

    # 两条探测：① discovery 只认 GET（POST 应落到 404，不是 405——本仓不新增第四个码）
    # ② 空体 POST（规范上必带 body；这里只取事实，期望由 JS 侧判）
    out["probe"]["post_discovery"] = client.post("/cds-services", json={}).status_code
    out["probe"]["get_invocation"] = client.get("/cds-services/red-flag-screen").status_code
    out["probe"]["empty_body"] = client.post("/cds-services/red-flag-screen", json={}).status_code
    out["probe"]["malformed_json"] = client.post(
        "/cds-services/red-flag-screen", content="{not json", headers={"Content-Type": "application/json"}
    ).status_code
    out["llm_key_present"] = bool(os.environ.get("DEEPSEEK_API_KEY"))

    print(json.dumps(out, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
