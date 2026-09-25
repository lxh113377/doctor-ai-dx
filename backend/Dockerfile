FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    BACKEND_HOST=0.0.0.0 \
    BACKEND_PORT=8000

WORKDIR /srv/backend

# 依赖层单独缓存：requirements.lock 不变则不重装。
# **从锁文件安装且开 --require-hashes**（第十八轮）：此前装的是 requirements.txt 的浮动区间，
# 同一个 tag 在不同时间会装出不同环境、镜像无法审计。锁由
# `uv pip compile requirements.txt --python-version 3.12 --python-platform x86_64-unknown-linux-gnu --generate-hashes`
# 生成（按本镜像的 Linux/glibc 解析），对账判据见 scripts/lock_guard.py。
COPY requirements.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock

COPY app ./app
COPY run.py ./
# 测试随镜像提供：`docker compose run --rm backend python tests/smoke_engine.py` 可在容器内自证
COPY tests ./tests

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health',timeout=4).status==200 else 1)"

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
