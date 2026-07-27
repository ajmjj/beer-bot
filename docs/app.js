// Tabbed dashboard. Reads pre-aggregated Supabase views via PostgREST. No build step.
const GOAL = 1_000_000;
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

async function view(name, query = "") {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${name}?select=*${query}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`${name}: ${res.status} ${await res.text()}`);
  return res.json();
}

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n == null ? "–" : Number(n).toLocaleString());
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString() : "–");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const err = (e) => { $("foot").innerHTML = `<span class="err">${esc(e.message)}</span>`; console.error(e); };

// --- table helper: headers = [{label, num}], rows = [[cell|{v,cls}, ...], ...] ---
function table(elId, headers, rows) {
  const th = headers ? `<thead><tr>${headers.map((h) => `<th class="${h.num ? "num" : ""}">${h.label}</th>`).join("")}</tr></thead>` : "";
  const tb = rows.map((r) => `<tr>${r.map((c) => {
    const cell = typeof c === "object" ? c : { v: c };
    return `<td class="${cell.cls || ""}">${cell.v}</td>`;
  }).join("")}</tr>`).join("");
  $(elId).innerHTML = `${th}<tbody>${tb}</tbody>`;
}

// --- Chart.js helper (dark theme, destroys any prior chart on the canvas) ---
const charts = {};
Chart.defaults.color = "#9a8c73";
Chart.defaults.borderColor = "#3a2f1e";
function chart(id, config) {
  charts[id]?.destroy();
  charts[id] = new Chart($(id), config);
}
const AMBER = "#f5a623";
const FOAM = "#f4eac9"; // warm cream head, like the foam on 🍺

// Vertical amber gradient for the fill: pale gold at top, deep amber at the bottom of the glass.
const beerFill = (ctx) => {
  const { chart } = ctx;
  const area = chart.chartArea;
  if (!area) return "rgba(245,166,35,.2)"; // pre-layout fallback
  const g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
  g.addColorStop(0, "rgba(250,205,95,.60)");
  g.addColorStop(0.35, "rgba(232,165,45,.50)");
  g.addColorStop(0.7, "rgba(205,130,25,.42)");
  g.addColorStop(1, "rgba(165,95,15,.34)");
  return g;
};

// Vertical dashed crosshair at the hovered point (stock-graph style). Chart.js has no built-in.
const crosshair = {
  id: "crosshair",
  afterDatasetsDraw(c) {
    const active = c.tooltip?.getActiveElements?.();
    if (!active?.length) return;
    const x = active[0].element.x;
    const { top, bottom } = c.chartArea;
    const ctx = c.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.moveTo(x, top); ctx.lineTo(x, bottom);
    ctx.strokeStyle = "#9a8c73"; ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  },
};

// Makes the filled area look like actual beer: a foamy head hugging the underside of the
// line + carbonation bubbles rising through the amber. Everything is clipped to the region
// under the line so foam/bubbles only appear inside the "glass". Self-animates via rAF.
const beer = {
  id: "beer",
  afterDatasetsDraw(c) {
    const pts = c.getDatasetMeta(0).data;
    if (!pts.length) return;
    const { ctx, chartArea: a } = c;
    const width = a.right - a.left, height = a.bottom - a.top;
    const t = performance.now() / 1000;

    // one-time deterministic bubble field (kept on the chart so they don't teleport each frame)
    c.$bubbles ??= Array.from({ length: 60 }, () => ({
      fx: Math.random(), r: 0.8 + Math.random() * 2.4,
      speed: 0.04 + Math.random() * 0.12, phase: Math.random(), drift: (Math.random() - 0.5) * 10,
    }));

    ctx.save();
    // clip to the area between the line and the bottom axis (the beer)
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts) ctx.lineTo(p.x, p.y);
    ctx.lineTo(pts[pts.length - 1].x, a.bottom);
    ctx.lineTo(pts[0].x, a.bottom);
    ctx.closePath();
    ctx.clip();

    // rising bubbles
    for (const b of c.$bubbles) {
      const x = a.left + b.fx * width + Math.sin(t * 1.5 + b.phase * 6) * b.drift;
      const y = a.bottom - ((t * b.speed + b.phase) % 1) * height;
      ctx.beginPath();
      ctx.arc(x, y, b.r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,244,214,.5)";
      ctx.fill();
      ctx.lineWidth = 0.6; ctx.strokeStyle = "rgba(255,255,255,.35)";
      ctx.stroke();
    }

    // foamy head: a continuous creamy band hugging the underside of the line — thick and soft,
    // denser at the top and fading into the beer below (drawn as stacked round strokes on the line).
    const tracePath = () => {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (const p of pts) ctx.lineTo(p.x, p.y);
    };
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    // many thin strokes, widest+faintest at the bottom of the band to densest+opaque at the line
    for (let w = 36; w >= 5; w -= 2) {
      const k = (36 - w) / 31; // 0 at the widest, 1 nearest the line
      tracePath();
      ctx.lineWidth = w;
      ctx.strokeStyle = `rgba(244,234,201,${(Math.pow(k, 4) * 0.95).toFixed(3)})`;
      ctx.stroke();
    }

    // sparse frothy texture where the foam meets the beer
    for (let i = 0; i < pts.length; i += 4) {
      const p = pts[i];
      ctx.beginPath();
      ctx.arc(p.x, p.y + 16 + Math.sin(t * 1.5 + i) * 2, 1 + (i % 3) * 0.8, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,250,235,.55)";
      ctx.fill();
    }
    ctx.restore();

    // keep the bubbles moving (single rAF loop per chart; stops itself once destroyed)
    if (!c.$beerRAF) {
      const loop = () => {
        if (!c.canvas) return; // chart destroyed on tab switch — stop the loop
        c.$beerRAF = requestAnimationFrame(loop);
        c.draw();
      };
      c.$beerRAF = requestAnimationFrame(loop);
    }
  },
};

