"""Offline tests: no API key needed. Run with `python -m pytest tests`."""

from datetime import date
from pathlib import Path

import openpyxl
import pytest
from pptx import Presentation

from pmtool import calc
from pmtool.cli import generate
from pmtool.ingest import collect
from pmtool.schema import Analysis, Schedule, ScheduleTask

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT / "examples" / "sample_analysis.json"


@pytest.fixture(scope="module")
def analysis() -> Analysis:
    return Analysis.model_validate_json(SAMPLE.read_text())


def _task(i, dur, preds=(), ms=False):
    return ScheduleTask(id=i, wbs_code="1", name=i, phase="P", duration_days=dur, predecessors=list(preds),
                        is_milestone=ms, owner_role="PM")


def test_critical_path_and_dates():
    # Monday start; A(5) -> B(3) and A -> C(1); B and C -> D (milestone).
    s = Schedule(start_date="2027-02-01", tasks=[_task("A", 5), _task("B", 3, ["A"]), _task("C", 1, ["A"]),
                                                 _task("D", 0, ["B", "C"], ms=True)])
    r = calc.compute_schedule(s)
    assert r.duration_days == 8
    assert r.tasks["A"].finish == date(2027, 2, 5)       # Friday
    assert r.tasks["B"].start == date(2027, 2, 8)        # skips the weekend
    assert r.tasks["B"].critical and not r.tasks["C"].critical
    assert r.tasks["C"].total_float == 2
    assert r.project_finish == date(2027, 2, 11)


def test_schedule_survives_bad_logic():
    s = Schedule(start_date="not-a-date", tasks=[_task("A", 2, ["B"]), _task("B", 2, ["A"]), _task("C", 1, ["Z"])])
    r = calc.compute_schedule(s)
    assert len(r.order) == 3
    assert any("loop" in w for w in r.warnings)
    assert any("unknown predecessor" in w for w in r.warnings)


def test_estimate_totals(analysis):
    t = calc.estimate_totals(analysis.estimate_schedule.estimate)
    assert t.base == pytest.approx(5_571_800)
    assert t.total == pytest.approx(t.base * 1.14)
    assert t.total_with_mr == pytest.approx(t.total * 1.05)
    assert sum(t.by_phase.values()) == pytest.approx(t.base)


def test_risk_scoring():
    assert calc.risk_rating(calc.risk_score(4, 5)) == "High"
    assert calc.risk_rating(calc.risk_score(2, 4)) == "Medium"
    assert calc.risk_rating(calc.risk_score(1, 5)) == "Low"


def test_ingest_reads_example_folder():
    docs, warnings = collect([ROOT / "examples" / "scope"])
    assert [d.name for d in docs] == ["Scope_of_Work.md"]
    assert "NEC4" in docs[0].text and not warnings


def test_generate_all_deliverables(analysis, tmp_path):
    files = generate(analysis, tmp_path)
    names = {f.name for f in files}
    assert names == {
        "Project_Estimate.xlsx", "Risk_Register.xlsx", "Assumptions_and_Exclusions.xlsx",
        "Project_Schedule.xlsx", "Commercial_and_Technical_Register.xlsx", "Compliance_Matrix.xlsx",
        "Organisation_Chart.pptx", "Scope_Review.docx", "PG3_Approval_Pack.pptx",
    }
    wb = openpyxl.load_workbook(tmp_path / "Risk_Register.xlsx")
    ws = wb["Risk Register"]
    assert ws.max_row >= 4 + len(analysis.risks.risks)
    assert Presentation(str(tmp_path / "PG3_Approval_Pack.pptx")).slides.__len__() == 14
