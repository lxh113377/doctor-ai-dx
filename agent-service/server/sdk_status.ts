/**
 * Agent SDK 可用性探测（面3 专用）。
 *
 * 背景：@tencent-ai/agent-sdk 是**通过子进程调用 CodeBuddy CLI** 的（`pathToCodebuddyCode` /
 * `CODEBUDDY_CODE_PATH`），因此 SDK 能否工作取决于本机是否装了 CLI、CLI 是否已登录、有无 API Key。
 * 探测结果只用于两件事：① /api/medchat/status 如实回报；② 决定走 Agent 编排还是确定性话术降级。
 * **本模块永不在探测失败时伪造可用**——返回的每一项都是实测，不做乐观假设。
 */
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** CLI 候选来源：显式环境变量 → PATH。全局 npm 安装常落在 PATH 之外，故两者都查。 */
export function cliCandidates(): string[] {
  const out: string[] = [];
  const fromEnv = (process.env.CODEBUDDY_CODE_PATH || "").trim();
  if (fromEnv) out.push(fromEnv);
  if (process.platform === "win32") {
    // Windows 上全局 npm bin 不一定在子进程 PATH 里（PowerShell 会话有、Node 子进程可能没有），
    // 故显式补 npm 全局前缀的常见落点，避免"装了却探测不到"这种假降级。
    const prefix = (process.env.npm_config_prefix || "").trim();
    if (process.env.APPDATA) {
      out.push(`${process.env.APPDATA}\\npm\\codebuddy.cmd`);
      out.push(`${process.env.APPDATA}\\npm\\codebuddy`);
    }
    if (prefix) {
      out.push(`${prefix}\\codebuddy.cmd`);
      out.push(`${prefix}\\codebuddy`);
    }
    out.push("D:\\npm-global\\codebuddy.cmd");
    out.push("D:\\npm-global\\codebuddy");
  }
  return [...new Set(out.filter(Boolean))];
}

export type SdkStatus = {
  /** 三态而非布尔：不可用原因不同，降级话术与提示也不同 */
  state: "ready" | "no-cli" | "no-auth" | "disabled";
  reason: string;
  cli_path: string | null;
  cli_version: string | null;
  has_api_key: boolean;
  /** 供前端徽标显示，绝不把 token / key 值带出去 */
  mode: "live" | "mock-fallback";
};

/** 环境变量显式关闭时优先（便于 CI 与离线复算时强制走确定性链路）。 */
function disabled(): SdkStatus {
  return {
    state: "disabled",
    reason: "AGENT_SDK_ENABLED=0 —— 已显式关闭 Agent 编排，对话走确定性话术链路",
    cli_path: null,
    cli_version: null,
    has_api_key: false,
    mode: "mock-fallback",
  };
}

export async function probeSdk(): Promise<SdkStatus> {
  if (process.env.AGENT_SDK_ENABLED === "0") return disabled();

  const hasKey = !!(process.env.CODEBUDDY_API_KEY || "").trim();

  let found: { path: string; version: string } | null = null;
  let sawExecError: string | null = null;

  for (const candidate of cliCandidates()) {
    try {
      // Windows 上 npm 全局安装产出的是 `codebuddy.cmd`（批处理），execFile 直接 spawn 会 EINVAL；
      // 必须经 shell（等价于 cmd /c）。代价是 shell 注入面——候选路径可被 CODEBUDDY_CODE_PATH 指定，
      // 故先做元字符校验：含 & | ; < > 或换行的候选直接跳过（不做转义，转义容易被绕过）。
      const needsShell = process.platform === "win32";
      if (needsShell && /[&|;<>\n\r]/.test(candidate)) {
        console.error(`[sdk_status] 候选含 shell 元字符，已跳过 ${candidate}`);
        continue;
      }
      const { stdout, stderr } = await execFileAsync(candidate, ["--version"], {
        timeout: 8000,
        windowsHide: true,
        ...(needsShell ? { shell: true as const } : {}),
      });
      const version = String(stdout || stderr || "").trim().split(/\r?\n/)[0] || "";
      if (version) {
        found = { path: candidate, version };
        break;
      }
    } catch (e) {
      // 记下来但不当失败：换下一个候选。这里刻意不抛——探测本身不该让服务起不来。
      sawExecError = String((e as Error)?.message || e).slice(0, 160);
      console.error(`[sdk_status] 候选不可执行 ${candidate}: ${sawExecError}`);
    }
  }

  if (!found) {
    return {
      state: "no-cli",
      reason: `未找到可执行的 CodeBuddy CLI（试过 ${cliCandidates().length} 个候选）——装它：npm install -g @tencent-ai/codebuddy-code`,
      cli_path: null,
      cli_version: null,
      has_api_key: hasKey,
      mode: "mock-fallback",
    };
  }

  if (hasKey) {
    return {
      state: "ready",
      reason: "CodeBuddy CLI 就绪，且已配置 CODEBUDDY_API_KEY",
      cli_path: found.path,
      cli_version: found.version,
      has_api_key: true,
      mode: "live",
    };
  }

  // CLI 在但既无 Key 也未登录：无法断定已登录（登录态是 CLI 内部缓存，--version 不暴露），
  // 故按"未认证"处理并让首次真实调用去判——**不假装可用**。
  return {
    state: "no-auth",
    reason: "CodeBuddy CLI 已安装但未见 CODEBUDDY_API_KEY；首次运行 `codebuddy` 完成浏览器认证，或设置 CODEBUDDY_API_KEY",
    cli_path: found.path,
    cli_version: found.version,
    has_api_key: false,
    mode: "mock-fallback",
  };
}