"""Ask Claude to review the documents and fill in each part of the analysis.

The documents go in one cached prefix, then one request per deliverable group,
so the second and later requests read the documents from the prompt cache.
"""

from __future__ import annotations

import json
import sys
from datetime import date
from typing import Type, TypeVar

import anthropic
from pydantic import BaseModel, ValidationError

from . import calc
from .ingest import Document
from .schema import (Analysis, EstimateAndSchedule, GateSummary, Overview, Registers,
                     RisksAndAssumptions)

MODEL = "claude-opus-5-5"
T = TypeVar("T", bound=BaseModel)

SYSTEM = """You are a senior project manager and bid/estimating lead preparing a project for a \
stage-gate approval. You are given the client's scope and support documents. Read all of them \
closely before answering.

Rules:
- Base everything on the documents. Where you have to assume something, say so in the field \
meant for it (basis, rationale, source_ref = "Assumption") rather than presenting it as fact.
- Quote document names and clause/section numbers in source_ref / document_ref fields so a \
reviewer can trace each line back.
- Be specific to this project. Avoid generic boilerplate entries that would apply to any project.
- Use consistent role titles across the organisation chart, owners and schedule.
- Prefer completeness: a reviewer would rather delete a weak line than find a missing one."""

TASKS = {
    "overview": (Overview, """Produce the project overview and document review:
- project: the project's identity, objectives, in-scope and out-of-scope items, deliverables, stakeholders.
- documents: one entry per document supplied.
- review_findings: every gap, ambiguity, conflict between documents, or missing information that \
would affect pricing, planning or delivery.
- clarifications: the questions to send to the client to close those findings.
- organisation: the delivery organisation chart (client interface, delivery team and key \
subcontractor roles). Exactly one role has reports_to = "" (the top of the chart); every other \
reports_to must be an id from this list."""),
    "estimate_schedule": (EstimateAndSchedule, """Produce the cost estimate and schedule:
- estimate: a bottom-up estimate structured by WBS covering every in-scope item, including project \
management, design, procurement, delivery, testing/commissioning and handover. Use rates and \
quantities from the documents where given; otherwise use realistic market rates for the project \
location and explain the basis. Set contingency, escalation and management reserve percentages \
appropriate to the estimate maturity, and state the estimate class.
- schedule: a logic-linked schedule (finish-to-start predecessors) using the same WBS codes, with \
key milestones (contract award, design approval, delivery, completion, handover) as zero-duration \
tasks. Respect any dates or durations the documents require. Every task except the first must \
have at least one predecessor; no task may depend on itself or create a loop."""),
    "risks": (RisksAndAssumptions, """Produce the risk register and the assumptions and exclusions:
- risks: project-specific threats (and opportunities, with response Exploit/Enhance) with \
probability and impact on a 1-5 scale, cost and schedule impact, response and mitigation, and \
residual probability/impact after mitigation.
- assumptions: every assumption the estimate and schedule depend on, with how to validate it.
- exclusions: everything that is not included in the price or scope, so the client sees it clearly."""),
    "registers": (Registers, """Produce the commercial register, technical register and compliance matrix:
- commercial: each commercial and contractual term (contract form, payment, pricing, liability, \
insurance, warranty, LDs, IP, variations, securities, tax...) with the client's requirement and \
our proposed position.
- technical: each technical requirement or design topic, by discipline, with our response.
- compliance: one line per requirement clause in the documents (mandatory 'shall/must' clauses \
first), with the compliance status we can offer, our response and where the evidence is."""),
}


def _documents_block(docs: list[Document]) -> str:
    parts = [f"<documents count=\"{len(docs)}\">"]
    for i, d in enumerate(docs, 1):
        parts.append(f"<document index=\"{i}\" name=\"{d.name}\">\n{d.text}\n</document>")
    parts.append("</documents>")
    return "\n".join(parts)


class AnalysisError(RuntimeError):
    pass


