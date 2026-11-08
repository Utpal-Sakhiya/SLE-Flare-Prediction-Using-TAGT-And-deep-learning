/* Hand-written SVG charts. No libraries; colours come from CSS custom properties,
   so a theme switch restyles every chart without redrawing. */

const SVG_NS = "http://www.w3.org/2000/svg";

export const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function el(tag, attrs = {}, ...children) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Signed contribution formatter: fixed for normal values, exponent for tiny ones. */
export function fmtSigned(v) {
  if (v === 0) return "0";
  const s = v > 0 ? "+" : "−";
  const a = Math.abs(v);
  return s + (a >= 0.001 ? a.toFixed(4) : a.toExponential(1).replace("-", "−"));
}

/** Tooltip living inside a position:relative host. */
function tooltip(host) {
  const t = document.createElement("div");
  t.className = "tip";
  t.hidden = true;
  t.setAttribute("aria-hidden", "true");
  host.append(t);
  return {
    show(html, x, y) {
      t.innerHTML = html;
      t.hidden = false;
      const W = host.clientWidth;
      let left = x + 14;
      if (left + t.offsetWidth > W) left = x - t.offsetWidth - 14;
      left = clamp(left, 0, Math.max(0, W - t.offsetWidth));
      let top = y - t.offsetHeight - 10;
      if (top < 0) top = y + 16;
      t.style.left = `${left}px`;
      t.style.top = `${top}px`;
    },
    hide() { t.hidden = true; },
  };
}

/** Call render(width) now and whenever the host's width changes (incl. hidden -> shown). */
function responsive(host, render) {
  let last = -1;
  const run = () => {
    const w = Math.floor(host.clientWidth);
    if (w > 0 && w !== last) { last = w; render(w); }
  };
  new ResizeObserver(run).observe(host);
  run();
}

function mountSvg(host, svg) {
  const old = host.querySelector(":scope > svg");
  if (old) old.replaceWith(svg); else host.prepend(svg);
}

const swatch = (color, line) => `<i class="${line ? "sw-line" : "sw"}" style="background:${color}"></i>`;

/** Linear interpolation of TPR at a given FPR on a step/ROC curve (max over ties). */
export function tprAt(fpr, tpr, x) {
  let v = 0;
  for (let i = 0; i < fpr.length - 1; i++) {
    const a = fpr[i], b = fpr[i + 1];
    if (x >= a && x <= b) v = Math.max(v, b === a ? Math.max(tpr[i], tpr[i + 1]) : tpr[i] + ((tpr[i + 1] - tpr[i]) * (x - a)) / (b - a));
  }
  if (x >= fpr[fpr.length - 1]) v = Math.max(v, tpr[tpr.length - 1]);
  return v;
}

/* ================================================================ ROC curves
   series: [{ name, color, fpr: [], tpr: [] }]  (first series is drawn on top) */
