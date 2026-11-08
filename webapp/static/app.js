/* TAGT Flare Predictor: front-end logic. Every number shown comes from the API. */
import { esc, rocChart, aucBars, divergingBars, fmtContrib, tprAt } from "/static/charts.js";

/* Institution logos. The files were not found when this UI was built; to show them, copy
   them into webapp/static/img/ and uncomment these entries (paths are served under /static/). */
const LOGOS = [
  // { src: "/static/img/ku-logo.jpeg", alt: "Karnavati University logo" },
  // { src: "/static/img/uit-logo.jpg", alt: "Unitedworld Institute of Technology logo" },
];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const fmt = {
  int: (n) => Number(n).toLocaleString("en-US"),
  pct: (p, d = 1) => `${(Number(p) * 100).toFixed(d)}%`,
  auc: (v) => Number(v).toFixed(3),
  sec: (v) => `${Number(v).toFixed(1)} s`,
  fold: (n) => `${Math.round(Number(n) / 5)}`,
  sledai: (v) => (Number.isInteger(Number(v)) ? String(Number(v)) : Number(v).toFixed(1)),
};

const state = { info: null, samples: [], filtered: [], busy: false, csv: null, models: [] };

/* ------------------------------------------------------------ API */
class ApiError extends Error {}
async function api(path, opts) {
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new ApiError("Could not reach the server. Is `python webapp/app.py` running?");
  }
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) throw new ApiError(body && body.error ? body.error : `Request failed (HTTP ${res.status}).`);
  return body;
}

/* ------------------------------------------------------------ Theme */
const THEME_KEY = "tagt-theme";
const mql = window.matchMedia("(prefers-color-scheme: dark)");
function effectiveTheme() {
  const t = document.documentElement.getAttribute("data-theme");
  return t === "light" || t === "dark" ? t : mql.matches ? "dark" : "light";
}
function syncThemeButton() {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  $("#themeToggle").setAttribute("aria-label", `Switch to ${next} theme`);
  $("#themeToggle").title = `Switch to ${next} theme`;
}
function initTheme() {
  $("#themeToggle").addEventListener("click", () => {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage unavailable */ }
    syncThemeButton();
  });
  mql.addEventListener("change", syncThemeButton);
  syncThemeButton();
}

