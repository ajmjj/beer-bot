// Reads the Supabase aggregate views via PostgREST. No build step, no dependencies.
const GOAL = 1_000_000;

async function view(name, query = "") {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${name}?select=*${query}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`${name}: ${res.status} ${await res.text()}`);
  return res.json();
}

const fmt = (n) => n.toLocaleString();
const $ = (id) => document.getElementById(id);

function renderBoard(rows) {
  const TOP = 20;
  let expanded = false;
  const draw = () => {
    const show = expanded ? rows : rows.slice(0, TOP);
    $("board").innerHTML = show.map((r, i) =>
      `<tr><td class="rank">${i + 1}</td><td>${escapeHtml(r.member)}</td><td class="beers">${fmt(r.beers)}</td></tr>`
    ).join("");
  };
  draw();
  const btn = $("toggle");
  if (rows.length > TOP) {
    btn.hidden = false;
    btn.onclick = () => { expanded = !expanded; btn.textContent = expanded ? "Show top 20" : "Show all"; draw(); };
  }
}

function renderTrend(daily) {
  const max = Math.max(1, ...daily.map((d) => d.beers));
  $("trend").innerHTML = daily.map((d) =>
    `<div class="b" style="height:${(d.beers / max) * 100}%" title="${d.beer_date}: ${d.beers}"></div>`
  ).join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function main() {
  try {
    const [[t], board, daily] = await Promise.all([
      view("totals"),
      view("leaderboard_alltime"),
      view("daily_counts", "&order=beer_date.asc"),
    ]);

    $("total").textContent = fmt(t.total_beers);
    $("members").textContent = fmt(t.members);
    $("days").textContent = fmt(t.active_days);
    $("avg").textContent = t.active_days ? (t.total_beers / t.active_days).toFixed(1) : "0";

    const last7 = daily.slice(-7).reduce((s, d) => s + d.beers, 0);
    $("week").textContent = fmt(last7);

    const pct = (t.total_beers / GOAL) * 100;
    $("bar").style.width = `${Math.min(100, Math.max(pct, 0.3))}%`; // floor so the sliver is visible
    $("pct").textContent = `${pct.toFixed(4)}% of the way there`;

    renderBoard(board);
    renderTrend(daily);
    $("foot").textContent = `Updated ${new Date().toLocaleString()}`;
  } catch (err) {
    $("foot").innerHTML = `<span class="err">${escapeHtml(err.message)}</span>`;
    console.error(err);
  }
}

main();
