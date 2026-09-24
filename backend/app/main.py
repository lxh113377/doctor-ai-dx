"""FastAPI 入口：应用组装 + CORS + 路由注册。"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .routers import api

app = FastAPI(
    title="医 · AI 辅助诊断 API",
    version="0.2.0",
    description="基层 AI 辅助诊断 MVP 后端：问诊 / 危险信号规则层 / RAG 知识库引用 / 结构化结论。",
)

settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings["cors_origins"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api.router)


def _health_data():
    from .config import llm_available
    return {"status": "ok", "llm_mode": "live" if llm_available() else "mock-fallback"}


@app.get("/health")
def health():
    return _health_data()


@app.get("/api/health")
def api_health():
    return {"code": 0, "data": _health_data()}