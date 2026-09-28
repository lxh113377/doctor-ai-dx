"""LLM 接入层——Provider 抽象 + OpenAI 兼容默认实现（DeepSeek）——镜像 frontend/functions/lib/engine.js 的 callLLM。
- 配置 API Key 后走真实推理；未配置或调用失败抛 LLMUnavailable，由 engine 捕获后安全降级。
- 换供应商只需注册新 Provider 并设 LLM_PROVIDER 环境变量，业务引擎零改动。
- 单次硬超时 8s（对齐线上），只输出 JSON 的调用用 chat_json。
"""
import json

import httpx

from ..config import get_settings, llm_available

SYSTEM_BASE = (
    "你是「医·基层AI辅助诊断系统」的基层医生辅助诊断助手。严格约束："
    "1) 输出仅为辅助参考，不替代执业医生决策；"
    "2) 发现高危信号必须优先提示急诊转诊，且不得推翻已检出的红旗；"
    "3) 只能引用给定证据列表中的 evidence_id，禁止编造；"
    "4) 不编造检查数值；5) 只输出 JSON，中文。"
)

HARD_TIMEOUT_S = 8.0

# 降级原因分类（#146，与 frontend/functions/lib/engine.js 的 LLM_FALLBACK_CAUSES 同表）。
# 期望值单一源 = frontend/tests/fixtures/llm_fallback_causes.json，两侧各自断言对齐（防"两端一起错"）。
# 只回答"哪一类失败"，不回答细节：堆栈／内部路径／上游响应体一律不进响应（红线：对外只给医生可理解文案）。
LLM_FALLBACK_CAUSES = ("no_key", "timeout", "net_error", "empty", "bad_json", "schema",
                       "truncated", "content_filter", "finish_unrecognized", "unknown")
LLM_HTTP_CAUSE_PREFIX = "http_"
# finish_reason 白名单（对标 openai/openai-node src/core/error.ts 的 Length/ContentFilter 两类错误）：
# 允许 stop/tool_calls 与"字段缺失"（部分网关不发该字段），其余一律降级——被过滤或被截断的回答
# 看起来像合法 JSON，当 live 发出去就是拿残缺内容给医生。
LLM_FINISH_OK = ("stop", "tool_calls", "", None)


class LLMUnavailable(Exception):
    """LLM 不可用。`cause_code` 是给降级层归因用的枚举，不进对外文案。"""

    def __init__(self, message: str, cause_code: str = "unknown") -> None:
        super().__init__(message)
        self.cause_code = cause_code if cause_code in LLM_FALLBACK_CAUSES or cause_code.startswith(LLM_HTTP_CAUSE_PREFIX) else "unknown"


class BaseProvider:
    """Provider 抽象基类。

    __init__ 是**构造契约的显式声明**：PROVIDERS 的值类型是 type[BaseProvider]，
    get_provider() 以关键字参数实例化它。此前基类没有 __init__，mypy 实测判
    「Unexpected keyword argument base_url/api_key/model/timeout for BaseProvider」4 条——
    即"新增 Provider 若签名不一致，运行时才炸"这一真实缺口，类型层现在静态就能拦住。
    子类各自实现自己的 __init__（与 JS 端 llm.js 保持同构），本方法只承载契约。
    """

    name = "base"

    def __init__(self, base_url: str, api_key: str, model: str, timeout: float = HARD_TIMEOUT_S) -> None:
        self.base_url = base_url
        self.api_key = api_key
        self.model = model
        self.timeout = timeout

    def chat(self, messages: list[dict], json_mode: bool = False, temperature: float = 0.3) -> str:
        raise NotImplementedError


class OpenAICompatProvider(BaseProvider):
    """OpenAI 兼容 /chat/completions 协议（DeepSeek、Qwen 兼容模式、本地网关均可）。"""

    name = "openai_compatible"

    def __init__(self, base_url: str, api_key: str, model: str, timeout: float = HARD_TIMEOUT_S):
        self.base_url = base_url
        self.api_key = api_key
        self.model = model
        self.timeout = timeout

    def chat(self, messages: list[dict], json_mode: bool = False, temperature: float = 0.3) -> str:
        if not self.api_key:
            raise LLMUnavailable(f"{self.name}: API Key 未配置", "no_key")
        payload = {"model": self.model, "messages": messages, "temperature": temperature}
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        try:
            resp = httpx.post(
                f"{self.base_url.rstrip('/')}/chat/completions",
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"},
                json=payload,
                timeout=self.timeout,
            )
        except httpx.TimeoutException:
            # 超时与网络失败必须分家：把"出口不通"记成"模型太慢"，接下来的修复就会去抬超时，白抬。
            raise LLMUnavailable("llm timeout", "timeout") from None
        except httpx.HTTPError as e:
            raise LLMUnavailable(f"llm network error: {type(e).__name__}", "net_error") from None
        if resp.status_code != 200:
            raise LLMUnavailable(f"llm http {resp.status_code}", f"{LLM_HTTP_CAUSE_PREFIX}{resp.status_code}")
        try:
            data = resp.json()
        except Exception:
            raise LLMUnavailable("llm body not json", "bad_json") from None
        try:
            finish = data["choices"][0].get("finish_reason")
        except (KeyError, IndexError, AttributeError, TypeError):
            finish = None
        if finish not in LLM_FINISH_OK:
            code = "truncated" if finish == "length" else ("content_filter" if finish == "content_filter" else "finish_unrecognized")
            raise LLMUnavailable(f"llm finish_reason {finish}", code)
        content = None
        try:
            content = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raise LLMUnavailable("llm response missing content", "empty") from None
        if not isinstance(content, str) or not content.strip():
            raise LLMUnavailable("llm response missing content", "empty")
        return content


PROVIDERS: dict[str, type[BaseProvider]] = {
    OpenAICompatProvider.name: OpenAICompatProvider,
}


def get_provider(settings: dict | None = None) -> BaseProvider:
    s = settings or get_settings()
    name = str(s.get("llm_provider") or OpenAICompatProvider.name).strip().lower()
    cls = PROVIDERS.get(name)
    if not cls:
        raise LLMUnavailable(f"unknown llm provider: {name}")
    return cls(
        base_url=s["deepseek_base_url"], api_key=s["deepseek_api_key"],
        model=s["deepseek_model"], timeout=HARD_TIMEOUT_S,
    )


def chat(messages: list[dict], json_mode: bool = False, temperature: float = 0.3) -> str:
    """返回模型原始文本；无 Key / 超时 / 网络 / HTTP 非 200 / 响应缺内容均抛 LLMUnavailable 并带 cause_code。"""
    if not llm_available():
        raise LLMUnavailable("DeepSeek API Key 未配置", "no_key")
    return get_provider().chat(messages, json_mode=json_mode, temperature=temperature)


def chat_json(messages: list[dict]) -> dict:
    """JSON 模式；解析失败抛 LLMUnavailable（由 engine 决定降级）。"""
    raw = chat(messages, json_mode=True)
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        raise LLMUnavailable("llm output not json", "bad_json") from None
    if not isinstance(data, dict):
        raise LLMUnavailable("llm output not an object", "schema")
    return data
