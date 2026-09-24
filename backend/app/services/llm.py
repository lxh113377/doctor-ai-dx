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


class LLMUnavailable(Exception):
    pass


class BaseProvider:
    name = "base"

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
            raise LLMUnavailable(f"{self.name}: API Key 未配置")
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
        except httpx.HTTPError as e:
            raise LLMUnavailable(f"llm network error: {e}")
        if resp.status_code != 200:
            raise LLMUnavailable(f"llm http {resp.status_code}")
        return resp.json()["choices"][0]["message"]["content"]


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
    """返回模型原始文本；无 Key / HTTP 错误 / 超时均抛 LLMUnavailable。"""
    if not llm_available():
        raise LLMUnavailable("DeepSeek API Key 未配置")
    return get_provider().chat(messages, json_mode=json_mode, temperature=temperature)


def chat_json(messages: list[dict]) -> dict:
    """JSON 模式；解析失败抛 LLMUnavailable（由 engine 决定降级）。"""
    raw = chat(messages, json_mode=True)
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise LLMUnavailable("llm output not an object")
    return data
