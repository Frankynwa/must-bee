#!/usr/bin/env python3
"""must-bee notes — generate Obsidian review notes from courseware.

Usage:
  python3 notes.py                          # every courseware file without a note
  python3 notes.py --course CS440           # only that course
  python3 notes.py --force                  # regenerate existing notes
  python3 notes.py --dry-run                # list tasks, no LLM calls
  python3 notes.py --limit 1                # process at most N files

Output: JSON on stdout. Per-file failures go into `errors`; the process exits
non-zero only when every task failed.

Requirements: PyMuPDF (fitz), python-pptx, requests.
Credentials: DEEPSEEK_API_KEY (environment, repo .env, or ~/.hermes/.env).
Privacy: the extracted text of each courseware file is sent to the configured
DeepSeek-compatible API. Do not run this on material you cannot share.
"""
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

DEFAULT_API_BASE = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-chat"
MAX_SOURCE_CHARS = 30000  # max characters of courseware fed to the LLM per file
MAX_FILES_PER_RUN = 500

# Only these keys are imported from .env files. A shared ~/.hermes/.env can
# contain unrelated secrets; the notes child process has no reason to see them.
ALLOWED_ENV_KEYS = {
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_API_BASE",
    "DEEPSEEK_MODEL",
    "OBSIDIAN_VAULT_PATH",
    "MUSTER_DOWNLOAD_PATH",
    "MUST_BEE_ENV",
}

COURSE_CODE_RE = re.compile(r"^(\d{4})-([A-Z]{2,4}\d{3})(?![0-9])", re.IGNORECASE)
COURSE_CODE_FALLBACK_RE = re.compile(r"(?:^|[^A-Z0-9])([A-Z]{2,4}\d{3})(?![0-9])")


def derive_course_code(course_name: str) -> str:
    """Recover CS482 from names like 2609-CS482EX1-5A7EE7."""
    text = str(course_name or "").strip()
    match = COURSE_CODE_RE.match(text)
    if match:
        return match.group(2).upper()
    match = COURSE_CODE_FALLBACK_RE.search(text.upper())
    return match.group(1) if match else ""


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def get_wemust_root() -> Path:
    base = os.environ.get("MUSTER_DOWNLOAD_PATH", str(Path.home() / ".must-bee"))
    root = Path(base).expanduser() / "wemust"

    def has_course_state(directory: Path) -> bool:
        try:
            return directory.is_dir() and any(
                (child / ".muster.json").is_file()
                for child in directory.iterdir() if child.is_dir()
            )
        except OSError:
            return False

    # Compatibility with the old ~/.must-bee/wemust/wemust default.
    nested = root / "wemust"
    if not has_course_state(root) and has_course_state(nested):
        return nested
    return root


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


def _parse_env_line(line: str):
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    if line.startswith("export "):
        line = line[len("export "):].lstrip()
    if "=" not in line:
        return None
    key, _, value = line.partition("=")
    key = key.strip()
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
        return None
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    else:
        value = re.sub(r"\s+#.*$", "", value)
    return key, value


def load_env():
    """Load KEY=VALUE pairs without overwriting the real environment.

    Search order (first wins): $MUST_BEE_ENV, <repo>/.env,
    ~/.config/must-bee/.env, ~/.must-bee/.env, ~/.hermes/.env (legacy).
    """
    candidates = []
    override = os.environ.get("MUST_BEE_ENV")
    if override:
        candidates.append(Path(override).expanduser())
    candidates.extend([
        repo_root() / ".env",
        Path.home() / ".config/must-bee/.env",
        Path.home() / ".must-bee/.env",
        Path.home() / ".hermes/.env",  # backward compatibility with Hermes setups
    ])
    for env_path in candidates:
        if not env_path.is_file():
            continue
        try:
            for line in env_path.read_text().splitlines():
                parsed = _parse_env_line(line)
                if not parsed:
                    continue
                key, value = parsed
                if key in ALLOWED_ENV_KEYS and key not in os.environ:
                    os.environ[key] = value
        except OSError:
            pass


