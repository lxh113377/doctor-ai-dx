"""工程配置：环境变量加载 + LLM 可用性判定。"""
import os
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


@lru_cache(maxsize=1)
def get_settings() -> dict:
    return {
        "deepseek_api_key": os.getenv("DEEPSEEK_API_KEY", "").strip(),
        "deepseek_base_url": os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1"),
        "deepseek_model": os.getenv("DEEPSEEK_MODEL", "deepseek-chat"),
        "backend_host": os.getenv("BACKEND_HOST", "127.0.0.1"),
        "backend_port": int(os.getenv("BACKEND_PORT", "8000")),
        "cors_origins": [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",") if o.strip()],
    }


def llm_available() -> bool:
    """无 API Key 时返回 False，全链路降级为内置演示数据（保证 demo 可跑）。"""
    return bool(get_settings()["deepseek_api_key"])