"""Data model for everything the tool extracts from the scope documents.

The same Pydantic models are used two ways:
  * as structured-output schemas, so Claude's answer is validated JSON, and
  * as the on-disk ``analysis.json`` that the document writers read.

Numbers that can be derived (totals, risk scores, dates) are NOT asked of the
model; ``calc.py`` computes them so they are always arithmetically consistent.
"""

from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, Field

Confidence = Literal["High", "Medium", "Low"]
Rating = Literal["High", "Medium", "Low"]


# --------------------------------------------------------------------------
# 1. Project overview, document review and organisation
# --------------------------------------------------------------------------
class SourceDocument(BaseModel):
    name: str
    document_type: str = Field(description="e.g. Scope of Work, Specification, Contract, Drawing list")
    summary: str


class ReviewFinding(BaseModel):
    area: str
    issue: str = Field(description="Gap, ambiguity, conflict or missing information found in the documents")
    impact: str
    recommendation: str
    severity: Rating


class Clarification(BaseModel):
    id: str = Field(description="e.g. CQ-001")
    question: str = Field(description="Question to raise with the client")
    document_ref: str = Field(description="Document name and clause/section the question relates to")
    priority: Rating


class ProjectInfo(BaseModel):
    name: str
    client: str
    location: str
    description: str
    objectives: List[str]
    in_scope: List[str]
    out_of_scope: List[str]
    key_deliverables: List[str]
    stakeholders: List[str]


class OrgRole(BaseModel):
    id: str = Field(description="Short unique id such as R01")
    title: str = Field(description="Role title, e.g. Project Director")
    person: str = Field(description="Named person if the documents name one, otherwise 'TBC'")
    organisation: Literal["Client", "Delivery Team", "Subcontractor", "Third Party"]
    reports_to: str = Field(description="id of the role this reports to; empty string for the top role")
    responsibilities: List[str]
    allocation_pct: int = Field(description="Expected time allocation to this project, 0-100")


class Overview(BaseModel):
    project: ProjectInfo
    documents: List[SourceDocument]
    review_findings: List[ReviewFinding]
    clarifications: List[Clarification]
    organisation: List[OrgRole]


# --------------------------------------------------------------------------
# 2. Estimate and schedule
# --------------------------------------------------------------------------
class EstimateLine(BaseModel):
    wbs_code: str = Field(description="e.g. 1.2.3")
    phase: str
    description: str
    cost_type: Literal["Labour", "Materials", "Equipment", "Subcontract", "Expenses", "Other"]
    unit: str = Field(description="e.g. hr, day, item, m, lump sum")
    quantity: float
    unit_rate: float = Field(description="Rate in the estimate currency, excluding contingency")
    basis: str = Field(description="How the quantity and rate were derived")
    confidence: Confidence
    source_ref: str = Field(description="Document and clause the line is based on, or 'Assumption'")


class Estimate(BaseModel):
    currency: str = Field(description="ISO currency code, e.g. GBP, USD, IDR")
    estimate_class: str = Field(description="Estimate class / maturity, e.g. 'AACE Class 4 (-30% / +50%)'")
    basis_of_estimate: str
    lines: List[EstimateLine]
    contingency_pct: float = Field(description="Contingency percentage applied to the base estimate")
    escalation_pct: float = Field(description="Escalation percentage applied to the base estimate")
    management_reserve_pct: float


class ScheduleTask(BaseModel):
    id: str = Field(description="Unique id such as T010")
    wbs_code: str
    name: str
    phase: str
    duration_days: int = Field(description="Working days; 0 for milestones")
    predecessors: List[str] = Field(description="ids of finish-to-start predecessors")
    is_milestone: bool
    owner_role: str


class Schedule(BaseModel):
    start_date: str = Field(description="Planned start date, ISO YYYY-MM-DD")
    tasks: List[ScheduleTask]


class EstimateAndSchedule(BaseModel):
    estimate: Estimate
    schedule: Schedule


# --------------------------------------------------------------------------
# 3. Risks, assumptions and exclusions
# --------------------------------------------------------------------------
class Risk(BaseModel):
    id: str = Field(description="e.g. R-001")
    title: str
    description: str = Field(description="Cause - event - effect")
    category: Literal["Commercial", "Technical", "Schedule", "Safety", "Environmental",
                      "Regulatory", "Resource", "Stakeholder", "Supply Chain", "Other"]
    owner_role: str
    probability: int = Field(description="1 (rare) to 5 (almost certain)")
    impact: int = Field(description="1 (negligible) to 5 (severe)")
    cost_impact: float = Field(description="Most likely cost if it occurs, estimate currency")
    schedule_impact_days: int
    response: Literal["Avoid", "Mitigate", "Transfer", "Accept", "Exploit", "Enhance"]
    mitigation: str
    residual_probability: int
    residual_impact: int
    source_ref: str


class Assumption(BaseModel):
    id: str = Field(description="e.g. A-001")
    area: str
    statement: str
    rationale: str
    impact_if_false: str
    validation_action: str
    owner_role: str
    source_ref: str


class Exclusion(BaseModel):
    id: str = Field(description="e.g. E-001")
    area: str
    statement: str
    rationale: str
    source_ref: str


class RisksAndAssumptions(BaseModel):
    risks: List[Risk]
    assumptions: List[Assumption]
    exclusions: List[Exclusion]


# --------------------------------------------------------------------------
# 4. Commercial / technical registers and compliance matrix
# --------------------------------------------------------------------------
RegisterStatus = Literal["Accepted", "Qualified", "Open", "Clarification Required", "Not Accepted"]


class CommercialItem(BaseModel):
    id: str = Field(description="e.g. C-001")
    category: Literal["Contract Form", "Payment", "Pricing", "Liability", "Insurance", "Warranty",
                      "Liquidated Damages", "Intellectual Property", "Variations", "Securities",
                      "Procurement", "Tax", "Other"]
    topic: str
    client_requirement: str
    our_position: str
    status: RegisterStatus
    risk_rating: Rating
    owner_role: str
    source_ref: str


class TechnicalItem(BaseModel):
    id: str = Field(description="e.g. T-001")
    discipline: str
    topic: str
    client_requirement: str
    our_response: str
    status: RegisterStatus
    risk_rating: Rating
    owner_role: str
    source_ref: str


class ComplianceItem(BaseModel):
    id: str = Field(description="e.g. CM-001")
    source_document: str
    clause_ref: str
    requirement: str
    requirement_type: Literal["Mandatory", "Desirable", "Information"]
    compliance: Literal["Compliant", "Partially Compliant", "Non-Compliant", "To Be Confirmed"]
    response: str
    evidence: str = Field(description="Where compliance is demonstrated, e.g. method statement section")
    owner_role: str


class Registers(BaseModel):
    commercial: List[CommercialItem]
    technical: List[TechnicalItem]
    compliance: List[ComplianceItem]


# --------------------------------------------------------------------------
# 5. Gate approval narrative (written last, from the computed figures)
# --------------------------------------------------------------------------
class GateSummary(BaseModel):
    gate_name: str
    recommendation: Literal["Approve", "Approve with conditions", "Defer", "Reject"]
    decision_requested: str
    executive_summary: str
    strategic_fit: str
    key_messages: List[str]
    conditions: List[str]
    next_steps: List[str]


# --------------------------------------------------------------------------
# Everything together: the analysis.json file
# --------------------------------------------------------------------------
class Analysis(BaseModel):
    generated_on: str
    overview: Overview
    estimate_schedule: EstimateAndSchedule
    risks: RisksAndAssumptions
    registers: Registers
    gate: GateSummary
    model: Optional[str] = None
