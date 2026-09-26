// 版本单一真值源（后端口径 = backend/app/version.py，二者由 tests/version_guard.mjs 强制同值）。
// health 端点与 OpenAPI 文档都以本行为准；升版本须与 package.json / APP_VERSION 一起改。
export const APP_VERSION = "1.30.0"
