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

// ---------- loaders (run once per tab) ----------
async function loadOverview() {
  const [[t], [d], series, [mstat], [gaps]] = await Promise.all([view("totals"), view("day_extremes"), view("v_daily_series", "&order=beer_date.asc"), view("v_member_stats"), view("v_gaps")]);
  $("total").textContent = fmt(t.total_beers);
  $("members").textContent = fmt(mstat?.posting_members);
  $("days").textContent = fmt(t.active_days);
  $("avg").textContent = t.active_days ? (t.total_beers / t.active_days).toFixed(1) : "0";
  $("week").textContent = fmt(series.length ? series[series.length - 1].rolling_7d : 0);
  $("highDay").textContent = fmt(d.highest); $("highDayDate").textContent = fmtDate(d.highest_date);
  const pct = (t.total_beers / GOAL) * 100;
  $("bar").style.width = `${Math.min(100, Math.max(pct, 0.3))}%`;
  $("pct").textContent = `${pct.toFixed(4)}% · ${fmt(GOAL - t.total_beers)} to go`;

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
    const rows = (expanded ? board : board.slice(0, 20)).map((r, i) => [{ v: i + 1, cls: "rank" }, esc(r.member), { v: fmt(r.beers), cls: "beers" }, { v: fmtDate(r.last_beer), cls: "num" }]);
    table("board", [{ label: "#", num: true }, { label: "Member" }, { label: "Beers", num: true }, { label: "Last beer", num: true }], rows);
  };
  drawBoard();
  const btn = $("toggle");
  if (board.length > 20) {
    btn.hidden = false;
    btn.onclick = () => { expanded = !expanded; btn.textContent = expanded ? "Show top 20" : "Show all"; drawBoard(); };
  } else btn.hidden = true;

  table("board-active", [{ label: "Member" }, { label: "Per day", num: true }, { label: "Beers", num: true }],
    active.slice(0, 10).map((r) => [esc(r.member), { v: r.per_active_day, cls: "num beers" }, { v: fmt(r.beers), cls: "num" }]));

  const isoWeek = (s) => { const d = new Date(s); d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); return Math.ceil(((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 1))) / 86400000 + 1) / 7); };
  table("board-week", [{ label: "Member" }, { label: "Beers", num: true }, { label: "CW", num: true }],
    [...week].sort((a, b) => b.beers - a.beers).slice(0, 10).map((r) => [esc(r.member), { v: fmt(r.beers), cls: "beers" }, { v: `CW ${isoWeek(r.week_start)}`, cls: "num" }]));

  table("board-bigday", [{ label: "Member" }, { label: "Beers", num: true }, { label: "Date", num: true }],
    [...bigday].sort((a, b) => b.biggest_day - a.biggest_day).slice(0, 10).map((r) => [esc(r.member), { v: fmt(r.biggest_day), cls: "beers" }, { v: fmtDate(r.date), cls: "num" }]));

  if (deletes.length) {
    table("admin-deletes", [{ label: "Deleter" }, { label: "Deletes", num: true }, { label: "By admin", num: true }],
      deletes.map((r) => [esc(r.deleter), { v: fmt(r.deletes), cls: "num beers" }, { v: fmt(r.admin_deletes), cls: "num" }]));
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
    data: { labels: dates, datasets: [{ label, data, borderColor: AMBER, backgroundColor: "rgba(245,166,35,.15)", fill: true, pointRadius: 0, tension: .2 }] },
    options: { plugins: { legend: { display: false } }, maintainAspectRatio: false, scales: { x: { ticks: { maxTicksLimit: 8 } } } },
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
