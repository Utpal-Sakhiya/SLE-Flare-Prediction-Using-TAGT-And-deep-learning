"""Train and evaluate the TAGT model plus classical baselines on the semi-synthetic SLE dataset
(real GSE49454 expression profiles paired with simulated clinical visit trajectories).

Evaluation uses *patient-grouped* stratified 5-fold cross-validation, so no patient's visits
appear in both the training and the test fold (the earlier repository results did not guard
against this leakage). After evaluation, the deployable models are refit on all data.

Usage:  python webapp/train.py
Outputs: webapp/artifacts/{tagt_model.pt, preprocessor.json, baseline_lr.joblib, metrics.json}
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import joblib
import numpy as np
import torch
import torch.nn as nn
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score, roc_auc_score, roc_curve
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tagt_core import ARTIFACT_DIR, Preprocessor, TAGTModel, load_dataset  # noqa: E402

SEED = 42
EPOCHS = 15


def set_seed(seed: int) -> None:
    np.random.seed(seed)
    torch.manual_seed(seed)


def train_tagt(Xg: np.ndarray, Xc: np.ndarray, y: np.ndarray, seed: int = SEED) -> TAGTModel:
    """Train TAGT with class-balanced BCE, weight decay and light noise augmentation."""
    set_seed(seed)
    model = TAGTModel(n_genes=Xg.shape[1], clinical_dim=Xc.shape[1])
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=5e-2)
    pos_weight = torch.tensor((y == 0).sum() / max((y == 1).sum(), 1), dtype=torch.float32)
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
    g, c, t = (torch.tensor(a, dtype=torch.float32) for a in (Xg, Xc, y))
    n = len(t)
    for _ in range(EPOCHS):
        model.train()
        perm = torch.randperm(n)
        for i in range(0, n, 32):
            idx = perm[i:i + 32]
            gb = g[idx] + 0.1 * torch.randn_like(g[idx])
            opt.zero_grad()
            loss = loss_fn(model(gb, c[idx]), t[idx])
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
    model.eval()
    return model


def tagt_predict(model: TAGTModel, Xg: np.ndarray, Xc: np.ndarray) -> np.ndarray:
    with torch.no_grad():
        logits = model(torch.tensor(Xg), torch.tensor(Xc))
    return torch.sigmoid(logits).numpy()


def summarize(y: np.ndarray, p: np.ndarray, fold_aucs: list[float], threshold: float) -> dict:
    pred = (p >= threshold).astype(int)
    tn, fp, fn, tp = confusion_matrix(y, pred, labels=[0, 1]).ravel()
    fpr, tpr, _ = roc_curve(y, p)
    # Thin the ROC curve to at most ~60 points for the UI.
    keep = np.unique(np.linspace(0, len(fpr) - 1, min(len(fpr), 60)).astype(int))
    return {
        "auc": float(roc_auc_score(y, p)),
        "auc_fold_mean": float(np.mean(fold_aucs)),
        "auc_fold_std": float(np.std(fold_aucs)),
        "fold_aucs": [float(a) for a in fold_aucs],
        "accuracy": float(accuracy_score(y, pred)),
        "f1": float(f1_score(y, pred, zero_division=0)),
        "sensitivity": float(tp / (tp + fn)) if tp + fn else 0.0,
        "specificity": float(tn / (tn + fp)) if tn + fp else 0.0,
        "threshold": float(threshold),
        "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
        "roc": {"fpr": fpr[keep].round(4).tolist(), "tpr": tpr[keep].round(4).tolist()},
    }


def youden_threshold(y: np.ndarray, p: np.ndarray) -> float:
    fpr, tpr, thr = roc_curve(y, p)
    best = int(np.argmax(tpr - fpr))
    return float(np.clip(thr[best], 0.05, 0.95))


def main() -> None:
    t0 = time.time()
    ds = load_dataset()
    X, C, y, groups = ds["X"], ds["C"], ds["y"], ds["groups"]
    Cs = Preprocessor.clinical(C)
    print(f"Data: {len(y)} visit pairs, {len(set(groups))} patients, flare rate {y.mean():.1%}")

    baselines = {
        "Logistic Regression (clinical)": lambda: make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000)),
        "Logistic Regression (genes + clinical)": lambda: make_pipeline(
            StandardScaler(), LogisticRegression(C=0.01, max_iter=3000)),
        "Random Forest (genes + clinical)": lambda: RandomForestClassifier(
            n_estimators=300, min_samples_leaf=3, random_state=SEED, n_jobs=-1),
    }
    feats = {
        "Logistic Regression (clinical)": lambda Xi, Ci: Ci,
        "Logistic Regression (genes + clinical)": lambda Xi, Ci: np.hstack([Xi, Ci]),
        "Random Forest (genes + clinical)": lambda Xi, Ci: np.hstack([Xi, Ci]),
    }
    names = ["TAGT (ours)"] + list(baselines)
    oof = {n: np.zeros(len(y)) for n in names}
    fold_aucs = {n: [] for n in names}

    cv = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=SEED)
    for k, (tr, te) in enumerate(cv.split(X, y, groups)):
        pre = Preprocessor().fit(X[tr])
        model = train_tagt(pre.genes(X[tr]), Cs[tr], y[tr], seed=SEED + k)
        oof["TAGT (ours)"][te] = tagt_predict(model, pre.genes(X[te]), Cs[te])
        for name, make in baselines.items():
            clf = make().fit(feats[name](X[tr], Cs[tr]), y[tr])
            oof[name][te] = clf.predict_proba(feats[name](X[te], Cs[te]))[:, 1]
        for name in names:
            fold_aucs[name].append(roc_auc_score(y[te], oof[name][te]))
        print(f"Fold {k + 1}: " + ", ".join(f"{n.split(' (')[0]}={fold_aucs[n][-1]:.3f}" for n in names))

    results = {}
    for name in names:
        results[name] = summarize(y, oof[name], fold_aucs[name], youden_threshold(y, oof[name]))
        r = results[name]
        print(f"{name:40s} AUC {r['auc']:.3f} (folds {r['auc_fold_mean']:.3f} ± {r['auc_fold_std']:.3f})  "
              f"Acc {r['accuracy']:.3f}  Sens {r['sensitivity']:.3f}  Spec {r['specificity']:.3f}")

    # ---- Refit deployable models on all data ----
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    pre = Preprocessor().fit(X)
    final = train_tagt(pre.genes(X), Cs, y, seed=SEED)
    torch.save(final.state_dict(), ARTIFACT_DIR / "tagt_model.pt")
    (ARTIFACT_DIR / "preprocessor.json").write_text(json.dumps(pre.state()))
    lr = baselines["Logistic Regression (clinical)"]().fit(Cs, y)
    joblib.dump(lr, ARTIFACT_DIR / "baseline_lr.joblib")

    metrics = {
        "trained_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "protocol": "Patient-grouped stratified 5-fold cross-validation (StratifiedGroupKFold, seed 42)",
        "dataset": {
            "source": "Semi-synthetic: real GSE49454 expression profiles + simulated clinical visits (src/data/process_real_data.py)",
            "n_samples": int(len(y)), "n_patients": int(len(set(groups))),
            "n_genes": int(X.shape[1]), "n_flares": int(y.sum()), "flare_rate": float(y.mean()),
        },
        "models": results,
        "tagt_threshold": results["TAGT (ours)"]["threshold"],
        "baseline_threshold": results["Logistic Regression (clinical)"]["threshold"],
        "training_seconds": round(time.time() - t0, 1),
    }
    (ARTIFACT_DIR / "metrics.json").write_text(json.dumps(metrics, indent=2))
    print(f"Saved artifacts to {ARTIFACT_DIR} in {metrics['training_seconds']}s")


if __name__ == "__main__":
    main()
