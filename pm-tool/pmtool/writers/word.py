"""Scope review report (Word): what was read, what is missing, what to ask."""

from __future__ import annotations

from pathlib import Path

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor

from ..schema import Analysis

NAVY = RGBColor(0x1F, 0x38, 0x64)
SEV_FILL = {"High": "F8CBAD", "Medium": "FFE699", "Low": "C6EFCE"}


def _shade(cell, hex_fill: str):
    tc = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_fill)
    tc.append(shd)


def _table(doc, headers, rows, sev_col=None):
    t = doc.add_table(rows=1, cols=len(headers))
    t.style = "Table Grid"
    for i, h in enumerate(headers):
        c = t.rows[0].cells[i]
        c.text = ""
        run = c.paragraphs[0].add_run(h)
        run.bold = True
        run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        _shade(c, "1F3864")
    for row in rows:
        cells = t.add_row().cells
        for i, v in enumerate(row):
            cells[i].text = str(v)
            if sev_col is not None and i == sev_col and v in SEV_FILL:
                _shade(cells[i], SEV_FILL[v])
    for row in t.rows:
        for c in row.cells:
            for p in c.paragraphs:
                for r in p.runs:
                    r.font.size = Pt(9)
    doc.add_paragraph()


def write_scope_review(a: Analysis, path: Path):
    doc = Document()
    sec = doc.sections[0]
    sec.orientation = WD_ORIENT.LANDSCAPE
    sec.page_width, sec.page_height = sec.page_height, sec.page_width
    style = doc.styles["Normal"]
    style.font.name = "Calibri"
    style.font.size = Pt(10.5)

    p, ov = a.overview.project, a.overview
    h = doc.add_heading(f"Scope Review: {p.name}", 0)
    for r in h.runs:
        r.font.color.rgb = NAVY
    doc.add_paragraph(f"Client: {p.client}    Location: {p.location}    Prepared: {a.generated_on}")

    doc.add_heading("1. Project summary", 1)
    doc.add_paragraph(p.description)
    for title, items in [("Objectives", p.objectives), ("In scope", p.in_scope), ("Out of scope", p.out_of_scope),
                         ("Key deliverables", p.key_deliverables), ("Stakeholders", p.stakeholders)]:
        doc.add_heading(title, 2)
        for it in items or ["None identified"]:
            doc.add_paragraph(it, style="List Bullet")

    doc.add_heading("2. Documents reviewed", 1)
    _table(doc, ["Document", "Type", "Summary"], [[d.name, d.document_type, d.summary] for d in ov.documents])

    doc.add_heading("3. Review findings", 1)
    doc.add_paragraph("Gaps, ambiguities and conflicts that affect pricing, planning or delivery.")
    order = {"High": 0, "Medium": 1, "Low": 2}
    _table(doc, ["Area", "Finding", "Impact", "Recommendation", "Severity"],
           [[f.area, f.issue, f.impact, f.recommendation, f.severity]
            for f in sorted(ov.review_findings, key=lambda f: order[f.severity])], sev_col=4)

    doc.add_heading("4. Clarification questions for the client", 1)
    _table(doc, ["Ref", "Question", "Document reference", "Priority"],
           [[c.id, c.question, c.document_ref, c.priority]
            for c in sorted(ov.clarifications, key=lambda c: order[c.priority])], sev_col=3)

    doc.add_heading("5. Gate recommendation", 1)
    doc.add_paragraph(f"{a.gate.gate_name}: {a.gate.recommendation}").runs[0].bold = True
    doc.add_paragraph(a.gate.executive_summary)
    doc.save(path)
