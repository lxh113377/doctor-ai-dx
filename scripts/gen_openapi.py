"""docs/openapi.json 版本注入口 + docs/OPENAPI.md 唯一派生源（round7 实测教训固化）。
口径：本仓 docs/openapi.json 是**手工契约文档**（6 端点 = Functions 权威面，含红线安全声明措辞），
不是 FastAPI 自动生成物——曾经用 app.openapi() 全量覆盖直接打爆 api_contract_guard 10 项断言。
本脚本只更新 info.version 一个字段（真值 = backend/app/version.py），其余内容不动；
并按同一真值派生 docs/OPENAPI.md（第八十二轮补的人类可读层）——md 是**派生件**，禁手写。
用法：
  python scripts/gen_openapi.py            # 同步 info.version，并按 json 重生成 OPENAPI.md
  python scripts/gen_openapi.py --check    # 只比对：版本不符或 md 与派生结果不一致即退出码 1（CI 用）
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "docs" / "openapi.json"
MD = ROOT / "docs" / "OPENAPI.md"
METHOD_ORDER = ["get", "post", "put", "patch", "delete"]

_VERSION_SRC = (ROOT / "backend" / "app" / "version.py").read_text(encoding="utf-8")
_ver = re.search(r'APP_VERSION = "([^"]+)"', _VERSION_SRC)
if not _ver:  # fail-closed：单一源被改动时报可读错误，而非 AttributeError（第十五轮 mypy union-attr 抓出）
    raise SystemExit('FAIL: backend/app/version.py 未匹配到 APP_VERSION = "x.y.z"（版本单一源被改坏）')
APP_VERSION = _ver.group(1)


def render_md(spec: dict) -> str:
    """由 openapi.json 单向派生人类可读 md（第八十三轮：此前 md 由一次性命令产出、无生成源，属 #106 同族）。"""
    info = spec["info"]
    lines = [
        "# OPENAPI（人类可读派生版）",
        "",
        f"版本: {info['version']} ｜ 标题: {info['title']}",
        "",
        "> 本文件由 `docs/openapi.json` 单向派生，禁止手写契约；契约变更只改 openapi.json 后重跑 `python scripts/gen_openapi.py`。",
        "",
        f"> 合规声明：{info.get('x-compliance', '')}",
        "",
    ]
    for path, ops in spec["paths"].items():
        for method in METHOD_ORDER:
            op = ops.get(method)
            if not op:
                continue
            codes = sorted((op.get("responses") or {}).keys(), key=lambda c: int(c))
            lines.append(f"## {method.upper()} {path}")
            lines.append("")
            lines.append(op.get("summary", "").strip())
            lines.append("")
            if op.get("tags"):
                lines.append(f"tags: {', '.join(op['tags'])}")
                lines.append("")
            lines.append(f"响应码: {' / '.join(codes)}")
            lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    raw = SPEC.read_text(encoding="utf-8")
    cur = json.loads(raw)["info"]["version"]
    want_md = render_md(json.loads(raw))
    if "--check" in sys.argv:
        fail = 0
        if cur != APP_VERSION:
            print(f"OPENAPI VERSION DRIFT: docs/openapi.json={cur} != backend/app/version.py={APP_VERSION}（运行 python scripts/gen_openapi.py）")
            fail += 1
        if not MD.exists():
            print(f"OPENAPI MD DRIFT: {MD.name} 缺失（运行 python scripts/gen_openapi.py）")
            fail += 1
        elif MD.read_text(encoding="utf-8") != want_md:
            print(f"OPENAPI MD DRIFT: {MD.name} 与 openapi.json 派生结果不一致（运行 python scripts/gen_openapi.py）")
            fail += 1
        if fail == 0:
            print(f"OPENAPI OK: version={cur} paths={len(json.loads(raw)['paths'])} md=in-sync")
        return fail
    if cur == APP_VERSION:
        print(f"NOCHANGE: version 已是 {APP_VERSION}")
    else:
        # 字符串级替换：只动版本行，保手工排版（json.dumps 全量重写会 churn 400+ 行格式 diff，实测教训）
        patched, n = re.subn(r'("version":\s*")' + re.escape(cur) + '"', r"\g<1>" + APP_VERSION + '"', raw, count=1)
        if n != 1:
            print("FAIL: 版本行未命中，拒绝改写")
            return 1
        json.loads(patched)  # 改后回验仍是合法 JSON
        SPEC.write_text(patched, encoding="utf-8", newline="\n")
        print(f"SYNCED info.version: {cur} -> {APP_VERSION}（仅动此一行，契约正文与排版不覆盖）")
    # md 派生：无论版本是否变动都按 json 现算重写，保证文档层永不落后于契约层
    latest = json.loads(SPEC.read_text(encoding="utf-8"))
    md_text = render_md(latest)
    changed = (not MD.exists()) or MD.read_text(encoding="utf-8") != md_text
    if changed:
        MD.write_text(md_text, encoding="utf-8", newline="\n")
        print(f"SYNCED docs/OPENAPI.md: 由 openapi.json v{latest['info']['version']} 派生（{len(latest['paths'])} paths）")
    else:
        print(f"NOCHANGE: docs/OPENAPI.md 已与 openapi.json v{latest['info']['version']} 一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