def _ask(client: anthropic.Anthropic, docs_text: str, instruction: str, schema: Type[T],
         effort: str, log) -> T:
    with client.beta.messages.stream(
        model=MODEL,
        max_tokens=64000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        output_config={"effort": effort},
        output_format=schema,
        system=SYSTEM,
        messages=[{
            "role": "user",
            "content": [
                # Identical across requests, so later requests read it from the cache.
                {"type": "text", "text": docs_text, "cache_control": {"type": "ephemeral"}},
                {"type": "text", "text": instruction},
            ],
        }],
    ) as stream:
        message = stream.get_final_message()

    u = message.usage
    log(f"    tokens: in {u.input_tokens:,}, cache read {u.cache_read_input_tokens or 0:,}, "
        f"cache write {u.cache_creation_input_tokens or 0:,}, out {u.output_tokens:,}")

    if message.stop_reason == "refusal":
        detail = getattr(message.stop_details, "explanation", "") if message.stop_details else ""
        raise AnalysisError(f"Claude declined this part of the analysis. {detail}".strip())
    if message.stop_reason == "max_tokens":
        raise AnalysisError("The answer was cut off at the output limit. "
                            "Run with fewer documents or split the pack.")
    text = "".join(b.text for b in message.content if b.type == "text")
    try:
        return schema.model_validate_json(text)
    except ValidationError as exc:
        raise AnalysisError(f"Claude's answer did not match the {schema.__name__} format: {exc}") from exc


def run(docs: list[Document], gate_name: str, effort: str = "high", log=None) -> Analysis:
    log = log or (lambda m: print(m, file=sys.stderr))
    client = anthropic.Anthropic()
    docs_text = _documents_block(docs)

    results = {}
    for key, (schema, instruction) in TASKS.items():
        log(f"  - {key.replace('_', ' ')}")
        results[key] = _ask(client, docs_text, instruction, schema, effort, log)

    es: EstimateAndSchedule = results["estimate_schedule"]
    totals = calc.estimate_totals(es.estimate)
    sched = calc.compute_schedule(es.schedule)
    risks: RisksAndAssumptions = results["risks"]
    high = [r for r in risks.risks if calc.risk_rating(calc.risk_score(r.probability, r.impact)) == "High"]
    reg: Registers = results["registers"]
    figures = {
        "currency": es.estimate.currency,
        "base_estimate": round(totals.base),
        "contingency": round(totals.contingency),
        "escalation": round(totals.escalation),
        "budget_at_completion": round(totals.total),
        "management_reserve": round(totals.management_reserve),
        "funding_requested": round(totals.total_with_mr),
        "start": sched.project_start.isoformat(),
        "finish": sched.project_finish.isoformat(),
        "duration_working_days": sched.duration_days,
        "risks_total": len(risks.risks),
        "risks_high": [f"{r.id} {r.title}" for r in high],
        "risk_expected_value": round(sum(calc.risk_ev(r) for r in risks.risks)),
        "open_commercial_items": sum(1 for c in reg.commercial if c.status != "Accepted"),
        "non_compliant_or_tbc": sum(1 for c in reg.compliance if c.compliance in ("Non-Compliant", "To Be Confirmed")),
        "review_findings_high": sum(1 for f in results["overview"].review_findings if f.severity == "High"),
    }
    gate_instruction = (
        f"Write the {gate_name} approval narrative for the governance board. The figures below were "
        "calculated from the estimate, schedule, risk register and registers you prepared; use them "
        "exactly and do not recalculate them.\n\n"
        f"<figures>\n{json.dumps(figures, indent=2)}\n</figures>\n\n"
        "Recommend Approve, Approve with conditions, Defer or Reject based on the evidence, list "
        f"conditions that must be met, and set gate_name to \"{gate_name}\"."
    )
    log("  - gate approval narrative")
    gate = _ask(client, docs_text, gate_instruction, GateSummary, effort, log)

    return Analysis(
        generated_on=date.today().isoformat(),
        overview=results["overview"],
        estimate_schedule=es,
        risks=risks,
        registers=reg,
        gate=gate,
        model=MODEL,
    )
