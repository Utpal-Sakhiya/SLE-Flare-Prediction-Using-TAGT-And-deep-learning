/* TAGT Flare Predictor: application logic.
   Every number on the page comes from /api/info, /api/samples or /api/predict. */
import { esc, fmtSigned, tprAt, rocChart, aucChart, attributionChart } from "/static/js/charts.js";

/* Institution logos. The files were not in the repository when this UI was built.
   To show them: copy them into webapp/static/img/ and add entries like
   { src: "/static/img/ku-logo.jpeg", alt: "Karnavati University logo" }. */
const LOGOS = [];

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const fmt = {
  int: (n) => Number(n).toLocaleString("en-US"),
  pct: (p, d = 1) => `${(Number(p) * 100).toFixed(d)}%`,
  dec: (v, d = 3) => Number(v).toFixed(d),
  sec: (v) => `${Number(v).toFixed(1)} s`,
  sledai: (v) => (Number.isInteger(Number(v)) ? String(Number(v)) : Number(v).toFixed(1)),
};

const state = { info: null, models: [], samples: [], shown: [], csv: null, busy: false, nFolds: 5 };

/* ------------------------------------------------------------------ API */
async function api(path, init) {
  let res;
  try { res = await fetch(path, init); }
  catch { throw new Error("Cannot reach the server. Is `python webapp/app.py` running?"); }
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw new Error(body?.error || `Request failed (HTTP ${res.status}).`);
  return body;
}

/* ------------------------------------------------------------------ Theme */
const THEME_KEY = "tagt.theme";
const osDark = window.matchMedia("(prefers-color-scheme: dark)");
const currentTheme = () => document.documentElement.getAttribute("data-theme") || (osDark.matches ? "dark" : "light");
function labelThemeButton() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  $("#themeBtn").setAttribute("aria-label", `Use ${next} theme`);
  $("#themeBtn").title = `Use ${next} theme`;
}
function initTheme() {
  $("#themeBtn").addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage blocked */ }
    labelThemeButton();
  });
  osDark.addEventListener("change", labelThemeButton);
  labelThemeButton();
}

