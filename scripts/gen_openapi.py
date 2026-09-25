"""docs/openapi.json 版本注入口（round7 实测教训固化）。
口径：本仓 docs/openapi.json 是**手工契约文档**（6 端点 = Functions 权威面，含红线安全声明措辞），
不是 FastAPI 自动生成物——曾经用 app.openapi() 全量覆盖直接打爆 api_contract_guard 10 项断言。
本脚本只更新 info.version 一个字段（真值 = backend/app/version.py），其余内容不动。
用法：
  python scripts/gen_openapi.py            # 把 info.version 同步为 APP_VERSION
  python scripts/gen_openapi.py --check    # 只比对：版本不符即退出码 1（CI 用）
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "docs" / "openapi.json"

_VERSION_SRC = (ROOT / "backend" / "app" / "version.py").read_text(encoding="utf-8")
_ver = re.search(r'APP_VERSION = "([^"]+)"', _VERSION_SRC)
if not _ver:  # fail-closed：单一源被改动时报可读错误，而非 AttributeError（第十五轮 mypy union-attr 抓出）
    raise SystemExit('FAIL: backend/app/version.py 未匹配到 APP_VERSION = "x.y.z"（版本单一源被改坏）')
APP_VERSION = _ver.group(1)


def main() -> int:
    raw = SPEC.read_text(encoding="utf-8")
    cur = json.loads(raw)["info"]["version"]
    if "--check" in sys.argv:
        if cur != APP_VERSION:
            print(f"OPENAPI VERSION DRIFT: docs/openapi.json={cur} != backend/app/version.py={APP_VERSION}（运行 python scripts/gen_openapi.py）")
            return 1
        print(f"OPENAPI OK: version={cur} paths={len(json.loads(raw)['paths'])}")
        return 0
    if cur == APP_VERSION:
        print(f"NOCHANGE: version 已是 {APP_VERSION}")
        return 0
    # 字符串级替换：只动版本行，保手工排版（json.dumps 全量重写会 churn 400+ 行格式 diff，实测教训）
    patched, n = re.subn(r'("version":\s*")' + re.escape(cur) + '"', r"\g<1>" + APP_VERSION + '"', raw, count=1)
    if n != 1:
        print("FAIL: 版本行未命中，拒绝改写")
        return 1
    json.loads(patched)  # 改后回验仍是合法 JSON
    SPEC.write_text(patched, encoding="utf-8", newline="\n")
    print(f"SYNCED info.version: {cur} -> {APP_VERSION}（仅动此一行，契约正文与排版不覆盖）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
