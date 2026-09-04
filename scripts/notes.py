#!/usr/bin/env python3
"""must-bee notes — 课件 → Obsidian 复习笔记生成器

用法:
  python3 notes.py                          # 为所有课程的未笔记课件生成笔记
  python3 notes.py --course CS440           # 只处理指定课程
  python3 notes.py --force                  # 已存在的笔记也重新生成
  python3 notes.py --dry-run                # 只列出将处理的课件，不调用 LLM
  python3 notes.py --limit 1                # 最多处理 N 份课件

输出: JSON 到 stdout（每份课件一个对象）。LLM 调用失败会进入 errors。
依赖: PyMuPDF (fitz), python-pptx, requests。DEEPSEEK_API_KEY 从
~/.hermes/.env 或 must-bee/.env 读取。vault 路径优先 OBSIDIAN_VAULT_PATH
环境变量，否则 ~/Vaults/Obsidian。
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
MODEL = "deepseek-chat"
MAX_SOURCE_CHARS = 30000  # 每份课件喂给 LLM 的最大字符数

VAULT_DEFAULT = Path.home() / "Vaults/Obsidian"


def get_wemust_root() -> Path:
    base = os.environ.get("MUSTER_DOWNLOAD_PATH", str(Path.home() / "Documents/wemust"))
    return Path(base) / "wemust"

SYSTEM_PROMPT = """你是课程助教，负责把讲义课件转成学生复习用的 Obsidian 笔记。用中文写，专业术语保留英文原文。

严格按以下结构输出（从 ## 开始，不要输出一级标题，不要输出 frontmatter）：

## 一、本次课主题
2-3 句话概括这节课讲什么、在课程中的位置。

## 二、知识结构
层级大纲覆盖课件全部章节，每个小节 1-2 行要点。课件没讲的章节不要写。

## 三、关键概念（问答卡）
每个概念一行，格式（冒号前是问题，两个冒号后是答案）：
- <概念/问题>？:: <答案>
挑 8-15 个最核心的概念。这是 Obsidian 闪卡语法，格式必须准确。

## 四、公式与算法
重要公式用 $$...$$ 包裹，逐条解释每个符号的含义。代码/伪代码用代码块。

## 五、挖空练习
5-8 条，格式：
- <句子，挖掉最关键的概念词> ==答案==。
只挖课件里明确讲过的内容。

## 六、易错点
3-5 条常见误解或易混淆点，每条说明正确理解是什么。

