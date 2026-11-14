"""Excel deliverables. Totals and scores are live formulas so users can edit inputs."""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path

from openpyxl import Workbook
from openpyxl.formatting.rule import CellIsRule, FormulaRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

from .. import calc
from ..schema import Analysis

NAVY = "1F3864"
LIGHT = "D9E2F3"
GREY = "F2F2F2"
RED, AMBER, GREEN = "F8CBAD", "FFE699", "C6EFCE"
THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
WRAP = Alignment(wrap_text=True, vertical="top")
HEAD_FONT = Font(bold=True, color="FFFFFF")
HEAD_FILL = PatternFill("solid", fgColor=NAVY)


def _fill(color: str) -> PatternFill:
    return PatternFill("solid", fgColor=color)


def _title(ws, title: str, a: Analysis, width_cols: int) -> int:
    """Write a document header block; returns the next free row."""
    p = a.overview.project
    ws["A1"] = title
    ws["A1"].font = Font(bold=True, size=14, color=NAVY)
    ws["A2"] = f"{p.name} | Client: {p.client} | Prepared {a.generated_on}"
    ws["A2"].font = Font(italic=True, color="595959")
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=max(1, width_cols))
    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=max(1, width_cols))
    return 4


def _table(ws, row: int, headers: list[tuple[str, int]], rows: list[list], wrap_cols=()) -> tuple[int, int]:
    """Write a header + data table starting at ``row``. Returns (first_data_row, last_data_row)."""
    for c, (h, w) in enumerate(headers, 1):
        cell = ws.cell(row=row, column=c, value=h)
        cell.font, cell.fill, cell.border = HEAD_FONT, HEAD_FILL, BORDER
        cell.alignment = Alignment(wrap_text=True, vertical="center", horizontal="center")
        ws.column_dimensions[get_column_letter(c)].width = w
    ws.row_dimensions[row].height = 30
    first = row + 1
    for r_i, values in enumerate(rows):
        r = first + r_i
        for c, v in enumerate(values, 1):
            cell = ws.cell(row=r, column=c, value=v)
            cell.border = BORDER
            cell.alignment = WRAP
            if r_i % 2:
                cell.fill = _fill(GREY)
    last = first + max(len(rows), 1) - 1
    ws.freeze_panes = ws.cell(row=first, column=1)
    if rows:
        ws.auto_filter.ref = f"A{row}:{get_column_letter(len(headers))}{last}"
    return first, last


def _rag(ws, rng: str, values: dict[str, str]):
    for text, color in values.items():
        ws.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=[f'"{text}"'], fill=_fill(color)))


def _setup_print(ws, landscape=True):
    ws.page_setup.orientation = "landscape" if landscape else "portrait"
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.print_options.gridLines = False


