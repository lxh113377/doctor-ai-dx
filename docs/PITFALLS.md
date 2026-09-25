# 排障手册（PITFALLS）— 本仓踩过的坑与常驻判据

> 用途：报错时先在这里对号，再去读代码。每条都写「症状（可 grep 的原样报错）→ 根因 → 处置 → 现在的常驻判据」。
> 规则：**只有真实踩过、且已在 CI 阻断链里有判据兜着的坑才允许写进来**。新增条目必须同时给出那一条判据的文件名，否则等于没固化。
> 与其他文档的分工：`ARCHITECTURE.md` 讲设计，`SECURITY.md` 讲漏洞披露，`CONTRIBUTING.md` 讲改哪里要同步哪里，本文件讲**为什么会炸**。

---

## A. 转义与控制字符（本仓复发次数最多的一类）

### A1 正则里的 `\b` 变成裸退格符 `0x08`
- 症状：判据"永远通过"、`frontend/tests/privacy_guard.mjs` 某几条从不 FAIL；用 `cat -v` 能看到 `^H`。
- 根因：用 Python/bash 字符串写 JS 文件时 `\b` 被当成退格控制字符落地，正则里的词边界消失，判据永不匹配。
- 处置：字面量一律经 Edit/Write 工具落地，不穿 shell+python 两层转义。
- 常驻判据：`scripts/check_text_hygiene.py`（CI 阻断作业 + pre-commit 钩，扫 C0/DEL；受控条目数 < 40 直接判红，防"清单空了就全绿"）。

### A2 `sed` 的回引用 `\1` 落成 `0x01`
- 症状：`yaml.scanner` 或 `ERROR: unacceptable character #x0001`，工作流整份解析失败。
- 根因/处置/判据：同 A1（同族，区别只在字符是 0x01 还是 0x08）。

### A3 多层转义把代码本身改坏
- 症状：`bash: -c: line 1: unexpected EOF`、`SyntaxError: closing parenthesis ')' does not match opening parenthesis '['`、或文件里出现**字面** `\n`（本该是续行）。
- 根因：heredoc / `python -c` / 工具参数三层里，反斜杠和引号每过一层就被剥一次。
- 处置：任何含反斜杠或嵌套引号的代码，**先落成脚本文件再执行**；改完立刻用 `node --check` / `python -m py_compile` / `actionlint` 复验。
- 判据：`infra-lint` 作业（actionlint 内嵌 shellcheck，会直接报 `SC1012: \n is just literal 'n' here`）。

---

## B. 判据自己骗自己（假绿）——本仓最贵的一类

### B1 判据命中"说到"而不是"做到"
- 症状：`scripts/lock_guard.py` 全绿，但 `backend/Dockerfile` 的 RUN 行其实还是浮动安装。
- 根因：把 `--require-hashes` 写进了 Dockerfile **注释**，全文匹配就满足了。
- 处置：只在指令行（`RUN`/`COPY`）上匹配，注释先剥掉。
- 判据：`scripts/lock_guard.py`（该场景本身已写成反例，注入即 rc=1）。

### B2 拿自己写的常量比自己写进保护的值
- 症状：`scripts/branch_guard.py --remote` 判绿，但 PR 永远卡在 "Expected"。
- 根因：required check 名字写成 job key，而 GitHub 上报的是 job 的 `name` 字段。
- 判据：`scripts/branch_guard.py` 从 `name` 推导 context，并与线上真实值逐字对账。

### B3 扫描根不存在 → 静默全绿
- 症状：新写的扫描判据首跑就 PASS，且一条也没扫到。
- 根因：`os.walk()` / `glob` 对**不存在的路径返回空**，不报错。本轮实测：`REPO/app` 里 `REPO` 是 `backend` 的上一层。
- 处置：路径用 `Path(__file__)` 解析，不用拼接；镜像内路径与仓库内不同（`/srv/backend` vs 仓根）。
- 判据：每个枚举器自带反向非空断言（`backend/tests/test_limits.py` 第 6 节断言"扫到 ≥5 个 .py"；`frontend/tests/limits_guard.mjs`／`frontend/tests/sbom_guard.mjs`／`scripts/suite_guard.py` 各有同类下限）。

