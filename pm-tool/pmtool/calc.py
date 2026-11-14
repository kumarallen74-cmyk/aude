"""Deterministic calculations: estimate totals, risk scores, critical path."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta

from .schema import Estimate, Risk, Schedule


# --------------------------------------------------------------------------
# Estimate
# --------------------------------------------------------------------------
@dataclass
class EstimateTotals:
    base: float
    by_phase: dict[str, float]
    by_cost_type: dict[str, float]
    contingency: float
    escalation: float
    management_reserve: float
    total: float          # base + contingency + escalation (budget at completion)
    total_with_mr: float  # total + management reserve (funding request)


def estimate_totals(est: Estimate) -> EstimateTotals:
    by_phase: dict[str, float] = {}
    by_type: dict[str, float] = {}
    base = 0.0
    for line in est.lines:
        amount = line.quantity * line.unit_rate
        base += amount
        by_phase[line.phase] = by_phase.get(line.phase, 0.0) + amount
        by_type[line.cost_type] = by_type.get(line.cost_type, 0.0) + amount
    contingency = base * est.contingency_pct / 100
    escalation = base * est.escalation_pct / 100
    total = base + contingency + escalation
    mr = total * est.management_reserve_pct / 100
    return EstimateTotals(base, by_phase, by_type, contingency, escalation, mr, total, total + mr)


# --------------------------------------------------------------------------
# Risk
# --------------------------------------------------------------------------
def risk_score(probability: int, impact: int) -> int:
    return max(1, min(5, probability)) * max(1, min(5, impact))


def risk_rating(score: int) -> str:
    if score >= 15:
        return "High"
    if score >= 8:
        return "Medium"
    return "Low"


def risk_ev(r: Risk) -> float:
    """Expected value: cost impact x probability (1..5 mapped to 10%..90%)."""
    pct = {1: 0.1, 2: 0.3, 3: 0.5, 4: 0.7, 5: 0.9}[max(1, min(5, r.probability))]
    return r.cost_impact * pct


def ranked_risks(risks: list[Risk]) -> list[Risk]:
    return sorted(risks, key=lambda r: (-risk_score(r.probability, r.impact), -r.cost_impact))


# --------------------------------------------------------------------------
# Schedule (critical path method on working days)
# --------------------------------------------------------------------------
def add_working_days(start: date, days: int) -> date:
    d = start
    step = 1 if days >= 0 else -1
    remaining = abs(days)
    while remaining:
        d += timedelta(days=step)
        if d.weekday() < 5:
            remaining -= 1
    return d


def next_working_day(d: date) -> date:
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


@dataclass
class ScheduledTask:
    id: str
    early_start: int  # working-day offsets from project start
    early_finish: int
    late_start: int
    late_finish: int
    start: date
    finish: date

    @property
    def total_float(self) -> int:
        return self.late_start - self.early_start

    @property
    def critical(self) -> bool:
        return self.total_float == 0


@dataclass
class ScheduleResult:
    tasks: dict[str, ScheduledTask]
    order: list[str]
    project_start: date
    project_finish: date
    duration_days: int
    warnings: list[str] = field(default_factory=list)


def compute_schedule(schedule: Schedule) -> ScheduleResult:
    warnings: list[str] = []
    try:
        start = date.fromisoformat(schedule.start_date)
    except ValueError:
        start = date.today()
        warnings.append(f"Invalid start date '{schedule.start_date}', used {start.isoformat()}")
    start = next_working_day(start)

    tasks = {t.id: t for t in schedule.tasks}
    preds: dict[str, list[str]] = {}
    for t in schedule.tasks:
        valid = []
        for p in t.predecessors:
            if p in tasks and p != t.id:
                valid.append(p)
            else:
                warnings.append(f"{t.id}: ignored unknown predecessor '{p}'")
        preds[t.id] = valid

    # Topological order (Kahn); break cycles by dropping the offending links.
    order: list[str] = []
    indeg = {tid: len(ps) for tid, ps in preds.items()}
    succs: dict[str, list[str]] = {tid: [] for tid in tasks}
    for tid, ps in preds.items():
        for p in ps:
            succs[p].append(tid)
    ready = [tid for tid in tasks if indeg[tid] == 0]
    while len(order) < len(tasks):
        if not ready:
            stuck = next(tid for tid in tasks if tid not in order)
            warnings.append(f"{stuck}: dependency loop detected, predecessors removed")
            for p in preds[stuck]:
                succs[p].remove(stuck)
            preds[stuck] = []
            indeg[stuck] = 0
            ready.append(stuck)
        tid = ready.pop(0)
        order.append(tid)
        for s in succs[tid]:
            indeg[s] -= 1
            if indeg[s] == 0:
                ready.append(s)

    dur = {tid: max(0, tasks[tid].duration_days) for tid in tasks}
    es: dict[str, int] = {}
    ef: dict[str, int] = {}
    for tid in order:
        es[tid] = max((ef[p] for p in preds[tid]), default=0)
        ef[tid] = es[tid] + dur[tid]
    project_len = max(ef.values(), default=0)

    lf: dict[str, int] = {}
    ls: dict[str, int] = {}
    for tid in reversed(order):
        lf[tid] = min((ls[s] for s in succs[tid]), default=project_len)
        ls[tid] = lf[tid] - dur[tid]

    result = {}
    for tid in order:
        s = add_working_days(start, es[tid])
        # A task of N days occupies N working days, finishing on the Nth.
        f = add_working_days(start, ef[tid] - 1) if dur[tid] > 0 else s
        result[tid] = ScheduledTask(tid, es[tid], ef[tid], ls[tid], lf[tid], s, f)

    finish = max((t.finish for t in result.values()), default=start)
    return ScheduleResult(result, order, start, finish, project_len, warnings)