/* ------------------------------------------------------------------ Routing (#/predict) */
const PAGES = { overview: "Overview", predict: "Predict", results: "Results", methodology: "Methodology", team: "Team" };
let firstRoute = true;
function route() {
  let page = location.hash.replace(/^#\/?/, "");
  if (!(page in PAGES)) page = "overview";
  $$("[data-page]").forEach((s) => { s.hidden = s.dataset.page !== page; });
  $$("[data-route]").forEach((a) => {
    if (a.dataset.route === page) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  document.title = page === "overview" ? "TAGT Flare Predictor" : `${PAGES[page]} · TAGT Flare Predictor`;
  if (!firstRoute) {
    window.scrollTo(0, 0);
    $(`[data-page="${page}"] h1`)?.focus({ preventScroll: true });
  }
  firstRoute = false;
}

/* ------------------------------------------------------------------ Models: identity + colour */
function describeModels(metrics) {
  return Object.entries(metrics.models).map(([name, m]) => {
    const genes = /genes/i.test(name);
    let slot = 4, short = name;
    if (/^TAGT/i.test(name)) { slot = 1; short = "TAGT (ours)"; }
    else if (/logistic/i.test(name) && !genes) { slot = 2; short = "LR · clinical only"; }
    else if (/logistic/i.test(name)) { slot = 3; short = "LR · genes + clinical"; }
    else if (/forest/i.test(name)) { slot = 4; short = "RF · genes + clinical"; }
    return {
      name, short, m, color: `var(--s${slot})`, slot,
      tagt: slot === 1, baseline: slot === 2, usesGenes: slot === 1 || genes,
    };
  }).sort((a, b) => b.m.auc - a.m.auc);
}
const nameCell = (x) =>
  `<span class="who"><i class="sw" style="background:${x.color}"></i>${esc(x.tagt ? "TAGT" : x.name)}${x.tagt ? ' <span class="ours">ours</span>' : ""}</span>`;

/* ------------------------------------------------------------------ Bindings: data-k="dataset.n_patients" data-f="int" */
function bind(metrics) {
  const get = (path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), metrics);
  $$("[data-k]").forEach((node) => {
    const v = get(node.dataset.k);
    if (v === undefined) return;
    const f = node.dataset.f;
    node.textContent = f === "fold" ? String(Math.round(v / state.nFolds)) : fmt[f] ? fmt[f](v) : String(v);
  });
}

/* ------------------------------------------------------------------ Overview */
function renderOverview() {
  const tagt = state.models.find((x) => x.tagt);
  const base = state.models.find((x) => x.baseline);
  if (tagt) $("#statAuc").textContent = fmt.dec(tagt.m.auc);
  $("#statAucSub").textContent = base
    ? `unseen patients · clinical baseline ${fmt.dec(base.m.auc)}`
    : "unseen patients";
}

/* ------------------------------------------------------------------ Results */
function renderResults() {
  const { metrics } = state.info;
  const ds = metrics.dataset;
  const models = state.models;
  const tagt = models.find((x) => x.tagt);
  const base = models.find((x) => x.baseline);

  $("#resultsLede").textContent =
    `${metrics.protocol}. ${fmt.int(ds.n_samples)} visit pairs from ${fmt.int(ds.n_patients)} patients; trained ${metrics.trained_at}.`;

  // Key findings: generated from the numbers, so they stay true if the model is retrained.
  const out = [];
  const top = models[0];
  if (top && tagt) {
    if (top.tagt) out.push(`TAGT has the highest AUC-ROC of all models (${fmt.dec(tagt.m.auc)}).`);
    else if (top.baseline) out.push(`The clinical-only baseline is the strongest model: AUC-ROC ${fmt.dec(top.m.auc)} against ${fmt.dec(tagt.m.auc)} for TAGT. SLEDAI-2K and flaring-now alone carry more signal than any model extracts from the gene probes.`);
    else out.push(`${top.name} has the highest AUC-ROC (${fmt.dec(top.m.auc)}); TAGT scores ${fmt.dec(tagt.m.auc)}.`);

    const geneModels = models.filter((x) => x.usesGenes);
    const rank = geneModels.indexOf(tagt) + 1;
    const others = geneModels.filter((x) => !x.tagt).map((x) => `${fmt.dec(x.m.auc)} for ${x.short}`).join(", ");
    out.push(rank === 1
      ? `Among the models that use the ${fmt.int(ds.n_genes)} gene probes, TAGT ranks first (${fmt.dec(tagt.m.auc)}, vs ${others}).`
      : `Among the models that use the ${fmt.int(ds.n_genes)} gene probes, TAGT ranks ${rank} of ${geneModels.length} (${fmt.dec(tagt.m.auc)}; ${others}).`);

    const f = tagt.m.fold_aucs;
    out.push(`Fold-to-fold variance is large: TAGT's ${f.length} fold AUCs run from ${fmt.dec(Math.min(...f))} to ${fmt.dec(Math.max(...f))} (SD ${fmt.dec(tagt.m.auc_fold_std)}), because each test fold holds only about ${Math.round(ds.n_patients / f.length)} of the ${fmt.int(ds.n_patients)} patients.`);
  }
  out.push("Every score is measured on unseen patients: each visit was scored by a model trained without any visit from that patient.");
  $("#findings").innerHTML = out.map((t) => `<li>${esc(t)}</li>`).join("");

  // ROC: TAGT, clinical LR, genes + clinical LR (TAGT first so it draws on top).
  const roc = [tagt, base, models.find((x) => x.slot === 3)].filter(Boolean);
  $("#rocKey").innerHTML = roc.map((x) =>
    `<li><i class="sw-line" style="background:${x.color}"></i>${esc(x.short)} <span class="val">AUC ${fmt.dec(x.m.auc)}</span></li>`).join("") +
    `<li><i class="sw-dash"></i>Chance <span class="val">AUC 0.500</span></li>`;
  rocChart($("#roc"),
    roc.map((x) => ({ name: x.short, color: x.color, fpr: x.m.roc.fpr, tpr: x.m.roc.tpr })),
    `ROC curves on unseen patients. ${roc.map((x) => `${x.short}: AUC ${fmt.dec(x.m.auc)}`).join("; ")}.`);
  const grid = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
  $("#rocTable").innerHTML = `<table><caption class="sr">True-positive rate at fixed false-positive rates, interpolated from each ROC curve</caption>
    <thead><tr><th scope="col">False-positive rate</th>${roc.map((x) => `<th scope="col">${esc(x.short)}</th>`).join("")}</tr></thead>
    <tbody>${grid.map((v) => `<tr><th scope="row">${v.toFixed(1)}</th>${roc.map((x) => `<td>${tprAt(x.m.roc.fpr, x.m.roc.tpr, v).toFixed(2)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

  // AUC bars, all models, sorted by AUC.
  aucChart($("#auc"), models.map((x) => ({
    name: x.short, color: x.color, auc: x.m.auc, mean: x.m.auc_fold_mean, sd: x.m.auc_fold_std, folds: x.m.fold_aucs,
  })));
  const nf = Math.max(...models.map((x) => x.m.fold_aucs.length));
  $("#foldTable").innerHTML = `<table><caption class="sr">AUC-ROC of each model on each test fold</caption>
    <thead><tr><th scope="col">Model</th>${Array.from({ length: nf }, (_, i) => `<th scope="col">Fold ${i + 1}</th>`).join("")}<th scope="col">Mean ± SD</th></tr></thead>
    <tbody>${models.map((x) => `<tr><th scope="row">${nameCell(x)}</th>${x.m.fold_aucs.map((a) => `<td>${fmt.dec(a)}</td>`).join("")}<td>${fmt.dec(x.m.auc_fold_mean)} ± ${fmt.dec(x.m.auc_fold_std)}</td></tr>`).join("")}</tbody></table>`;

  // Full metrics table, sorted by AUC.
  $("#metrics").innerHTML = `<table><caption class="sr">Cross-validated metrics for every model, sorted by AUC-ROC</caption>
    <thead><tr><th scope="col">Model</th><th scope="col">AUC-ROC</th><th scope="col">Fold AUC mean ± SD</th><th scope="col">Accuracy</th><th scope="col">Sensitivity</th><th scope="col">Specificity</th><th scope="col">F1</th><th scope="col">Threshold</th></tr></thead>
    <tbody>${models.map((x) => `<tr><th scope="row">${nameCell(x)}</th>
      <td>${fmt.dec(x.m.auc)}</td><td>${fmt.dec(x.m.auc_fold_mean)} ± ${fmt.dec(x.m.auc_fold_std)}</td>
      <td>${fmt.pct(x.m.accuracy)}</td><td>${fmt.pct(x.m.sensitivity)}</td><td>${fmt.pct(x.m.specificity)}</td>
      <td>${fmt.dec(x.m.f1)}</td><td>${fmt.dec(x.m.threshold)}</td></tr>`).join("")}</tbody></table>`;

  // Confusion matrices: TAGT and the clinical baseline.
  $("#cms").innerHTML = [tagt, base].filter(Boolean).map(confusion).join("");
}

function confusion(x) {
  const c = x.m.confusion;
  const neg = c.tn + c.fp, pos = c.fn + c.tp;
  const cell = (n, of, label) => {
    const share = of ? n / of : 0;
    return `<div class="cm-c" role="cell" style="--a:${Math.round(8 + share * 62)}%">
      <span class="cm-n">${fmt.int(n)}</span><span class="cm-l">${label}</span><span class="cm-p">${fmt.pct(share)} of row</span></div>`;
  };
  const id = `cm-${x.slot}`;
  return `<article class="panel" aria-labelledby="${id}">
    <h2 id="${id}" class="who"><i class="sw" style="background:${x.color}"></i>Confusion matrix · ${esc(x.short)}</h2>
    <p class="sub">Out-of-fold predictions at threshold ${fmt.dec(x.m.threshold)}. Rows: actual outcome; columns: prediction. Shading follows the row share.</p>
    <div class="cm" role="table" aria-label="Confusion matrix, ${esc(x.short)}">
      <div role="row" style="display:contents"><span role="columnheader"></span><span class="cm-h" role="columnheader">Predicted no flare</span><span class="cm-h" role="columnheader">Predicted flare</span></div>
      <div role="row" style="display:contents"><span class="cm-rh" role="rowheader">Actual no flare<br>(${fmt.int(neg)})</span>${cell(c.tn, neg, "True negative")}${cell(c.fp, neg, "False positive")}</div>
      <div role="row" style="display:contents"><span class="cm-rh" role="rowheader">Actual flare<br>(${fmt.int(pos)})</span>${cell(c.fn, pos, "False negative")}${cell(c.tp, pos, "True positive")}</div>
    </div>
    <p class="cm-foot"><span>Sensitivity <b>${fmt.pct(x.m.sensitivity)}</b></span><span>Specificity <b>${fmt.pct(x.m.specificity)}</b></span><span>Accuracy <b>${fmt.pct(x.m.accuracy)}</b></span></p>
  </article>`;
}

/* ------------------------------------------------------------------ Team */
function renderTeam() {
  const p = state.info.project;
  $("#projTitle").textContent = p.title;
  $("#projType").textContent = p.type.toLowerCase();
  $("#people").innerHTML = p.team.map((m) => {
    const initials = m.name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
    return `<li class="panel person"><span class="avatar" aria-hidden="true">${esc(initials)}</span>
      <div><h2>${esc(m.name)}</h2><p>Enrollment No.</p><p class="enr">${esc(m.enrollment)}</p></div></li>`;
  }).join("");
  $("#logos").innerHTML = LOGOS.map((l) => `<img src="${esc(l.src)}" alt="${esc(l.alt)}" height="72">`).join("");
}

/* ------------------------------------------------------------------ Predict: dataset visits */
const visitLabel = (r) => `${r.patient_id} · visit ${r.visit_from}→${r.visit_to} · SLEDAI ${fmt.sledai(r.current_sledai)}`;

function filterVisits(keep) {
  const terms = $("#q").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  state.shown = state.samples.filter((r) => {
    const hay = `${visitLabel(r)} visit ${r.visit_from} #${r.index}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  const sel = $("#visit");
  if (!state.shown.length) {
    sel.innerHTML = '<option value="">No matching visits</option>';
  } else {
    // Note: the option text never includes next_flare; the true outcome stays hidden until predicted.
    sel.innerHTML = state.shown.map((r) => `<option value="${r.index}">${esc(visitLabel(r))}</option>`).join("");
    sel.value = String(state.shown.some((r) => r.index === keep) ? keep : state.shown[0].index);
    $("#idx").value = sel.value;
  }
  $("#qCount").textContent = terms.length
    ? `${fmt.int(state.shown.length)} of ${fmt.int(state.samples.length)} visits match`
    : `${fmt.int(state.samples.length)} visits`;
}

function initDataset() {
  const max = state.samples.length - 1;
  $("#idx").max = String(max);
  $("#idxHelp").textContent = `0–${max}. Typing an index selects that visit. The true outcome stays hidden until you run a prediction.`;
  $("#q").addEventListener("input", () => filterVisits(Number($("#visit").value)));
  $("#visit").addEventListener("change", (e) => { $("#idx").value = e.target.value; });
  $("#idx").addEventListener("input", (e) => {
    const n = Number(e.target.value);
    if (e.target.value === "" || !Number.isInteger(n) || n < 0 || n > max) return; // the server reports bad indices
    if (!state.shown.some((r) => r.index === n)) { $("#q").value = ""; filterVisits(n); }
    $("#visit").value = String(n);
  });
  $("#randomBtn").addEventListener("click", () => {
    const pick = state.samples[Math.floor(Math.random() * state.samples.length)];
    $("#q").value = "";
    filterVisits(pick.index);
    $("#visit").focus();
  });
  filterVisits(state.samples[0]?.index);
}

/* ------------------------------------------------------------------ Predict: custom patient */
/** Parse "probe_id,expression" text. Comma, semicolon or tab separated; quoted IDs allowed;
    a non-numeric first row is treated as a header. Returns { values, count, skipped }. */
export function parseExpressionCsv(text) {
  const values = {};
  let skipped = 0, first = true;
  const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  for (const raw of text.replace(/^﻿/, "").split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const delim = line.includes("\t") ? "\t" : line.includes(";") ? ";" : ",";
    const [id, rawVal] = line.split(delim).map(unquote);
    // With semicolons, a decimal comma ("7,12") is common; accept it.
    const val = delim === ";" && rawVal ? rawVal.replace(",", ".") : rawVal;
    const num = val === undefined || val === "" ? NaN : Number(val);
    if (first) { first = false; if (!Number.isFinite(num)) continue; }
    if (!id || !Number.isFinite(num)) { skipped++; continue; }
    values[id] = num;
  }
  return { values, count: Object.keys(values).length, skipped };
}

function setCsvMessage(text, ok) {
  const msg = $("#csvMsg");
  msg.textContent = text;
  msg.classList.toggle("ok", !!ok);
  $("#csvClear").hidden = !text;
}

function initCustom() {
  const range = $("#sledaiRange"), num = $("#sledai");
  range.addEventListener("input", () => { num.value = range.value; });
  num.addEventListener("input", () => {
    const v = Number(num.value);
    if (num.value !== "" && Number.isFinite(v)) range.value = String(clamp(v, 0, 45));
  });
  $("#csv").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    state.csv = null;
    if (!file) { setCsvMessage(""); return; }
    if (file.size > 5 * 1024 * 1024) { setCsvMessage("That file is over 5 MB; expected about 1,000 rows of probe_id,expression."); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseExpressionCsv(String(reader.result));
      if (!parsed.count) {
        setCsvMessage(`No probe values found in ${file.name} (${fmt.int(parsed.skipped)} rows skipped). Expected two columns: probe_id,expression.`);
      } else {
        state.csv = { ...parsed, name: file.name };
        setCsvMessage(`Loaded ${fmt.int(parsed.count)} probes, ${fmt.int(parsed.skipped)} rows skipped.`, true);
      }
    };
    reader.onerror = () => setCsvMessage("Could not read that file.");
    reader.readAsText(file);
  });
  $("#csvClear").addEventListener("click", () => {
    state.csv = null;
    $("#csv").value = "";
    setCsvMessage("");
    $("#csv").focus();
  });
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ------------------------------------------------------------------ Predict: submit + render */
const mode = () => $('input[name="mode"]:checked').value;

function showError(text) {
  const box = $("#err");
  box.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.2"/><path d="M12 7.4v6M12 16.6v.2"/></svg><span>${esc(text)}</span>`;
  box.hidden = false;
}
function clearError() { $("#err").hidden = true; $("#err").textContent = ""; }

function setBusy(on) {
  state.busy = on;
  const go = $("#go");
  go.disabled = on;
  go.classList.toggle("busy", on);
  $(".go-text", go).textContent = on ? "Predicting…" : "Predict";
  $("#result").classList.toggle("busy", on);
  $(".explain").classList.toggle("busy", on);
  $("#result").setAttribute("aria-busy", String(on));
}

async function onSubmit(e) {
  e.preventDefault();
  if (state.busy) return;
  clearError();
  let body;
  if (mode() === "dataset") {
    const raw = $("#idx").value.trim();
    if (raw === "") { showError("Choose a visit, or type a visit index."); $("#idx").focus(); return; }
    if (!Number.isInteger(Number(raw))) { showError("The visit index must be a whole number."); $("#idx").focus(); return; }
    body = { sample_index: Number(raw) };
  } else {
    const raw = $("#sledai").value.trim();
    if (raw === "" || !Number.isFinite(Number(raw))) { showError("Enter a SLEDAI-2K score (a number from 0 to 105)."); $("#sledai").focus(); return; }
    body = { current_sledai: Number(raw), current_flare: $("#flaring").checked ? 1 : 0 };
    if (state.csv) body.expression = state.csv.values;
  }
  setBusy(true);
  try {
    const res = await api("/api/predict", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    renderResult(res);
    renderExplanation(res);
  } catch (err) {
    showError(err.message);
  } finally {
    setBusy(false);
  }
}

const BANDS = {
  High: { cls: "band-high", icon: '<path class="shape" d="M12 2.2 23 21.3H1Z"/><path class="glyph" d="M12 9.2v5.2M12 17.6v.1"/>' },
  Moderate: { cls: "band-mod", icon: '<path class="shape" d="M12 1.5 22.5 12 12 22.5 1.5 12Z"/><path class="glyph" d="M7.8 12h8.4"/>' },
  Low: { cls: "band-low", icon: '<circle class="shape" cx="12" cy="12" r="10.5"/><path class="glyph" d="m7.3 12.3 3.1 3.1 6.3-6.6"/>' },
};
const band = (risk) => BANDS[risk] || BANDS.Low;

function scoreCard(title, color, tag, r) {
  const b = band(r.risk);
  const pct = clamp(r.probability * 100, 0, 100);
  const thr = clamp(r.threshold * 100, 0, 100);
  const modStart = Math.max(0, thr - 10);
  const lblPos = clamp(thr, 18, 82);
  return `<section class="score" aria-label="${esc(title)} result">
    <h3><i class="sw" style="background:${color}"></i>${esc(title)}${tag}</h3>
    <p class="score-k">Flare risk score</p>
    <p class="score-v">${pct.toFixed(1)}<small>%</small></p>
    <span class="band ${b.cls}"><svg viewBox="0 0 24 24" aria-hidden="true">${b.icon}</svg>${esc(r.risk)} risk</span>
    <div class="meter" role="img" aria-label="Risk score ${pct.toFixed(1)}% on a 0 to 100% scale; decision threshold ${thr.toFixed(1)}%; the Moderate band starts at ${modStart.toFixed(1)}%.">
      <div class="meter-track">
        <div class="meter-fill ${b.cls}" style="width:${pct}%"></div>
        <span class="meter-mod" style="left:${modStart}%"></span>
        <span class="meter-thr" style="left:${thr}%"></span>
      </div>
      <div class="meter-lbl" aria-hidden="true"><span style="left:${lblPos}%">threshold ${thr.toFixed(1)}%</span></div>
    </div>
    <p class="verdict"><strong>${r.predicted_flare ? "Flare likely" : "Flare unlikely"}</strong> at the next visit (score ${r.predicted_flare ? "at or above" : "below"} the threshold).</p>
  </section>`;
}

function renderResult(res) {
  const inp = res.inputs || {};
  const clinical = `SLEDAI-2K ${fmt.sledai(inp.current_sledai)} · ${inp.current_flare ? "flaring now" : "not flaring now"}`;
  let truth = "";
  if ("actual_next_flare" in res) {
    const actual = res.actual_next_flare === 1;
    const check = (who, predicted) => {
      const ok = predicted === actual;
      return `<span><span class="mark ${ok ? "mark-ok" : "mark-bad"}" aria-hidden="true">${ok ? "✓" : "✗"}</span>${esc(who)}: ${ok ? "correct" : "incorrect"}</span>`;
    };
    truth = `<div class="truth">
      <p class="truth-h">True outcome at the next visit: ${actual ? "Flare" : "No flare"}</p>
      <p class="truth-row">${check("TAGT", res.tagt.predicted_flare)}${check("Clinical baseline", res.baseline.predicted_flare)}</p>
    </div>
    <p class="fine">The served models were fitted on every dataset visit, so this check is in-sample. Unseen-patient performance is on the <a href="#/results">Results</a> page.</p>`;
  }
  let matched = "";
  if ("matched_probes" in res && state.csv && mode() === "custom") {
    matched = `<p class="fine">${fmt.int(res.matched_probes)} of the ${fmt.int(state.csv.count)} probes in ${esc(state.csv.name)} matched the model's probe list.</p>`;
  }
  $("#resultBody").innerHTML = `
    <p class="src"><strong>Source:</strong> ${esc(res.source || "")} · ${esc(clinical)}</p>
    <div class="scores">
      ${scoreCard("TAGT", "var(--s1)", ' <span class="ours">ours</span>', res.tagt)}
      ${scoreCard("Clinical baseline (LR)", "var(--s2)", "", res.baseline)}
    </div>
    <p class="fine">Risk scores rank visits by risk; they are not calibrated probabilities. High: at or above the model's threshold. Moderate: up to 10 points below it. Low: further below.</p>
    ${matched}${truth}`;
}

function renderExplanation(res) {
  const genes = res.top_genes || [];
  const host = $("#explainBody");
  const maxAbs = genes.reduce((mx, d) => Math.max(mx, Math.abs(d.contribution)), 0);
  if (!genes.length || maxAbs === 0) {
    host.innerHTML = `<div class="no-attr"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.2"/><path d="M12 10.8v6M12 7.4v.2"/></svg>
      <p>No gene-level attributions: all probes are at the cohort average, so the prediction uses only the clinical inputs.</p></div>`;
    return;
  }
  const tiny = maxAbs < 1e-4
    ? `<p class="tiny-note">All contributions are tiny (largest ${fmtSigned(maxAbs)}): the uploaded values sit at or very near the cohort average, so these bars mostly reflect rounding, not signal.</p>`
    : "";
  host.innerHTML = `${tiny}
    <ul class="key"><li><i class="sw" style="background:var(--raise)"></i>Raises risk (bar right)</li><li><i class="sw" style="background:var(--lower)"></i>Lowers risk (bar left)</li></ul>
    <div class="chart" id="attr"></div>
    <details><summary>Contributions as a table</summary><div class="scroll-x"><table>
      <caption class="sr">Top 10 probe contributions to this TAGT risk score</caption>
      <thead><tr><th scope="col">Probe</th><th scope="col">Effect</th><th scope="col">Contribution</th><th scope="col">Expression (log2)</th><th scope="col">z-score</th></tr></thead>
      <tbody>${genes.map((d) => `<tr><th scope="row"><code>${esc(d.probe)}</code></th><td>${d.contribution > 0 ? "Raises risk" : d.contribution < 0 ? "Lowers risk" : "None"}</td><td>${fmtSigned(d.contribution)}</td><td>${d.expression.toFixed(2)}</td><td>${d.z_score.toFixed(2)}</td></tr>`).join("")}</tbody>
    </table></div></details>`;
  attributionChart($("#attr"), genes);
}

function initPredict() {
  $$('input[name="mode"]').forEach((r) => r.addEventListener("change", () => {
    const custom = mode() === "custom";
    $("#modeDataset").hidden = custom;
    $("#modeCustom").hidden = !custom;
    clearError();
  }));
  $("#form").addEventListener("submit", onSubmit);
  initCustom();
}

/* ------------------------------------------------------------------ Boot */
async function boot() {
  initTheme();
  $(".skip").addEventListener("click", (e) => { e.preventDefault(); $("#content").focus(); });
  window.addEventListener("hashchange", route);
  route();
  initPredict();
  try {
    const [info, samples] = await Promise.all([api("/api/info"), api("/api/samples")]);
    state.info = info;
    state.samples = samples;
    state.models = describeModels(info.metrics);
    state.nFolds = state.models[0]?.m.fold_aucs.length || 5;
    bind(info.metrics);
    renderOverview();
    renderResults();
    renderTeam();
    initDataset();
  } catch (err) {
    const box = $("#apiDown");
    box.textContent = `The prediction server is not responding: ${err.message}`;
    box.hidden = false;
    $("#visit").innerHTML = "<option value=\"\">Unavailable</option>";
  }
}

boot();
