"""Gate (PG) approval PowerPoint pack and the standalone organisation chart deck."""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path

from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.dml.color import RGBColor
from pptx.util import Inches, Pt

from .. import calc
from ..schema import Analysis
from .slides import (ACCENT, AMBER, GREEN, LIGHT_AMBER, LIGHT_GREEN, LIGHT_RED, MUTED, NAVY, PALE, RED,
                     SLIDE_H, SLIDE_W, TEXT, WHITE, bullets, clip, draw_org_chart, line, org_legend, rect,
                     table, textbox)

REC_COLOR = {"Approve": GREEN, "Approve with conditions": AMBER, "Defer": AMBER, "Reject": RED}
RATING_FILL = {"High": LIGHT_RED, "Medium": LIGHT_AMBER, "Low": LIGHT_GREEN}
L = Inches(0.5)          # left margin
CW = SLIDE_W - 2 * L     # content width
TOP = Inches(1.25)       # content top


def _money(v: float, cur: str) -> str:
    a = abs(v)
    if a >= 1e9:
        s = f"{v / 1e9:,.2f}bn"
    elif a >= 1e6:
        s = f"{v / 1e6:,.2f}m"
    elif a >= 1e4:
        s = f"{v / 1e3:,.0f}k"
    else:
        s = f"{v:,.0f}"
    return f"{cur} {s}"


class Deck:
    def __init__(self, a: Analysis):
        self.a = a
        self.prs = Presentation()
        self.prs.slide_width, self.prs.slide_height = SLIDE_W, SLIDE_H
        self.blank = self.prs.slide_layouts[6]
        self.n = 0

    def slide(self, title: str, subtitle: str = ""):
        s = self.prs.slides.add_slide(self.blank)
        self.n += 1
        rect(s, 0, 0, SLIDE_W, Inches(0.12), NAVY)
        textbox(s, L, Inches(0.3), CW, Inches(0.6), title, 26, True, NAVY)
        if subtitle:
            textbox(s, L, Inches(0.82), CW, Inches(0.35), subtitle, 12, color=MUTED)
        p = self.a.overview.project
        textbox(s, L, SLIDE_H - Inches(0.4), Inches(9), Inches(0.3),
                f"{p.name} | {self.a.gate.gate_name} | {self.a.generated_on}", 9, color=MUTED)
        textbox(s, SLIDE_W - L - Inches(1), SLIDE_H - Inches(0.4), Inches(1), Inches(0.3), str(self.n), 9,
                color=MUTED, align=PP_ALIGN.RIGHT)
        return s

    def save(self, path: Path):
        self.prs.save(path)


def _kpi(s, x, y, w, label, value, color=NAVY):
    rect(s, x, y, w, Inches(1.05), PALE)
    rect(s, x, y, Inches(0.08), Inches(1.05), color)
    textbox(s, x + Inches(0.18), y + Inches(0.08), w - Inches(0.25), Inches(0.3), label, 11, color=MUTED)
    textbox(s, x + Inches(0.18), y + Inches(0.4), w - Inches(0.25), Inches(0.55), value, 22, True, color)