### B4 只验一种形态 → 换个写法就绕过
- 症状：遥测判据只认 `sentry.io`，注入 `@sentry/browser` 命中 0。
- 判据：`frontend/tests/privacy_guard.mjs` 按真实形态逐条自证（25 形态）+ 元反例。

### B5 新判据必须双向验
- 规则：任何新判据交付时，除"能测出问题"（变异/反例 rc=1）外，还要证它**不会误伤合法输入**。零输入不得记 PASS。
- 落点：各 guard 的 `== 反例 ==` 小节 + `--against` 类外部对照。

---

## C. 发布与 Git

### C1 跨环境源码包 sha 不同
- 症状：同一 tag，CI 产物与本机产物 SHA256 不一致。
- 根因（两条，都可消除）：① Windows `core.autocrlf=true` 使 `git archive` 导出把 LF 转 CRLF；② zip 的 MS-DOS 时间字段按归档进程**时区**渲染（CI=UTC / 本机=UTC+8）。
- 处置：`TZ=UTC0 git -c core.autocrlf=false archive --format=zip --mtime=$(git log -1 --format=%ct <tag>) ...`；`.gitattributes` 已进被归档 tree。
- 判据：`scripts/release_repro_check.py`（同 ref 二次构建全等 / 包内零 CRLF / 文件数下限 / 可与外部包逐字节对账）。
- 归因纪律：两份产物不一致先**换对账粒度**（整包 sha → 逐文件 CRC → 首差字节），未归因不得写成"平台差异"。

### C2 轻量 tag 静默不推送
- 症状：`git push --follow-tags` 成功，但 `gh run list` 里没有发布作业的 run。
- 根因：`--follow-tags` 只推**附注** tag。
- 判据：发布一律 `git tag -a`；作业状态以远端可见为准（`git ls-remote --tags` + run + Release 资产三查）。

### C3 被护栏拦停后能不能重锚 tag
- 规则：拦停就是成功，不绕、不删判据凑绿。**只有零下游可见物才允许重锚**；一旦镜像 tag 已公开可拉，就改出新版本，旧 tag 无 Release 一事写进 CHANGELOG，不补号不抹平。

### C4 依赖声明与安装面混用
- 症状：CI 14 秒判红 `pip install --require-hashes` 失败。
- 根因：锁与 dev 件（区间声明）写进同一条命令——该选项作用于本次安装的**全部**输入。
- 判据：`scripts/lock_guard.py` 第 10 条（同一命令不得混用 `--require-hashes` 与非 `.lock` 需求文件）。
- 另一条同族：`requirements.txt` 注释续行漏 `#` → `uv` 能解析、`pip` 报 `ERROR: Invalid requirement` → 判据按**消费者口径**逐行核（第 11 条）。

### C5 GHCR 匿名可读实证 404
- 症状：`MANIFEST_UNKNOWN: OCI index found, but Accept header does not support OCI indexes`，被误读成"包是私有"。
- 根因：`build-push-action` 推的是 OCI **index**，`Accept` 只列 manifest 两种类型。
- 处置：`Accept` 必须含 `application/vnd.oci.image.index.v1+json`；报错按状态码分支（401/403＝可见性，404＝tag 没推上或协商失败）并把响应体打进日志。
- 纪律：**判据红了先读响应体，再动状态开关**；猜测式提示语会把下一轮排查带到别的系统上。
- 个人包可见性 PATCH 用 `GITHUB_TOKEN`/PAT 均 404（该端点要求更高 scope）；源仓库公开时包默认 public，真判据是匿名 manifest 实测。

---

## D. Windows + Git Bash 专属

### D1 `docker run -v $PWD:/work -w /work` 报 working directory 无效
- 症状：`the working directory 'C:/Program Files/Git/work' is invalid, it needs to be an absolute path`。
- 根因：MSYS 路径自动改写。
- 处置：命令前加 `MSYS_NO_PATHCONV=1`（本机专用；CI 的 ubuntu runner 不需要）。

