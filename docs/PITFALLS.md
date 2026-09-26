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


### B8 「逐字同表」是口头约定，不是判据
- 症状：`engine_smoke.mjs` 与 `smoke_engine.py` 各有一份红旗探针表，注释写着"逐字复刻"，实测全仓除两处定义外零引用
  ⇒ 一端改表另一端不知道。本轮我自己加探针时就只改了一侧，靠新加的判据当场判红。
- 根因：双端各持一份期望值 = 第二真值，而"同表"这件事本身无人守。
- 处置：`engine_smoke.mjs` 按字面解析 `smoke_engine.py` 的 `RED_FLAG_PROBES` 字面量并与本端表全等比对。
- 常驻判据：同上一条判据本身（"镜像端探针表仍在场"防表被删/改名静默通过 + "逐字全等"防内容漂移）。
- 坑中坑：解析镜像端的正则第一版用 `[\w./-]` 字符类，`\w` 是 ASCII-only，中文路径/中文诊断名一律不匹配 ⇒
  判据恒绿。变异实测（往文档注入一条中文仓外路径）才抓到。**新判据必须配"它会红"的实测，否则等于没写。**

### B9 观察器把"还没有 run"当成"看完了"（第二十五轮 CI 抓到，脚本自己报的）
- 症状：`python scripts/ci_watch.py --sha <刚推的提交>` 报 `UNKNOWN 未观察到任何 run`，
  而 `gh run list` 同期显示该提交三条 run **全部 success**。
- 根因：轮询退出条件写成 `if not pending or 超时: break`。当一行 run 都还没被 GitHub 建出来时
  `rows == []` ⇒ `pending == []` ⇒ `not pending` 恒真 ⇒ 第一次查询就退出。
  也就是说「没有可判的对象」被当成了「判定已完成」——**空集恒真**这一族，与本仓 B 节其它条目同源。
- 处置：`rows and not pending` 才算完成；空集必须轮到 deadline 才罢手并如实返回空 ⇒ 上层判 UNKNOWN。
  同时把轮询从 `main()` 里抽成 `poll_runs()`，让它可以被离线自证（`main` 内不留第二份实现，
  否则"改了一份、另一份还带老 bug"就是本条的复发路径）。
- 常驻判据：`python scripts/ci_watch.py --selftest`（注入假 fetch，离线不联网），
  五条：空集按 deadline 轮询≥5 次／空集最终返回空／第 3 次才出现的 run 要等到／未收尾不提前返回／
  `expect=3` 只见 2 条时等满。已挂进 CI 的 `infra-lint`。
- 额外一条自省：本文件的 docstring 第 10 行**本来就写着**「run 创建有延迟……不在第一轮就下结论」，
  实现却没做到——又是"承诺在文档、实现在另一条路"（与第二十二轮 ERRORS.md 4xx 日志那条同形）。

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
- **同一族的第二个出口（第二十二轮现形）**：状态码对上了，**日志级别还是错的**——未知病例 id 抛裸 `Error`，
  catch 先按"未预期异常"落 `error` 级、事后才用 `message.startsWith("unknown case")` 翻译成 404。
  守卫只比响应码，所以这条 404 一直**合法地**往 error 日志里灌噪声（任何人拿随机 id 打 `/api/dx/*` 就能刷）。
  修法＝权威面补带类型的 `UnknownCase`（`status=404`，与镜像面 `engine.py.UnknownCase` 同名），
  4xx 分支统一按 `e.status` 分流，删掉前缀匹配；**"是什么码"与"落什么级别"必须同源**，靠字符串比对续命迟早再错一次。
- 判据（本轮补）：`error_parity_guard.mjs` 按 `X-Request-Id` 逐条归因断言"34 条 4xx 用例零 error 级日志"，
  并配**正向对照**（同批用例必须真留下 34 条可归因行，否则"零 error"是恒真——实测拔掉捕获即 rc=1）。

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

