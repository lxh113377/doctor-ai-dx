FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    BACKEND_HOST=0.0.0.0 \
    BACKEND_PORT=8000

WORKDIR /srv/backend

# 依赖层单独缓存：锁不变则不重装。
# **从锁文件安装且开 --require-hashes**（第十八轮）：此前装的是 requirements.txt 的浮动区间，
# 同一个 tag 在不同时间会装出不同环境、镜像无法审计。锁由
# `python scripts/recompile_locks.py` 一次性重算（第十八轮的单文件命令已升级，见该脚本头注），
# 对账判据见 scripts/lock_guard.py。
#
# 多架构（第二十二轮）：`--python-platform` 解析出的锁**按平台分列 wheel 哈希**，
# 因此 arm64 不能用 amd64 那份锁（`--require-hashes` 会因缺 aarch64 轮直接装不动）。
# 两把锁由同一次重算产出（版本集必须全等，由 lock_guard 钉住）；这里先按 TARGETARCH 选锁、
# 再保持单一安装入口 `-r requirements.lock`，避免"两条安装命令只有一条开 require-hashes"的形态。
COPY requirements.lock requirements.arm64.lock ./
ARG TARGETARCH
RUN if [ "$TARGETARCH" = "arm64" ]; then cp requirements.arm64.lock requirements.lock; fi
RUN pip install --no-cache-dir --require-hashes -r requirements.lock

COPY app ./app
COPY run.py ./
# 自证 runner 与套件清单必须一起进镜像：runner 从 tests/suite.json 读单源清单，
# 少 COPY 一个就是"compose selftest 在镜像里报文件不存在"（第二十轮实测踩过一次类似坑）。
COPY selftest.py ./
# 测试随镜像提供：`docker compose run --rm backend python tests/smoke_engine.py` 可在容器内自证
COPY tests ./tests

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health',timeout=4).status==200 else 1)"

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