// ---------- loaders (run once per tab) ----------
async function loadOverview() {
  const [[t], [d], series, [mstat], [gaps]] = await Promise.all([view("totals"), view("day_extremes"), view("v_daily_series", "&order=beer_date.asc"), view("v_member_stats"), view("v_gaps")]);
  const total = t.total_beers + (gaps?.total_missing ?? 0); // skipped numbers count toward the tally
  $("total").textContent = fmt(total);
  $("members").textContent = fmt(mstat?.posting_members);
  $("days").textContent = fmt(t.active_days);
  $("avg").textContent = t.active_days ? (t.total_beers / t.active_days).toFixed(1) : "0";
  $("week").textContent = fmt(series.length ? series[series.length - 1].rolling_7d : 0);
  $("highDay").textContent = fmt(d.highest); $("highDayDate").textContent = fmtDate(d.highest_date);
  const pct = (total / GOAL) * 100;
  $("bar").style.width = `${Math.min(100, Math.max(pct, 0.3))}%`;
  $("pct").textContent = `${pct.toFixed(4)}% · ${fmt(GOAL - total)} to go`;
  if (gaps?.total_missing > 0) $("missed").textContent = fmt(gaps.total_missing);
}

async function loadLeaderboards() {
  const [board, active, week, bigday, deletes, [part]] = await Promise.all([
    view("leaderboard_alltime"),
    view("v_leaderboard_active"),
    view("v_highest_week"),
    view("v_biggest_day"),
    view("v_admin_deletes"),
    view("v_participation"),
  ]);

  $("participation").innerHTML = [
    ["Total beers", fmt(part?.total_beers)],
    ["People posted", fmt(part?.people_posted)],
    ["Avg / person", fmt(part?.avg_per_person)],
    ["Top 10 share", part ? `${part.top10_pct}%` : "–"],
  ].map(([l, v]) => `<div class="card"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");

  // top performers with show-all toggle
  let expanded = false;
  const drawBoard = () => {
    const rows = (expanded ? board : board.slice(0, 20)).map((r, i) => [{ v: i + 1, cls: "rank" }, esc(r.member), { v: fmt(r.beers), cls: "beers" }, { v: fmtDate(r.last_beer), cls: "num" }, { v: fmtDate(r.first_beer), cls: "num" }]);
    table("board", [{ label: "#", num: true }, { label: "Member" }, { label: "Beers", num: true }, { label: "Last beer", num: true }, { label: "First beer", num: true }], rows);
  };
  drawBoard();
  const btn = $("toggle");
  if (board.length > 20) {
    btn.hidden = false;
    btn.onclick = () => { expanded = !expanded; btn.textContent = expanded ? "Show top 20" : "Show all"; drawBoard(); };
  } else btn.hidden = true;

  table("board-active", [{ label: "Member" }, { label: "Per day", num: true }, { label: "Beers", num: true }],
    active.slice(0, 10).map((r) => [esc(r.member), { v: r.per_active_day, cls: "num beers" }, { v: fmt(r.beers), cls: "num" }]));

  table("board-week", [{ label: "Member" }, { label: "Beers", num: true }, { label: "Week of", num: true }],
    [...week].sort((a, b) => b.beers - a.beers).slice(0, 10).map((r) => [esc(r.member), { v: fmt(r.beers), cls: "beers" }, { v: fmtDate(r.week_start), cls: "num" }]));

  table("board-bigday", [{ label: "Member" }, { label: "Beers", num: true }, { label: "Date", num: true }],
    [...bigday].sort((a, b) => b.biggest_day - a.biggest_day).slice(0, 10).map((r) => [esc(r.member), { v: fmt(r.biggest_day), cls: "beers" }, { v: fmtDate(r.date), cls: "num" }]));

  const adminDeletes = deletes.filter((r) => r.admin_deletes > 0);
  if (adminDeletes.length) {
    table("admin-deletes", [{ label: "Deleter" }, { label: "Deletes", num: true }],
      adminDeletes.map((r) => [esc(r.deleter), { v: fmt(r.admin_deletes), cls: "num beers" }]));
  } else {
    $("admin-deletes").innerHTML = `<tr><td style="color:var(--muted)">No deletions tracked yet.</td></tr>`;
  }
}

async function loadTrends() {
  loadForecast();
  const [series, monthly, weekly] = await Promise.all([
    view("v_daily_series", "&order=beer_date.asc"),
    view("v_monthly", "&order=month.asc"),
    view("v_weekly", "&order=week_start.asc"),
  ]);
  const dates = series.map((r) => r.beer_date);
  const line = (label, data) => ({
    type: "line",
    plugins: [beer, crosshair],
    data: { labels: dates, datasets: [{ label, data, borderColor: FOAM, borderWidth: 3, backgroundColor: beerFill, fill: true, pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: FOAM, pointHoverBorderColor: AMBER, tension: .3 }] },
    options: {
      interaction: { mode: "index", intersect: false }, // stock-graph style: hover anywhere on the x-axis
      plugins: {
        legend: { display: false },
        tooltip: {
          position: "nearest", yAlign: "bottom", caretSize: 0, displayColors: false,
          backgroundColor: "#2a2419", padding: 8, cornerRadius: 6,
          titleColor: "#f5e9d0", bodyColor: "#9a8c73",
          callbacks: { title: (items) => `${fmt(items[0].parsed.y)}`, label: (item) => fmtDate(item.label) },
        },
      },
      maintainAspectRatio: false, scales: { x: { ticks: { maxTicksLimit: 8 } } },
    },
  });
  chart("chart-cumulative", line("Cumulative", series.map((r) => r.cumulative)));
  chart("chart-rolling", line("Rolling 7d", series.map((r) => r.rolling_7d)));

  table("monthly", [{ label: "Month" }, { label: "Total", num: true }, { label: "Days", num: true }, { label: "Beer/day", num: true }, { label: "Rank", num: true }],
    monthly.map((r) => [new Date(r.month).toLocaleDateString(undefined, { month: "short", year: "2-digit" }),
      { v: fmt(r.total), cls: "num" }, { v: r.days, cls: "num" }, { v: r.beer_per_day, cls: "num beers" }, { v: r.rank, cls: "num" }]));

  table("weekly", [{ label: "Week of" }, { label: "Beers", num: true }, { label: "Rank", num: true }],
    [...weekly].reverse().slice(0, 16).map((r) => [fmtDate(r.week_start), { v: fmt(r.beers), cls: "num beers" }, { v: r.rank, cls: "num" }]));
}

async function loadPatterns() {
  const [dow, hourly] = await Promise.all([view("v_day_of_week", "&order=dow.asc"), view("v_hourly_matrix")]);

  const mondayAvg = dow.find((r) => r.dow === 1)?.average || 1;
  chart("chart-dow", {
    data: {
      labels: dow.map((r) => r.day_name),
      datasets: [
        { type: "bar", label: "Total", data: dow.map((r) => r.total), backgroundColor: AMBER, yAxisID: "y" },
        { type: "line", label: "Average", data: dow.map((r) => r.average), borderColor: "#7fb3d5", yAxisID: "y1", tension: .3 },
      ],
    },
    options: { maintainAspectRatio: false, scales: { y: { position: "left" }, y1: { position: "right", grid: { drawOnChartArea: false } } } },
  });
  table("dow", [{ label: "Day" }, { label: "Total", num: true }, { label: "Avg", num: true }, { label: "High", num: true }, { label: "Low", num: true }, { label: "Mon ratio", num: true }],
    dow.map((r) => [r.day_name, { v: fmt(r.total), cls: "num" }, { v: r.average, cls: "num beers" }, { v: r.highest, cls: "num" }, { v: r.lowest, cls: "num" }, { v: (r.average / mondayAvg).toFixed(2), cls: "num" }]));

  // heatmap: hours 0-23 (rows) x Mon-Sun (cols)
  const m = {};
  let max = 1;
  for (const r of hourly) { m[`${r.hour}-${r.dow}`] = r.beers; if (r.beers > max) max = r.beers; }
  let html = `<div class="h"></div>` + DOW.map((d) => `<div class="h">${d}</div>`).join("");
  for (let h = 0; h < 24; h++) {
    html += `<div class="hr">${String(h).padStart(2, "0")}</div>`;
    for (let dw = 1; dw <= 7; dw++) {
      const c = m[`${h}-${dw}`] || 0;
      const bg = c ? `rgba(245,166,35,${(0.12 + 0.88 * (c / max)).toFixed(3)})` : "var(--line)";
      html += `<div class="cell" style="background:${bg}" title="${DOW[dw - 1]} ${h}:00 — ${c}"></div>`;
    }
  }
  $("heatmap").innerHTML = html;
}

async function loadForecast() {
  const [[f], milestones] = await Promise.all([view("v_forecast"), view("v_milestones", "&order=milestone.asc")]);
  $("forecast-cards").innerHTML = [
    ["Beers / day (trend)", fmt(f?.linear_rate_per_day)],
    ["Beers / day (last 30)", fmt(f?.trailing_rate_per_day)],
    ["1M — trend model", fmtDate(f?.linear_1m_date)],
    ["1M — recent-rate model", fmtDate(f?.trailing_1m_date)],
  ].map(([l, v]) => `<div class="card"><div class="v" style="font-size:20px">${v}</div><div class="l">${l}</div></div>`).join("");

  table("milestones", [{ label: "Milestone", num: true }, { label: "Who" }, { label: "Date", num: true }, { label: "Days", num: true }],
    milestones.map((r) => [{ v: fmt(r.milestone), cls: "num beers" }, esc(r.member), { v: fmtDate(r.date), cls: "num" }, { v: r.days_to_reach ?? "–", cls: "num" }]));
  if (!milestones.length) $("milestones").innerHTML = `<tbody><tr><td style="color:var(--muted)">No milestones reached yet.</td></tr></tbody>`;
}

// ---------- router (lazy: load a tab's data the first time it's shown) ----------
const LOADERS = { overview: loadOverview, leaderboards: loadLeaderboards, trends: loadTrends, patterns: loadPatterns };
const loaded = new Set();

function show(name) {
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((s) => s.classList.toggle("active", s.id === name));
  if (!loaded.has(name)) { loaded.add(name); LOADERS[name]().catch(err); }
}

document.querySelectorAll("nav button").forEach((b) => (b.onclick = () => show(b.dataset.tab)));
show("overview");
$("foot").textContent = `Updated ${new Date().toLocaleString()}`;

// SHELVED: self-service rename. See .locals/username-feature-shelved.md
// async function registerName() {
//   const phone = $("reg-phone").value.trim();
//   const name  = $("reg-name").value.trim();
//   const status = $("reg-status");
//   if (!phone || !name) { status.innerHTML = `<span class="err">Enter both a phone number and a display name.</span>`; return; }
//   status.style.color = "var(--muted)";
//   status.textContent = "Saving…";
//   try {
//     const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/register_display_name`, {
//       method: "POST",
//       headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
//       body: JSON.stringify({ phone, name }),
//     });
//     if (!res.ok) throw new Error(await res.text());
//     const n = await res.json();
//     status.style.color = "var(--amber)";
//     status.textContent = n > 0 ? "Done — your display name has been updated." : "Phone number not found in the group member list.";
//   } catch (e) {
//     status.innerHTML = `<span class="err">${esc(e.message)}</span>`;
//   }
// }
