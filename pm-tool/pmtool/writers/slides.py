"""Shared PowerPoint helpers and the organisation chart drawing."""

from __future__ import annotations

from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Inches, Pt

from ..schema import OrgRole

NAVY = RGBColor(0x1F, 0x38, 0x64)
ACCENT = RGBColor(0x2F, 0x55, 0x97)
TEXT = RGBColor(0x26, 0x26, 0x26)
MUTED = RGBColor(0x59, 0x59, 0x59)
LINE = RGBColor(0xA6, 0xA6, 0xA6)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
RED = RGBColor(0xC0, 0x00, 0x00)
AMBER = RGBColor(0xED, 0x9B, 0x00)
GREEN = RGBColor(0x37, 0x86, 0x3C)
LIGHT_RED = RGBColor(0xF8, 0xCB, 0xAD)
LIGHT_AMBER = RGBColor(0xFF, 0xE6, 0x99)
LIGHT_GREEN = RGBColor(0xC6, 0xEF, 0xCE)
PALE = RGBColor(0xF2, 0xF2, 0xF2)

ORG_COLORS = {
    "Client": RGBColor(0x7F, 0x7F, 0x7F),
    "Delivery Team": NAVY,
    "Subcontractor": RGBColor(0x38, 0x76, 0x6E),
    "Third Party": RGBColor(0x8E, 0x5B, 0x9E),
}

SLIDE_W = Inches(13.333)
SLIDE_H = Inches(7.5)


def clip(text: str, n: int) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def textbox(slide, x, y, w, h, text="", size=12, bold=False, color=TEXT, align=PP_ALIGN.LEFT,
            anchor=MSO_ANCHOR.TOP):
    tb = slide.shapes.add_textbox(x, y, w, h)
    tf = tb.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = Inches(0.05)
    lines = text if isinstance(text, list) else [text]
    for i, line in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        r = p.add_run()
        r.text = line
        r.font.size = Pt(size)
        r.font.bold = bold
        r.font.color.rgb = color
    return tb


def bullets(slide, x, y, w, h, items, size=13, color=TEXT, space=6):
    tb = slide.shapes.add_textbox(x, y, w, h)
    tf = tb.text_frame
    tf.word_wrap = True
    for i, item in enumerate(items):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.space_after = Pt(space)
        r = p.add_run()
        r.text = "•  " + item
        r.font.size = Pt(size)
        r.font.color.rgb = color
    return tb


def rect(slide, x, y, w, h, fill, line=None, shape=MSO_SHAPE.RECTANGLE):
    s = slide.shapes.add_shape(shape, x, y, w, h)
    s.fill.solid()
    s.fill.fore_color.rgb = fill
    if line is None:
        s.line.fill.background()
    else:
        s.line.color.rgb = line
        s.line.width = Pt(0.75)
    s.shadow.inherit = False
    return s


def line(slide, x1, y1, x2, y2, color=LINE, width=1.25):
    c = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, x1, y1, x2, y2)
    c.line.color.rgb = color
    c.line.width = Pt(width)
    return c


def table(slide, x, y, w, rows, col_widths, size=10, header_fill=NAVY, row_h=Inches(0.3), fills=None):
    """rows[0] is the header. col_widths are relative weights. fills: {(r,c): RGBColor}."""
    n_rows, n_cols = len(rows), len(rows[0])
    shape = slide.shapes.add_table(n_rows, n_cols, x, y, w, row_h * n_rows)
    tbl = shape.table
    total = sum(col_widths)
    for c, cw in enumerate(col_widths):
        tbl.columns[c].width = Emu(int(w * cw / total))
    for r in range(n_rows):
        tbl.rows[r].height = row_h
        for c in range(n_cols):
            cell = tbl.cell(r, c)
            cell.margin_left = cell.margin_right = Inches(0.05)
            cell.margin_top = cell.margin_bottom = Inches(0.02)
            cell.vertical_anchor = MSO_ANCHOR.MIDDLE
            tf = cell.text_frame
            tf.word_wrap = True
            p = tf.paragraphs[0]
            p.text = ""
            run = p.add_run()
            run.text = "" if rows[r][c] is None else str(rows[r][c])
            run.font.size = Pt(size)
            cell.fill.solid()
            if r == 0:
                run.font.bold = True
                run.font.color.rgb = WHITE
                cell.fill.fore_color.rgb = header_fill
            else:
                run.font.color.rgb = TEXT
                cell.fill.fore_color.rgb = (fills or {}).get((r, c), PALE if r % 2 == 0 else WHITE)
    return shape


# --------------------------------------------------------------------------
# Organisation chart
# --------------------------------------------------------------------------
def _build_tree(roles: list[OrgRole]):
    by_id = {r.id: r for r in roles}
    children: dict[str, list[str]] = {r.id: [] for r in roles}
    roots = []
    for r in roles:
        parent = r.reports_to if r.reports_to in by_id and r.reports_to != r.id else ""
        (children[parent].append(r.id) if parent else roots.append(r.id))
    if not roots and roles:
        roots = [roles[0].id]
    # Guard against cycles: keep only nodes reachable from the roots.
    seen: set[str] = set()

    def walk(n):
        if n in seen:
            return
        seen.add(n)
        children[n] = [c for c in children[n] if c not in seen]
        for c in children[n]:
            walk(c)

    for rt in roots:
        walk(rt)
    orphans = [r.id for r in roles if r.id not in seen]
    if len(roots) > 1 or orphans:
        top = roots[0]
        children[top].extend([x for x in roots[1:] + orphans if x != top])
        roots = [top]
    return by_id, children, roots[0] if roots else None


