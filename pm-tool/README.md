# PM Tool: scope documents to gate approval pack

Point it at a folder of scope and support documents. Claude reads and reviews them, and the tool
writes the project management deliverables needed for a gate (PG) approval:

| Deliverable | File | Contents |
|---|---|---|
| Project estimate | `Project_Estimate.xlsx` | WBS line items (qty x rate formulas), summary by phase and cost type, contingency, escalation, management reserve, funding requested |
| Risk register | `Risk_Register.xlsx` | P x I scoring, RAG rating, expected value, response, mitigation, residual risk; live 5x5 heat map |
| Assumptions and exclusions | `Assumptions_and_Exclusions.xlsx` | Assumptions with impact-if-false and validation action; exclusions |
| Schedule | `Project_Schedule.xlsx` | Logic-linked tasks, critical path (forward/backward pass on working days), float, weekly Gantt, milestones |
| Commercial and technical register | `Commercial_and_Technical_Register.xlsx` | Client requirement vs our position, status, risk, owner |
| Compliance matrix | `Compliance_Matrix.xlsx` | Clause-by-clause compliance, response, evidence; summary by status and type |
| Organisation chart | `Organisation_Chart.pptx` | Drawn org chart (editable shapes) and roles and responsibilities |
| Scope review | `Scope_Review.docx` | Documents reviewed, gaps and conflicts found, clarification questions for the client |
| PG approval pack | `<gate>_Approval_Pack.pptx` | 14 slides: decision requested, executive summary, scope, estimate, schedule, risks, A&E, commercial/technical, compliance, document review, organisation, next steps and sign-off |

Every line carries a source reference (document and clause, or "Assumption") so reviewers can
trace it back.

## How it works

1. **Read**: PDF, Word, Excel, PowerPoint, HTML, Markdown, text and CSV files are converted to text.
2. **Analyse**: five Claude requests (overview and review, estimate and schedule, risks and A&E,
   registers and compliance, then the gate narrative). Each returns validated JSON via structured
   outputs. The documents are sent once as a cached prefix, so later requests reuse them at a
   fraction of the cost.
3. **Calculate**: totals, risk scores, critical path and dates are computed in code, not by the
   model, so the numbers always add up. The gate narrative is written from those computed figures.
4. **Write**: the analysis is saved as `analysis.json` and every deliverable is generated from it.

## Setup

```bash
cd pm-tool
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...   # or sign in with `ant auth login`
```

## Use

```bash
# Read a folder of documents and produce everything
python -m pmtool analyse ./tender-docs --out ./output --gate "PG3"

# Review and edit output/analysis.json (rates, dates, owners...), then rebuild without API calls
python -m pmtool generate ./output/analysis.json --out ./output
```

Options for `analyse`:

- `--gate` gate name used in the pack title and file name (default `PG`)
- `--effort` `low | medium | high | xhigh | max` (default `high`). Higher means more thorough
  analysis and more cost.

Try it without an API key using the worked example:

```bash
python -m pmtool generate examples/sample_analysis.json --out ./sample-output
```

## Notes and limits

- Uses `claude-opus-5-5` with server-side refusal fallback enabled.
- Scanned PDFs without a text layer are skipped with a warning; run OCR first.
- The whole pack must fit in one request (about 750k tokens of text). Larger packs: split them,
  or drop appendices that don't affect scope.
- The output is a first draft for an experienced PM, estimator and commercial lead to review.
  Rates the documents don't give are market estimates and are marked with their basis and a
  confidence level.
- Excel totals, scores and heat map counts are formulas, so edits in the workbook flow through.

## Tests

```bash
pip install pytest
python -m pytest tests
```