# --------------------------------------------------------------------------
def write_pack(a: Analysis, path: Path, files: list[str]):
    d = Deck(a)
    p, g = a.overview.project, a.gate
    est = a.estimate_schedule.estimate
    cur = est.currency
    tot = calc.estimate_totals(est)
    sch = calc.compute_schedule(a.estimate_schedule.schedule)
    risks = calc.ranked_risks(a.risks.risks)
    scored = [(r, calc.risk_score(r.probability, r.impact)) for r in risks]
    high = [r for r, sc in scored if calc.risk_rating(sc) == "High"]
    rec_color = REC_COLOR.get(g.recommendation, NAVY)

    # 1. Title -------------------------------------------------------------
    s = d.prs.slides.add_slide(d.blank)
    d.n += 1
    rect(s, 0, 0, SLIDE_W, SLIDE_H, NAVY)
    rect(s, L, Inches(2.0), Inches(0.12), Inches(2.3), WHITE)
    textbox(s, L + Inches(0.4), Inches(1.9), Inches(11), Inches(0.6), f"{g.gate_name} Approval Pack", 20,
            color=WHITE)
    textbox(s, L + Inches(0.4), Inches(2.45), Inches(11.5), Inches(1.2), p.name, 38, True, WHITE)
    textbox(s, L + Inches(0.4), Inches(3.7), Inches(11), Inches(0.5),
            f"Client: {p.client}   |   {p.location}   |   {a.generated_on}", 14, color=WHITE)
    badge = rect(s, L + Inches(0.4), Inches(4.8), Inches(4.2), Inches(0.6), rec_color)
    tf = badge.text_frame
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    tf.paragraphs[0].alignment = PP_ALIGN.CENTER
    r = tf.paragraphs[0].add_run()
    r.text = f"Recommendation: {g.recommendation}"
    r.font.size, r.font.bold, r.font.color.rgb = Pt(16), True, WHITE

    # 2. Decision requested -------------------------------------------------
    s = d.slide("Decision requested", f"Recommendation: {g.recommendation}")
    rect(s, L, TOP, CW, Inches(1.3), PALE)
    rect(s, L, TOP, Inches(0.1), Inches(1.3), rec_color)
    textbox(s, L + Inches(0.3), TOP + Inches(0.12), CW - Inches(0.5), Inches(1.1), clip(g.decision_requested, 420),
            16, True, TEXT, anchor=MSO_ANCHOR.MIDDLE)
    kw = (CW - Inches(0.6)) / 4
    y = TOP + Inches(1.6)
    _kpi(s, L, y, kw, "Funding requested", _money(tot.total_with_mr, cur))
    _kpi(s, L + (kw + Inches(0.2)), y, kw, "Budget at completion", _money(tot.total, cur))
    _kpi(s, L + 2 * (kw + Inches(0.2)), y, kw, "Completion", sch.project_finish.strftime("%d %b %Y"))
    _kpi(s, L + 3 * (kw + Inches(0.2)), y, kw, "High risks", str(len(high)), RED if high else GREEN)
    y += Inches(1.35)
    textbox(s, L, y, CW, Inches(0.35), "Conditions of approval", 14, True, NAVY)
    bullets(s, L, y + Inches(0.4), CW, Inches(2.2), [clip(c, 170) for c in g.conditions[:7]] or ["None"], 12)

    # 3. Executive summary ---------------------------------------------------
    s = d.slide("Executive summary")
    textbox(s, L, TOP, Inches(6.6), Inches(5.4), clip(g.executive_summary, 1400), 13, color=TEXT)
    rect(s, Inches(7.4), TOP, Inches(5.43), Inches(5.5), PALE)
    textbox(s, Inches(7.6), TOP + Inches(0.15), Inches(5), Inches(0.35), "Key messages", 14, True, NAVY)
    bullets(s, Inches(7.6), TOP + Inches(0.6), Inches(5.05), Inches(3.4), [clip(k, 150) for k in g.key_messages[:6]], 12)
    textbox(s, Inches(7.6), TOP + Inches(4.0), Inches(5), Inches(0.3), "Strategic fit", 12, True, NAVY)
    textbox(s, Inches(7.6), TOP + Inches(4.3), Inches(5.05), Inches(1.2), clip(g.strategic_fit, 300), 11)

    # 4. Scope ---------------------------------------------------------------
    s = d.slide("Project scope", clip(p.description, 150))
    colw = (CW - Inches(0.4)) / 3
    for i, (head, items) in enumerate([("Objectives", p.objectives), ("In scope", p.in_scope),
                                       ("Out of scope", p.out_of_scope)]):
        x = L + i * (colw + Inches(0.2))
        rect(s, x, TOP, colw, Inches(0.4), NAVY if i < 2 else MUTED)
        textbox(s, x + Inches(0.1), TOP + Inches(0.03), colw, Inches(0.35), head, 13, True, WHITE)
        shown = items[:9]
        more = [f"+ {len(items) - 9} more (see Scope Review)"] if len(items) > 9 else []
        bullets(s, x, TOP + Inches(0.5), colw, Inches(4.9), [clip(t, 110) for t in shown] + more, 11, space=4)

    # 5. Cost estimate --------------------------------------------------------
    s = d.slide("Cost estimate", f"{est.estimate_class} | Currency {cur}")
    phases = sorted(tot.by_phase.items(), key=lambda kv: -kv[1])
    chart_data = CategoryChartData()
    chart_data.categories = [clip(k, 28) for k, _ in phases[:10]]
    chart_data.add_series(f"Base cost ({cur})", [round(v) for _, v in phases[:10]])
    gf = s.shapes.add_chart(XL_CHART_TYPE.BAR_CLUSTERED, L, TOP, Inches(6.6), Inches(5.4), chart_data)
    ch = gf.chart
    ch.has_legend = False
    ch.plots[0].series[0].format.fill.solid()
    ch.plots[0].series[0].format.fill.fore_color.rgb = ACCENT
    ch.plots[0].has_data_labels = True
    ch.plots[0].data_labels.number_format = '#,##0'
    ch.plots[0].data_labels.number_format_is_linked = False
    ch.plots[0].data_labels.font.size = Pt(9)
    ch.category_axis.tick_labels.font.size = Pt(10)
    ch.category_axis.reverse_order = True
    ch.value_axis.visible = False
    ch.value_axis.has_major_gridlines = False
    rows = [["Budget build-up", f"{cur}", "%"],
            ["Base estimate", f"{tot.base:,.0f}", ""],
            ["Contingency", f"{tot.contingency:,.0f}", f"{est.contingency_pct:g}%"],
            ["Escalation", f"{tot.escalation:,.0f}", f"{est.escalation_pct:g}%"],
            ["Budget at completion", f"{tot.total:,.0f}", ""],
            ["Management reserve", f"{tot.management_reserve:,.0f}", f"{est.management_reserve_pct:g}%"],
            ["Funding requested", f"{tot.total_with_mr:,.0f}", ""]]
    bold_fill = {(4, c): LIGHT_AMBER for c in range(3)} | {(6, c): LIGHT_GREEN for c in range(3)}
    table(s, Inches(7.4), TOP, Inches(5.43), rows, [3, 2.2, 1], 11, row_h=Inches(0.36), fills=bold_fill)
    low = sum(1 for l in est.lines if l.confidence == "Low")
    textbox(s, Inches(7.4), TOP + Inches(2.75), Inches(5.43), Inches(2.6),
            [f"{len(est.lines)} estimate lines; {low} at low confidence.",
             f"Expected value of risk register: {_money(sum(calc.risk_ev(r) for r in risks), cur)} "
             f"vs contingency {_money(tot.contingency, cur)}.",
             clip(est.basis_of_estimate, 300)], 11, color=MUTED)

    # 6. Schedule ------------------------------------------------------------
    s = d.slide("Schedule", f"{sch.project_start:%d %b %Y} to {sch.project_finish:%d %b %Y} | "
                            f"{sch.duration_days} working days | critical path in red")
    tasks = {t.id: t for t in a.estimate_schedule.schedule.tasks}
    # Phase bars.
    phase_span: dict[str, list] = {}
    phase_crit: dict[str, bool] = {}
    for tid in sch.order:
        t, st = tasks[tid], sch.tasks[tid]
        sp = phase_span.setdefault(t.phase, [st.start, st.finish])
        sp[0], sp[1] = min(sp[0], st.start), max(sp[1], st.finish)
        phase_crit[t.phase] = phase_crit.get(t.phase, False) or (st.critical and not t.is_milestone)
    gx, gw = L + Inches(2.3), Inches(5.6)
    total_days = max(1, (sch.project_finish - sch.project_start).days + 1)
    ph_items = list(phase_span.items())[:11]
    bh = min(Inches(0.38), int(Inches(4.8) / max(1, len(ph_items))))
    # Month ticks.
    m = sch.project_start.replace(day=1)
    months = []
    while m <= sch.project_finish:
        months.append(m)
        m = (m + timedelta(days=32)).replace(day=1)
    step = max(1, len(months) // 8)
    for mm in months[::step]:
        x = gx + int(gw * max(0, (mm - sch.project_start).days) / total_days)
        textbox(s, x, TOP, Inches(0.8), Inches(0.25), mm.strftime("%b %y"), 8, color=MUTED)
        line(s, x, TOP + Inches(0.28), x, TOP + Inches(0.35) + bh * (len(ph_items) + 1), RGBColor(0xD9, 0xD9, 0xD9), 0.5)
    for i, (ph, (a0, a1)) in enumerate(ph_items):
        y = TOP + Inches(0.35) + i * bh
        textbox(s, L, y, Inches(2.25), bh, clip(ph, 30), 10, anchor=MSO_ANCHOR.MIDDLE)
        x = gx + int(gw * (a0 - sch.project_start).days / total_days)
        w = max(Inches(0.05), int(gw * ((a1 - a0).days + 1) / total_days))
        rect(s, x, y + int(bh * 0.18), w, int(bh * 0.64), RED if phase_crit[ph] else ACCENT)
    ms = sorted((t for t in tasks.values() if t.is_milestone), key=lambda t: sch.tasks[t.id].start)
    # Milestone diamonds on their own row under the phase bars.
    my = TOP + Inches(0.35) + len(ph_items) * bh
    textbox(s, L, my, Inches(2.25), bh, "Milestones", 10, True, NAVY, anchor=MSO_ANCHOR.MIDDLE)
    dm = Inches(0.16)
    for t in ms:
        st = sch.tasks[t.id]
        x = gx + int(gw * (st.start - sch.project_start).days / total_days)
        rect(s, x - dm // 2, my + (bh - dm) // 2, dm, dm, RED if st.critical else NAVY, shape=MSO_SHAPE.DIAMOND)
    rows = [["Milestone", "Date"]] + [[clip(t.name, 38), f"{sch.tasks[t.id].start:%d %b %Y}"] for t in ms[:13]]
    table(s, Inches(8.3), TOP, Inches(4.53), rows, [3, 1.3], 10, row_h=Inches(0.33))

    # 7. Risk ----------------------------------------------------------------
    s = d.slide("Key risks", f"{len(risks)} risks | {len(high)} high | expected value "
                             f"{_money(sum(calc.risk_ev(r) for r in risks), cur)}")
    cell = Inches(0.52)
    hx, hy = L + Inches(0.45), TOP + Inches(0.3)
    textbox(s, L, TOP - Inches(0.05), Inches(3.2), Inches(0.3), "Probability ↑  /  Impact →", 9, color=MUTED)
    for pr in range(5, 0, -1):
        for im in range(1, 6):
            sc = pr * im
            fill = LIGHT_RED if sc >= 15 else LIGHT_AMBER if sc >= 8 else LIGHT_GREEN
            x, y = hx + (im - 1) * cell, hy + (5 - pr) * cell
            b = rect(s, x, y, cell - Inches(0.03), cell - Inches(0.03), fill)
            count = sum(1 for r in risks if r.probability == pr and r.impact == im)
            if count:
                tf = b.text_frame
                tf.vertical_anchor = MSO_ANCHOR.MIDDLE
                tf.paragraphs[0].alignment = PP_ALIGN.CENTER
                rr = tf.paragraphs[0].add_run()
                rr.text = str(count)
                rr.font.size, rr.font.bold, rr.font.color.rgb = Pt(14), True, TEXT
        textbox(s, L + Inches(0.15), hy + (5 - pr) * cell, Inches(0.3), cell, str(pr), 10, color=MUTED,
                anchor=MSO_ANCHOR.MIDDLE)
    for im in range(1, 6):
        textbox(s, hx + (im - 1) * cell, hy + 5 * cell, cell, Inches(0.25), str(im), 10, color=MUTED,
                align=PP_ALIGN.CENTER)
    top_r = risks[:9]
    rows = [["ID", "Risk", "Score", "Owner", "Mitigation"]]
    fills = {}
    for i, r in enumerate(top_r, 1):
        sc = calc.risk_score(r.probability, r.impact)
        rows.append([r.id, clip(r.title, 48), str(sc), clip(r.owner_role, 22), clip(r.mitigation, 80)])
        fills[(i, 2)] = RATING_FILL[calc.risk_rating(sc)]
    table(s, L + Inches(3.4), TOP, CW - Inches(3.4), rows, [0.7, 3, 0.65, 1.6, 4.2], 9,
          row_h=Inches(0.5), fills=fills)

    # 8. Assumptions and exclusions -----------------------------------------
    s = d.slide("Key assumptions and exclusions",
                f"{len(a.risks.assumptions)} assumptions and {len(a.risks.exclusions)} exclusions in the register")
    half = (CW - Inches(0.3)) / 2
    rows = [["ID", "Assumption"]] + [[x.id, clip(x.statement, 120)] for x in a.risks.assumptions[:10]]
    table(s, L, TOP, half, rows, [0.8, 6], 10, row_h=Inches(0.48))
    rows = [["ID", "Exclusion"]] + [[x.id, clip(x.statement, 120)] for x in a.risks.exclusions[:10]]
    table(s, L + half + Inches(0.3), TOP, half, rows, [0.8, 6], 10, header_fill=MUTED, row_h=Inches(0.48))

    # 9. Commercial and technical -------------------------------------------
    reg = a.registers
    s = d.slide("Commercial and technical position")
    statuses = ["Accepted", "Qualified", "Open", "Clarification Required", "Not Accepted"]
    rows = [["Status", "Commercial", "Technical"]] + [
        [st, str(sum(1 for c in reg.commercial if c.status == st)),
         str(sum(1 for t in reg.technical if t.status == st))] for st in statuses]
    table(s, L, TOP, Inches(4.2), rows, [2.4, 1, 1], 11, row_h=Inches(0.36))
    key = [c for c in reg.commercial if c.status != "Accepted"]
    key.sort(key=lambda c: {"High": 0, "Medium": 1, "Low": 2}[c.risk_rating])
    keyt = [t for t in reg.technical if t.status != "Accepted"]
    keyt.sort(key=lambda t: {"High": 0, "Medium": 1, "Low": 2}[t.risk_rating])
    items = [("C", c.topic, c.our_position, c.risk_rating) for c in key[:6]] + \
            [("T", t.topic, t.our_response, t.risk_rating) for t in keyt[:5]]
    rows = [["", "Open item", "Our position", "Risk"]]
    fills = {}
    for i, (k, topic, pos, rr) in enumerate(items, 1):
        rows.append([k, clip(topic, 40), clip(pos, 95), rr])
        fills[(i, 3)] = RATING_FILL[rr]
    if len(rows) == 1:
        rows.append(["", "No open items", "", ""])
    table(s, L + Inches(4.5), TOP, CW - Inches(4.5), rows, [0.35, 2.4, 5, 0.8], 9, row_h=Inches(0.42), fills=fills)

    # 10. Compliance ----------------------------------------------------------
    comp = reg.compliance
    s = d.slide("Compliance", f"{len(comp)} requirements assessed")
    cstat = ["Compliant", "Partially Compliant", "Non-Compliant", "To Be Confirmed"]
    colors = [GREEN, AMBER, RED, ACCENT]
    kw = (CW - Inches(0.6)) / 4
    for i, st in enumerate(cstat):
        n = sum(1 for c in comp if c.compliance == st)
        _kpi(s, L + i * (kw + Inches(0.2)), TOP, kw, st, str(n), colors[i])
    gaps = [c for c in comp if c.compliance != "Compliant"]
    gaps.sort(key=lambda c: ({"Mandatory": 0, "Desirable": 1, "Information": 2}[c.requirement_type],
                             {"Non-Compliant": 0, "Partially Compliant": 1, "To Be Confirmed": 2}[c.compliance]))
    rows = [["Clause", "Requirement", "Type", "Status", "Response"]]
    fills = {}
    for i, c in enumerate(gaps[:8], 1):
        rows.append([clip(f"{c.source_document} {c.clause_ref}", 28), clip(c.requirement, 70), c.requirement_type,
                     c.compliance, clip(c.response, 70)])
        fills[(i, 3)] = {"Non-Compliant": LIGHT_RED, "Partially Compliant": LIGHT_AMBER}.get(c.compliance, PALE)
    if len(rows) == 1:
        rows.append(["", "All requirements compliant", "", "", ""])
    table(s, L, TOP + Inches(1.3), CW, rows, [1.6, 3.6, 0.9, 1.3, 3.6], 9, row_h=Inches(0.44), fills=fills)

    # 11. Document review -----------------------------------------------------
    ov = a.overview
    s = d.slide("Scope document review",
                f"{len(ov.documents)} documents reviewed | {len(ov.review_findings)} findings | "
                f"{len(ov.clarifications)} clarification questions")
    fnd = sorted(ov.review_findings, key=lambda f: {"High": 0, "Medium": 1, "Low": 2}[f.severity])
    rows = [["Area", "Finding", "Impact", "Severity"]]
    fills = {}
    for i, f in enumerate(fnd[:9], 1):
        rows.append([clip(f.area, 22), clip(f.issue, 95), clip(f.impact, 70), f.severity])
        fills[(i, 3)] = RATING_FILL[f.severity]
    if len(rows) == 1:
        rows.append(["", "No findings", "", ""])
    table(s, L, TOP, CW, rows, [1.4, 5, 3.6, 0.9], 9, row_h=Inches(0.46), fills=fills)

    # 12. Organisation --------------------------------------------------------
    s = d.slide("Project organisation")
    draw_org_chart(s, ov.organisation, L, TOP, CW, Inches(5.25))
    org_legend(s, L, SLIDE_H - Inches(0.8), ov.organisation)

    # 13. Next steps and approvals -------------------------------------------
    s = d.slide("Next steps and approval")
    textbox(s, L, TOP, Inches(5.6), Inches(0.35), "Next steps", 14, True, NAVY)
    bullets(s, L, TOP + Inches(0.45), Inches(5.6), Inches(4.8), [clip(n, 140) for n in g.next_steps[:9]], 12)
    rows = [["Approver role", "Name", "Decision", "Signature", "Date"]] + [[r, "", "", "", ""] for r in
            ["Sponsor", "Project Director", "Commercial Director", "Finance", "Technical Authority"]]
    table(s, Inches(6.4), TOP, Inches(6.43), rows, [2, 1.6, 1.2, 1.4, 0.9], 11, row_h=Inches(0.6))

    # 14. Appendix ------------------------------------------------------------
    s = d.slide("Appendix: supporting documents")
    bullets(s, L, TOP, Inches(6), Inches(5.4), files, 13)
    rows = [["Source document", "Type"]] + [[clip(x.name, 50), clip(x.document_type, 30)] for x in ov.documents[:12]]
    table(s, Inches(6.8), TOP, Inches(6.03), rows, [3, 2], 10, row_h=Inches(0.36))

    d.save(path)


def write_org_chart(a: Analysis, path: Path):
    d = Deck(a)
    roles = a.overview.organisation
    s = d.slide("Project organisation chart", a.overview.project.name)
    draw_org_chart(s, roles, L, TOP, CW, Inches(5.25))
    org_legend(s, L, SLIDE_H - Inches(0.8), roles)

    s = d.slide("Roles and responsibilities")
    rows = [["Role", "Name", "Organisation", "Reports to", "Alloc.", "Key responsibilities"]]
    by_id = {r.id: r.title for r in roles}
    for r in roles[:14]:
        rows.append([clip(r.title, 30), clip(r.person, 18), r.organisation, clip(by_id.get(r.reports_to, "-"), 26),
                     f"{r.allocation_pct}%", clip("; ".join(r.responsibilities), 110)])
    table(s, L, TOP, CW, rows, [2, 1.3, 1.3, 1.8, 0.7, 5.5], 9, row_h=Inches(0.36))
    d.save(path)
