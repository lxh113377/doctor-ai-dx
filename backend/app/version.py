"""版本单一真值源（前端口径 = functions/lib/version.js，二者由 tests/version_guard.mjs 强制同值）。
改版本流程：① 同步改本文件 / functions/lib/version.js / package.json → ② python scripts/gen_openapi.py → ③ 打 tag vX.Y.Z。
"""

APP_VERSION = "1.21.0"