### D2 `gh api "/users/..."` 变成 `invalid API endpoint: "C:/Program Files/Git/users/..."`
- 处置：**去掉 endpoint 前导斜杠**（`gh api users/xxx/...`）。

### D3 `/tmp` 在 git bash 与 Windows python 里不是同一个目录
- 症状：bash 写 `/tmp/x.json` 成功，python `open('/tmp/x.json')` 报 FileNotFoundError。
- 处置：跨工具传文件用 `mktemp -d` 返回的**Windows 形态**路径（`python -c "import tempfile;print(tempfile.mkdtemp())"`），或统一用 `$TEMP`。

### D4 线上端点探测被 Cloudflare 拦
- 症状：`error code: 1010`、HTTP 403，看着像端点坏了。
- 根因：默认 `python-urllib` UA 被 WAF 规则拦。
- 处置：探测带浏览器 UA（`Mozilla/5.0 ... Chrome/141`）。可达性按「域名 × 时刻」记录，不把任一方向写成永久结论。

### D5 子进程管道吃掉退出码
- 症状：`cmd | tail -5` 返回"看起来全绿"，实际链路中间已经炸。
- 处置：取 `${PIPESTATUS[0]}`，或先把输出写文件再 grep `FAIL|RESULT`。npm 链式脚本同理（`npm test` 内部多个 `&&`，中间失败时 tail 只剩前面的输出）。

---

## E. 双端一致（Functions 权威面 ↔ FastAPI 镜像面）

### E1 同一份清单被抄两遍
- 症状：镜像里 selftest 跑的是**过期套件**（新测试没挂上），且两处各改各的。
- 判据：`backend/tests/suite.json` 单一源 + `backend/selftest.py` 驱动，`scripts/suite_guard.py` 反向枚举磁盘上所有 `test_*.py`，漏登记即红。

### E2 客户端错误被当服务端故障
- 症状：`history:"boom"` 权威面 500、镜像面 422，且差异被测试**钉住**而不是修掉。
- 处置：入站定码（4xx），500 只留给真故障；4xx 一律 warn 级日志（滥用流量不得刷 error 日志）。
- 判据：`frontend/tests/error_parity_guard.mjs` + `frontend/tests/fixtures/error_parity.json` 做**三方**对账（期望 ↔ JS ↔ Py）。只比"两端互相等"不够——两边一起错就永远绿。

### E3 错误处理路径自身抛异常
- 症状：医生看到平台错误页而不是承诺过的可读文案（破"API 失败只显示可读文案"红线）。
- 根因：catch 分支里 `redact(e.message, env)` 读 env 抛异常，异常逃出 handler。
- 判据：`frontend/tests/route_guard.mjs` 用「取属性即抛的 env 桩」常驻测这条；原则＝**归因可以降级，响应信封不能失败**。

### E4 镜像内没有前端目录
- 症状：后端测试在镜像里 `FileNotFoundError` 退出码 1。
- 处置：仓库外文件读取要有显式 SKIP 分支并**打印跳过原因与谁接管判定**，禁止静默 `return`（静默通过＝假绿）。

### E5 双端各写一遍中文文案
- 症状：码相同但 message 不同（本轮实测：`undefined` vs 空串）。
- 处置：文案提成模块常量，两侧同名同值；判据逐字比。能逐字比对的东西才谈得上判据。

---

## G. 容器与多架构（第二十二轮新增）

### G1 配了 `platforms` 却只发布出一个架构
- 症状：`docker run` 在 Apple Silicon 上 `exec format error`；manifest 看得到（HTTP 200），但里面只有一个平台。
- 根因：buildx 缺 QEMU（`docker/setup-qemu-action`）、或 `--load` 与多平台互斥被静默降级、或只在单个 `docker build` 里加 `--platform`。
- 处置：`release.yml` 先注册 QEMU 再 `platforms: linux/amd64,linux/arm64`，推完读 index 断言两个平台都在。
- 常驻判据：`.github/workflows/release.yml` 的匿名 manifest 步骤（`[GATE:multiarch-pass]`，缺平台即 rc=1）。