### G5 改了 Dockerfile 却没重扫 hadolint（第二十二轮 CI 抓到）
- 症状：CI 里 `backend/Dockerfile:24 DL3059 info: Multiple consecutive RUN instructions`，`infra-lint` 与聚合检查双双判红。
- 根因：本机那次 hadolint 是在**改文件之前**跑的（当时确实 0 findings）；为多架构选锁新加了一条 RUN，
  两条相邻 RUN 就违反了 info 档。判据没变，**是我用了一次过期结论**。
- 处置：合并成一条 `RUN if ...; then cp ...; fi && pip install ...`，不放宽阈值、不给规则加豁免。
- 常驻判据：`ci.yml` 的 `infra-lint` 每次 push 重扫（本机跑过不等于 CI 会放过）；
  改 Dockerfile 后的本地复扫命令就写在下面 §F 的清单项里。

### G6 `--platform` 配了但没人证明两个架构都真的发布了
- 症状：README 写"一条命令可拉取运行"，arm 机器上 `docker run` 报 `exec format error`；
  而 manifest HTTP 200、看起来"发布成功"。
- 根因：buildx 缺 QEMU、或 `--load` 与多平台互斥被静默降级；只断言"有子清单"看见的是数量不是覆盖面。
- 处置：`docker/setup-qemu-action@v3` + `platforms: linux/amd64,linux/arm64`；本机验证时先
  `docker pull --platform linux/arm64 <base>` 预热（buildkit 自己取 `auth.docker.io` token 的路径可能被网络挡住）。
- 常驻判据：`.github/workflows/release.yml` 推之后读 index 断言 `{linux/amd64, linux/arm64}` 全在（`[GATE:multiarch-pass]`）；
  镜像层 CVE 按平台各扫一次，arm64 不许漏扫。

### G7 文档里的"反例样本"被拼写检查当成笔误
- 症状：`.github/workflows/ci.yml` 的 codespell 步骤报 <!-- codespell:ignore-begin 这里是它**引用**的报错原文，不是本文件的笔误 -->`CHANGELOG.md: recieve ==> receive`<!-- codespell:ignore-end -->，而那两个词是
  我为了说明"注入反例会红"**故意写进去的样本**。
- 根因：拼写检查不区分"写错的词"和"举例用的错词"。靠 `ignore-words-list` 收编会**永久瞎掉**这个常见错拼；
  从文档里删掉样本又会让证据变得不可复算。
- 处置：用**段级豁免** `<!-- codespell:ignore-begin 原因 --> … <!-- codespell:ignore-end -->`
  （由 `.codespellrc` 的 `ignore-multiline-regex` 启用），并且只允许圈住"故意写的错拼样本"、必须紧邻写原因。
  禁用词表扩容和整文件 skip——那两类"为凑绿关闸"的做法与 B1 同族。
- 常驻判据：`.github/workflows/ci.yml` infra-lint 的 codespell 步骤（豁免段落在 diff 里一眼可见，评审即可查）；
  机制本身由 `docs/PITFALLS.md` §F 的本地复扫命令验证（实测：不加豁免 rc=65 点名两条，加豁免 rc=0）。

## H. 中文临床文本语义（第二十四轮新增）

### H1 否定式回答被当成阳性线索（安全层的假阳性）
- 症状：`expect_flag=false` 的病例在页面上打出脓毒症红旗。实测 ev-06：主诉"发热 3 天伴咽痛"＋回答"**无**气促"。
- 根因：规则层用 `text.includes(kw)` 子串命中，`无气促` 含 `气促`。感染线索来自主诉、灌注线索来自被否定的症状，
  组合规则两组都"齐"了。规则的头注写着"关键词须特异以免误报"，但**特异性挡不住否定**——这是另一维。
