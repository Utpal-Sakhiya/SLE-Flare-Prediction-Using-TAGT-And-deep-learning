/* Hand-written SVG charts (no libraries). Colours come from CSS custom properties,
   so switching theme restyles every chart without a redraw. */

const NS = "http://www.w3.org/2000/svg";

export function esc(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function s(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) n.setAttribute(k, v);
  for (const k of kids.flat()) if (k !== null && k !== undefined) n.append(k);
  return n;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Tooltip positioned inside a relatively-positioned host. */
function makeTip(host) {
  const t = document.createElement("div");
  t.className = "tip";
  t.setAttribute("aria-hidden", "true");
  t.hidden = true;
  host.append(t);
  return {
    show(html, x, y) {
      t.innerHTML = html;
      t.hidden = false;
      const hw = host.clientWidth;
      const tw = t.offsetWidth;
      const th = t.offsetHeight;
      let left = x + 14;
      if (left + tw > hw) left = x - tw - 14;
      left = clamp(left, 0, Math.max(0, hw - tw));
      let top = y - th - 12;
      if (top < 0) top = y + 18;
      t.style.left = `${left}px`;
      t.style.top = `${top}px`;
    },
    hide() { t.hidden = true; },
  };
}

/** Re-render whenever the host's width changes (also handles hidden -> visible). */
function mount(host, render) {
  let last = 0;
  const run = () => {
    const w = Math.floor(host.clientWidth);
    if (w > 0 && w !== last) { last = w; render(w); }
  };
  new ResizeObserver(run).observe(host);
  run();
}

function placeSvg(host, svg) {
  const old = host.querySelector(":scope > svg");
  if (old) old.replaceWith(svg); else host.prepend(svg);
}

const swatch = (color, line = false) =>
  `<span class="${line ? "swatch-line" : "swatch"}" style="background:${color}"></span>`;

/* ------------------------------------------------------------------ ROC */

function tprAt(fpr, tpr, x) {
  let best = 0;
  for (let i = 0; i < fpr.length - 1; i++) {
    const a = fpr[i], b = fpr[i + 1];
    if (x >= a && x <= b) {
      const v = b === a ? Math.max(tpr[i], tpr[i + 1]) : tpr[i] + ((tpr[i + 1] - tpr[i]) * (x - a)) / (b - a);
      best = Math.max(best, v);
    }
  }
  if (x >= fpr[fpr.length - 1]) best = Math.max(best, tpr[tpr.length - 1]);
  return best;
}
export { tprAt };

/**
 * series: [{ name, color, auc, fpr:[], tpr:[] }]
 */
export function rocChart(host, series, summary) {
  const tip = makeTip(host);
  host.tabIndex = 0;
  host.setAttribute("role", "img");
  host.setAttribute("aria-label", `${summary} Focus and use the left and right arrow keys to read values; a table version follows.`);
  let geom = null;
  let fx = null;

  function update(xVal, clientPos) {
    if (!geom) return;
    const { X, Y, cross, dots, m, pw } = geom;
    if (xVal === null) {
      cross.setAttribute("visibility", "hidden");
      dots.forEach((d) => d.setAttribute("visibility", "hidden"));
      tip.hide();
      return;
    }
    fx = clamp(xVal, 0, 1);
    const px = X(fx);
    cross.setAttribute("x1", px); cross.setAttribute("x2", px);
    cross.setAttribute("visibility", "visible");
    let rows = "";
    let minY = Infinity;
    series.forEach((ser, i) => {
      const t = tprAt(ser.fpr, ser.tpr, fx);
      const py = Y(t);
      minY = Math.min(minY, py);
      dots[i].setAttribute("cx", px); dots[i].setAttribute("cy", py);
      dots[i].setAttribute("visibility", "visible");
      rows += `<div class="tip-row"><span>${swatch(ser.color, true)}${esc(ser.name)}</span><b>${t.toFixed(2)}</b></div>`;
    });
    const html = `<div class="tip-title">False-positive rate ${fx.toFixed(2)}</div><div class="hint" style="margin-bottom:4px">True-positive rate:</div>${rows}`;
    const pos = clientPos || { x: px, y: minY };
    tip.show(html, clamp(pos.x, m.l, m.l + pw), pos.y);
  }

  function render(W) {
    const size = Math.min(W, 560);
    const m = { l: 52, r: 14, t: 10, b: 48 };
    const pw = size - m.l - m.r;
    const ph = pw;
    const H = ph + m.t + m.b;
    const X = (v) => m.l + v * pw;
    const Y = (v) => m.t + (1 - v) * ph;
    const svg = s("svg", { width: size, height: H, viewBox: `0 0 ${size} ${H}`, "aria-hidden": "true", focusable: "false" });

    for (let i = 0; i <= 5; i++) {
      const v = i / 5;
      svg.append(
        s("line", { x1: X(v), x2: X(v), y1: m.t, y2: m.t + ph, class: "grid" }),
        s("line", { x1: m.l, x2: m.l + pw, y1: Y(v), y2: Y(v), class: "grid" }),
        s("text", { x: X(v), y: m.t + ph + 18, class: "tick", "text-anchor": "middle" }, v.toFixed(1)),
        s("text", { x: m.l - 8, y: Y(v) + 4, class: "tick", "text-anchor": "end" }, v.toFixed(1)),
      );
    }
    svg.append(
      s("line", { x1: m.l, x2: m.l + pw, y1: m.t + ph, y2: m.t + ph, class: "axis" }),
      s("line", { x1: m.l, x2: m.l, y1: m.t, y2: m.t + ph, class: "axis" }),
      s("text", { x: m.l + pw / 2, y: H - 6, class: "axis-title", "text-anchor": "middle" }, "False-positive rate (1 − specificity)"),
      s("text", { x: 14, y: m.t + ph / 2, class: "axis-title", "text-anchor": "middle", transform: `rotate(-90 14 ${m.t + ph / 2})` }, "True-positive rate (sensitivity)"),
      s("line", { x1: X(0), y1: Y(0), x2: X(1), y2: Y(1), class: "chance" }),
    );
    // Label sits just below the diagonal, where the (above-chance) curves don't reach.
    const cl = { x: X(0.5) + 10, y: Y(0.5) + 12 };
    svg.append(s("text", { x: cl.x, y: cl.y, class: "chance-label", "text-anchor": "middle", transform: `rotate(-45 ${cl.x} ${cl.y})` }, "Chance (AUC 0.5)"));

    // Draw the series with the most-relevant (first) series last, so it sits on top.
    [...series].reverse().forEach((ser) => {
      const pts = ser.fpr.map((f, i) => `${X(f).toFixed(1)},${Y(ser.tpr[i]).toFixed(1)}`).join(" ");
      svg.append(s("polyline", { points: pts, class: "curve", style: `stroke:${ser.color}` }));
    });

    const cross = s("line", { y1: m.t, y2: m.t + ph, class: "cross", visibility: "hidden" });
    svg.append(cross);
    const dots = series.map((ser) => s("circle", { r: 5, class: "dot", style: `fill:${ser.color}`, visibility: "hidden" }));
    svg.append(...dots);

    const overlay = s("rect", { x: m.l, y: m.t, width: pw, height: ph, fill: "transparent" });
    overlay.addEventListener("pointermove", (e) => {
      const r = host.getBoundingClientRect();
      const x = e.clientX - r.left;
      update((x - m.l) / pw, { x, y: e.clientY - r.top });
    });
    overlay.addEventListener("pointerleave", () => update(null));
    svg.append(overlay);

    placeSvg(host, svg);
    geom = { X, Y, cross, dots, m, pw };
    if (fx !== null && document.activeElement === host) update(fx);
  }

  host.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.01 : 0.05;
    let v = fx === null ? 0 : fx;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") v += step;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") v -= step;
    else if (e.key === "Home") v = 0;
    else if (e.key === "End") v = 1;
    else if (e.key === "Escape") { update(null); return; }
    else return;
    e.preventDefault();
    update(Math.round(clamp(v, 0, 1) * 100) / 100);
  });
  host.addEventListener("focus", () => update(fx === null ? 0.2 : fx));
  host.addEventListener("blur", () => update(null));

  mount(host, render);
}