### G2 同一句 `uv pip compile` 写出两种结果（看着像架构差异）
- 症状：仓内 `requirements.lock` 是 `uvicorn 0.53.0`，新建的 `requirements.arm64.lock` 是 `0.54.0`，像"两架构版本不同"。
- 根因：**uv 复用输出文件里已有的钉版**（in-source caching）。写已存在的文件＝保持旧版本，写新文件＝取当前最新 ⇒ 差异纯属"有没有缓存"，与平台无关。
- 处置：多平台锁只能由 `scripts/recompile_locks.py` **同一时刻**产出（内部带 `--upgrade`），日常不要单跑一把。
- 常驻判据：`scripts/lock_guard.py` 的"各锁版本集全等 + 每把锁头注平台与文件名匹配 + 额外锁必须被 RUN 选用"三条（各自反例实测 rc=1）。

### G3 本机 buildkit 取不到 Docker Hub token
- 症状：`failed to fetch oauth token: Post "https://auth.docker.io/token": ... timed out`，而同一台机器 `docker pull --platform linux/arm64 <base>` 却成功。
- 根因：buildkit 自己走 auth.docker.io，与 daemon 的取 token 路径不同；网络对域名×路径的可达性不一样。
- 处置：先 `docker pull --platform <目标架构> <base>` 预热，再 `docker buildx build --load --provenance=false`。
- 判据口径：本机能不能跑不改变 CI 的断言——**发布后 index 双架构那一步才是判据**，本机结果只作为"已验证/未验证"如实记录（同 D 类"可达性按域名×时刻记"）。

### G4 覆盖面阈值靠拍脑袋
- 症状：新写的"扫描面非空"判据写了 `≥120`，本机一跑实际只有 87 ⇒ 上线即假红。
- 根因：分母没量。分母必须由枚举器当场产出，不能凭印象写整数（同 B3 的近亲）。
- 处置：改成实测 87 → 取下限 80（留删改余量），并在注释里写"本轮实测 87"。
- 常驻判据：`.github/workflows/ci.yml` infra-lint 的 codespell 步骤（`受检文件数` 先算再断言）。

## F. 提交前自检顺序（照抄即可）

```bash
# 以下全部在**仓库根**执行（别一半在根一半在 frontend，`../` 写法最容易错）
pre-commit run --all-files                          # 十钩：版本/KB/openapi/契约/ESLint/ruff/mypy/lock/suite/卫生
(cd frontend && npm test)                           # 18 件套（含 docs_link_guard、error_parity）
(cd frontend && npm run test:e2e)                   # 双视口浏览器回归（Playwright）
python backend/selftest.py                          # 六套件 exit 0
python scripts/branch_guard.py                      # 分支保护 ↔ 作业图（加 --remote 还要对线上真实配置）
python scripts/lock_guard.py                        # 依赖锁 ↔ 声明 ↔ Dockerfile 接线
(cd frontend && npm run coverage:js && npm run coverage:py)   # 双端覆盖率地板（只升不降）
MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD":/work:ro -w /work rhysd/actionlint:1.7.7   # 工作流自身（Windows 本机需前缀，CI 不用）
```

推送之后（只看远端，别拿本机绿当发出）：

```bash
python scripts/ci_watch.py --sha "$(git rev-parse --short HEAD)" --wait 900
# [GATE:ci-watch-pass] 才算这一推有远端回执；一条 run 都没看到 = rc 2（UNKNOWN）而不是通过
```

发布链路（tag 触发 `.github/workflows/release.yml`）里的顺序即判据顺序：门禁全绿 → SBOM → 源码包 → 可复现对账 → 镜像 CVE 阻断扫描 → 推 GHCR → **匿名**可读实证 → Release 正文（取 `CHANGELOG.md` 小节，缺或过短判红）→ 资产上传 → 线上正文对账。任一步红就不产出下游可见物。
