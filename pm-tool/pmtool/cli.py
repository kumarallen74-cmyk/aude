"""Command line entry point.

    python -m pmtool analyse ./scope-docs --out ./output --gate "PG3"
    python -m pmtool generate ./output/analysis.json --out ./output
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .schema import Analysis

OUTPUTS = [
    ("Project_Estimate.xlsx", "Project estimate"),
    ("Risk_Register.xlsx", "Risk register"),
    ("Assumptions_and_Exclusions.xlsx", "Assumptions and exclusions"),
    ("Project_Schedule.xlsx", "Schedule"),
    ("Commercial_and_Technical_Register.xlsx", "Commercial and technical register"),
    ("Compliance_Matrix.xlsx", "Compliance matrix"),
    ("Organisation_Chart.pptx", "Organisation chart"),
    ("Scope_Review.docx", "Scope review and clarifications"),
]


def log(msg: str):
    print(msg, file=sys.stderr)


def generate(analysis: Analysis, out: Path) -> list[Path]:
    from .writers import excel, pack, word

    out.mkdir(parents=True, exist_ok=True)
    gate_file = f"{analysis.gate.gate_name.replace(' ', '_')}_Approval_Pack.pptx"
    writers = {
        "Project_Estimate.xlsx": excel.write_estimate,
        "Risk_Register.xlsx": excel.write_risk_register,
        "Assumptions_and_Exclusions.xlsx": excel.write_assumptions,
        "Project_Schedule.xlsx": excel.write_schedule,
        "Commercial_and_Technical_Register.xlsx": excel.write_commercial_technical,
        "Compliance_Matrix.xlsx": excel.write_compliance,
        "Organisation_Chart.pptx": pack.write_org_chart,
        "Scope_Review.docx": word.write_scope_review,
    }
    written = []
    for name, label in OUTPUTS:
        writers[name](analysis, out / name)
        written.append(out / name)
        log(f"  wrote {name}")
    pack.write_pack(analysis, out / gate_file, [f"{label}: {name}" for name, label in OUTPUTS])
    written.append(out / gate_file)
    log(f"  wrote {gate_file}")
    return written


def main(argv=None):
    ap = argparse.ArgumentParser(prog="pmtool", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("analyse", aliases=["analyze"],
                       help="Read scope documents with Claude, save analysis.json and write all deliverables")
    a.add_argument("inputs", nargs="+", type=Path, help="Files or folders of scope/support documents")
    a.add_argument("--out", type=Path, default=Path("output"))
    a.add_argument("--gate", default="PG", help='Gate name used in the approval pack, e.g. "PG3"')
    a.add_argument("--effort", default="high", choices=["low", "medium", "high", "xhigh", "max"],
                   help="How hard Claude works on each part (higher costs more)")

    g = sub.add_parser("generate", help="Rebuild the deliverables from an edited analysis.json (no API calls)")
    g.add_argument("analysis", type=Path)
    g.add_argument("--out", type=Path, default=Path("output"))

    args = ap.parse_args(argv)

    if args.cmd in ("analyse", "analyze"):
        from . import analyze
        from .ingest import collect

        docs, warnings = collect(args.inputs)
        for w in warnings:
            log(f"warning: {w}")
        if not docs:
            ap.error("no readable documents found")
        log(f"Read {len(docs)} documents (~{sum(d.chars for d in docs) // 4:,} tokens). Analysing with Claude:")
        try:
            analysis = analyze.run(docs, args.gate, args.effort, log)
        except analyze.AnalysisError as exc:
            log(f"error: {exc}")
            return 1
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "analysis.json").write_text(analysis.model_dump_json(indent=2), encoding="utf-8")
        log("  wrote analysis.json (edit it and run `generate` to rebuild the documents)")
    else:
        analysis = Analysis.model_validate_json(args.analysis.read_text(encoding="utf-8"))

    log("Writing deliverables:")
    generate(analysis, args.out)
    log(f"Done. Files are in {args.out.resolve()}")
    return 0