/* ------------------------------------------------------------- AUC bars */

/** rows: [{ name, color, auc, mean, sd, folds:[] }] already sorted. */
export function aucBars(host, rows) {
  const tip = makeTip(host);
  function render(W) {
    const m = { l: 4, r: 56, t: 22, b: 30 };
    const rowH = 58;
    const pw = Math.max(120, W - m.l - m.r);
    const H = m.t + rows.length * rowH + m.b;
    const X = (v) => m.l + v * pw;
    const svg = s("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "group", "aria-label": "AUC by model" });

    [0, 0.25, 0.5, 0.75, 1].forEach((v) => {
      svg.append(
        s("line", { x1: X(v), x2: X(v), y1: m.t, y2: H - m.b, class: "grid" }),
        s("text", { x: X(v), y: H - m.b + 18, class: "tick", "text-anchor": v === 0 ? "start" : v === 1 ? "end" : "middle" }, v === 0 ? "0" : v === 1 ? "1.0" : String(v)),
      );
    });
    svg.append(
      s("line", { x1: X(0.5), x2: X(0.5), y1: m.t - 6, y2: H - m.b, class: "chance" }),
      s("text", { x: X(0.5) + 6, y: m.t - 8, class: "chance-label" }, "Chance 0.5"),
    );

    rows.forEach((r, i) => {
      const y0 = m.t + i * rowH;
      const barY = y0 + 24;
      const bh = 20;
      const x1 = X(r.auc);
      const rad = Math.min(4, x1 - X(0));
      const path = `M${X(0)},${barY} H${x1 - rad} Q${x1},${barY} ${x1},${barY + rad} V${barY + bh - rad} Q${x1},${barY + bh} ${x1 - rad},${barY + bh} H${X(0)} Z`;
      const lo = clamp(r.mean - r.sd, 0, 1), hi = clamp(r.mean + r.sd, 0, 1);
      const cy = barY + bh / 2;
      const label = `${r.name}: pooled AUC ${r.auc.toFixed(3)}; fold mean ${r.mean.toFixed(3)} ± ${r.sd.toFixed(3)}`;
      const g = s("g", { class: "row", tabindex: "0", role: "img", "aria-label": label });
      g.append(
        s("rect", { x: 0, y: y0, width: W, height: rowH, class: "hit", rx: 6 }),
        s("text", { x: m.l, y: y0 + 16, class: "row-label" }, r.name),
        s("path", { d: path, style: `fill:${r.color}` }),
        s("line", { x1: X(lo), x2: X(hi), y1: cy, y2: cy, class: "whisker" }),
        s("line", { x1: X(lo), x2: X(lo), y1: cy - 6, y2: cy + 6, class: "whisker" }),
        s("line", { x1: X(hi), x2: X(hi), y1: cy - 6, y2: cy + 6, class: "whisker" }),
        s("circle", { cx: X(r.mean), cy, r: 4.5, class: "mean-dot" }),
        s("text", { x: Math.max(x1, X(hi)) + 8, y: cy + 4.5, class: "val" }, r.auc.toFixed(3)),
      );
      const html = `<div class="tip-title">${swatch(r.color)} ${esc(r.name)}</div>
        <div class="tip-row"><span>Pooled AUC</span><b>${r.auc.toFixed(3)}</b></div>
        <div class="tip-row"><span>Fold mean ± SD</span><b>${r.mean.toFixed(3)} ± ${r.sd.toFixed(3)}</b></div>
        <div class="tip-row"><span>Fold AUCs</span><b>${r.folds.map((f) => f.toFixed(2)).join(" · ")}</b></div>`;
      const show = (x, y) => { g.classList.add("is-active"); tip.show(html, x, y); };
      const hide = () => { g.classList.remove("is-active"); tip.hide(); };
      g.addEventListener("pointermove", (e) => { const b = host.getBoundingClientRect(); show(e.clientX - b.left, e.clientY - b.top); });
      g.addEventListener("pointerleave", hide);
      g.addEventListener("focus", () => show(Math.max(x1, X(hi)), y0 + 8));
      g.addEventListener("blur", hide);
      svg.append(g);
    });
    placeSvg(host, svg);
  }
  mount(host, render);
}

/* ------------------------------------------------- Diverging attributions */

export function fmtContrib(v) {
  const a = Math.abs(v);
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  if (a === 0) return "0";
  if (a >= 1e-3) return sign + a.toFixed(4);
  return sign + a.toExponential(1).replace("e-", "e−");
}

/** genes: [{ probe, contribution, z_score, expression }] sorted by |contribution|. */
export function divergingBars(host, genes) {
  const tip = makeTip(host);
  function render(W) {
    const narrow = W < 520;
    const lw = narrow ? 104 : 124;
    const vs = narrow ? 58 : 70;
    const m = { t: 26, b: 8 };
    const rowH = 32;
    const H = m.t + genes.length * rowH + m.b;
    const half = Math.max(40, (W - lw - 2 * vs) / 2);
    const cx = lw + vs + half;
    const maxAbs = Math.max(...genes.map((g) => Math.abs(g.contribution)), 1e-12);
    const L = (v) => (Math.abs(v) / maxAbs) * half;
    const svg = s("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "group", "aria-label": "Top 10 probe attributions for the TAGT score" });

    svg.append(
      s("text", { x: cx - 8, y: 14, class: "dir-label", "text-anchor": "end" }, "← Lowers risk"),
      s("text", { x: cx + 8, y: 14, class: "dir-label" }, "Raises risk →"),
      s("line", { x1: cx, x2: cx, y1: m.t - 4, y2: H - m.b, class: "zero" }),
    );

    genes.forEach((g, i) => {
      const y0 = m.t + i * rowH;
      const bh = 18;
      const by = y0 + (rowH - bh) / 2;
      const len = Math.max(L(g.contribution), g.contribution === 0 ? 0 : 1.5);
      const up = g.contribution >= 0;
      const color = up ? "var(--raise)" : "var(--lower)";
      const r = Math.min(4, len);
      const x0 = cx;
      const x1 = up ? cx + len : cx - len;
      const d = up
        ? `M${x0},${by} H${x1 - r} Q${x1},${by} ${x1},${by + r} V${by + bh - r} Q${x1},${by + bh} ${x1 - r},${by + bh} H${x0} Z`
        : `M${x0},${by} H${x1 + r} Q${x1},${by} ${x1},${by + r} V${by + bh - r} Q${x1},${by + bh} ${x1 + r},${by + bh} H${x0} Z`;
      const dir = g.contribution > 0 ? "raises risk" : g.contribution < 0 ? "lowers risk" : "no effect";
      const label = `${g.probe}: ${dir}, contribution ${fmtContrib(g.contribution)}, expression ${g.expression.toFixed(2)}, z-score ${g.z_score.toFixed(2)}`;
      const row = s("g", { class: "row", tabindex: "0", role: "img", "aria-label": label });
      row.append(
        s("rect", { x: 0, y: y0 + 1, width: W, height: rowH - 2, class: "hit", rx: 6 }),
        s("text", { x: lw - 8, y: y0 + rowH / 2 + 4.5, class: "probe-label", "text-anchor": "end" }, g.probe),
        s("path", { d, style: `fill:${color}` }),
        s("text", { x: up ? x1 + 6 : x1 - 6, y: y0 + rowH / 2 + 4.5, class: "val", "text-anchor": up ? "start" : "end" }, fmtContrib(g.contribution)),
      );
      const html = `<div class="tip-title" style="font-family:var(--mono)">${esc(g.probe)}</div>
        <div class="tip-row"><span>${swatch(color)} Contribution</span><b>${fmtContrib(g.contribution)}</b></div>
        <div class="tip-row"><span>Effect</span><b>${dir}</b></div>
        <div class="tip-row"><span>Expression (log2)</span><b>${g.expression.toFixed(2)}</b></div>
        <div class="tip-row"><span>z-score vs cohort</span><b>${g.z_score.toFixed(2)}</b></div>`;
      const show = (x, y) => { row.classList.add("is-active"); tip.show(html, x, y); };
      const hide = () => { row.classList.remove("is-active"); tip.hide(); };
      row.addEventListener("pointermove", (e) => { const b = host.getBoundingClientRect(); show(e.clientX - b.left, e.clientY - b.top); });
      row.addEventListener("pointerleave", hide);
      row.addEventListener("focus", () => show(up ? x1 : x1, y0));
      row.addEventListener("blur", hide);
      svg.append(row);
    });
    placeSvg(host, svg);
  }
  mount(host, render);
}