export function rocChart(host, series, summary) {
  const tip = tooltip(host);
  host.tabIndex = 0;
  host.setAttribute("role", "img");
  host.setAttribute("aria-label", `${summary} Press the left and right arrow keys to read values. A table version follows the chart.`);
  let g = null;      // geometry from the latest render
  let cur = null;    // current FPR under the crosshair

  function readout(x, at) {
    if (!g) return;
    if (x == null) {
      g.cross.setAttribute("visibility", "hidden");
      g.dots.forEach((d) => d.setAttribute("visibility", "hidden"));
      tip.hide();
      return;
    }
    cur = clamp(x, 0, 1);
    const px = g.X(cur);
    g.cross.setAttribute("x1", px);
    g.cross.setAttribute("x2", px);
    g.cross.setAttribute("visibility", "visible");
    let rows = "", topY = Infinity;
    series.forEach((s, i) => {
      const v = tprAt(s.fpr, s.tpr, cur);
      const py = g.Y(v);
      topY = Math.min(topY, py);
      g.dots[i].setAttribute("cx", px);
      g.dots[i].setAttribute("cy", py);
      g.dots[i].setAttribute("visibility", "visible");
      rows += `<div class="tip-r"><span>${swatch(s.color, true)}${esc(s.name)}</span><b>${v.toFixed(2)}</b></div>`;
    });
    const pos = at || { x: px, y: topY };
    tip.show(`<div class="tip-h">False-positive rate ${cur.toFixed(2)}</div><div class="tip-r"><span>True-positive rate</span></div>${rows}`, pos.x, pos.y);
  }

  responsive(host, (W) => {
    const size = Math.min(W, 540);
    const m = { l: 50, r: 12, t: 12, b: 46 };
    const pw = size - m.l - m.r;
    const H = pw + m.t + m.b;
    const X = (v) => m.l + v * pw;
    const Y = (v) => m.t + (1 - v) * pw;
    const svg = el("svg", { viewBox: `0 0 ${size} ${H}`, width: size, height: H, "aria-hidden": "true", focusable: "false" });

    for (let i = 0; i <= 5; i++) {
      const v = i / 5;
      svg.append(
        el("line", { x1: X(v), x2: X(v), y1: m.t, y2: m.t + pw, class: "grid" }),
        el("line", { x1: m.l, x2: m.l + pw, y1: Y(v), y2: Y(v), class: "grid" }),
        el("text", { x: X(v), y: m.t + pw + 17, "text-anchor": "middle" }, v.toFixed(1)),
        el("text", { x: m.l - 8, y: Y(v) + 4, "text-anchor": "end" }, v.toFixed(1)),
      );
    }
    svg.append(
      el("line", { x1: m.l, x2: m.l + pw, y1: m.t + pw, y2: m.t + pw, class: "axis" }),
      el("line", { x1: m.l, x2: m.l, y1: m.t, y2: m.t + pw, class: "axis" }),
      el("text", { x: m.l + pw / 2, y: H - 6, "text-anchor": "middle", class: "t-strong" }, "False-positive rate (1 − specificity)"),
      el("text", { x: 13, y: m.t + pw / 2, "text-anchor": "middle", class: "t-strong", transform: `rotate(-90 13 ${m.t + pw / 2})` }, "True-positive rate (sensitivity)"),
      el("line", { x1: X(0), y1: Y(0), x2: X(1), y2: Y(1), class: "chance" }),
    );
    const cl = { x: X(0.62) + 8, y: Y(0.62) + 14 };
    svg.append(el("text", { x: cl.x, y: cl.y, "text-anchor": "middle", transform: `rotate(-45 ${cl.x} ${cl.y})` }, "chance"));

    [...series].reverse().forEach((s) => {
      const pts = s.fpr.map((f, i) => `${X(f).toFixed(1)},${Y(s.tpr[i]).toFixed(1)}`).join(" ");
      svg.append(el("polyline", { points: pts, class: "curve", style: `stroke:${s.color}` }));
    });

    const cross = el("line", { y1: m.t, y2: m.t + pw, class: "cross", visibility: "hidden" });
    const dots = series.map((s) => el("circle", { r: 5, class: "hot", style: `fill:${s.color}`, visibility: "hidden" }));
    const pad = el("rect", { x: m.l, y: m.t, width: pw, height: pw, fill: "transparent" });
    pad.addEventListener("pointermove", (e) => {
      const r = host.getBoundingClientRect();
      const x = e.clientX - r.left;
      readout((x - m.l) / pw, { x, y: e.clientY - r.top });
    });
    pad.addEventListener("pointerleave", () => readout(null));
    svg.append(cross, ...dots, pad);
    mountSvg(host, svg);
    g = { X, Y, cross, dots };
    if (cur != null && document.activeElement === host) readout(cur);
  });

  host.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.01 : 0.05;
    let v = cur ?? 0;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") v += step;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") v -= step;
    else if (e.key === "Home") v = 0;
    else if (e.key === "End") v = 1;
    else if (e.key === "Escape") { readout(null); return; }
    else return;
    e.preventDefault();
    readout(Math.round(clamp(v, 0, 1) * 100) / 100);
  });
  host.addEventListener("focus", () => readout(cur ?? 0.2));
  host.addEventListener("blur", () => readout(null));
}

/* ================================================================ AUC bars
   rows: [{ name, color, auc, mean, sd, folds: [] }]  already sorted */
