# TAGT Flare Predictor: Web Application

**University Capstone Project: SLE Flare Prediction with a Temporal Attention Graph Transformer (TAGT)**

| Team member | Enrollment No. |
|---|---|
| Utpal Sakhiya | 202307020101 |
| Vyom Patel | 202307020084 |
| Harshil Dhamat | 202307020033 |
| Poojan Shihora | 202307020111 |

A browser-based interface to the TAGT model. Given a patient's current visit (whole-blood gene expression, SLEDAI-2K score and flare status), it predicts the probability of a lupus flare at the **next** visit and explains which gene probes drove the prediction.

> ⚠️ Research and education only. This is not a medical device.

---

## Quick start (Windows)

Double-click **`run_webapp.bat`**.
The first run creates a `.venv`, installs the dependencies (CPU PyTorch, Flask, scikit-learn) and opens <http://127.0.0.1:5000>.

### Manual start (any OS)

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate      macOS/Linux: source .venv/bin/activate
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements-webapp.txt

python webapp/train.py      # optional: retrains models (~20 s); app.py does this automatically if needed
python webapp/app.py        # then open http://127.0.0.1:5000
```

Requires Python 3.10 or newer. No GPU and no internet connection are needed once the packages are installed (the UI has no CDN dependencies).

## What the app contains

| Section | Contents |
|---|---|
| **Overview** | Plain-language problem statement, disclaimer, dataset stat tiles, 3-step model pipeline |
| **Predict** | Pick any of the 378 dataset visit pairs (searchable, random or by index; the true outcome is revealed only after predicting), or enter a custom patient with a SLEDAI slider, a flare toggle and an optional expression CSV. Shows the TAGT flare risk score, risk band, threshold meter and the clinical baseline side by side, plus the top 10 probe attributions (gradient × input) |
| **Results** | Out-of-fold ROC curves, AUC bar chart with fold ± SD whiskers, metrics table sorted by AUC, confusion matrices and generated key findings |
| **Methodology** | Data provenance, inputs, model, training, validation, baselines and limitations |
| **Team** | Project members, group and institution |

## Front-end

Plain HTML, CSS and JavaScript in `webapp/static/`, with no build step, no libraries and no CDN or font requests, so it works fully offline. Flask serves `index.html` at `/` and the other files under `/static/`.

| File | Role |
|---|---|
| `index.html` | Page shell: header, 5 sections, footer |
| `css/main.css` | Light/dark theme tokens (OS setting + manual toggle stored in `localStorage`), layout from 360 px to 1440 px, space reserved for results so nothing shifts |
| `js/main.js` | Routing (`#/overview`, `#/predict`, ...), API calls, CSV parsing, rendering, generated key findings. Every number comes from `/api/info`, `/api/samples` or `/api/predict` |
| `js/charts.js` | Hand-written SVG charts: ROC with crosshair readout, AUC bars with fold ± SD whiskers, diverging attribution bars. Tooltips work on hover and keyboard focus; each chart has a table alternative |
| `img/mark.svg` | Logo and favicon |

**Run it:** start the server (see *Quick start* above), then open <http://127.0.0.1:5000>. Nothing else is needed.

**Institution logos:** the logo files were not available when the UI was built. Copy them into `webapp/static/img/` and list them in `LOGOS` at the top of `webapp/static/js/main.js`, e.g. `{ src: "/static/img/ku-logo.jpeg", alt: "Karnavati University logo" }`. They will appear on the Team page.

**Screenshots** of every section in light and dark mode, at 1440 px and 390 px, are in `webapp/screenshots/`.

### Demo notes

- Dataset visit 5 gives TAGT 65.6% (High) vs clinical baseline 37.6% (Moderate); the true outcome is a flare. Dataset visits were used to fit the deployed models, so this check is in-sample. The Results page shows unseen-patient performance.
- The downloadable template contains the cohort *mean* for every probe, so uploading it unchanged yields attributions near zero (the page says so). Edit some values first to demonstrate the attribution chart with a custom profile.
- Invalid inputs (SLEDAI-2K 200, visit index 9999) show the server's error message inline. Chrome also logs its standard "Failed to load resource: 400" line in the console for these deliberate bad requests.

## Project layout (web-app files)

```
webapp/
├── app.py            Flask server + REST API
├── train.py          Patient-grouped 5-fold CV, baselines, final model fit
├── tagt_core.py      TAGT architecture, data loading, preprocessing
├── artifacts/        Trained weights, scaler, baseline model, metrics.json (generated)
├── static/           index.html, css/main.css, js/main.js, js/charts.js, img/ (UI, no external libraries)
└── screenshots/      UI screenshots, light + dark, desktop + mobile
run_webapp.bat        One-click launcher
requirements-webapp.txt
```

## REST API

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/info` | Project, team, and cross-validation metrics |
| GET | `/api/samples` | List of cohort visits |
| POST | `/api/predict` | `{"sample_index": 5}` **or** `{"current_sledai": 12, "current_flare": 0, "expression": {"ILMN_1697499": 7.1, ...}}` |
| GET | `/api/template.csv` | Expression CSV template (1,000 probes, cohort mean values) |

## Results (patient-grouped stratified 5-fold CV)

| Model | AUC-ROC | Fold AUC (mean ± SD) | Accuracy | Sensitivity | Specificity |
|---|---|---|---|---|---|
| **TAGT (ours)** | **0.598** | 0.609 ± 0.091 | 65.9% | 42.2% | 78.0% |
| Logistic Regression (clinical) | 0.669 | 0.669 ± 0.043 | 70.1% | 48.4% | 81.2% |
| Logistic Regression (genes + clinical) | 0.561 | 0.573 ± 0.074 | 59.5% | 49.2% | 64.8% |
| Random Forest (genes + clinical) | 0.529 | 0.535 ± 0.063 | 58.7% | 37.5% | 69.6% |

### Notes on validity (please read before presenting)

0. **The dataset is semi-synthetic.** `src/data/process_real_data.py` *simulates* the patients, visits, SLEDAI-2K scores and flare labels, and gives each visit a randomly chosen real GSE49454 expression profile plus noise. Gene expression is therefore not linked to the outcome, which is why gene-based models score near chance. The project demonstrates a validated pipeline and application, not a clinically validated predictor.

1. **Patient-grouped CV.** All visits from the same patient stay in one fold, so the models are tested on unseen patients. Ordinary (ungrouped) CV leaks a patient's visits between training and test sets and inflates the scores.
2. **The original checkpoint was retrained.** `models/best_tagt_model.pt` produced near-constant outputs (≈ 0.53 for every sample, AUC ≈ 0.50) on the project's own data. The app trains a fresh TAGT model and leaves the original file untouched.
3. **The earlier 94.3% AUC claim is not reproducible.** Documents elsewhere in this repository report AUC 0.94. That figure did not hold up under leakage-free evaluation, and the repository's own `validation_plan/reports/FINAL_VALIDATION_REPORT.md` flags the claims as unverified. Present the numbers above.
4. **The clinical baseline beats TAGT here.** Most of the signal is in the current SLEDAI score, and the gene expression adds little in a 100-patient cohort. TAGT does outperform the classical genes + clinical models. This is a defensible, honest finding for a capstone.