/* ------------------------------------------------------------ Routing */
const VIEWS = { overview: "Overview", predict: "Predict", results: "Results", method: "Methodology", team: "Team" };
let routedOnce = false;
function route() {
  let v = location.hash.replace(/^#/, "");
  if (!(v in VIEWS)) v = "overview";
  $$(".view").forEach((el) => { el.hidden = el.dataset.view !== v; });
  $$("[data-nav]").forEach((a) => {
    if (a.dataset.nav === v) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  document.title = v === "overview" ? "TAGT Flare Predictor" : `${VIEWS[v]} · TAGT Flare Predictor`;
  if (routedOnce) {
    window.scrollTo(0, 0);
    const h = $(`#view-${v} h1`);
    if (h) h.focus({ preventScroll: true });
  }
  routedOnce = true;
}

/* ------------------------------------------------------------ Model metadata */
function describeModels(metrics) {
  const entries = Object.entries(metrics.models);
  const baselineEntry =
    entries.find(([n, m]) => !/^TAGT/i.test(n) && Math.abs(m.threshold - metrics.baseline_threshold) < 1e-9) ||
    entries.find(([n]) => /clinical\)$/i.test(n) && !/genes/i.test(n));
  const baselineName = baselineEntry ? baselineEntry[0] : null;
  return entries.map(([name, m]) => {
    let slot = 4, short = name;
    if (/^TAGT/i.test(name)) { slot = 1; short = "TAGT (ours)"; }
    else if (name === baselineName) { slot = 2; short = "LR · clinical only"; }
    else if (/logistic/i.test(name) && /genes/i.test(name)) { slot = 3; short = "LR · genes + clinical"; }
    else if (/forest/i.test(name)) { slot = 4; short = "RF · genes + clinical"; }
    return {
      name, short, m, color: `var(--s${slot})`,
      isTagt: slot === 1, isBaseline: name === baselineName, usesGenes: /^TAGT/i.test(name) || /genes/i.test(name),
    };
  }).sort((a, b) => b.m.auc - a.m.auc);
}

/* ------------------------------------------------------------ Data binding */
function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function applyBindings(metrics) {
  $$("[data-bind]").forEach((el) => {
    const v = getPath(metrics, el.dataset.bind);
    if (v === undefined) return;
    const f = fmt[el.dataset.fmt];
    el.textContent = f ? f(v) : String(v);
  });
}

/* ------------------------------------------------------------ Overview */
function renderOverview() {
  const tagt = state.models.find((x) => x.isTagt);
  const base = state.models.find((x) => x.isBaseline);
  if (tagt) $("#tileTagtAuc").textContent = fmt.auc(tagt.m.auc);
  $("#tileTagtSub").textContent = base
    ? `Unseen patients, 5-fold CV · clinical baseline ${fmt.auc(base.m.auc)}`
    : "Unseen patients, 5-fold CV";
}

/* ------------------------------------------------------------ Results */
function renderResults() {
  const { metrics } = state.info;
  const models = state.models;
  $("#resultsMeta").textContent =
    `${metrics.protocol}. ${fmt.int(metrics.dataset.n_samples)} visit pairs from ${fmt.int(metrics.dataset.n_patients)} patients. Trained ${metrics.trained_at}.`;

  // Key findings, generated from the numbers.
  const tagt = models.find((x) => x.isTagt);
  const best = models[0];
  const items = [];
  if (best && tagt) {
    if (best.isTagt) {
      items.push(`TAGT has the highest AUC of all models (${fmt.auc(tagt.m.auc)}).`);
    } else {
      const who = best.isBaseline ? "The clinical-only baseline" : best.name;
      items.push(`${who} has the highest AUC (${fmt.auc(best.m.auc)}), above TAGT (${fmt.auc(tagt.m.auc)}). The two clinical inputs alone carry more signal than any model extracts from the gene probes.`);
    }
    const geneModels = models.filter((x) => x.usesGenes);
    const rank = geneModels.indexOf(tagt) + 1;
    const others = geneModels.filter((x) => !x.isTagt).map((x) => `${fmt.auc(x.m.auc)} for ${x.short}`).join(" and ");
    items.push(rank === 1
      ? `Among the models that use the ${fmt.int(metrics.dataset.n_genes)} gene probes, TAGT ranks first (AUC ${fmt.auc(tagt.m.auc)} vs ${others}).`
      : `Among the models that use the ${fmt.int(metrics.dataset.n_genes)} gene probes, TAGT ranks ${rank} of ${geneModels.length} (AUC ${fmt.auc(tagt.m.auc)}; others: ${others}).`);
    const f = tagt.m.fold_aucs;
    items.push(`Fold-to-fold variance is large: TAGT's five fold AUCs range from ${fmt.auc(Math.min(...f))} to ${fmt.auc(Math.max(...f))} (SD ${fmt.auc(tagt.m.auc_fold_std)}), because each test fold holds only about ${fmt.fold(metrics.dataset.n_patients)} of the ${fmt.int(metrics.dataset.n_patients)} patients.`);
  }
  items.push("All scores are measured on unseen patients: every visit was scored by a model trained without any visit from that patient.");
  $("#findings").innerHTML = items.map((t) => `<li>${esc(t)}</li>`).join("");

  // ROC: TAGT and the two logistic regressions.
  const rocModels = models.filter((x) => x.isTagt || x.isBaseline || (/logistic/i.test(x.name) && x.usesGenes));
  rocModels.sort((a, b) => (a.isTagt ? -1 : b.isTagt ? 1 : b.m.auc - a.m.auc));
  $("#rocLegend").innerHTML = rocModels.map((x) =>
    `<li><span class="swatch-line" style="background:${x.color}"></span>${esc(x.short)} <span class="val-muted">AUC ${fmt.auc(x.m.auc)}</span></li>`).join("") +
    `<li><span class="swatch-line" style="background:repeating-linear-gradient(90deg,var(--ink-2) 0 4px,transparent 4px 7px)"></span>Chance</li>`;
  rocChart($("#rocChart"),
    rocModels.map((x) => ({ name: x.short, color: x.color, auc: x.m.auc, fpr: x.m.roc.fpr, tpr: x.m.roc.tpr })),
    `ROC curves: ${rocModels.map((x) => `${x.short} AUC ${fmt.auc(x.m.auc)}`).join("; ")}.`);
  const fprs = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
  $("#rocTable").innerHTML = `<table><caption class="sr-only">True-positive rate at selected false-positive rates, interpolated from each ROC curve</caption>
    <thead><tr><th scope="col">False-positive rate</th>${rocModels.map((x) => `<th scope="col">${esc(x.short)}</th>`).join("")}</tr></thead>
    <tbody>${fprs.map((f) => `<tr><th scope="row">${f.toFixed(1)}</th>${rocModels.map((x) => `<td>${tprAt(x.m.roc.fpr, x.m.roc.tpr, f).toFixed(2)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

  // AUC bars (all models, sorted by AUC).
  aucBars($("#aucChart"), models.map((x) => ({
    name: x.short, color: x.color, auc: x.m.auc, mean: x.m.auc_fold_mean, sd: x.m.auc_fold_std, folds: x.m.fold_aucs,
  })));
  const nf = Math.max(...models.map((x) => x.m.fold_aucs.length));
  $("#foldTable").innerHTML = `<table><thead><tr><th scope="col">Model</th>${Array.from({ length: nf }, (_, i) => `<th scope="col">Fold ${i + 1}</th>`).join("")}<th scope="col">Mean ± SD</th></tr></thead>
    <tbody>${models.map((x) => `<tr><th scope="row"><span class="model-cell"><span class="swatch" style="background:${x.color}"></span>${esc(x.short)}</span></th>${x.m.fold_aucs.map((a) => `<td>${fmt.auc(a)}</td>`).join("")}<td>${fmt.auc(x.m.auc_fold_mean)} ± ${fmt.auc(x.m.auc_fold_std)}</td></tr>`).join("")}</tbody></table>`;

  // Metrics table.
  $("#metricsTable").innerHTML = `<table>
    <caption class="sr-only">Cross-validated metrics for every model, sorted by AUC</caption>
    <thead><tr><th scope="col">Model</th><th scope="col">AUC-ROC</th><th scope="col">Fold AUC (mean ± SD)</th><th scope="col">Accuracy</th><th scope="col">Sensitivity</th><th scope="col">Specificity</th><th scope="col">F1</th><th scope="col">Threshold</th></tr></thead>
    <tbody>${models.map((x) => `<tr>
      <th scope="row"><span class="model-cell"><span class="swatch" style="background:${x.color}"></span>${esc(x.name.replace(/\s*\(ours\)/i, ""))}${x.isTagt ? ' <span class="tag">ours</span>' : ""}</span></th>
      <td>${fmt.auc(x.m.auc)}</td><td>${fmt.auc(x.m.auc_fold_mean)} ± ${fmt.auc(x.m.auc_fold_std)}</td>
      <td>${fmt.pct(x.m.accuracy)}</td><td>${fmt.pct(x.m.sensitivity)}</td><td>${fmt.pct(x.m.specificity)}</td>
      <td>${fmt.auc(x.m.f1)}</td><td>${fmt.auc(x.m.threshold)}</td></tr>`).join("")}</tbody></table>`;

  // Confusion matrices: TAGT and the clinical baseline.
  const cmModels = [models.find((x) => x.isTagt), models.find((x) => x.isBaseline)].filter(Boolean);
  $("#confusionGrid").innerHTML = cmModels.map(confusionCard).join("");
}

function confusionCard(x) {
  const c = x.m.confusion;
  const negs = c.tn + c.fp, poss = c.fn + c.tp;
  const lvl = (share) => (share >= 0.75 ? 4 : share >= 0.5 ? 3 : share >= 0.25 ? 2 : 1);
  const cell = (n, total, lab) => {
    const share = total ? n / total : 0;
    return `<div class="cm-cell cm-l${lvl(share)}" role="cell"><span class="n">${fmt.int(n)}</span><span class="lab">${lab}</span><span class="share">${fmt.pct(share)} of row</span></div>`;
  };
  const id = `cm-${x.isTagt ? "tagt" : "base"}`;
  return `<article class="card cm-card" aria-labelledby="${id}">
    <h2 id="${id}" class="model-cell"><span class="swatch" style="background:${x.color}"></span>Confusion matrix: ${esc(x.short)}</h2>
    <p class="sub">Out-of-fold predictions at threshold ${fmt.auc(x.m.threshold)}. Rows: actual outcome. Columns: predicted.</p>
    <div class="cm" role="table" aria-label="Confusion matrix for ${esc(x.short)}">
      <div role="row" style="display:contents">
        <div class="cm-corner" role="columnheader"><span class="sr-only">Actual \\ Predicted</span></div>
        <div class="cm-colhead" role="columnheader">Predicted: no flare</div>
        <div class="cm-colhead" role="columnheader">Predicted: flare</div>
      </div>
      <div role="row" style="display:contents">
        <div class="cm-rowhead" role="rowheader">Actual: no flare<br>(${fmt.int(negs)})</div>
        ${cell(c.tn, negs, "True negative")}${cell(c.fp, negs, "False positive")}
      </div>
      <div role="row" style="display:contents">
        <div class="cm-rowhead" role="rowheader">Actual: flare<br>(${fmt.int(poss)})</div>
        ${cell(c.fn, poss, "False negative")}${cell(c.tp, poss, "True positive")}
      </div>
    </div>
    <p class="cm-stats"><span>Sensitivity <b>${fmt.pct(x.m.sensitivity)}</b></span><span>Specificity <b>${fmt.pct(x.m.specificity)}</b></span><span>Accuracy <b>${fmt.pct(x.m.accuracy)}</b></span></p>
  </article>`;
}

/* ------------------------------------------------------------ Team */
function renderTeam() {
  const p = state.info.project;
  $("#projectTitle").textContent = p.title;
  $("#projectType").textContent = p.type.toLowerCase();
  $("#teamGrid").innerHTML = p.team.map((m) => {
    const initials = m.name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
    return `<li class="card member"><span class="avatar" aria-hidden="true">${esc(initials)}</span>
      <div><h2>${esc(m.name)}</h2><p>Enrollment No.</p><p class="enr">${esc(m.enrollment)}</p></div></li>`;
  }).join("");
  $("#logos").innerHTML = LOGOS.map((l) => `<img src="${esc(l.src)}" alt="${esc(l.alt)}" width="160" height="64">`).join("");
}

/* ------------------------------------------------------------ Predict: dataset mode */
const sampleLabel = (r) => `${r.patient_id} · visit ${r.visit_from}→${r.visit_to} · SLEDAI ${fmt.sledai(r.current_sledai)}`;

function fillSelect(keepIndex) {
  const sel = $("#visitSelect");
  const q = $("#visitSearch").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  state.filtered = state.samples.filter((r) => {
    const hay = `${sampleLabel(r)} #${r.index}`.toLowerCase();
    return q.every((t) => hay.includes(t));
  });
  if (!state.filtered.length) {
    sel.innerHTML = `<option value="" disabled selected>No matching visits</option>`;
  } else {
    sel.innerHTML = state.filtered.map((r) => `<option value="${r.index}">${esc(sampleLabel(r))}</option>`).join("");
    const keep = state.filtered.some((r) => r.index === keepIndex) ? keepIndex : state.filtered[0].index;
    sel.value = String(keep);
    $("#visitIndex").value = String(keep);
  }
  $("#visitCount").textContent = q.length
    ? `${fmt.int(state.filtered.length)} of ${fmt.int(state.samples.length)} visits match`
    : `${fmt.int(state.samples.length)} visits`;
}

function initDataset() {
  const max = state.samples.length - 1;
  $("#visitIndex").max = String(max);
  $("#visitIndexHint").textContent = `0–${max}. Typing an index selects that visit. The true outcome stays hidden until you run a prediction.`;
  $("#visitSearch").addEventListener("input", () => fillSelect(Number($("#visitIndex").value)));
  $("#visitSelect").addEventListener("change", (e) => { $("#visitIndex").value = e.target.value; });
  $("#visitIndex").addEventListener("input", (e) => {
    const n = Number(e.target.value);
    if (Number.isInteger(n) && n >= 0 && n <= max) {
      if (!state.filtered.some((r) => r.index === n)) { $("#visitSearch").value = ""; fillSelect(n); }
      $("#visitSelect").value = String(n);
    }
  });
  $("#randomBtn").addEventListener("click", () => {
    const n = Math.floor(Math.random() * state.samples.length);
    $("#visitSearch").value = "";
    fillSelect(n);
    $("#visitSelect").focus();
  });
  fillSelect(5);
}

/* ------------------------------------------------------------ Predict: custom mode */
function initCustom() {
  const range = $("#sledaiRange"), num = $("#sledaiNum");
  range.addEventListener("input", () => { num.value = range.value; });
  num.addEventListener("input", () => {
    const v = Number(num.value);
    if (num.value !== "" && Number.isFinite(v)) range.value = String(Math.max(0, Math.min(45, v)));
  });
  $("#csvFile").addEventListener("change", onCsvChosen);
  $("#csvClear").addEventListener("click", () => {
    state.csv = null;
    $("#csvFile").value = "";
    $("#csvStatus").textContent = "";
    $("#csvStatus").classList.remove("ok");
    $("#csvClear").hidden = true;
    $("#csvFile").focus();
  });
}

/** Parse `probe_id,expression` text: comma, semicolon or tab separated; quoted IDs allowed. */
export function parseExpressionCsv(text) {
  const values = {};
  let skipped = 0;
  const lines = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  let first = true;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const delim = line.includes("\t") ? "\t" : line.includes(";") ? ";" : ",";
    const cells = line.split(delim).map((c) => c.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1").trim());
    let [id, val] = cells;
    if (delim === ";" && val) val = val.replace(",", ".");
    const num = val === undefined || val === "" ? NaN : Number(val);
    if (first) {
      first = false;
      if (!Number.isFinite(num)) continue; // header row
    }
    if (!id || !Number.isFinite(num)) { skipped++; continue; }
    values[id] = num;
  }
  return { values, count: Object.keys(values).length, skipped };
}

function onCsvChosen(e) {
  const file = e.target.files && e.target.files[0];
  const status = $("#csvStatus");
  status.classList.remove("ok");
  state.csv = null;
  if (!file) { status.textContent = ""; $("#csvClear").hidden = true; return; }
  if (file.size > 5 * 1024 * 1024) {
    status.textContent = "That file is larger than 5 MB. Expected about 1,000 rows of probe_id,expression.";
    $("#csvClear").hidden = false;
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const parsed = parseExpressionCsv(String(reader.result));
    if (!parsed.count) {
      status.textContent = `No probe values found in ${file.name} (${fmt.int(parsed.skipped)} rows skipped). Expected two columns: probe_id,expression.`;
    } else {
      state.csv = { ...parsed, name: file.name };
      status.textContent = `Loaded ${fmt.int(parsed.count)} probes, ${fmt.int(parsed.skipped)} rows skipped.`;
      status.classList.add("ok");
    }
    $("#csvClear").hidden = false;
  };
  reader.onerror = () => { status.textContent = "Could not read that file."; $("#csvClear").hidden = false; };
  reader.readAsText(file);
}

/* ------------------------------------------------------------ Predict: submit */
function currentMode() { return $("#modeCustom").checked ? "custom" : "dataset"; }

function showError(msg) {
  const box = $("#formError");
  box.innerHTML = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.2v.3"/></svg><span>${esc(msg)}</span>`;
  box.hidden = false;
}
function clearError() { $("#formError").hidden = true; $("#formError").textContent = ""; }

function setBusy(on) {
  state.busy = on;
  const btn = $("#predictBtn");
  btn.disabled = on;
  btn.classList.toggle("is-busy", on);
  btn.querySelector(".btn-label").textContent = on ? "Predicting…" : "Predict";
  $("#resultCard").setAttribute("aria-busy", on ? "true" : "false");
  $("#resultBody").style.opacity = on ? "0.55" : "";
}

async function onPredict(e) {
  e.preventDefault();
  if (state.busy) return;
  clearError();
  let body;
  if (currentMode() === "dataset") {
    const raw = $("#visitIndex").value.trim();
    if (raw === "") { showError("Choose a visit, or type a visit index."); return; }
    const n = Number(raw);
    if (!Number.isInteger(n)) { showError("The visit index must be a whole number."); return; }
    body = { sample_index: n };
  } else {
    const raw = $("#sledaiNum").value.trim();
    if (raw === "" || !Number.isFinite(Number(raw))) { showError("Enter a SLEDAI-2K score (a number from 0 to 105)."); return; }
    body = { current_sledai: Number(raw), current_flare: $("#flareNow").checked ? 1 : 0 };
    if (state.csv) body.expression = state.csv.values;
  }
  setBusy(true);
  try {
    const res = await api("/api/predict", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    renderPrediction(res);
    renderExplanation(res);
    $("#liveStatus").textContent =
      `Prediction ready. TAGT flare risk score ${fmt.pct(res.tagt.probability)}, ${res.tagt.risk}. Clinical baseline ${fmt.pct(res.baseline.probability)}, ${res.baseline.risk}.` +
      ("actual_next_flare" in res ? ` Actual outcome: ${res.actual_next_flare ? "flare" : "no flare"}.` : "");
  } catch (err) {
    showError(err.message);
  } finally {
    setBusy(false);
  }
}

const BAND = {
  High: { cls: "band-high", icon: '<path class="fill-shape" d="M12 2.5 22.5 21h-21Z"/><path class="glyph" d="M12 9.5v5M12 17.6v.2"/>' },
  Moderate: { cls: "band-mod", icon: '<path class="fill-shape" d="M12 2 22 12 12 22 2 12Z"/><path class="glyph" d="M8 12h8"/>' },
  Low: { cls: "band-low", icon: '<circle class="fill-shape" cx="12" cy="12" r="10"/><path class="glyph" d="m7.5 12.2 3 3 6-6.2"/>' },
};
function badge(risk) {
  const b = BAND[risk] || BAND.Low;
  return `<span class="badge ${b.cls}"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${b.icon}</svg>${esc(risk)} risk</span>`;
}

function scorePanel(title, color, tagHtml, r) {
  const p = r.probability, thr = r.threshold;
  const band = (BAND[r.risk] || BAND.Low).cls;
  const pctVal = (p * 100).toFixed(1);
  const thrPct = Math.max(0, Math.min(100, thr * 100));
  const modPct = Math.max(0, thrPct - 10);
  const labelPos = Math.max(16, Math.min(84, thrPct));
  return `<section class="score-panel" aria-label="${esc(title)}">
    <h3><span class="swatch" style="background:${color}"></span>${esc(title)}${tagHtml}</h3>
    <p class="score-label">Flare risk score</p>
    <p class="score-value">${pctVal}<span class="unit">%</span></p>
    ${badge(r.risk)}
    <div class="meter" role="img" aria-label="Risk score ${pctVal}% on a 0 to 100% scale. Decision threshold ${thrPct.toFixed(1)}%; Moderate band starts at ${modPct.toFixed(1)}%.">
      <div class="meter-track">
        <div class="meter-fill ${band}" style="width:${Math.max(0, Math.min(100, p * 100))}%"></div>
        <span class="meter-tick minor" style="left:${modPct}%"></span>
        <span class="meter-tick" style="left:${thrPct}%"></span>
      </div>
      <div class="meter-scale" aria-hidden="true"><span style="left:${labelPos}%">Threshold ${thrPct.toFixed(1)}%</span></div>
    </div>
    <p class="verdict"><strong>${r.predicted_flare ? "Flare likely" : "Flare unlikely"}</strong> at the next visit: the score is ${r.predicted_flare ? "at or above" : "below"} the decision threshold.</p>
  </section>`;
}

function renderPrediction(res) {
  const inputs = res.inputs || {};
  const clin = `SLEDAI-2K ${fmt.sledai(inputs.current_sledai)} · ${inputs.current_flare ? "flaring now" : "not flaring now"}`;
  let extra = "";
  if ("matched_probes" in res && state.csv && currentMode() === "custom") {
    extra = `<p class="fine">${fmt.int(res.matched_probes)} of the ${fmt.int(state.csv.count)} probes in ${esc(state.csv.name)} matched the model's probe list.</p>`;
  }
  let outcome = "";
  if ("actual_next_flare" in res) {
    const actual = res.actual_next_flare === 1;
    const chk = (label, predicted) => {
      const ok = predicted === actual;
      return `<span class="check ${ok ? "ok" : "bad"}"><span class="mark" aria-hidden="true">${ok ? "✓" : "✗"}</span>${esc(label)}: ${ok ? "correct" : "incorrect"}</span>`;
    };
    outcome = `<div class="outcome">
      <div class="outcome-head">Actual outcome at the next visit: ${actual ? "Flare" : "No flare"}</div>
      <div class="outcome-checks">${chk("TAGT", res.tagt.predicted_flare)}${chk("Clinical baseline", res.baseline.predicted_flare)}</div>
    </div>
    <p class="fine">The deployed models were fitted on all dataset visits, so this check is in-sample. Performance on unseen patients is on the <a href="#results">Results</a> page.</p>`;
  }
  $("#resultBody").innerHTML = `
    <p class="source"><strong>Source:</strong> ${esc(res.source || "")} · ${esc(clin)}</p>
    <div class="score-pair">
      ${scorePanel("TAGT", "var(--s1)", ' <span class="tag">ours</span>', res.tagt)}
      ${scorePanel("Clinical baseline (LR)", "var(--s2)", "", res.baseline)}
    </div>
    <p class="fine">Scores rank risk; they are not calibrated probabilities. High = at or above the threshold; Moderate = up to 10 points below it; Low = further below.</p>
    ${extra}${outcome}`;
}

function renderExplanation(res) {
  const genes = res.top_genes || [];
  const body = $("#explainBody");
  const maxAbs = genes.reduce((mx, g) => Math.max(mx, Math.abs(g.contribution)), 0);
  if (!genes.length || maxAbs === 0) {
    body.innerHTML = `<div class="empty-attr"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.3"/></svg>
      <p>No gene-level attributions: all probes are at the cohort average, so the prediction uses only the clinical inputs.</p></div>`;
    return;
  }
  const caution = maxAbs < 1e-4
    ? `<p class="caution">Every contribution is tiny (largest ${fmtContrib(maxAbs)}): the uploaded values sit at, or very near, the cohort average, so these bars mostly reflect rounding rather than signal.</p>`
    : "";
  body.innerHTML = `${caution}
    <ul class="legend"><li><span class="swatch" style="background:var(--raise)"></span>Raises risk (bar to the right)</li><li><span class="swatch" style="background:var(--lower)"></span>Lowers risk (bar to the left)</li></ul>
    <div class="chart" id="explainChart"></div>
    <details><summary>Show as table</summary><div class="table-wrap"><table>
      <caption class="sr-only">Top 10 probe attributions for this TAGT score</caption>
      <thead><tr><th scope="col">Probe</th><th scope="col">Effect</th><th scope="col">Contribution</th><th scope="col">Expression (log2)</th><th scope="col">z-score</th></tr></thead>
      <tbody>${genes.map((g) => `<tr><th scope="row" class="mono">${esc(g.probe)}</th><td>${g.contribution > 0 ? "Raises risk" : g.contribution < 0 ? "Lowers risk" : "None"}</td><td>${fmtContrib(g.contribution)}</td><td>${g.expression.toFixed(2)}</td><td>${g.z_score.toFixed(2)}</td></tr>`).join("")}</tbody>
    </table></div></details>`;
  divergingBars($("#explainChart"), genes);
}

function initPredict() {
  $$('input[name="mode"]').forEach((r) => r.addEventListener("change", () => {
    const custom = currentMode() === "custom";
    $("#paneDataset").hidden = custom;
    $("#paneCustom").hidden = !custom;
    clearError();
  }));
  $("#predictForm").addEventListener("submit", onPredict);
  initCustom();
}

/* ------------------------------------------------------------ Boot */
function showApiBanner(msg) {
  const b = $("#apiBanner");
  b.textContent = msg;
  b.hidden = false;
}

async function boot() {
  initTheme();
  $("#skipLink").addEventListener("click", (e) => { e.preventDefault(); $("#main").focus(); });
  window.addEventListener("hashchange", route);
  route();
  initPredict();

  try {
    const [info, samples] = await Promise.all([api("/api/info"), api("/api/samples")]);
    state.info = info;
    state.samples = samples;
    state.models = describeModels(info.metrics);
    applyBindings(info.metrics);
    renderOverview();
    renderResults();
    renderTeam();
    initDataset();
  } catch (err) {
    showApiBanner(`The API is unavailable: ${err.message}`);
    $("#visitSelect").innerHTML = "<option>Unavailable</option>";
  }
}

boot();
