"""Read scope and support documents into plain text."""

from __future__ import annotations

import csv
import html
import re
from dataclasses import dataclass
from pathlib import Path

SUPPORTED = {".pdf", ".docx", ".xlsx", ".xlsm", ".pptx", ".txt", ".md", ".csv", ".html", ".htm", ".json"}

# Roughly 4 characters per token; leave room under a 1M-token context window.
MAX_TOTAL_CHARS = 3_000_000


@dataclass
class Document:
    name: str
    text: str

    @property
    def chars(self) -> int:
        return len(self.text)


def _read_pdf(path: Path) -> str:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    pages = []
    for i, page in enumerate(reader.pages, 1):
        pages.append(f"[Page {i}]\n{page.extract_text() or ''}")
    return "\n\n".join(pages)


def _read_docx(path: Path) -> str:
    import docx

    d = docx.Document(str(path))
    parts = []
    for p in d.paragraphs:
        if not p.text.strip():
            continue
        style = (p.style.name or "") if p.style is not None else ""
        prefix = "#" * int(style[-1]) + " " if style.startswith("Heading") and style[-1:].isdigit() else ""
        parts.append(prefix + p.text)
    for ti, table in enumerate(d.tables, 1):
        parts.append(f"\n[Table {ti}]")
        for row in table.rows:
            parts.append(" | ".join(c.text.strip() for c in row.cells))
    return "\n".join(parts)


def _read_xlsx(path: Path) -> str:
    import openpyxl

    wb = openpyxl.load_workbook(str(path), data_only=True, read_only=True)
    parts = []
    for ws in wb.worksheets:
        parts.append(f"[Sheet: {ws.title}]")
        for row in ws.iter_rows(values_only=True):
            if any(v is not None and str(v).strip() for v in row):
                parts.append(" | ".join("" if v is None else str(v) for v in row))
    return "\n".join(parts)


def _read_pptx(path: Path) -> str:
    from pptx import Presentation

    prs = Presentation(str(path))
    parts = []
    for i, slide in enumerate(prs.slides, 1):
        parts.append(f"[Slide {i}]")
        for shape in slide.shapes:
            if shape.has_text_frame and shape.text_frame.text.strip():
                parts.append(shape.text_frame.text)
    return "\n".join(parts)


def _read_html(path: Path) -> str:
    raw = path.read_text(encoding="utf-8", errors="replace")
    raw = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", raw)
    raw = re.sub(r"(?i)<br\s*/?>|</(p|div|li|tr|h[1-6])>", "\n", raw)
    text = html.unescape(re.sub(r"<[^>]+>", " ", raw))
    return re.sub(r"[ \t]+", " ", re.sub(r"\n\s*\n+", "\n\n", text)).strip()


def _read_csv(path: Path) -> str:
    with path.open(newline="", encoding="utf-8", errors="replace") as f:
        return "\n".join(" | ".join(row) for row in csv.reader(f))


def read_document(path: Path) -> Document:
    ext = path.suffix.lower()
    if ext == ".pdf":
        text = _read_pdf(path)
    elif ext == ".docx":
        text = _read_docx(path)
    elif ext in (".xlsx", ".xlsm"):
        text = _read_xlsx(path)
    elif ext == ".pptx":
        text = _read_pptx(path)
    elif ext in (".html", ".htm"):
        text = _read_html(path)
    elif ext == ".csv":
        text = _read_csv(path)
    else:
        text = path.read_text(encoding="utf-8", errors="replace")
    return Document(name=path.name, text=text.strip())


def collect(inputs: list[Path]) -> tuple[list[Document], list[str]]:
    """Read every supported file under the given files/folders.

    Returns the documents and a list of warnings (skipped or empty files).
    """
    files: list[Path] = []
    for p in inputs:
        if p.is_dir():
            files.extend(sorted(f for f in p.rglob("*") if f.is_file()))
        elif p.is_file():
            files.append(p)
        else:
            raise FileNotFoundError(p)

    docs, warnings = [], []
    for f in files:
        if f.suffix.lower() not in SUPPORTED:
            warnings.append(f"Skipped unsupported file type: {f}")
            continue
        try:
            doc = read_document(f)
        except Exception as exc:  # a bad file should not stop the run
            warnings.append(f"Could not read {f}: {exc}")
            continue
        if not doc.text:
            warnings.append(f"No text found in {f} (scanned PDF? run OCR first)")
            continue
        docs.append(doc)

    total = sum(d.chars for d in docs)
    if total > MAX_TOTAL_CHARS:
        raise ValueError(
            f"The documents hold about {total // 4:,} tokens, more than fits in one request. "
            "Split the pack into smaller runs or remove appendices that are not needed."
        )
    return docs, warnings