- 处置：命中点前 4 字若以 `无/没有/未/未见/未出现/无明显/无伴/不伴/否认/阴性` 起头则该次出现作废，
  同词其它出现仍算命中（取或）。`无尿`＝尿闭，是真阳性，列例外词放行；而 `无尿痛` 里的 `无尿` 不得放行，
  故例外词还要看后随字。**刻意不收 `不`/`排除`/`不支持`**：`不能排除心前区闷痛` 被抑制就是漏报，
  本层失败代价不对称（漏报危险信号 >> 多提示一条）。
- 常驻判据：`engine_smoke.mjs` 的 `RED_FLAG_PROBES` 阳性 8 条＋阴性 5 条（含 `无尿` vs `无尿痛` 鉴别对），
  与 `backend/tests/smoke_engine.py` **逐字同表且由判据机器对账**（见 B8）；任一侧漏挂或判据失效即判红。
- 坑中坑：修复首版把"例外词后随字"与"否定判定"写成互斥（`!blockedByFollow && 否定`），
  于是 `无尿痛` 仍被当阳性。是加鉴别探针当轮暴露的，不是原设计想清楚的。

### H2 规则表加得越多，误报面线性增长
- 症状/根因：新增一条含常见症状词的规则，就会与既有全部否定式回答发生新组合；本层是 O(规则×回答) 的假阳性面。
- 处置：新关键词先跑一遍 31 例评测看是否引入新误报，再考虑"组合线索"（COMBO 而非 DANGER）来表达临床与逻辑。
- 常驻判据：`npm run test:accuracy`（金标准 top-1/top-3/危急类召回带地板）＋ `test:engine`（红旗在产品真实输入上的通过率）。

## F. 提交前自检顺序（照抄即可）

```bash
# 以下全部在**仓库根**执行（别一半在根一半在 frontend，`../` 写法最容易错）
pre-commit run --all-files                          # 十钩：版本/KB/openapi/契约/ESLint/ruff/mypy/lock/suite/卫生
(cd frontend && npm test)                           # 二十件套（含 docs_link_guard、error_parity）
(cd frontend && npm run test:e2e)                   # 双视口浏览器回归（Playwright）
python backend/selftest.py                          # 六套件 exit 0
python scripts/branch_guard.py                      # 分支保护 ↔ 作业图（加 --remote 还要对线上真实配置）
python scripts/lock_guard.py                        # 依赖锁 ↔ 声明 ↔ Dockerfile 接线
(cd frontend && npm run coverage:js && npm run coverage:py)   # 双端覆盖率地板（只升不降）
MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD":/work:ro -w /work rhysd/actionlint:1.7.7   # 工作流自身（Windows 本机需前缀，CI 不用）
MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD":/work:ro -w /work ghcr.io/hadolint/hadolint:v2.14.0-alpine hadolint backend/Dockerfile   # 改过 Dockerfile 必跑（G5 的教训）
docker compose -f docker-compose.yml config -q                                          # 改过 compose 必跑
PYTHONPATH="$TEMP/csenv" python -m codespell_lib                                        # 拼写看守（本地需先装 codespell==2.4.1）
docker build -t probe:amd64 ./backend && docker run --rm probe:amd64 python selftest.py # 改过 Dockerfile/锁：镜像内自证
docker buildx build --platform linux/arm64 --load --provenance=false -t probe:arm64 ./backend \
  && docker run --rm --platform linux/arm64 probe:arm64 python selftest.py              # arm64 侧同样要实跑
```

推送之后（只看远端，别拿本机绿当发出）：

```bash
python scripts/ci_watch.py --sha "$(git rev-parse --short HEAD)" --wait 900
# [GATE:ci-watch-pass] 才算这一推有远端回执；一条 run 都没看到 = rc 2（UNKNOWN）而不是通过
```

发布链路（tag 触发 `.github/workflows/release.yml`）里的顺序即判据顺序：门禁全绿 → SBOM → 源码包 → 可复现对账 → 镜像 CVE 阻断扫描 → 推 GHCR → **匿名**可读实证 → Release 正文（取 `CHANGELOG.md` 小节，缺或过短判红）→ 资产上传 → 线上正文对账。任一步红就不产出下游可见物。