export function aucChart(host, rows) {
  const tip = tooltip(host);
  responsive(host, (W) => {
    const narrow = W < 460;
    const m = { l: 14, r: narrow ? 48 : 56, t: 26, b: 34 };
    const rowH = 56;
    const H = m.t + rows.length * rowH + m.b;
    const pw = W - m.l - m.r;
    const X = (v) => m.l + clamp(v, 0, 1) * pw;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "group", "aria-label": "AUC-ROC by model, sorted from highest to lowest" });

    [0, 0.25, 0.5, 0.75, 1].forEach((v) => {
      svg.append(
        el("line", { x1: X(v), x2: X(v), y1: m.t - 6, y2: H - m.b + 4, class: "grid" }),
        el("text", { x: X(v), y: H - m.b + 20, "text-anchor": "middle" }, String(v)),
      );
    });
    svg.append(el("text", { x: X(0.5) + 5, y: m.t - 10 }, "chance 0.5"));

    rows.forEach((r, i) => {
      const y0 = m.t + i * rowH;
      const by = y0 + 24;
      const bh = 16;
      const lo = r.mean - r.sd, hi = r.mean + r.sd;
      const label = `${r.name}: pooled AUC ${r.auc.toFixed(3)}; fold mean ${r.mean.toFixed(3)} ± ${r.sd.toFixed(3)}; folds ${r.folds.map((f) => f.toFixed(3)).join(", ")}`;
      const g = el("g", { class: "row", tabindex: "0", role: "img", "aria-label": label });
      const w = Math.max(0, X(r.auc) - X(0));
      const rad = Math.min(4, w);
      g.append(
        el("rect", { x: 0, y: y0 + 2, width: W, height: rowH - 4, rx: 8, class: "hit" }),
        el("text", { x: m.l, y: y0 + 16, class: "t-strong" }, r.name),
        el("path", { d: `M${X(0)},${by} H${X(0) + w - rad} Q${X(0) + w},${by} ${X(0) + w},${by + rad} V${by + bh - rad} Q${X(0) + w},${by + bh} ${X(0) + w - rad},${by + bh} H${X(0)} Z`, style: `fill:${r.color}` }),
        el("line", { x1: X(lo), x2: X(hi), y1: by + bh / 2, y2: by + bh / 2, class: "whisker" }),
        el("line", { x1: X(lo), x2: X(lo), y1: by + 3, y2: by + bh - 3, class: "whisker" }),
        el("line", { x1: X(hi), x2: X(hi), y1: by + 3, y2: by + bh - 3, class: "whisker" }),
        el("circle", { cx: X(r.mean), cy: by + bh / 2, r: 4.5, class: "hot", style: "fill:var(--ink)" }),
        el("text", { x: Math.max(X(r.auc), X(hi)) + 8, y: by + bh / 2 + 4.5, class: "t-strong" }, r.auc.toFixed(3)),
      );
      const html = `<div class="tip-h">${swatch(r.color)} ${esc(r.name)}</div>
        <div class="tip-r"><span>Pooled AUC</span><b>${r.auc.toFixed(3)}</b></div>
        <div class="tip-r"><span>Fold mean ± SD</span><b>${r.mean.toFixed(3)} ± ${r.sd.toFixed(3)}</b></div>
        <div class="tip-r"><span>Fold range</span><b>${Math.min(...r.folds).toFixed(3)}–${Math.max(...r.folds).toFixed(3)}</b></div>`;
      const show = (x, y) => tip.show(html, x, y);
      g.addEventListener("pointermove", (e) => { const b = host.getBoundingClientRect(); show(e.clientX - b.left, e.clientY - b.top); });
      g.addEventListener("pointerleave", () => tip.hide());
      g.addEventListener("focus", () => show(X(hi), by));
      g.addEventListener("blur", () => tip.hide());
      svg.append(g);
    });
    // Chance line on top of the bars so it stays visible.
    svg.append(el("line", { x1: X(0.5), x2: X(0.5), y1: m.t - 6, y2: H - m.b + 4, class: "chance" }));
    mountSvg(host, svg);
  });
}

