"""Flask web application for the TAGT SLE flare prediction capstone project.

Run:  python webapp/app.py      then open http://127.0.0.1:5000
"""
from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import joblib
import numpy as np
import torch
from flask import Flask, Response, jsonify, request, send_from_directory

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tagt_core import ARTIFACT_DIR, Preprocessor, TAGTModel, load_dataset  # noqa: E402

STATIC_DIR = Path(__file__).resolve().parent / "static"

PROJECT = {
    "title": "SLE Flare Prediction with a Temporal Attention Graph Transformer (TAGT)",
    "short_title": "TAGT · SLE Flare Prediction",
    "type": "University Capstone Project",
    "team": [
        {"name": "Utpal Sakhiya", "enrollment": "202307020101"},
        {"name": "Vyom Patel", "enrollment": "202307020084"},
        {"name": "Harshil Dhamat", "enrollment": "202307020033"},
        {"name": "Poojan Shihora", "enrollment": "202307020111"},
    ],
}


def ensure_artifacts() -> None:
    needed = ["tagt_model.pt", "preprocessor.json", "baseline_lr.joblib", "metrics.json"]
    if not all((ARTIFACT_DIR / n).exists() for n in needed):
        print("Model artifacts not found - training now (about 20 seconds)...")
        import train
        train.main()


ensure_artifacts()
DATA = load_dataset()
METRICS = json.loads((ARTIFACT_DIR / "metrics.json").read_text())
PRE = Preprocessor.from_state(json.loads((ARTIFACT_DIR / "preprocessor.json").read_text()))
MODEL = TAGTModel(n_genes=DATA["X"].shape[1], clinical_dim=DATA["C"].shape[1])
MODEL.load_state_dict(torch.load(ARTIFACT_DIR / "tagt_model.pt", map_location="cpu"))
MODEL.eval()
BASELINE = joblib.load(ARTIFACT_DIR / "baseline_lr.joblib")
PROBES = DATA["probes"]
PROBE_INDEX = {p: i for i, p in enumerate(PROBES)}
COHORT_MEAN = DATA["X"].mean(axis=0)
TAGT_THR = METRICS["tagt_threshold"]
BASE_THR = METRICS["baseline_threshold"]

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")


def risk_band(p: float, thr: float) -> str:
    """High = at/above the decision threshold (flare predicted); Moderate = within 10 points below it."""
    if p >= thr:
        return "High"
    if p >= thr - 0.10:
        return "Moderate"
    return "Low"


def predict_one(expression: np.ndarray, sledai: float, flare_now: int) -> dict:
    clin = Preprocessor.clinical(np.array([[sledai, flare_now]], np.float32))
    genes = torch.tensor(PRE.genes(expression[None, :]), requires_grad=True)
    logit = MODEL(genes, torch.tensor(clin))
    prob = float(torch.sigmoid(logit).item())
    logit.sum().backward()
    # Gradient x input saliency on standardised expression: positive = pushes towards flare.
    contrib = (genes.grad * genes).detach().numpy()[0]
    z = genes.detach().numpy()[0]
    top = np.argsort(-np.abs(contrib))[:10]
    base_prob = float(BASELINE.predict_proba(clin)[0, 1])
    return {
        "tagt": {"probability": prob, "threshold": TAGT_THR, "risk": risk_band(prob, TAGT_THR),
                 "predicted_flare": prob >= TAGT_THR},
        "baseline": {"probability": base_prob, "threshold": BASE_THR, "risk": risk_band(base_prob, BASE_THR),
                     "predicted_flare": base_prob >= BASE_THR},
        "top_genes": [
            {"probe": PROBES[i], "contribution": float(contrib[i]), "z_score": float(z[i]),
             "expression": float(expression[i])}
            for i in top
        ],
        "inputs": {"current_sledai": sledai, "current_flare": flare_now},
    }


@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/api/info")
def info():
    return jsonify({"project": PROJECT, "metrics": METRICS})


@app.get("/api/samples")
def samples():
    out = []
    for i, r in enumerate(DATA["records"]):
        out.append({
            "index": i, "patient_id": r["patient_id"],
            "visit_from": int(r["visit_from"]), "visit_to": int(r["visit_to"]),
            "current_sledai": float(r["current_sledai"]), "current_flare": int(r["current_flare"]),
            "next_flare": int(DATA["y"][i]),
        })
    return jsonify(out)


@app.post("/api/predict")
def predict():
    body = request.get_json(force=True, silent=True) or {}
    try:
        if "sample_index" in body:
            i = int(body["sample_index"])
            if not 0 <= i < len(DATA["y"]):
                return jsonify({"error": "sample_index out of range"}), 400
            r = DATA["records"][i]
            res = predict_one(DATA["X"][i], float(r["current_sledai"]), int(r["current_flare"]))
            res["actual_next_flare"] = int(DATA["y"][i])
            res["source"] = f"{r['patient_id']} (visit {int(r['visit_from'])} → {int(r['visit_to'])})"
            return jsonify(res)

        sledai = float(body.get("current_sledai", 0))
        flare_now = 1 if body.get("current_flare") in (1, True, "1", "true") else 0
        if not 0 <= sledai <= 105:
            return jsonify({"error": "SLEDAI-2K must be between 0 and 105"}), 400
        expression = COHORT_MEAN.copy()
        matched = 0
        for probe, value in (body.get("expression") or {}).items():
            idx = PROBE_INDEX.get(str(probe).strip().strip('"'))
            if idx is not None:
                expression[idx] = float(value)
                matched += 1
        res = predict_one(expression.astype(np.float32), sledai, flare_now)
        res["matched_probes"] = matched
        res["source"] = (f"Custom profile ({matched} of {len(PROBES)} probes supplied, rest = cohort mean)"
                         if matched else "Clinical inputs + cohort-average expression profile")
        return jsonify(res)
    except (TypeError, ValueError) as exc:
        return jsonify({"error": f"Invalid input: {exc}"}), 400


@app.get("/api/template.csv")
def template_csv():
    buf = io.StringIO()
    buf.write("probe_id,expression\n")
    for p, v in zip(PROBES, COHORT_MEAN):
        buf.write(f"{p},{v:.4f}\n")
    return Response(buf.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=expression_template.csv"})


if __name__ == "__main__":
    print("TAGT web app running at http://127.0.0.1:5000")
    app.run(host="127.0.0.1", port=5000, debug=False)