def resolve_vault() -> Path:
    env_value = os.environ.get("OBSIDIAN_VAULT_PATH")
    legacy_icloud = Path.home() / "Documents/Obsidian Vault"
    main_vault = Path.home() / "Vaults/Obsidian"
    # An old iCloud placeholder is still exported by some setups. Prefer the
    # migrated main vault when both exist, even if the env var is stale.
    if env_value and Path(env_value).expanduser() == legacy_icloud and main_vault.is_dir():
        return main_vault

    candidates = []
    if env_value:
        candidates.append(Path(env_value).expanduser())
    candidates.extend([main_vault, Path.home() / "Obsidian"])
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    if legacy_icloud.is_dir() and not env_value:
        return legacy_icloud
    return candidates[0]


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
        raise RuntimeError("DEEPSEEK_API_KEY not found in environment or .env files")
    base = os.environ.get("DEEPSEEK_API_BASE", DEFAULT_API_BASE).rstrip("/")
    url = base if base.endswith("/chat/completions") else f"{base}/chat/completions"
    model = os.environ.get("DEEPSEEK_MODEL", DEFAULT_MODEL)
    user = (
        f"课程: {meta['course']} ({meta['courseCode']})\n"
        f"课件: {meta['filename']}（{meta['date']}）\n\n"
        f"课件内容:\n{source_text}"
    )
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user},
        ],
        "max_tokens": 4000,
        "temperature": 0.3,
    }
    last_error = None
    for attempt in range(3):
        resp = requests.post(
            url,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json=payload,
            timeout=180,
        )
        if resp.status_code in (429, 500, 502, 503, 504) and attempt < 2:
            last_error = f"HTTP {resp.status_code}"
            time.sleep(2 ** attempt)
            continue
        resp.raise_for_status()
        data = resp.json()
        content = data["choices"][0]["message"]["content"]
        return content.strip()
    raise RuntimeError(f"DeepSeek API failed after retries: {last_error}")


def yaml_string(value) -> str:
    """JSON strings are valid YAML double-quoted scalars."""
    return json.dumps(str(value), ensure_ascii=False)


def note_frontmatter(meta: dict) -> str:
    title = f"{meta['date']} {Path(meta['filename']).stem}"
    return (
        "---\n"
        f"title: {yaml_string(title)}\n"
        f"course: {yaml_string(meta['course'])}\n"
        f"courseCode: {yaml_string(meta['courseCode'])}\n"
        f"lectureDate: {yaml_string(meta['date'])}\n"
        f"source: {yaml_string(meta['fileUrl'])}\n"
        "type: courseware-note\n"
        f"tags: [courseware, {yaml_string(meta['courseCode'])}]\n"
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


def safe_name(name: str) -> str:
    # Treat path separators as separators, not as characters to preserve:
    # "../../2026-01-01" becomes "2026-01-01", never a traversal component.
    parts = [p for p in re.split(r"[\\/]+", str(name)) if p not in ("", ".", "..")]
    cleaned = re.sub(r'[:*?"<>|]+', "_", "_".join(parts)).strip().strip(".")
    return cleaned or "course"


def note_path_for(vault: Path, meta: dict) -> Path:
    course_folder = safe_name(f"{meta['course']} {meta['courseCode']}")
    stem = safe_name(Path(meta["filename"]).stem)
    date = safe_name(meta.get("date") or "unknown")
    return vault / "Courses" / course_folder / f"{date} {stem}.md"


def is_within(base: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(base.resolve())
        return True
    except ValueError:
        return False


def scan_tasks(vault: Path, course_filter=None, force=False):
    """Scan the wemust download directory and return note-generation tasks."""
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
        if not code:
            code = derive_course_code(name) or derive_course_code(course_dir.name)
        if course_filter and code.upper() != course_filter.upper():
            continue
        for f in state["files"]:
            if not f.get("path"):
                continue
            src = (course_dir / f["path"]).resolve()
            if not is_within(wemust_root, src):
                continue  # never read outside the download root
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


def generate_note(meta: dict) -> dict:
    src = Path(meta["srcPath"])
    text = extract_text(src)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if not text:
        return {"error": "empty extracted text"}
    if len(text) > MAX_SOURCE_CHARS:
        text = text[:MAX_SOURCE_CHARS] + "\n\n[内容过长已截断]"
    body = call_deepseek(text, meta)
    return {"body": body}


def write_note_atomic(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)


def main():
    parser = argparse.ArgumentParser(description="Courseware → Obsidian review notes")
    parser.add_argument("--course", help="only this course code")
    parser.add_argument("--force", action="store_true", help="overwrite existing notes")
    parser.add_argument("--dry-run", action="store_true", help="list tasks without calling the LLM")
    parser.add_argument("--limit", type=int, default=0, help="process at most N files")
    args = parser.parse_args()

    load_env()
    vault = resolve_vault()
    if not vault.exists():
        print(json.dumps({
            "error": f"Obsidian vault not found: {vault}. Set OBSIDIAN_VAULT_PATH."
        }))
        sys.exit(1)

    tasks = scan_tasks(vault, args.course, args.force)
    if args.limit > 0:
        tasks = tasks[: min(args.limit, MAX_FILES_PER_RUN)]

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
        note_path = Path(t["notePath"])
        if not is_within(vault / "Courses", note_path):
            errors.append({**meta, "error": "refusing to write outside the vault's Courses directory"})
            continue
        try:
            gen = generate_note(meta)
            if "error" in gen:
                errors.append({**meta, "error": gen["error"]})
                continue
            content = note_frontmatter(meta) + gen["body"] + "\n"
            write_note_atomic(note_path, content)
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