/* ================================================================ Diverging attribution bars
   genes: [{ probe, contribution, expression, z_score }] sorted by |contribution| */
export function attributionChart(host, genes) {
  const tip = tooltip(host);
  responsive(host, (W) => {
    const narrow = W < 520;
    const lw = narrow ? 104 : 130;          // probe-label column
    const vw = narrow ? 64 : 76;            // room for value labels on each side
    const m = { t: 24, b: 6 };
    const rowH = 32;
    const H = m.t + genes.length * rowH + m.b;
    const half = Math.max(36, (W - lw - 2 * vw) / 2);
    const cx = lw + vw + half;
    const maxAbs = Math.max(...genes.map((d) => Math.abs(d.contribution)), 1e-12);
    const len = (v) => (Math.abs(v) / maxAbs) * half;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "group", "aria-label": "Top 10 probe contributions to this TAGT risk score. Bars right raise risk, bars left lower it." });

    svg.append(
      el("text", { x: cx - 8, y: 13, "text-anchor": "end", class: "t-strong" }, "← lowers risk"),
      el("text", { x: cx + 8, y: 13, class: "t-strong" }, "raises risk →"),
    );

    genes.forEach((d, i) => {
      const y0 = m.t + i * rowH;
      const bh = 18, by = y0 + (rowH - bh) / 2;
      const up = d.contribution >= 0;
      const L = d.contribution === 0 ? 0 : Math.max(len(d.contribution), 2);
      const x1 = up ? cx + L : cx - L;
      const rad = Math.min(4, L);
      const color = up ? "var(--raise)" : "var(--lower)";
      const path = up
        ? `M${cx},${by} H${x1 - rad} Q${x1},${by} ${x1},${by + rad} V${by + bh - rad} Q${x1},${by + bh} ${x1 - rad},${by + bh} H${cx} Z`
        : `M${cx},${by} H${x1 + rad} Q${x1},${by} ${x1},${by + rad} V${by + bh - rad} Q${x1},${by + bh} ${x1 + rad},${by + bh} H${cx} Z`;
      const effect = d.contribution > 0 ? "raises risk" : d.contribution < 0 ? "lowers risk" : "no effect";
      const g = el("g", {
        class: "row", tabindex: "0", role: "img",
        "aria-label": `${d.probe}: ${effect}, contribution ${fmtSigned(d.contribution)}, expression ${d.expression.toFixed(2)}, z-score ${d.z_score.toFixed(2)}`,
      });
      g.append(
        el("rect", { x: 0, y: y0 + 1, width: W, height: rowH - 2, rx: 6, class: "hit" }),
        el("text", { x: lw - 6, y: y0 + rowH / 2 + 4, "text-anchor": "end", class: "t-mono" }, d.probe),
        el("path", { d: path, style: `fill:${color}` }),
        el("text", { x: up ? x1 + 6 : x1 - 6, y: y0 + rowH / 2 + 4, "text-anchor": up ? "start" : "end" }, fmtSigned(d.contribution)),
      );
      const html = `<div class="tip-h" style="font-family:var(--mono)">${esc(d.probe)}</div>
        <div class="tip-r"><span>${swatch(color)}Contribution</span><b>${fmtSigned(d.contribution)}</b></div>
        <div class="tip-r"><span>Effect</span><b>${effect}</b></div>
        <div class="tip-r"><span>Expression (log2)</span><b>${d.expression.toFixed(2)}</b></div>
        <div class="tip-r"><span>z-score vs cohort</span><b>${d.z_score.toFixed(2)}</b></div>`;
      g.addEventListener("pointermove", (e) => { const b = host.getBoundingClientRect(); tip.show(html, e.clientX - b.left, e.clientY - b.top); });
      g.addEventListener("pointerleave", () => tip.hide());
      g.addEventListener("focus", () => tip.show(html, x1, y0));
      g.addEventListener("blur", () => tip.hide());
      svg.append(g);
    });
    svg.append(el("line", { x1: cx, x2: cx, y1: m.t - 4, y2: H - m.b, class: "zero" }));
    mountSvg(host, svg);
  });
}
