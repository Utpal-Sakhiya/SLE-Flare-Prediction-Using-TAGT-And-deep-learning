# TAGT Flare Predictor

**SLE flare prediction with a Temporal Attention Graph Transformer: a validated pipeline and web application**

Capstone Project (Phase I), B.Tech in Artificial Intelligence and Machine Learning
Unitedworld Institute of Technology, Karnavati University · Group **Token Burners**

| Team member | Enrollment No. |
|---|---|
| Utpal Sakhiya | 202307020101 |
| Vyom Patel | 202307020084 |
| Harshil Dhamat | 202307020033 |
| Poojan Shihora | 202307020111 |

> ⚠️ Research and education prototype. Not a medical device; do not use for clinical decisions.

---

## What it does

Systemic Lupus Erythematosus (SLE) alternates between quiet periods and **flares**. Given a patient's current visit (1,000 whole-blood gene-expression probes, SLEDAI-2K score and current flare status), the app estimates the probability of a flare at the **next** visit. It also explains which probes drove the prediction and shows how every model was validated.

- **TAGT model** (PyTorch, ~400k parameters): gene encoder → graph projection → 8-head attention → clinical fusion → classifier
- **Leakage-free evaluation:** patient-grouped stratified 5-fold cross-validation against three classical baselines
- **Explainability:** gradient × input attribution for the top-10 probes of each prediction
- **Web app:** Flask REST API plus an offline HTML/CSS/JS interface (Overview, Predict, Results, Methodology, Team)

## Quick start

**Windows:** double-click `run_webapp.bat`. It sets up a virtual environment, installs dependencies and opens <http://127.0.0.1:5000>.

**Any OS:**

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate    macOS/Linux: source .venv/bin/activate
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements-webapp.txt
python webapp/app.py            # open http://127.0.0.1:5000
python webapp/train.py          # optional: retrain all models (~20 s on CPU)
```

Requires Python 3.10 or newer. No GPU is needed. See [README_WEBAPP.md](README_WEBAPP.md) for the REST API and more detail.

## Results (patient-grouped stratified 5-fold CV)

| Model | AUC-ROC | Fold AUC (mean ± SD) | Accuracy | Sensitivity | Specificity |
|---|---|---|---|---|---|
| **TAGT (ours)** | **0.598** | 0.609 ± 0.091 | 65.9% | 42.2% | 78.0% |
| Logistic Regression (clinical only) | 0.669 | 0.669 ± 0.043 | 70.1% | 48.4% | 81.2% |
| Logistic Regression (genes + clinical) | 0.561 | 0.573 ± 0.074 | 59.5% | 49.2% | 64.8% |
| Random Forest (genes + clinical) | 0.529 | 0.535 ± 0.063 | 58.7% | 37.5% | 69.6% |

### Read before citing these numbers

- **The dataset is semi-synthetic.** Expression profiles are real [GSE49454](https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE49454) measurements. Patients, visits, SLEDAI-2K scores and flare labels were *simulated* by `src/data/process_real_data.py`, and each visit was given a randomly chosen expression profile. The genes therefore carry almost no real flare signal, which is why the clinical-only baseline scores highest.
- **Earlier claims were not reproducible.** Earlier documents in this code base report AUC 0.943. That figure does not hold under patient-level validation, and the previously shipped checkpoint `models/best_tagt_model.pt` gives near-constant outputs (AUC ≈ 0.50). The web app uses a freshly trained model in `webapp/artifacts/`.
- The project demonstrates a correct, reproducible pipeline and application. It does not demonstrate clinical validity.

## Repository layout

```
webapp/                  Capstone web application
  app.py                 Flask server + REST API + explanations
  train.py               Patient-grouped CV, baselines, final model fit
  tagt_core.py           TAGT architecture, data loading, preprocessing
  artifacts/             Trained model, scaler, baseline, metrics.json
  static/                index.html, style.css, app.js
docs/capstone_report/    Capstone project report (.docx and .pdf)
data/                    Preprocessed GSE49454-derived dataset
src/                     Original research code (models, training, analysis)
run_webapp.bat           One-click launcher (Windows)
requirements-webapp.txt  Web-app dependencies
```

## Report

The full capstone report (55 pages, KU/UIT format) is in [`docs/capstone_report/`](docs/capstone_report/).

## Acknowledgements

This project builds on the open-source TAGT research code base (MIT License; see [LICENSE](LICENSE) and the original documentation in [docs/ORIGINAL_README.md](docs/ORIGINAL_README.md)). Expression data come from Chiche et al. (2014), *Arthritis & Rheumatology* 66(6):1583-1595, via NCBI GEO.