规则：
- 不编造课件里没有的内容；信息不足的写「课件未涉及」
- 只输出 Markdown 正文，不要任何开头寒暄或结尾总结语
"""


def load_env():
    """从 ~/.hermes/.env 和 ~/projects/must-bee/.env 读取环境变量（不覆盖已存在的）。"""
    for env_path in [
        Path.home() / ".hermes/.env",
        Path.home() / "projects/must-bee/.env",
    ]:
        if not env_path.exists():
            continue
        try:
            for line in env_path.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
        except OSError:
            pass


def extract_pdf(path: Path) -> str:
    import fitz  # PyMuPDF
    doc = fitz.open(str(path))
    pages = []
    for page in doc:
        try:
            pages.append(page.get_text("text"))
        except Exception:
            pages.append("")
    doc.close()
    return "\n\n".join(pages)


def extract_pptx(path: Path) -> str:
    from pptx import Presentation
    prs = Presentation(str(path))
    slides = []
    for i, slide in enumerate(prs.slides, 1):
        parts = [f"[Slide {i}]"]
        for shape in slide.shapes:
            if shape.has_text_frame:
                txt = "\n".join(p.text for p in shape.text_frame.paragraphs if p.text)
                if txt.strip():
                    parts.append(txt)
            if shape.shape_type == 19:  # table
                try:
                    for row in shape.table.rows:
                        cells = [c.text.strip() for c in row.cells]
                        if any(cells):
                            parts.append(" | ".join(cells))
                except Exception:
                    pass
        slides.append("\n".join(parts))
    return "\n\n".join(slides)


def extract_text(path: Path):
    ext = path.suffix.lower()
    if ext == ".pdf":
        return extract_pdf(path)
    if ext == ".pptx":
        return extract_pptx(path)
    raise ValueError(f"unsupported extension: {ext} (only PDF/PPTX supported)")


def call_deepseek(source_text: str, meta: dict) -> str:
    import requests
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        raise RuntimeError("DEEPSEEK_API_KEY not found in env files")
    user = (
        f"课程: {meta['course']} ({meta['courseCode']})\n"
        f"课件: {meta['filename']}（{meta['date']}）\n\n"
        f"课件内容:\n{source_text}"
    )
    resp = requests.post(
        DEEPSEEK_URL,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={
            "model": MODEL,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user},
            ],
            "max_tokens": 4000,
            "temperature": 0.3,
        },
        timeout=180,
    )
    resp.raise_for_status()
    data = resp.json()
    content = data["choices"][0]["message"]["content"]
    return content.strip()


def note_frontmatter(meta: dict) -> str:
    title = f"{meta['date']} {Path(meta['filename']).stem}"
    return (
        "---\n"
        f"title: \"{title}\"\n"
        f"course: \"{meta['course']}\"\n"
        f"courseCode: {meta['courseCode']}\n"
        f"lectureDate: {meta['date']}\n"
        f"source: \"{meta['fileUrl']}\"\n"
        "type: courseware-note\n"
        "tags: [courseware, " + meta['courseCode'] + "]\n"
        "---\n\n"
    )


def load_course_state(course_dir: Path):
    p = course_dir / ".muster.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def note_path_for(vault: Path, meta: dict) -> Path:
    course_folder = safe_name(f"{meta['course']} {meta['courseCode']}")
    stem = Path(meta["filename"]).stem
    return vault / "Courses" / course_folder / f"{meta['date']} {stem}.md"


def safe_name(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|]+', "_", name).strip()


def scan_tasks(vault: Path, course_filter=None, force=False):
    """扫描 wemust 下载目录，找出需要生成笔记的课件。"""
    tasks = []
    wemust_root = get_wemust_root()
    if not wemust_root.exists():
        return tasks
    for course_dir in sorted(wemust_root.iterdir()):
        if not course_dir.is_dir():
            continue
        state = load_course_state(course_dir)
        if not state or not state.get("files"):
            continue
        code = state.get("courseCode") or ""
        name = state.get("courseName") or course_dir.name
        if course_filter and code.upper() != course_filter.upper():
            continue
        for f in state["files"]:
            if not f.get("path"):
                continue
            src = course_dir / f["path"]
            if not src.exists():
                continue
            if src.suffix.lower() not in (".pdf", ".pptx"):
                continue
            meta = {
                "course": name,
                "courseCode": code,
                "filename": f["filename"],
                "date": f.get("uploadDate") or "unknown",
                "fileUrl": f.get("fileUrl") or "",
                "srcPath": str(src),
            }
            note_path = note_path_for(vault, meta)
            if note_path.exists() and not force:
                continue
            tasks.append({"meta": meta, "notePath": str(note_path), "exists": note_path.exists()})
    return tasks


def generate_note(meta: dict, force=False) -> dict:
    src = Path(meta["srcPath"])
    text = extract_text(src)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if not text:
        return {"error": "empty extracted text"}
    if len(text) > MAX_SOURCE_CHARS:
        text = text[:MAX_SOURCE_CHARS] + "\n\n[内容过长已截断]"
    body = call_deepseek(text, meta)
    return {"body": body}


def main():
    parser = argparse.ArgumentParser(description="课件 → Obsidian 复习笔记")
    parser.add_argument("--course", help="只处理指定课程代码")
    parser.add_argument("--force", action="store_true", help="覆盖已存在的笔记")
    parser.add_argument("--dry-run", action="store_true", help="只列出任务不生成")
    parser.add_argument("--limit", type=int, default=0, help="最多生成 N 份")
    args = parser.parse_args()

    load_env()
    vault = Path(os.environ.get("OBSIDIAN_VAULT_PATH", "")) if os.environ.get("OBSIDIAN_VAULT_PATH") else VAULT_DEFAULT
    # 旧路径纠偏：.env 里的路径指向 iCloud 旧库时回退到主库
    if not vault.exists() or vault == Path.home() / "Documents/Obsidian Vault":
        vault = VAULT_DEFAULT
    if not vault.exists():
        print(json.dumps({"error": f"vault not found: {vault}"}))
        sys.exit(1)

    tasks = scan_tasks(vault, args.course, args.force)
    if args.limit > 0:
        tasks = tasks[: args.limit]

    if args.dry_run:
        print(json.dumps({
            "vault": str(vault),
            "tasks": [{"course": t["meta"]["courseCode"], "file": t["meta"]["filename"],
                       "note": t["notePath"], "exists": t["exists"]} for t in tasks]
        }, ensure_ascii=False, indent=2))
        return

    results = []
    errors = []
    for t in tasks:
        meta = t["meta"]
        try:
            gen = generate_note(meta)
            if "error" in gen:
                errors.append({**meta, "error": gen["error"]})
                continue
            note_path = Path(t["notePath"])
            note_path.parent.mkdir(parents=True, exist_ok=True)
            content = note_frontmatter(meta) + gen["body"] + "\n"
            note_path.write_text(content)
            results.append({
                "course": meta["course"],
                "courseCode": meta["courseCode"],
                "file": meta["filename"],
                "note": str(note_path),
                "chars": len(content),
            })
        except Exception as e:
            errors.append({**meta, "error": f"{type(e).__name__}: {e}"})

    print(json.dumps({"vault": str(vault), "generated": results, "errors": errors},
                     ensure_ascii=False, indent=2))
    if errors and not results:
        sys.exit(1)


if __name__ == "__main__":
    main()