# --------------------------------------------------------------------------
def write_estimate(a: Analysis, path: Path):
    est = a.estimate_schedule.estimate
    cur = est.currency
    money = f'#,##0 "{cur}"' if len(cur) <= 4 else "#,##0"
    wb = Workbook()

    # Detail sheet first (Summary formulas reference it).
    ws = wb.active
    ws.title = "Estimate Detail"
    start = _title(ws, "Cost Estimate - Detail", a, 12)
    headers = [("WBS", 9), ("Phase", 18), ("Description", 42), ("Cost Type", 13), ("Unit", 9),
               ("Qty", 9), (f"Rate ({cur})", 13), (f"Amount ({cur})", 15), ("Confidence", 11),
               ("Basis of Estimate", 40), ("Source", 22)]
    lines = sorted(est.lines, key=lambda l: [int(x) if x.isdigit() else x for x in l.wbs_code.split(".")])
    rows = [[l.wbs_code, l.phase, l.description, l.cost_type, l.unit, l.quantity, l.unit_rate, None,
             l.confidence, l.basis, l.source_ref] for l in lines]
    first, last = _table(ws, start, headers, rows)
    for r in range(first, last + 1):
        ws.cell(row=r, column=8, value=f"=F{r}*G{r}")
        for c in (6,):
            ws.cell(row=r, column=c).number_format = "#,##0.##"
        for c in (7, 8):
            ws.cell(row=r, column=c).number_format = money
    tr = last + 1
    ws.cell(row=tr, column=7, value="Base estimate").font = Font(bold=True)
    ws.cell(row=tr, column=8, value=f"=SUM(H{first}:H{last})").font = Font(bold=True)
    ws.cell(row=tr, column=8).number_format = money
    _rag(ws, f"I{first}:I{last}", {"Low": RED, "Medium": AMBER, "High": GREEN})
    _setup_print(ws)
    detail = f"'Estimate Detail'!"
    amt = f"{detail}$H${first}:$H${last}"

    # Summary sheet.
    s = wb.create_sheet("Summary", 0)
    r = _title(s, "Cost Estimate - Summary", a, 4)
    s.column_dimensions["A"].width = 34
    s.column_dimensions["B"].width = 20
    s.column_dimensions["C"].width = 12
    s.column_dimensions["D"].width = 60
    info = [("Estimate class", est.estimate_class), ("Currency", cur), ("Basis of estimate", est.basis_of_estimate)]
    for k, v in info:
        s.cell(row=r, column=1, value=k).font = Font(bold=True)
        s.cell(row=r, column=1).alignment = WRAP
        s.cell(row=r, column=2, value=v).alignment = WRAP
        s.merge_cells(start_row=r, start_column=2, end_row=r, end_column=4)
        r += 1
    s.row_dimensions[r - 1].height = max(15, 15 * (len(est.basis_of_estimate) // 90 + 1))
    r += 1

    def section(title, keys, col_letter):
        nonlocal r
        for c, h in enumerate([title, f"Amount ({cur})", "% of base"], 1):
            cell = s.cell(row=r, column=c, value=h)
            cell.font, cell.fill, cell.border = HEAD_FONT, HEAD_FILL, BORDER
        r += 1
        f0 = r
        for k in keys:
            s.cell(row=r, column=1, value=k).border = BORDER
            s.cell(row=r, column=2, value=f'=SUMIF({detail}${col_letter}${first}:${col_letter}${last},A{r},{amt})')
            s.cell(row=r, column=3, value=f"=IF($B${{BASE}}=0,0,B{r}/$B${{BASE}})")
            r += 1
        rng = (f0, r - 1)
        r += 1
        return rng

    phases = list(dict.fromkeys(l.phase for l in lines))
    types = list(dict.fromkeys(l.cost_type for l in lines))
    ph = section("By phase", phases, "B")
    ty = section("By cost type", types, "D")

    for c, h in enumerate(["Budget build-up", f"Amount ({cur})", "Rate"], 1):
        cell = s.cell(row=r, column=c, value=h)
        cell.font, cell.fill, cell.border = HEAD_FONT, HEAD_FILL, BORDER
    r += 1
    base_row = r
    s.cell(row=r, column=1, value="Base estimate")
    s.cell(row=r, column=2, value=f"=SUM({amt})")
    r += 1
    s.cell(row=r, column=1, value="Contingency")
    s.cell(row=r, column=3, value=est.contingency_pct / 100)
    s.cell(row=r, column=2, value=f"=B{base_row}*C{r}")
    cont_row = r
    r += 1
    s.cell(row=r, column=1, value="Escalation")
    s.cell(row=r, column=3, value=est.escalation_pct / 100)
    s.cell(row=r, column=2, value=f"=B{base_row}*C{r}")
    esc_row = r
    r += 1
    s.cell(row=r, column=1, value="Budget at completion")
    s.cell(row=r, column=2, value=f"=B{base_row}+B{cont_row}+B{esc_row}")
    bac_row = r
    r += 1
    s.cell(row=r, column=1, value="Management reserve")
    s.cell(row=r, column=3, value=est.management_reserve_pct / 100)
    s.cell(row=r, column=2, value=f"=B{bac_row}*C{r}")
    mr_row = r
    r += 1
    s.cell(row=r, column=1, value="Total funding requested")
    s.cell(row=r, column=2, value=f"=B{bac_row}+B{mr_row}")
    for rr in (bac_row, r):
        for c in (1, 2):
            s.cell(row=rr, column=c).font = Font(bold=True)
            s.cell(row=rr, column=c).fill = _fill(LIGHT)
    for rr in range(base_row, r + 1):
        s.cell(row=rr, column=3).number_format = "0.0%"
        for c in (1, 2, 3):
            s.cell(row=rr, column=c).border = BORDER

    # Resolve the {BASE} placeholder and apply number formats.
    for row in s.iter_rows():
        for cell in row:
            if isinstance(cell.value, str) and "{BASE}" in cell.value:
                cell.value = cell.value.replace("{BASE}", str(base_row))
            if cell.column == 2 and cell.row > 7:
                cell.number_format = money
            if cell.column == 3 and cell.row in range(ph[0], ty[1] + 1):
                cell.number_format = "0.0%"
    _setup_print(s, landscape=False)
    wb.save(path)


# --------------------------------------------------------------------------
def write_risk_register(a: Analysis, path: Path):
    ra = a.risks
    cur = a.estimate_schedule.estimate.currency
    wb = Workbook()
    ws = wb.active
    ws.title = "Risk Register"
    start = _title(ws, "Risk Register", a, 19)
    headers = [("ID", 8), ("Title", 26), ("Description (cause - event - effect)", 46), ("Category", 13),
               ("Owner", 18), ("P", 5), ("I", 5), ("Score", 7), ("Rating", 9), (f"Cost impact ({cur})", 14),
               ("Expected value", 14), ("Schedule (days)", 10), ("Response", 11), ("Mitigation / action", 46),
               ("Residual P", 8), ("Residual I", 8), ("Residual score", 9), ("Residual rating", 10), ("Source", 22)]
    risks = calc.ranked_risks(ra.risks)
    rows = [[r.id, r.title, r.description, r.category, r.owner_role, r.probability, r.impact, None, None,
             r.cost_impact, None, r.schedule_impact_days, r.response, r.mitigation, r.residual_probability,
             r.residual_impact, None, None, r.source_ref] for r in risks]
    first, last = _table(ws, start, headers, rows)
    rating = lambda c: f'=IF({c}>=15,"High",IF({c}>=8,"Medium","Low"))'
    for r in range(first, last + 1):
        ws.cell(row=r, column=8, value=f"=F{r}*G{r}")
        ws.cell(row=r, column=9, value=rating(f"H{r}"))
        ws.cell(row=r, column=11, value=f"=J{r}*CHOOSE(F{r},0.1,0.3,0.5,0.7,0.9)")
        ws.cell(row=r, column=17, value=f"=O{r}*P{r}")
        ws.cell(row=r, column=18, value=rating(f"Q{r}"))
        for c in (10, 11):
            ws.cell(row=r, column=c).number_format = "#,##0"
    for col in ("I", "R"):
        _rag(ws, f"{col}{first}:{col}{last}", {"High": RED, "Medium": AMBER, "Low": GREEN})
    dv = DataValidation(type="whole", operator="between", formula1="1", formula2="5", showErrorMessage=True)
    ws.add_data_validation(dv)
    for col in ("F", "G", "O", "P"):
        dv.add(f"{col}{first}:{col}{last}")
    tr = last + 1
    ws.cell(row=tr, column=10, value="Total EV").font = Font(bold=True)
    ws.cell(row=tr, column=11, value=f"=SUM(K{first}:K{last})").font = Font(bold=True)
    ws.cell(row=tr, column=11).number_format = "#,##0"
    _setup_print(ws)

    # Heat map (live COUNTIFS against the register).
    hm = wb.create_sheet("Heat Map")
    hm["A1"] = "Risk Heat Map (inherent) - count of risks"
    hm["A1"].font = Font(bold=True, size=14, color=NAVY)
    hm["B3"] = "Impact →"
    hm["A4"] = "Probability ↓"
    for i in range(1, 6):
        hm.cell(row=4, column=1 + i, value=i).font = Font(bold=True)
        hm.cell(row=4, column=1 + i).alignment = Alignment(horizontal="center")
    reg = "'Risk Register'!"
    for p in range(5, 0, -1):
        row = 5 + (5 - p)
        hm.cell(row=row, column=1, value=p).font = Font(bold=True)
        for i in range(1, 6):
            cell = hm.cell(row=row, column=1 + i,
                           value=f"=COUNTIFS({reg}$F${first}:$F${last},{p},{reg}$G${first}:$G${last},{i})")
            score = p * i
            cell.fill = _fill(RED if score >= 15 else AMBER if score >= 8 else GREEN)
            cell.alignment = Alignment(horizontal="center", vertical="center")
            cell.border = BORDER
            cell.font = Font(bold=True, size=12)
        hm.row_dimensions[row].height = 34
    for c in range(2, 7):
        hm.column_dimensions[get_column_letter(c)].width = 10
    hm.column_dimensions["A"].width = 14
    hm["A12"] = "Ratings: score = P x I; High >= 15, Medium 8-14, Low <= 7. EV uses P1-5 = 10/30/50/70/90%."
    hm["A12"].font = Font(italic=True, color="595959")
    wb.save(path)


# --------------------------------------------------------------------------
def write_assumptions(a: Analysis, path: Path):
    wb = Workbook()
    ws = wb.active
    ws.title = "Assumptions"
    start = _title(ws, "Assumptions Register", a, 8)
    _table(ws, start, [("ID", 8), ("Area", 16), ("Assumption", 50), ("Rationale", 36), ("Impact if false", 36),
                       ("Validation action", 36), ("Owner", 18), ("Source", 22)],
           [[x.id, x.area, x.statement, x.rationale, x.impact_if_false, x.validation_action, x.owner_role,
             x.source_ref] for x in a.risks.assumptions])
    _setup_print(ws)
    ws = wb.create_sheet("Exclusions")
    start = _title(ws, "Exclusions Register", a, 5)
    _table(ws, start, [("ID", 8), ("Area", 18), ("Exclusion", 60), ("Rationale", 44), ("Source", 24)],
           [[x.id, x.area, x.statement, x.rationale, x.source_ref] for x in a.risks.exclusions])
    _setup_print(ws)
    wb.save(path)


# --------------------------------------------------------------------------
def write_schedule(a: Analysis, path: Path):
    sched = a.estimate_schedule.schedule
    res = calc.compute_schedule(sched)
    wb = Workbook()
    ws = wb.active
    ws.title = "Schedule"
    start = _title(ws, "Project Schedule (critical path)", a, 12)
    headers = [("ID", 7), ("WBS", 8), ("Task", 40), ("Phase", 16), ("Dur (wd)", 8), ("Start", 11),
               ("Finish", 11), ("Predecessors", 13), ("Float (wd)", 8), ("Critical", 8), ("Owner", 18)]
    by_id = {t.id: t for t in sched.tasks}
    rows = []
    for tid in res.order:
        t, s = by_id[tid], res.tasks[tid]
        rows.append([t.id, t.wbs_code, ("◆ " if t.is_milestone else "") + t.name, t.phase, t.duration_days,
                     s.start, s.finish, ", ".join(t.predecessors), s.total_float, "Yes" if s.critical else "",
                     t.owner_role])
    first, last = _table(ws, start, headers, rows)
    for r in range(first, last + 1):
        for c in (6, 7):
            ws.cell(row=r, column=c).number_format = "dd-mmm-yy"
    ws.conditional_formatting.add(f"A{first}:K{last}",
                                  FormulaRule(formula=[f'$J{first}="Yes"'], font=Font(color="C00000", bold=True)))

    # Weekly Gantt to the right of the table.
    g0 = len(headers) + 1
    week0 = res.project_start - timedelta(days=res.project_start.weekday())
    weeks = max(1, ((res.project_finish - week0).days // 7) + 1)
    for w in range(weeks):
        col = g0 + w
        d = week0 + timedelta(weeks=w)
        cell = ws.cell(row=start, column=col, value=d)
        cell.number_format = "dd-mmm"
        cell.font, cell.fill = Font(bold=True, color="FFFFFF", size=8), HEAD_FILL
        cell.alignment = Alignment(text_rotation=90, horizontal="center")
        ws.column_dimensions[get_column_letter(col)].width = 3.2
    ws.row_dimensions[start].height = 48
    for i, tid in enumerate(res.order):
        r = first + i
        s = res.tasks[tid]
        a_w = (s.start - week0).days // 7
        b_w = (s.finish - week0).days // 7
        color = "C00000" if s.critical else "2F5597"
        for w in range(a_w, b_w + 1):
            cell = ws.cell(row=r, column=g0 + w)
            if by_id[tid].is_milestone:
                cell.value = "◆"
                cell.font = Font(color=color, bold=True)
                cell.alignment = Alignment(horizontal="center")
            else:
                cell.fill = _fill(color)
    _setup_print(ws)

    m = wb.create_sheet("Milestones")
    mstart = _title(m, "Key Milestones", a, 4)
    _table(m, mstart, [("ID", 8), ("Milestone", 44), ("Date", 13), ("Critical", 9)],
           [[t.id, t.name, res.tasks[t.id].start, "Yes" if res.tasks[t.id].critical else ""]
            for t in sorted((t for t in sched.tasks if t.is_milestone), key=lambda t: res.tasks[t.id].start)])
    for row in m.iter_rows(min_row=mstart + 1, min_col=3, max_col=3):
        for c in row:
            c.number_format = "dd-mmm-yy"
    r = m.max_row + 2
    m.cell(row=r, column=1, value="Project start").font = Font(bold=True)
    m.cell(row=r, column=3, value=res.project_start).number_format = "dd-mmm-yy"
    m.cell(row=r + 1, column=1, value="Project finish").font = Font(bold=True)
    m.cell(row=r + 1, column=3, value=res.project_finish).number_format = "dd-mmm-yy"
    m.cell(row=r + 2, column=1, value="Duration (working days)").font = Font(bold=True)
    m.cell(row=r + 2, column=3, value=res.duration_days)
    if res.warnings:
        m.cell(row=r + 4, column=1, value="Logic warnings").font = Font(bold=True, color="C00000")
        for i, w in enumerate(res.warnings):
            m.cell(row=r + 5 + i, column=1, value=w)
    wb.save(path)


# --------------------------------------------------------------------------
_STATUS_RAG = {"Accepted": GREEN, "Qualified": AMBER, "Open": AMBER, "Clarification Required": AMBER,
               "Not Accepted": RED}


def write_commercial_technical(a: Analysis, path: Path):
    reg = a.registers
    wb = Workbook()
    ws = wb.active
    ws.title = "Commercial Register"
    start = _title(ws, "Commercial Register", a, 9)
    first, last = _table(ws, start, [("ID", 8), ("Category", 16), ("Topic", 24), ("Client requirement", 44),
                                     ("Our position", 44), ("Status", 14), ("Risk", 8), ("Owner", 18),
                                     ("Source", 22)],
                         [[c.id, c.category, c.topic, c.client_requirement, c.our_position, c.status,
                           c.risk_rating, c.owner_role, c.source_ref] for c in reg.commercial])
    _rag(ws, f"F{first}:F{last}", _STATUS_RAG)
    _rag(ws, f"G{first}:G{last}", {"High": RED, "Medium": AMBER, "Low": GREEN})
    _setup_print(ws)

    ws = wb.create_sheet("Technical Register")
    start = _title(ws, "Technical Register", a, 9)
    first, last = _table(ws, start, [("ID", 8), ("Discipline", 16), ("Topic", 24), ("Client requirement", 44),
                                     ("Our response", 44), ("Status", 14), ("Risk", 8), ("Owner", 18),
                                     ("Source", 22)],
                         [[t.id, t.discipline, t.topic, t.client_requirement, t.our_response, t.status,
                           t.risk_rating, t.owner_role, t.source_ref] for t in reg.technical])
    _rag(ws, f"F{first}:F{last}", _STATUS_RAG)
    _rag(ws, f"G{first}:G{last}", {"High": RED, "Medium": AMBER, "Low": GREEN})
    _setup_print(ws)
    wb.save(path)


# --------------------------------------------------------------------------
def write_compliance(a: Analysis, path: Path):
    items = a.registers.compliance
    wb = Workbook()
    ws = wb.active
    ws.title = "Compliance Matrix"
    start = _title(ws, "Compliance Matrix", a, 9)
    order = {"Mandatory": 0, "Desirable": 1, "Information": 2}
    items = sorted(items, key=lambda c: (order[c.requirement_type], c.source_document, c.clause_ref))
    first, last = _table(ws, start, [("ID", 9), ("Document", 22), ("Clause", 10), ("Requirement", 52),
                                     ("Type", 12), ("Compliance", 16), ("Response / deviation", 46),
                                     ("Evidence", 28), ("Owner", 18)],
                         [[c.id, c.source_document, c.clause_ref, c.requirement, c.requirement_type, c.compliance,
                           c.response, c.evidence, c.owner_role] for c in items])
    _rag(ws, f"F{first}:F{last}", {"Compliant": GREEN, "Partially Compliant": AMBER, "Non-Compliant": RED,
                                   "To Be Confirmed": "DDEBF7"})
    dv = DataValidation(type="list", formula1='"Compliant,Partially Compliant,Non-Compliant,To Be Confirmed"')
    ws.add_data_validation(dv)
    dv.add(f"F{first}:F{last}")
    _setup_print(ws)

    s = wb.create_sheet("Summary", 0)
    _title(s, "Compliance Summary", a, 5)
    statuses = ["Compliant", "Partially Compliant", "Non-Compliant", "To Be Confirmed"]
    types = ["Mandatory", "Desirable", "Information"]
    hdr = ["Status"] + types + ["Total"]
    for c, h in enumerate(hdr, 1):
        cell = s.cell(row=4, column=c, value=h)
        cell.font, cell.fill, cell.border = HEAD_FONT, HEAD_FILL, BORDER
        s.column_dimensions[get_column_letter(c)].width = 22 if c == 1 else 14
    m = "'Compliance Matrix'!"
    for i, st in enumerate(statuses):
        r = 5 + i
        s.cell(row=r, column=1, value=st).border = BORDER
        for j, ty in enumerate(types):
            s.cell(row=r, column=2 + j,
                   value=f'=COUNTIFS({m}$F${first}:$F${last},$A{r},{m}$E${first}:$E${last},"{ty}")').border = BORDER
        s.cell(row=r, column=5, value=f"=SUM(B{r}:D{r})").border = BORDER
    _rag(s, "A5:A8", {"Compliant": GREEN, "Partially Compliant": AMBER, "Non-Compliant": RED,
                      "To Be Confirmed": "DDEBF7"})
    s.cell(row=9, column=1, value="Total").font = Font(bold=True)
    for c in range(2, 6):
        col = get_column_letter(c)
        s.cell(row=9, column=c, value=f"=SUM({col}5:{col}8)").font = Font(bold=True)
    s.cell(row=11, column=1, value="Mandatory compliance")
    s.cell(row=11, column=2, value="=IF(B9=0,0,B5/B9)").number_format = "0%"
    wb.save(path)