def draw_org_chart(slide, roles: list[OrgRole], x0, y0, w, h):
    """Draw a hierarchy in the box (x0, y0, w, h). Leaf-only teams below the top
    level are stacked vertically to keep the chart readable on one slide."""
    if not roles:
        textbox(slide, x0, y0, w, Inches(0.5), "No organisation roles identified.", 12, color=MUTED)
        return
    by_id, children, root = _build_tree(roles)

    stacked: set[str] = set()
    size: dict[str, tuple[int, int]] = {}  # node -> (width units, height rows)

    def measure(n, depth):
        kids = children[n]
        if kids and depth >= 1 and all(not children[k] for k in kids):
            stacked.add(n)
            size[n] = (1, 1 + len(kids))
            for k in kids:
                size[k] = (1, 1)
            return size[n]
        if not kids:
            size[n] = (1, 1)
            return size[n]
        wsum, hmax = 0, 0
        for k in kids:
            kw, kh = measure(k, depth + 1)
            wsum += kw
            hmax = max(hmax, kh)
        size[n] = (max(1, wsum), 1 + hmax)
        return size[n]

    total_w, total_h = measure(root, 0)
    col_w = w / total_w
    row_h = h / total_h
    box_w = min(Inches(2.3), int(col_w * 0.9))
    box_h = min(Inches(0.85), int(row_h * 0.78))
    font = 11 if box_w > Inches(1.9) and box_h > Inches(0.7) else 9 if box_w > Inches(1.4) else 8
    stack_indent = int(box_w * 0.12)

    def box(role: OrgRole, cx, top, bw=box_w):
        color = ORG_COLORS.get(role.organisation, NAVY)
        s = rect(slide, int(cx - bw / 2), int(top), int(bw), int(box_h), color, shape=MSO_SHAPE.ROUNDED_RECTANGLE)
        s.adjustments[0] = 0.12
        tf = s.text_frame
        tf.word_wrap = True
        tf.margin_left = tf.margin_right = Inches(0.04)
        tf.margin_top = tf.margin_bottom = Inches(0.02)
        tf.vertical_anchor = MSO_ANCHOR.MIDDLE
        p = tf.paragraphs[0]
        p.alignment = PP_ALIGN.CENTER
        r = p.add_run()
        r.text = role.title
        r.font.size, r.font.bold, r.font.color.rgb = Pt(font), True, WHITE
        p2 = tf.add_paragraph()
        p2.alignment = PP_ALIGN.CENTER
        r2 = p2.add_run()
        r2.text = role.person if role.person and role.person.upper() != "TBC" else "TBC"
        r2.font.size, r2.font.color.rgb = Pt(max(7, font - 2)), WHITE

    def place(n, left_units, row):
        nw, _ = size[n]
        cx = x0 + (left_units + nw / 2) * col_w
        top = y0 + row * row_h
        box(by_id[n], cx, top)
        bottom = top + box_h
        kids = children[n]
        if not kids:
            return
        if n in stacked:
            sub_w = int(box_w - stack_indent)
            spine_x = int(cx - box_w / 2 + stack_indent / 2)
            last_mid = bottom
            for i, k in enumerate(kids):
                ktop = y0 + (row + 1 + i) * row_h
                kcx = cx + stack_indent / 2
                box(by_id[k], kcx, ktop, sub_w)
                mid = int(ktop + box_h / 2)
                line(slide, spine_x, mid, int(kcx - sub_w / 2), mid)
                last_mid = mid
            line(slide, spine_x, int(bottom), spine_x, int(last_mid))
            return
        bus_y = int(bottom + (row_h - box_h) / 2)
        line(slide, int(cx), int(bottom), int(cx), bus_y)
        offset = left_units
        centers = []
        for k in kids:
            kw, _ = size[k]
            kcx = x0 + (offset + kw / 2) * col_w
            centers.append(kcx)
            line(slide, int(kcx), bus_y, int(kcx), int(y0 + (row + 1) * row_h))
            place(k, offset, row + 1)
            offset += kw
        if len(centers) > 1:
            line(slide, int(min(centers)), bus_y, int(max(centers)), bus_y)

    place(root, 0, 0)


def org_legend(slide, x, y, roles: list[OrgRole]):
    used = [o for o in ORG_COLORS if any(r.organisation == o for r in roles)]
    for i, o in enumerate(used):
        rect(slide, x + Inches(1.9) * i, y + Inches(0.05), Inches(0.2), Inches(0.2), ORG_COLORS[o])
        textbox(slide, x + Inches(1.9) * i + Inches(0.25), y, Inches(1.6), Inches(0.3), o, 10, color=MUTED)
