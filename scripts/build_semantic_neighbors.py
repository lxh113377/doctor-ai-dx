"""语义邻接表离线构建器（唯一产出者，双端同源）。

为什么要它：本项目线上权威面是 Cloudflare Pages + Functions（serverless），运行期跑不了 onnx 模型，
也托管不了 Milvus/Chroma/FAISS 这类向量服务（同类开源医疗 RAG 项目的普遍做法）。
因此把「语义相似」在构建期一次性算完、蒸馏成 KB 条目间的邻接表落盘：
运行时零模型、零网络、零外部服务，且是纯查表——能进双端 31:31 逐字段契约对账。

相似度来源（provenance，全部写进产物文件头）：
  模型  BAAI/bge-small-zh-v1.5（512 维，L2 归一后取余弦）
  权重  sha256 见 MODEL_SHA256
  编码  焚诀 eval/bge_onnx_engine.py 的纯 Python WordPiece + onnxruntime 推理
  文本  f"{title} {condition} {keywords} {text}"（与 retriever.js docText 同形）

用法：
  python scripts/build_semantic_neighbors.py --engine-dir <含 bge_onnx_engine.py 的目录>
环境变量 BGE_ENGINE_DIR 可替代 --engine-dir。缺目录即报错退出（不产出半成品表）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS_KB = ROOT / "frontend" / "functions" / "lib" / "knowledge.js"
OUT_JS = ROOT / "frontend" / "functions" / "lib" / "semantic_neighbors.js"
OUT_PY = ROOT / "backend" / "app" / "semantic_neighbors.py"

MODEL_ID = "BAAI/bge-small-zh-v1.5"
MODEL_SHA256 = "69a0b846f4f116b5e6aabf9546ea6754d02264f3211a13a1bd69b31b8040749a"
DIM = 512
TOP_KEEP = 8          # 存富余集（运行时再切 SEM_TOP），改切档不必重建本表
MIN_COS = 0.55        # 存表地板；实测全量 off-diagonal 均值 0.552 / p90 0.640（2026-09-25）
SCORE_SCALE = 1000    # 千分比整数：JS/Py 两侧零浮点表示差

DUMP_JS = """
import { KNOWLEDGE_BASE } from %s
const slim = KNOWLEDGE_BASE.map(k => ({
  id: k.id,
  doc: `${k.title} ${k.condition || ''} ${(k.keywords || []).join(' ')} ${k.text}`,
}))
process.stdout.write(JSON.stringify(slim))
"""


def load_corpus() -> list[dict]:
    """从权威源 knowledge.js 取语料（单向 js→产物，与 export_kb.mjs 同方向，禁反向手改）。"""
    if not JS_KB.exists():
        raise SystemExit(f"FAIL: 权威知识库不存在 {JS_KB}")
    spec = JS_KB.as_uri()
    proc = subprocess.run(["node", "--input-type=module", "-e", DUMP_JS % json.dumps(spec)],
                          capture_output=True, text=True, encoding="utf-8")
    if proc.returncode != 0:
        raise SystemExit(f"FAIL: node 读取 knowledge.js 失败 rc={proc.returncode}\n{proc.stderr[:800]}")
    rows = json.loads(proc.stdout)
    if not rows:
        raise SystemExit("FAIL: 语料为空（R247：'0 命中'须先证输入非空）")
    return rows


def corpus_sha(rows: list[dict]) -> str:
    """语料指纹：按 id 排序后对 id+doc 串联取 sha256——知识库一改即变，防邻接表静默陈旧。"""
    payload = "\n".join(f"{r['id']}::={r['doc']}" for r in sorted(rows, key=lambda x: x["id"]))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def encode(rows: list[dict], engine_dir: str):
    import numpy as np

    sys.path.insert(0, engine_dir)
    try:
        from bge_onnx_engine import BgeOnnxEncoder
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"FAIL: 无法导入 bge_onnx_engine（engine-dir={engine_dir}）：{exc}")
    enc = BgeOnnxEncoder()
    vec = enc.encode([r["doc"] for r in rows])
    if vec.shape[1] != DIM:
        raise SystemExit(f"FAIL: 维度漂移 期望{DIM} 实测{vec.shape[1]}")
    vec = vec / np.linalg.norm(vec, axis=1, keepdims=True)
    return vec @ vec.T


def build_table(rows: list[dict], sim) -> dict[str, list[list]]:
    ids = [r["id"] for r in rows]
    table: dict[str, list[list]] = {}
    for i, kid in enumerate(ids):
        order = sorted(range(len(ids)), key=lambda j: (-float(sim[i, j]), ids[j]))
        pairs = []
        for j in order:
            if i == j:
                continue                      # 禁自环
            s = float(sim[i, j])
            if s < MIN_COS or len(pairs) >= TOP_KEEP:
                break                         # 富余集到此为止（升序已排好，后面只更差）
            pairs.append([ids[j], round(s * SCORE_SCALE)])
        table[kid] = pairs                    # 即使为空也要保 key，防「条目静默消失」
    return table


HEADER = (
    f"MODEL_ID={MODEL_ID} DIM={DIM} MODEL_SHA256={MODEL_SHA256}\n"
    f"TEXT_FIELD=title+condition+keywords+text | TOP_KEEP={TOP_KEEP} MIN_COS={MIN_COS} SCORE_SCALE={SCORE_SCALE}\n"
)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine-dir", default=os.getenv("BGE_ENGINE_DIR", ""))
    args = ap.parse_args()
    if not args.engine_dir or not (Path(args.engine_dir) / "bge_onnx_engine.py").exists():
        raise SystemExit("FAIL: 未找到 bge_onnx_engine.py——请给 --engine-dir 或 BGE_ENGINE_DIR（不产出半成品表）")

    rows = load_corpus()
    sha = corpus_sha(rows)
    sim = encode(rows, args.engine_dir)
    table = build_table(rows, sim)
    total = sum(len(v) for v in table.values())
    empty = [k for k, v in table.items() if not v]

    js = ["// 语义邻接表（构建期产物，禁手改）——由 scripts/build_semantic_neighbors.py 生成。",
          "// 生成器/模型/参数/语料指纹见 SEMANTIC_META；运行时零模型零网络，纯查表，双端同源。",
          f"// {HEADER.replace(chr(10), ' | ')}",
          "// 语料指纹（knowledge.js 变更须重跑本脚本，semantic_guard 会拦漂移）：",
          f"export const SEMANTIC_META = {{",
          f"  modelId: {json.dumps(MODEL_ID)}, modelSha256: {json.dumps(MODEL_SHA256)}, dim: {DIM},",
          f"  topKeep: {TOP_KEEP}, minCos: {MIN_COS}, scoreScale: {SCORE_SCALE},",
          f"  corpusSha256: {json.dumps(sha)}, entries: {len(rows)}, generatedAt: {json.dumps(date.today().isoformat())},",
          "}",
          "",
          "export const SEMANTIC_NEIGHBORS = {"]
    for kid in sorted(table):
        body = ", ".join(f'["{n}", {s}]' for n, s in table[kid])
        js.append(f'  "{kid}": [{body}],')
    js.append("}\n")
    OUT_JS.write_text("\n".join(js), encoding="utf-8", newline="\n")

    py = ['"""语义邻接表（构建期产物，禁手改）——由 scripts/build_semantic_neighbors.py 生成。',
          "运行时零模型零网络，纯查表；与 frontend/functions/lib/semantic_neighbors.js 同源同值。",
          f"{HEADER}\"\"\"",
          "SEMANTIC_META = {",
          f"    'modelId': {json.dumps(MODEL_ID)}, 'modelSha256': {json.dumps(MODEL_SHA256)}, 'dim': {DIM},",
          f"    'topKeep': {TOP_KEEP}, 'minCos': {MIN_COS}, 'scoreScale': {SCORE_SCALE},",
          f"    'corpusSha256': {json.dumps(sha)}, 'entries': {len(rows)}, 'generatedAt': {json.dumps(date.today().isoformat())},",
          "}",
          "",
          "SEMANTIC_NEIGHBORS = {"]
    for kid in sorted(table):
        body = ", ".join(f'("{n}", {s})' for n, s in table[kid])
        py.append(f"    {json.dumps(kid)}: [{body}],")
    py.append("}\n")
    OUT_PY.write_text("\n".join(py), encoding="utf-8", newline="\n")

    print(f"BUILT entries={len(rows)} pairs={total} avg_neighbors={total/len(rows):.1f} "
          f"empty={len(empty)} corpus_sha={sha[:16]}")
    if empty:
        print(f"EMPTY_KEYS={empty}")
    print(f"WROTE {OUT_JS} ({OUT_JS.stat().st_size} B) | {OUT_PY} ({OUT_PY.stat().st_size} B)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
