// Keep reference material available without crowding the trading surface.
for (const hint of document.querySelectorAll('section > .hint')) {
  const guide = document.createElement('details');
  guide.className = 'guide';
  const summary = document.createElement('summary');
  summary.textContent = 'How to read this view';
  hint.before(guide);
  guide.append(summary, hint);
}
for (const input of document.querySelectorAll('input[type="search"]')) {
  input.setAttribute('aria-label', 'Filter items by name');
  input.placeholder = 'Search items…';
}
document.getElementById('kind').setAttribute('aria-label', 'Trading strategy');
for (const button of document.querySelectorAll('.bar > button.act')) button.textContent = '↻ Refresh';
const viewDescriptions = {
  today: 'One queue for exits, unfinished purchases, and the best verified next trades.',
  ops: 'Find your next trade. Compare spreads, spot value, and put your platinum to work.',
  sets: 'The sum of the parts. Find profitable sets and build your shopping list.',
  plan: 'Put a budget to work. A shortlist of trades that fits your platinum without piling it into one item.',
  alerts: 'Fresh signals from the market watcher, with the newest opportunities first.',
  log: 'Follow up on your whispers and learn which counterparties reply.',
  trades: 'See where your platinum is, what it has earned, and what each position needs next.',
  ducats: 'Make every platinum count. Compare Prime parts by their ducat return.'
  ,settings: 'Control notifications, planning defaults, and the live alert thresholds.'
};
import { $, api, esc, describeError, toast, act, placeholderRow, connection } from "./core.js";
const JSON_HEADERS = { "content-type": "application/json" };

async function copyAndLog(btn, text, entry) {
  await copyWhisper(text);
  btn.textContent = "copied";
  btn.classList.add("done");
  try {
    await api("/api/whispers", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(entry),
    });
    loadStatus();
  } catch (err) {
    toast(`Copied, but not logged — reply rates will miss it: ${describeError(err)}`, "error");
  }
}

// Serialize refreshes so a slower request cannot overwrite newer filter results.
const loadingViews = new Map();
const lastLoaded = new Map();
async function loadView(id, fetcher) {
  if (loadingViews.has(id)) { loadingViews.set(id, true); return; }
  loadingViews.set(id, false);
  const section = document.getElementById('tab-' + id);
  let feedback = section?.querySelector('.load-feedback');
  if (section && !feedback) {
    feedback = document.createElement('div');
    feedback.className = 'load-feedback';
    feedback.setAttribute('role', 'status');
    section.prepend(feedback);
  }
  // A first load says so in the table itself, not only in a bar above an empty frame.
  const bodies = section ? [...section.querySelectorAll("table > tbody")] : [];
  for (const tb of bodies) if (!tb.children.length) placeholderRow(tb, "Loading…");
  try {
    do {
      loadingViews.set(id, false);
      if (feedback) {
        feedback.hidden = false;
        feedback.dataset.error = 'false';
        feedback.textContent = 'Refreshing market data…';
        section.setAttribute('aria-busy', 'true');
      }
      await fetcher();
    } while (loadingViews.get(id));
    lastLoaded.set(id, new Date());
    if (feedback) feedback.hidden = true;
    const stamp = section?.querySelector('.updated');
    if (stamp) stamp.textContent = 'updated ' + lastLoaded.get(id).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (error) {
    const reason = describeError(error);
    const since = lastLoaded.get(id);
    if (feedback) {
      feedback.dataset.error = 'true';
      feedback.textContent = `Couldn't refresh: ${reason} ` +
        (since ? `Showing results from ${since.toLocaleTimeString()}. ` : '');
      const retry = document.createElement('button');
      retry.className = 'act';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => loadView(id, fetcher));
      feedback.append(retry);
    } else {
      document.getElementById('stale').textContent = `Market status unavailable: ${reason}`;
    }
    // Never leave a table saying "Loading…" once the load has failed.
    for (const tb of bodies) {
      if (tb.querySelector('tr.placeholder')) placeholderRow(tb, `Couldn't load this view: ${esc(reason)}`);
    }
  } finally {
    section?.setAttribute('aria-busy', 'false');
    loadingViews.delete(id);
  }
}

/**
 * Click-to-sort. The server's "Rank by" sets the default order; a header click
 * re-sorts what is on screen, and changing "Rank by" hands control back.
 */
const sortState = {};
function sortRows(tableId, list, key = (x) => x) {
  const s = sortState[tableId];
  if (!s) return list;
  const dir = s.dir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    const x = key(a)[s.key], y = key(b)[s.key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;   // unknowns last, whichever way round
    if (y == null) return -1;
    return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir;
  });
}
function paintSortHeaders(tableId) {
  for (const th of document.querySelectorAll(`#${tableId} thead th[data-sort]`)) {
    const s = sortState[tableId];
    if (s && s.key === th.dataset.sort) th.setAttribute("aria-sort", s.dir === "asc" ? "ascending" : "descending");
    else th.removeAttribute("aria-sort");
  }
}
function clearSort(tableId) {
  delete sortState[tableId];
  paintSortHeaders(tableId);
}
const sortRenderers = {};
document.addEventListener("click", (e) => {
  const th = e.target.closest("thead th[data-sort]");
  if (!th) return;
  const tableId = th.closest("table").id;
  const prev = sortState[tableId];
  // The best trade on top: most profit first, but quickest to sell and
  // freshest prices first; names A–Z.
  const firstDir = ["name", "item_name", "sellDays", "bookAgeH"].includes(th.dataset.sort) ? "asc" : "desc";
  sortState[tableId] = {
    key: th.dataset.sort,
    dir: prev && prev.key === th.dataset.sort ? (prev.dir === "asc" ? "desc" : "asc") : firstDir,
  };
  paintSortHeaders(tableId);
  sortRenderers[tableId]?.();
});

// Density: the trading tables are for comparing many rows at once.
(() => {
  let compact = true;
  try { compact = localStorage.getItem("pw:compact") !== "0"; } catch {}
  document.body.classList.toggle("compact", compact);
  $("#compact").checked = compact;
  $("#compact").addEventListener("change", (e) => {
    document.body.classList.toggle("compact", e.target.checked);
    try { localStorage.setItem("pw:compact", e.target.checked ? "1" : "0"); } catch {}
  });
})();
for (const bar of document.querySelectorAll("section > .bar")) {
  const stamp = document.createElement("span");
  stamp.className = "updated";
  bar.querySelector("button.act")?.after(stamp);
}

const plat = (n) => (n == null ? "–" : `${Math.round(n).toLocaleString()}<span class="u">p</span>`);
const signed = (n) => (n > 0 ? `+${n}` : String(n));
function loadOps() { return loadView('ops', fetchOps); }
function loadSets() { return loadView('sets', fetchSets); }
function loadAlerts() { return loadView('alerts', fetchAlerts); }
function loadLog() { return loadView('log', fetchLog); }
function loadTrades() { return loadView('trades', fetchTrades); }
function loadDucats() { return loadView('ducats', fetchDucats); }
function loadStatus() { return loadView('status', fetchStatus); }
function freshness(age, liveAt) {
  if (liveAt) return '<span class="freshness live">Live</span>';
  if (age == null) return '<span class="freshness unknown">Unknown</span>';
  const state = age > 24 ? 'stale' : age > 1 ? 'aging' : 'recent';
  const label = state === 'stale' ? 'Stale' : state === 'aging' ? 'Aging' : 'Recent';
  return `<span class="freshness ${state}" title="Last order-book update: ${age.toFixed(1)} hours ago">${label} · ${age.toFixed(0)}h</span>`;
}

let rows = [];

/**
 * A small native-dialog form, used instead of prompt().
 *
 * prompt() blocks the page, cannot be styled or labelled, and browsers are
 * steadily restricting it. Resolves to an object of values, or null on cancel.
 */
function askForm(title, fields, opts = {}) {
  const modal = $("#modal");
  $("#modal-title").textContent = title;
  $("#modal-ok").textContent = opts.okLabel || "Save";
  // A whole-platinum field pre-filled with a decimal prediction (138.75p)
  // fails the input's step="1" check and silently refuses to submit.
  const initial = (f) => f.type === "number" && typeof f.value === "number" && !Number.isInteger(f.value)
    ? Math.round(f.value) : f.value ?? "";
  $("#modal-fields").innerHTML = (opts.intro ? `<div class="modal-intro">${opts.intro}</div>` : "") + fields.map((f) => `
    <label>${esc(f.label)}
      ${f.type === "select"
        ? `<select name="${esc(f.name)}">${f.options.map((o) => `<option value="${esc(o.value)}"${
            String(o.value) === String(f.value ?? "") ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`
        : `<input name="${esc(f.name)}" type="${f.type || "text"}"
             value="${esc(initial(f))}" ${f.type === "number" ? `step="1" min="${f.min ?? 0}"` : ""}
             ${f.required ? "data-required=\"1\"" : ""}>`}
      ${f.hint ? `<span class="hint-inline">${esc(f.hint)}</span>` : ""}
    </label>`).join("") + `<span class="warn-inline" id="modal-warn"></span>`;

  return new Promise((resolve) => {
    const form = $("#modal-form");

    // A required field left blank would otherwise submit as NaN and record a
    // meaningless price. Block it here rather than storing nonsense.
    const onSubmit = (e) => {
      if (e.submitter?.value !== "ok") return;
      const missing = [...form.querySelectorAll("input[data-required]")].filter(
        (i) => i.value.trim() === "",
      );
      if (missing.length) {
        e.preventDefault();
        $("#modal-warn").textContent = "Enter a value — this one is not guessed for you.";
        missing[0].focus();
      }
    };
    const onClose = () => {
      modal.removeEventListener("close", onClose);
      form.removeEventListener("submit", onSubmit);
      if (modal.returnValue !== "ok") return resolve(null);
      resolve(Object.fromEntries([...new FormData(form).entries()]));
    };
    form.addEventListener("submit", onSubmit);
    modal.addEventListener("close", onClose);
    modal.showModal();
    $("#modal-fields input")?.focus();
  });
}

function rateCell(c) {
  if (!c) return '<span class="rate none">–</span>';
  if (c.sent === 0) return `<span class="who">${esc(c.ingameName)}</span> <span class="rate none">no history</span>`;
  const pct = Math.round((c.replied / c.sent) * 100);
  const cls = pct >= 50 ? "good" : "bad";
  return `<span class="who">${esc(c.ingameName)}</span> <span class="rate ${cls}">${pct}% of ${c.sent}</span>`;
}

/**
 * What to actually do, which differs by strategy.
 *
 * A spread is market making: post a bid and an ask, and wait. Offering the
 * seller their asking price and then undercutting it loses money, so the only
 * whisper here is a lowball at the model's own buy price.
 *
 * Set arbitrage takes component asks, so the whispers are per part.
 */
function playCell(r) {
  if (r.playKind === "buy-parts") {
    const n = r.parts ? r.parts.length : 0;
    return `<button class="act" data-act="why">why?</button> <button class="act" data-act="verify">verify</button> <button class="act" data-act="parts">buy ${n} parts</button>`;
  }
  return `<span class="play">post <b>${r.postBuyAt}</b> / <b>${r.postSellAt}</b></span> <button class="act" data-act="why">why?</button> <button class="act" data-act="verify">verify</button>
          ${r.lowballWhisper ? `<button class="act" data-act="lowball" title="offer the cheapest seller ${r.postBuyAt}p — below their ask">offer ${r.postBuyAt}p</button>` : ""}`;
}

/** Days as a trader reads them: hours under a day, then days, then "weeks". */
function fmtDays(d) {
  if (d == null) return "–";
  const minutes = d * 1440;
  if (minutes < 60) return `~${Math.max(1, Math.round(minutes))}m`;
  if (minutes < 48 * 60) return `~${Math.round(minutes / 60)}h`;
  if (d < 14) return `~${d < 3 ? d.toFixed(1) : Math.round(d)}d`;
  return "2w+";
}

/** Platinum that may be a decimal prediction: 138.75 stays 138.75, 45 stays 45. */
const fmtNum = (n) => n == null ? "–" : Number.isInteger(Number(n)) ? String(n) : Number(n).toFixed(2).replace(/0$/, "");

const CONFIDENCE = {
  high: { dots: "●●●", label: "high", cls: "" },
  medium: { dots: "●●○", label: "medium", cls: "" },
  low: { dots: "●○○", label: "low", cls: "warn" },
};

/** Expected selling time, with how far the history backs it — never the time alone. */
function sellsInCell(r) {
  if (r.sellDays == null) return '<span class="u">–</span>';
  const c = CONFIDENCE[r.sellConfidence] ?? CONFIDENCE.low;
  const range = r.sellDaysOptimistic != null && r.sellDaysConservative != null
    ? `${fmtDays(r.sellDaysOptimistic)}–${fmtDays(r.sellDaysConservative)}` : fmtDays(r.sellDays);
  return `${range}<span class="sub ${c.cls === "warn" ? "capped" : ""}" title="Base case ${fmtDays(r.sellDays)}. ${esc(r.sellBasis ?? "")}">base ${fmtDays(r.sellDays)} · ${c.dots} ${c.label}</span>`;
}

/**
 * Trend of the traded price: last week against last month. Shown only when it
 * moved enough to matter, and a fall is flagged — a "bargain" in a declining
 * market is often just the new price.
 */
function trendTag(t, m7, m30) {
  if (t == null || Math.abs(t) < 0.05) return "";
  const pct = Math.round(Math.abs(t) * 100);
  const tip = m7 != null && m30 != null ? ` title="traded ${Math.round(m7)}p this week, ${Math.round(m30)}p over 30 days"` : "";
  return t < 0
    ? `<span class="tag ${t <= -0.1 ? "warn" : ""}"${tip}>▼ ${pct}% 30d</span>`
    : `<span class="tag"${tip}>▲ ${pct}% 30d</span>`;
}

/** Profit, its return, and — once your trades say so — what it has really been making. */
function profitCell(r, known = true) {
  if (!known) return "?";
  const cls = r.margin > 0 ? "" : "loss";
  const ret = `${Math.round(r.marginPct * 100)}% return`;
  const cal = r.calibration && r.calibration.factor !== 1 && r.expectedMargin != null
    ? ` · ≈${signed(r.expectedMargin)}p on your record`
    : "";
  const tip = r.calibration && r.calibration.factor !== 1
    ? ` title="${esc(r.calibration.note)}"` : "";
  return `<span class="${cls}">${signed(r.margin)}<span class="u">p</span></span><span class="sub"${tip}>${ret}${cal}</span>`;
}

function riskCell(r) {
  const score = r.riskScore ?? 0;
  const tone = score >= 80 ? "good" : score >= 60 ? "warn" : "bad";
  const tip = r.riskFlags?.length ? r.riskFlags.join("; ") : "strong current evidence";
  return `<span class="risk-meter ${tone}" title="${esc(tip)}"><b>${score}</b>/100</span><span class="sub">${signed(r.riskAdjustedMargin ?? 0)}p adjusted</span>`;
}

const MARKET_TIP = "Open on warframe.market to confirm availability";

/**
 * An item name that opens its warframe.market page in a new tab — the place
 * to confirm a listing or market still exists before committing platinum.
 * A specific order's page is preferred when one is known; warframe.market's
 * API does not currently supply one, so this is normally the item page.
 */
function marketLink(slug, name, orderUrl = null) {
  const href = orderUrl || (slug ? `https://warframe.market/items/${encodeURIComponent(slug)}` : null);
  if (!href) return `<span class="name">${esc(name)}</span>`;
  return `<a class="name link market" href="${esc(href)}" target="_blank" rel="noopener noreferrer"
    title="${MARKET_TIP}" aria-label="${esc(name)} — ${MARKET_TIP}">${esc(name)}<span class="ext" aria-hidden="true">↗</span></a>`;
}

/** The name links to warframe.market; price history stays one click away beside it. */
function itemName(r, name = r.name) {
  return `${marketLink(r.item_slug ?? r.slug, name)}<button class="hist-btn" data-act="chart" title="Price history" aria-label="Price history for ${esc(name)}">history</button>`;
}

function renderOps() {
  const q = $("#filter").value.trim().toLowerCase();
  const shown = sortRows("ops", q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows);
  const body = $("#ops tbody");

  if (!shown.length) {
    placeholderRow(body, q && rows.length
      ? 'No items match your search. Try a different name or clear the search.'
      : 'No opportunities qualify right now. Widen your filters or refresh after the next sweep.');
    return;
  }

  body.innerHTML = shown.map((r) => {
    // Both strategies start by buying, so the whisper always targets the
    // cheapest live ask.
    const target = r.seller;
    const kind = r.kind === "set" ? `set · ${r.parts ? r.parts.length : "?"} parts` : "spread";
    // Indexed into `rows`, not `shown`: the click handler looks rows up there,
    // and with a filter active the two disagree — every button acted on the
    // wrong item.
    return `<tr data-i="${rows.indexOf(r)}">
      <td><button class="star ${r.watched ? "on" : ""}" data-act="watch" aria-label="${r.watched ? "unwatch" : "watch"}">${r.watched ? "★" : "☆"}</button></td>
      <td>${itemName(r)}${r.variant ? `<span class="variant">${esc(r.variant)}</span>` : ""}
          <div class="kind">${kind}${trendTag(r.trend, r.median7d, r.median30d)}</div></td>
      <td class="r num">${plat(r.buyAt)}</td>
      <td class="r num">${plat(r.sellAt)}</td>
      <td class="r num margin">${profitCell(r)}</td>
      <td class="r num">${sellsInCell(r)}</td>
      <td class="r num">${r.volume48h}</td>
      <td class="r num">${r.score.toLocaleString()}</td>
      <td class="r num">${riskCell(r)}<span class="sub">${r.profitPerContact}p / ${r.contacts} contact${r.contacts===1?"":"s"}</span></td>
      <td class="r num">${freshness(r.bookAgeH, r.liveAt)}</td>
      <td>${rateCell(target)}${r.ghostSweeps > 1 ? `<span class="ghost" title="cheapest ask, unsold across ${r.ghostSweeps} sweeps">ghost ×${r.ghostSweeps}</span>` : ""}</td>
      <td>${playCell(r)}
          <button class="act" data-act="bought" title="record that you bought this">bought</button></td>
    </tr>`;
  }).join("");
}
sortRenderers.ops = () => renderOps();

async function fetchOps() {
  const params = new URLSearchParams();
  if ($("#kind").value) params.set("kind", $("#kind").value);
  if ($("#watched-only").checked) params.set("watched", "1");
  if ($("#sort").value !== "score") params.set("sort", $("#sort").value);
  if ($("#capital").value) params.set("maxBuyAt", $("#capital").value);
  rows = await api("/api/opportunities?" + params);
  renderOps();
}

async function copyWhisper(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

$("#ops").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn || !btn.closest("tr[data-i]")) return;
  await rowAction(btn, rows[Number(btn.closest("tr").dataset.i)], renderOps);
});

/** The actions a ranked trade offers, wherever it is listed — Opportunities or the Plan. */
async function rowAction(btn, row, rerender) {
  if (btn.dataset.act === "chart") {
    showHistory(row, { buyAt: row.buyAt, sellAt: row.sellAt });
    return;
  }

  if (btn.dataset.act === "watch") {
    await act(btn, async () => {
      await api("/api/watch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId: row.itemId, variant: row.variant, on: !row.watched }),
      });
      row.watched = !row.watched;
      rerender();
      loadStatus();
    });
    return;
  }

  if (btn.dataset.act === "why") {
    showWhy(row);
    return;
  }

  if (btn.dataset.act === "verify") {
    if (await verifyRow(row, btn)) {
      await loadOps();
      if (!$("#tab-plan").hidden) await loadPlan();
    }
    return;
  }

  if (btn.dataset.act === "bought") {
    await recordBought(row, btn);
    return;
  }

  if (btn.dataset.act === "lowball" && row.seller) {
    // Logged at the price OFFERED, not the seller's ask — the reply rate is
    // about whether lowballs get answered, which is the useful question.
    await act(btn, () => copyAndLog(btn, row.lowballWhisper, {
      itemId: row.itemId,
      userId: row.seller.userId,
      ingameName: row.seller.ingameName,
      platinum: row.postBuyAt,
      note: `${row.kind} lowball (asked ${row.seller.platinum}p)`,
    }));
    return;
  }

  if (btn.dataset.act === "parts" && row.parts) {
    await showParts(row);
    return;
  }
}

let planRows = [];
let planRoutes = [];
function loadPlan() { return loadView('plan', fetchPlan); }

async function fetchPlan() {
  const params = new URLSearchParams({
    budget: $("#plan-budget").value || "0",
    sort: $("#plan-sort").value,
    minConfidence: $("#plan-conf").value,
  });
  if ($("#plan-cap").value) params.set("maxPerItem", $("#plan-cap").value);
  if ($("#plan-reserve").value) params.set("cashReserve", $("#plan-reserve").value);
  if ($("#plan-group-cap").value) params.set("maxPerGroup", $("#plan-group-cap").value);
  const p = await api("/api/plan?" + params);
  planRows = p.picks;
  planRoutes = p.sellerRoutes ?? [];

  const days = p.picks.map((r) => r.sellDays).filter((d) => d != null).sort((a, b) => a - b);
  const typical = days.length ? days[Math.floor(days.length / 2)] : null;
  const skipped = [
    p.skipped.overCap && `${p.skipped.overCap} over the per-item limit`,
    p.skipped.held && `${p.skipped.held} already at the limit from positions you hold`,
    p.skipped.lowConfidence && `${p.skipped.lowConfidence} with too little history to trust`,
    p.skipped.overBudget && `${p.skipped.overBudget} that no longer fit the budget`,
    p.skipped.sharedStock && `${p.skipped.sharedStock} competing for stock already reserved by a higher-ranked set`,
    p.skipped.concentrated && `${p.skipped.concentrated} blocked by the category exposure limit`,
  ].filter(Boolean);
  $("#plan-summary").innerHTML = p.picks.length
    ? `<span class="stat"><span>Outlay</span><b>${p.spent.toLocaleString()}p</b><em>of ${p.deployableBudget.toLocaleString()}p deployable · ${p.cashReserve.toLocaleString()}p reserved</em></span>
       <span class="stat"><span>Expected profit</span><b>${signed(p.expectedProfit)}p</b><em>${p.spent ? Math.round((p.expectedProfit / p.spent) * 100) : 0}% on the outlay</em></span>
       <span class="stat"><span>Trades</span><b>${p.picks.length}</b><em>one per item</em></span>
       <span class="stat"><span>Typical time to sell</span><b>${fmtDays(typical)}</b><em>median of the picks</em></span>
       ${skipped.length ? `<p class="plan-skipped">Left out: ${esc(skipped.join(" · "))}.</p>` : ""}`
    : "";
  renderPlan(p);
  renderSellerRoutes();
}

function renderSellerRoutes() {
  const box = $("#plan-routes");
  box.hidden = planRoutes.length === 0;
  if (!planRoutes.length) return;
  const purchases = planRoutes.reduce((n, r) => n + r.purchases.length, 0);
  box.querySelector("summary").textContent = `Seller route · ${purchases} part purchases grouped into ${planRoutes.length} player visits`;
  box.querySelector(".route-grid").innerHTML = planRoutes.map((route, i) => `<article class="route">
    <div class="route-head"><b>${esc(route.ingameName)}</b><span>${route.totalPlatinum}p total</span></div>
    <ul>${route.purchases.map((p) => `<li>${p.units}× ${marketLink(p.item_slug, p.name)} · ${p.platinum}p each</li>`).join("")}</ul>
    <button class="act" data-route="${i}">copy ${route.purchases.length === 1 ? "whisper" : "whispers"}</button>
  </article>`).join("");
}

$("#plan-routes").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-route]");
  if (!btn) return;
  const route = planRoutes[Number(btn.dataset.route)];
  await act(btn, async () => {
    await copyWhisper(route.purchases.map((p) => p.whisper).join("\n"));
    btn.textContent = "copied";
  });
});

function renderPlan(p) {
  const body = $("#plan tbody");
  if (!planRows.length) {
    placeholderRow(body, Number($("#plan-budget").value) > 0
      ? "Nothing fits. Raise the budget or the per-item limit, or allow lower confidence."
      : "Enter the platinum you have to spend.");
    return;
  }
  const budget = p?.budget ?? Number($("#plan-budget").value);
  body.innerHTML = planRows.map((r, i) => {
    const kind = r.kind === "set" ? `set · ${r.parts ? r.parts.length : "?"} parts` : "spread";
    const expected = r.expectedMargin ?? r.margin;
    const adjusted = r.calibration && r.calibration.factor !== 1;
    return `<tr data-i="${i}">
      <td class="r num">${i + 1}</td>
      <td>${itemName(r)}${r.variant ? `<span class="variant">${esc(r.variant)}</span>` : ""}
          <div class="kind">${kind}${trendTag(r.trend, r.median7d, r.median30d)}</div></td>
      <td class="r num">${plat(r.buyAt)}</td>
      <td class="r num margin">${signed(expected)}<span class="u">p</span><span class="sub"${
        adjusted ? ` title="${esc(r.calibration.note)}"` : ""}>${adjusted ? `predicted ${signed(r.margin)}p` : `${Math.round((expected / r.buyAt) * 100)}% return`}</span></td>
      <td class="r num">${riskCell(r)}</td>
      <td class="r num">${sellsInCell(r)}</td>
      <td class="r num">${plat(r.runningTotal)}<span class="sub">${(budget - r.runningTotal).toLocaleString()}p left</span></td>
      <td>${playCell(r)}
          ${r.kind === "set" ? checklistProgress(r) : ""}
          <button class="act" data-act="bought" title="record that you bought this">bought</button></td>
    </tr>`;
  }).join("");
}

$("#plan").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn || !btn.closest("tr[data-i]")) return;
  await rowAction(btn, planRows[Number(btn.closest("tr").dataset.i)], () => renderPlan());
});
for (const id of ["#plan-budget", "#plan-cap", "#plan-reserve", "#plan-group-cap", "#plan-sort", "#plan-conf"]) $(id).addEventListener("change", () => loadPlan());
$("#plan-refresh").addEventListener("click", () => loadPlan());

/** Open a journal position from a ranked row — spread or set, either tab. */
async function recordBought(row, btn) {
  const form = await askForm(`Bought ${row.name}`, [
    {
      name: "paid",
      label: "Paid per unit (platinum)",
      type: "number",
      value: Math.round(row.buyAt),
      required: true,
      hint:
        `model assumed ${row.buyAt}p` +
        (row.seller ? `, cheapest live ask is ${row.seller.platinum}p` : ""),
    },
    { name: "qty", label: "Quantity", type: "number", value: 1, required: true },
    { name: "buyWait", label: "Hours your buy order took to fill (optional)", type: "number", value: "", hint: "This teaches PlatWatch acquisition timing separately from selling time." },
    {
      name: "target",
      label: "Target sell price per unit (platinum)",
      type: "number",
      value: Math.floor(row.sellAt),
      hint: "exit alerts fire against this — you can change it later on the Trades tab",
    },
  ], { intro: `${marketLink(row.item_slug ?? row.slug, row.name)} <span class="hint-inline">confirm the listing is still there before paying</span>` });
  if (!form) return;
  await act(btn, async () => {
    await api("/api/trades", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        itemId: row.itemId,
        variant: row.variant,
        quantity: Number(form.qty),
        buyPrice: Number(form.paid),
        boughtFrom: row.seller ? row.seller.ingameName : null,
        expectedSell: row.sellAt,
        expectedMargin: row.margin,
        ...(form.target ? { targetPrice: Number(form.target) } : {}),
        source: row.kind,
        ...(form.buyWait !== "" ? { buyWaitH: Number(form.buyWait) } : {}),
      }),
    });
    btn.textContent = "logged";
    btn.classList.add("done");
    toast(`Recorded ${row.name} on the Trades tab.`);
  });
}

/** Copy a set component's whisper and log it against that part's seller. */
function copyPartWhisper(btn, part, setName) {
  return act(btn, () => copyAndLog(btn, part.whisper, {
    itemId: part.itemId,
    userId: part.seller.userId,
    ingameName: part.seller.ingameName,
    platinum: part.seller.platinum,
    note: `set part for ${setName}`,
  }));
}

// Set checklists live in SQLite (src/trade/checklists.ts), so they survive a
// cleared browser, another machine, restarts and backups. This key is read
// once, to move progress saved by older versions into the database.
const LEGACY_CHECKLIST_KEY = "platwatch:set-checklists:v1";
let checklistStore = new Map();
async function loadChecklists() {
  const list = await api("/api/checklists");
  checklistStore = new Map(list.map((c) => [c.setItemId, c]));
  return list;
}
async function importLegacyChecklists() {
  let legacy = null;
  try { legacy = JSON.parse(localStorage.getItem(LEGACY_CHECKLIST_KEY) || "null"); } catch {}
  if (!legacy || typeof legacy !== "object" || !Object.keys(legacy).length) return;
  const { imported } = await api("/api/checklists/import", {
    method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ checklists: legacy }),
  });
  try { localStorage.removeItem(LEGACY_CHECKLIST_KEY); } catch {}
  if (imported) toast(`Moved ${imported} set checklist${imported === 1 ? "" : "s"} from this browser into the PlatWatch database.`);
}
function checklistFor(row) { return checklistStore.get(row.itemId)?.entries || {}; }
// Saves for one set run in order, so a slow request cannot land after a newer one.
const checklistSaves = new Map();
function saveChecklist(row, state) {
  const entries = structuredClone(state);
  const prior = checklistStore.get(row.itemId);
  checklistStore.set(row.itemId, {
    ...(prior ?? { setItemId: row.itemId, name: row.name, item_slug: row.item_slug, status: "active", currentRow: row }),
    entries, row,
  });
  const run = (checklistSaves.get(row.itemId) ?? Promise.resolve()).then(async () => {
    const saved = await api(`/api/checklists/${encodeURIComponent(row.itemId)}`, {
      method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ entries, row }),
    });
    const now = checklistStore.get(row.itemId);
    checklistStore.set(row.itemId, { ...now, ...saved, entries: now.entries, currentRow: now.currentRow });
  }).catch((err) => toast(`Checklist not saved: ${describeError(err)}`, "error"));
  checklistSaves.set(row.itemId, run);
  return run;
}
function checklistEntryKey(part, fill, partIndex, fillIndex) {
  const order = fill?.orderId;
  if (order) return `${part.itemId}:order:${order}`;
  const seller = fill?.seller?.userId;
  return `${part.itemId}:seller:${seller || "unavailable"}:${partIndex}:${fillIndex}`;
}
function checklistEntries(row) {
  return row.parts.flatMap((part, partIndex) =>
    (part.fills?.length ? part.fills : [{ seller: part.seller }])
      .map((fill, fillIndex) => checklistEntryKey(part, fill, partIndex, fillIndex)));
}
function checklistStatus(value) {
  if (value === true) return "purchased";
  if (typeof value === "string") return value;
  return value?.status || "needed";
}
function checklistProgress(row) {
  const entries = checklistEntries(row);
  const state = checklistFor(row);
  const done = entries.filter((key) => checklistStatus(state[key]) === "purchased").length;
  return done ? `<span class="check-progress">${done}/${entries.length} acquired</span>` : "";
}

/** One dialog listing every component to acquire, each with its own whisper. */
async function showParts(row) {
  const modal = $("#modal");
  const state = structuredClone(checklistFor(row));
  const updateTitle = () => {
    const entries = checklistEntries(row);
    const total = entries.length;
    const done = entries.filter((key) => checklistStatus(state[key]) === "purchased").length;
    $("#modal-title").textContent = `Assemble ${row.name} — ${done}/${total} purchases acquired`;
    let remaining = 0, projected = 0;
    row.parts.forEach((p, i) => (p.fills?.length ? p.fills : [{ seller:p.seller, units:p.qty, platinum:p.each }]).forEach((fill, k) => {
      const key = checklistEntryKey(p, fill, i, k), saved = state[key];
      const quoted = (fill.platinum ?? 0) * (fill.units || p.qty);
      const paid = typeof saved === "object" && Number(saved.paid) >= 0 ? Number(saved.paid) : quoted;
      projected += checklistStatus(saved) === "purchased" ? paid : quoted;
      if (checklistStatus(saved) !== "purchased") remaining += quoted;
    }));
    const summary = $("#check-summary");
    if (summary) summary.textContent = `${remaining}p still to spend · projected ${signed(row.sellAt - projected)}p profit at ${row.sellAt}p resale`;
  };
  updateTitle();
  $("#modal-ok").textContent = "Close";
  $("#modal-fields").outerHTML = `<div class="parts" id="modal-fields"><div class="modal-intro">${marketLink(row.item_slug ?? row.slug, row.name)}</div><div class="hint-inline" id="check-summary"></div>${row.parts
    .flatMap((p, i) => (p.fills?.length ? p.fills : [{
      seller: p.seller, units: p.qty, platinum: p.each, whisper: p.whisper,
    }]).map((fill, k) => {
      const key = checklistEntryKey(p, fill, i, k);
      const status = checklistStatus(state[key]);
      const paid = typeof state[key] === "object" ? state[key].paid ?? "" : "";
      return `<div class="part${status === "purchased" ? " acquired" : ""}" data-check-row="${key}">
        <label class="part-check">
          <span class="pn"><span class="pq">${fill.units || p.qty}×</span> ${marketLink(p.item_slug, p.name)}
            <span class="hint-inline">${fill.platinum == null ? "unpriced" : fill.platinum + "p each"}${
              fill.seller ? " · " + esc(fill.seller.ingameName) : " · no live seller"
            }</span></span></label>
        <select data-check="${key}" aria-label="Purchase status"><option value="needed" ${status === "needed" ? "selected" : ""}>needed</option><option value="contacted" ${status === "contacted" ? "selected" : ""}>contacted</option><option value="purchased" ${status === "purchased" ? "selected" : ""}>purchased</option><option value="unavailable" ${status === "unavailable" ? "selected" : ""}>unavailable</option></select>
        <input data-paid="${key}" type="number" min="0" step="1" value="${esc(paid)}" placeholder="paid total" title="Actual total paid for this purchase">
        ${fill.whisper ? `<button type="button" class="act" data-part="${i}" data-fill="${k}">copy</button>` : ""}
      </div>`;
    }))
    .join("")}<button type="button" class="act" data-replace="1">verify markets / find replacements</button>
    <div class="check-actions"><button type="button" class="act" data-check-status="assembled">mark assembled</button>
      <button type="button" class="act" data-check-status="removed">remove checklist</button></div></div>`;
  updateTitle();

  const onClick = async (e) => {
    const b = e.target.closest("button[data-part]");
    const replacement = e.target.closest("button[data-replace]");
    const closing = e.target.closest("button[data-check-status]");
    if (closing) {
      const status = closing.dataset.checkStatus;
      const ok = await act(closing, async () => {
        // Record the latest progress before closing it out.
        await saveChecklist(row, state);
        await api(`/api/checklists/${encodeURIComponent(row.itemId)}/status`, {
          method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ status }),
        });
      });
      if (ok) {
        modal.close();
        toast(status === "removed" ? `Removed the ${row.name} checklist.` : `${row.name} marked assembled.`);
        loadToday();
      }
      return;
    }
    if (replacement) {
      const result = await verifyRow(row, replacement);
      if (result) {
        modal.close();
        await Promise.all([loadSets(), loadChecklists()]);
        const fresh = setList.find((x) => x.itemId === row.itemId) ?? checklistStore.get(row.itemId)?.currentRow;
        showParts(fresh ?? row);
      }
      return;
    }
    if (!b) return;
    const part = row.parts[Number(b.dataset.part)];
    const fill = part.fills?.[Number(b.dataset.fill ?? 0)];
    await copyPartWhisper(b, fill ? { ...part, seller: fill.seller, whisper: fill.whisper } : part, row.name);
    const key = checklistEntryKey(part, fill, Number(b.dataset.part), Number(b.dataset.fill ?? 0));
    if (checklistStatus(state[key]) === "needed") state[key] = { status: "contacted" };
    saveChecklist(row, state);
    const select = modal.querySelector(`select[data-check="${CSS.escape(key)}"]`);
    if (select && select.value === "needed") select.value = "contacted";
  };
  const onChange = (e) => {
    const input = e.target.closest("select[data-check]");
    const paid = e.target.closest("input[data-paid]");
    if (paid) {
      const old = state[paid.dataset.paid];
      state[paid.dataset.paid] = { status: checklistStatus(old), ...(paid.value !== "" ? { paid: Number(paid.value) } : {}) };
      saveChecklist(row, state); updateTitle(); return;
    }
    if (!input) return;
    const old = state[input.dataset.check];
    state[input.dataset.check] = { status: input.value, ...(typeof old === "object" && old.paid !== undefined ? { paid: old.paid } : {}) };
    saveChecklist(row, state);
    input.closest(".part").classList.toggle("acquired", input.value === "purchased");
    updateTitle();
  };
  modal.addEventListener("click", onClick);
  modal.addEventListener("change", onChange);
  modal.addEventListener(
    "close",
    () => {
      modal.removeEventListener("click", onClick);
      modal.removeEventListener("change", onChange);
      $("#modal-ok").textContent = "Save";
      // Restore the plain form container the shared askForm() expects.
      $("#modal-fields").outerHTML = `<div class="fields" id="modal-fields"></div>`;
    },
    { once: true },
  );
  modal.showModal();
}

let setList = [];
let setTotals = { tradable: 0, priced: 0 };
const openSets = new Set();

/** Why the set is listed at the price it is — the ask, or the trades capping it. */
function setPriceNote(r) {
  if (r.cappedByTrades) return `cheapest ask ${r.setAsk}p, but sets trade at ${Math.round(r.tradedAt)}p`;
  if (r.tradedAt === null) return `undercuts the ${r.setAsk}p ask · no trade history to check it against`;
  return `undercuts the ${r.setAsk}p ask · trades at ${Math.round(r.tradedAt)}p`;
}

function setRowHtml(r, i) {
  const open = openSets.has(r.itemId);
  const known = r.unpriced === 0 && r.buyAt > 0;
  const held = r.rejects.length > 0 || r.margin <= 0;
  const short = r.parts.filter((p) => p.subtotal === null && p.each !== null).length;
  return `<tr data-i="${i}" class="set-row${held ? " held" : ""}" aria-expanded="${open}">
    <td><button class="tog" aria-label="${open ? "hide" : "show"} parts">${open ? "▾" : "▸"}</button></td>
    <td>${itemName(r)}
        <div class="kind">${r.parts.length} parts${checklistProgress(r)}${trendTag(r.trend, r.median7d, r.median30d)}${
          short ? `<span class="tag bad" title="not enough units on sale from sellers you can reach">${short} part${short > 1 ? "s" : ""} short</span>` : ""}</div>
        ${r.rejects.length ? `<div class="why">${esc(r.rejects.join("; "))}</div>` : ""}</td>
    <td class="r num">${known ? plat(r.buyAt) : "?"}</td>
    <td class="r num">${plat(r.sellAt)}
        <span class="sub${r.cappedByTrades ? " capped" : ""}">ask ${r.setAsk}${
          r.tradedAt === null ? "" : ` · trades ${Math.round(r.tradedAt)}`}</span></td>
    <td class="r num ${known && r.margin > 0 ? "margin" : ""}">${profitCell(r, known)}</td>
    <td class="r num">${sellsInCell(r)}</td>
    <td class="r num">${r.volume48h}</td>
    <td class="r num">${freshness(r.bookAgeH, r.liveAt)}</td>
    <td>${held ? "" : '<button class="act" data-act="verify">verify</button> <button class="act" data-act="parts">checklist</button> <button class="act" data-act="bought" title="record the assembled set">bought</button>'}</td>
  </tr>`;
}

/** Who a part is bought from — more than one seller when the cheapest has too few. */
function fillsHtml(p, j) {
  if (!p.fills || !p.fills.length) return '<span class="rate none">no reachable seller</span>';
  return p.fills.map((f, k) => `<div class="fill">${rateCell(f.seller)}
      <span class="sub" style="display:inline">${f.units > 1 ? `buy ${f.units} · ` : ""}${f.platinum}p${
        f.status && f.status !== "ingame" ? ` · ${esc(f.status)}` : ""}</span>
      <button class="act" data-part="${j}" data-fill="${k}">copy whisper</button></div>`).join("");
}

/** The comparison itself: each part × quantity, their sum, and the set. */
function setBreakdownHtml(r, i) {
  const known = r.unpriced === 0 && r.buyAt > 0;
  const lines = r.parts.map((p, j) => {
    const short = p.subtotal === null && p.each !== null;
    return `<tr>
      <td class="r pq">${p.qty}×</td>
      <td>${marketLink(p.item_slug, p.name)}</td>
      <td class="r num" title="cheapest reachable ask">${p.each === null ? "–" : p.each + "p"}</td>
      <td class="r num">${p.subtotal !== null ? p.subtotal + "p"
        : short ? `<span class="why" title="only ${p.available} of ${p.qty} on sale from sellers you can reach">${p.available} of ${p.qty}</span>`
        : '<span class="why">unpriced</span>'}</td>
      <td class="r num sub" style="display:table-cell">${p.volume48h ?? 0}/48h</td>
      <td>${fillsHtml(p, j)}</td>
    </tr>`;
  }).join("");
  return `<tr class="breakdown" data-i="${i}"><td></td><td colspan="8">
    <table class="bd"><tbody>${lines}
      <tr class="tot first"><td></td><td>Parts, bought separately</td><td></td>
        <td class="r num">${known ? r.buyAt + "p" : "?"}</td><td colspan="2"></td></tr>
      <tr class="tot"><td></td><td>Set, sold assembled</td><td></td>
        <td class="r num">${r.sellAt}p</td>
        <td colspan="2" class="sub${r.cappedByTrades ? " capped" : ""}" style="display:table-cell">${esc(setPriceNote(r))}</td></tr>
      <tr class="tot"><td></td><td><b>Net profit</b></td><td></td>
        <td class="r num ${!known ? "" : r.margin > 0 ? "margin" : "loss"}">${known ? signed(r.margin) + "p" : "?"}</td>
        <td colspan="2"></td></tr>
    </tbody></table></td></tr>`;
}

function renderSets() {
  const q = $("#set-filter").value.trim().toLowerCase();
  const body = $("#sets tbody");
  // Keep each row's index into setList, which is what the click handler reads.
  const shown = sortRows("sets", setList
    .map((r, i) => [r, i])
    .filter(([r]) => !q || r.name.toLowerCase().includes(q)), ([r]) => r);

  $("#set-count").innerHTML = `<b>${setTotals.tradable}</b> tradable of <b>${setTotals.priced}</b> fully priced sets`;

  if (!shown.length) {
    placeholderRow(body, setTotals.priced === 0
      ? "No priced sets yet — the first sweep has to finish."
      : setList.length
        ? "Nothing matches the filter."
        : "No set clears the policy right now. Tick “show held back” to see why.");
    return;
  }
  body.innerHTML = shown
    .map(([r, i]) => setRowHtml(r, i) + (openSets.has(r.itemId) ? setBreakdownHtml(r, i) : ""))
    .join("");
}
sortRenderers.sets = () => renderSets();

async function fetchSets() {
  const params = new URLSearchParams();
  if ($("#set-sort").value !== "margin") params.set("sort", $("#set-sort").value);
  if ($("#set-capital").value) params.set("maxBuyAt", $("#set-capital").value);
  if ($("#set-held").checked) params.set("heldBack", "1");
  const res = await api("/api/sets?" + params);
  setList = res.rows;
  setTotals = { tradable: res.tradable, priced: res.priced };
  renderSets();
}

$("#sets").addEventListener("click", async (e) => {
  // A warframe.market link opens its page; it must not also fold the row.
  if (e.target.closest("a")) return;
  const tr = e.target.closest("tr[data-i]");
  if (!tr) return;
  const row = setList[Number(tr.dataset.i)];
  const btn = e.target.closest("button");

  if (btn?.dataset.act === "chart") {
    showHistory(row, { buyAt: row.buyAt || null, sellAt: row.sellAt });
    return;
  }
  if (btn?.dataset.act === "bought") {
    await recordBought(row, btn);
    return;
  }

  if (btn?.dataset.act === "verify") {
    if (await verifyRow(row, btn)) {
      if (row.kind === "set") await loadSets();
      await loadOps();
      if (!$("#tab-plan").hidden) await loadPlan();
    }
    return;
  }
  if (btn?.dataset.act === "parts") {
    await showParts(row);
    return;
  }
  if (btn?.dataset.part !== undefined) {
    const part = row.parts[Number(btn.dataset.part)];
    const fill = part.fills?.[Number(btn.dataset.fill ?? 0)];
    await copyPartWhisper(btn, fill ? { ...part, seller: fill.seller, whisper: fill.whisper } : part, row.name);
    return;
  }
  if (tr.classList.contains("set-row")) {
    if (openSets.has(row.itemId)) openSets.delete(row.itemId);
    else openSets.add(row.itemId);
    renderSets();
  }
});

$("#set-filter").addEventListener("input", renderSets);
$("#set-sort").addEventListener("change", () => { clearSort("sets"); loadSets(); });
$("#set-capital").addEventListener("change", loadSets);
$("#set-held").addEventListener("change", loadSets);
$("#set-refresh").addEventListener("click", loadSets);

let alertList = [];
/** Repeated alerts (same item, variant, side and price) expanded by the user. */
const openAlertGroups = new Set();
let showSuspicious = false;

const alertGroupKey = (a) => `${a.item_id}|${a.variant}|${a.kind}|${a.platinum}`;

function alertRowHtml(a, i, group) {
  const side = a.kind === "underpriced_sell" ? "buy" : "sell";
  const whisper = `/w ${a.ingame_name} Hi! I want to ${side}: "${a.item_name}" for ${a.platinum} platinum. (warframe.market)`;
  const fired = new Date(a.fired_at);
  const today = fired.toDateString() === new Date().toDateString();
  // Strong only with fresh sourcing evidence; otherwise the row says to check first.
  const evidence = a.suspicious ? ""
    : a.actionable
      ? `<span class="tag good" title="${esc(a.sourcingDetail)}">actionable</span>`
      : `<span class="tag warn" title="${esc(a.sourcingDetail)}">verify first</span>`;
  const repeats = group.head && group.count > 1
    ? `<button class="act group-toggle" data-group="${esc(group.key)}" aria-expanded="${group.open}"
         title="The same item and price fired ${group.count} times">×${group.count} ${group.open ? "▾" : "▸"}</button>` : "";
  const outcome = (value, label) => `<option value="${value}" ${a.outcome === value ? "selected" : ""}>${label}</option>`;
  return `<tr data-i="${i}" class="${group.head ? "" : "alert-repeat"}${a.actionable ? "" : " unverified"}">
    <td class="num" title="${esc(fired.toLocaleString())}">${today ? fired.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : fired.toLocaleDateString([], { month: "short", day: "numeric" })}</td>
    <td class="kind">${a.kind === "underpriced_sell" ? "buy it" : "sell to them"}</td>
    <td>${itemName(a, a.item_name)}${a.suspicious ? '<span class="tag bad" title="so far off the market it is more likely a mistake or bait">suspicious</span>' : ""}${repeats}</td>
    <td class="r num">${fmtNum(a.platinum)}<span class="u">p</span></td>
    <td class="r num">${fmtNum(a.reference)}<span class="u">p</span></td>
    <td class="r num ${a.actionable ? "margin" : "muted"}">+${fmtNum(a.profit)}<span class="u">p</span><span class="sub">${evidence}</span></td>
    <td class="r num">${trendTag(a.trend, a.median7d, a.median30d) || '<span class="u">flat</span>'}</td>
    <td class="r num">${a.volume_48h ?? "–"}</td>
    <td class="who">${esc(a.ingame_name)} <span class="rate none">${esc(a.user_status)}</span></td>
    <td><button class="act" data-w="${esc(whisper)}" aria-label="Copy whisper to ${esc(a.ingame_name)}">copy</button></td>
    <td><select data-outcome="1" aria-label="Outcome for ${esc(a.item_name)}"><option value="">not reviewed</option>${outcome("bought", a.kind === "underpriced_sell" ? "bought" : "sold")}${outcome("already_gone", "already gone")}${outcome("no_reply", "no reply")}${outcome("margin_disappeared", "margin disappeared")}</select>${
      a.outcome === "bought" && !a.trade_linked ? '<button class="act" data-act="journal-alert">add to trades</button>' : ""}${
      a.trade_linked ? '<span class="sub">in Trades &amp; P&amp;L</span>' : ""}${
      a.realised_profit != null ? `<span class="sub margin">${signed(Math.round(a.realised_profit))}p realised</span>` : ""}</td>
  </tr>`;
}

function renderAlerts() {
  const q = $("#alert-filter").value.trim().toLowerCase();
  const body = $("#alerts tbody");
  const shown = sortRows("alerts", alertList
    .map((a, i) => [a, i])
    .filter(([a]) => !q || a.item_name.toLowerCase().includes(q)), ([a]) => a);
  if (!shown.length) {
    placeholderRow(body, alertList.length
      ? "No alerts match the filter."
      : "No alerts yet. The live watcher fires them as underpriced listings appear.");
    return;
  }
  // One row per item and price, newest first; the repeats fold underneath it.
  const rowsFor = (list) => {
    const groups = new Map();
    for (const [a, i] of list) {
      const key = alertGroupKey(a);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push([a, i]);
    }
    return [...groups].map(([key, members]) => {
      const open = openAlertGroups.has(key);
      return members.map(([a, i], k) => k === 0 || open
        ? alertRowHtml(a, i, { key, count: members.length, head: k === 0, open }) : "").join("");
    }).join("");
  };
  const genuine = shown.filter(([a]) => !a.suspicious);
  const suspicious = shown.filter(([a]) => a.suspicious);
  const cols = $("#alerts thead tr").children.length;
  body.innerHTML = rowsFor(genuine) + (suspicious.length
    ? `<tr class="suspicious-toggle"><td colspan="${cols}"><button class="act" data-act="toggle-suspicious" aria-expanded="${showSuspicious}">${
        showSuspicious ? "Hide" : "Show"} ${suspicious.length} suspicious alert${suspicious.length === 1 ? "" : "s"}</button>
        <span class="sub" style="display:inline">priced so far off the market they are more likely mistakes or bait</span></td></tr>` +
      (showSuspicious ? rowsFor(suspicious) : "")
    : "");
}
sortRenderers.alerts = () => renderAlerts();

async function fetchAlerts() {
  const [alerts, performance] = await Promise.all([api("/api/alerts"), api("/api/alerts/performance")]);
  alertList = alerts;
  $("#alert-performance").textContent = `${performance.reviewed}/${performance.total} reviewed · ${performance.conversionRate == null ? "–" : Math.round(performance.conversionRate*100)+"%"} bought · ${signed(performance.realisedProfit)}p realised across ${performance.realisedLots} sale${performance.realisedLots === 1 ? "" : "s"}`;
  $("#alert-recommendations").hidden=!performance.recommendations.length;
  $("#alert-recommendations").textContent=performance.recommendations.join(" ");
  renderAlerts();
}

$("#alerts").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (btn.dataset.act === "toggle-suspicious") {
    showSuspicious = !showSuspicious;
    renderAlerts();
    return;
  }
  if (btn.dataset.group !== undefined) {
    if (openAlertGroups.has(btn.dataset.group)) openAlertGroups.delete(btn.dataset.group);
    else openAlertGroups.add(btn.dataset.group);
    renderAlerts();
    return;
  }
  if (!btn.closest("tr[data-i]")) return;
  const a = alertList[Number(btn.closest("tr").dataset.i)];
  if (btn.dataset.act === "chart") {
    showHistory({ itemId: a.item_id, variant: a.variant, name: a.item_name, item_slug: a.item_slug },
      a.kind === "underpriced_sell" ? { buyAt: a.platinum, sellAt: a.reference } : { buyAt: a.reference, sellAt: a.platinum });
    return;
  }
  if (btn.dataset.w) {
    await act(btn, () => copyAndLog(btn, btn.dataset.w, {
      orderId: a.order_id, itemId: a.item_id,
      userId: a.user_id || `alert:${a.order_id}`,
      ingameName: a.ingame_name, platinum: a.platinum,
      note: `live alert: ${a.kind}`,
    }));
  }
  // Repair: an outcome recorded as bought/sold before trades were linked to it.
  if (btn.dataset.act === "journal-alert") {
    await act(btn, async () => {
      if (await recordAlertOutcome(a)) { await fetchAlerts(); loadStatus(); }
    });
  }
});
$("#alert-filter").addEventListener("input", renderAlerts);
$("#alert-refresh").addEventListener("click", () => loadAlerts());

async function loadSettings(){ const s=await api("/api/settings");
  $("#setting-webhook").value=s.discordWebhook; $("#setting-budget").value=s.defaultBudget; $("#setting-cap").value=s.maxPerItem; $("#setting-reserve").value=s.cashReserve; $("#setting-group-cap").value=s.maxPerGroup;
  $("#setting-confidence").value=s.minConfidence; $("#setting-poll").value=s.pollSeconds;
  $("#setting-discount").value=Math.round(s.alert.sellDiscount*100); $("#setting-premium").value=Math.round(s.alert.buyPremium*100);
  $("#setting-profit").value=s.alert.minProfit; $("#setting-volume").value=s.alert.minVolume48h;
  const h=await api("/api/status"); const age=(iso)=>iso?Math.max(0,Math.round((Date.now()-Date.parse(iso))/60000))+"m ago":"never";
  $("#health-poll").textContent=h.livePoll.lastError?"failed":age(h.livePoll.lastSuccess);
  // What the running daemon actually has switched on — "disabled" for toasts under --no-toast.
  for (const n of h.notifications) {
    const el = $("#health-" + n.name);
    el.textContent = n.state === "unknown" ? "unknown"
      : !n.enabled ? (n.name === "discord" ? "not set" : "disabled")
      : n.lastError ? "enabled · failing"
      : n.lastSuccess ? `enabled · sent ${age(n.lastSuccess)}` : "enabled";
    el.dataset.state = n.enabled ? (n.lastError ? "failing" : "enabled") : "disabled";
    el.title = [n.detail, n.lastError, n.name === "discord" ? `${n.pending} queued` : ""].filter(Boolean).join(" · ");
  }
  const backups=await api("/api/backups"); $("#backup-list").innerHTML=backups.length?backups.map(b=>`<button class="act" data-restore="${esc(b.name)}">restore ${new Date(b.modifiedAt).toLocaleString()} · ${(b.bytes/1048576).toFixed(1)} MB</button>`).join(""):"No backups yet.";
}
$("#settings-form").addEventListener("submit",async(e)=>{e.preventDefault(); const body={discordWebhook:$("#setting-webhook").value,defaultBudget:Number($("#setting-budget").value),maxPerItem:Number($("#setting-cap").value),cashReserve:Number($("#setting-reserve").value),maxPerGroup:Number($("#setting-group-cap").value),minConfidence:$("#setting-confidence").value,pollSeconds:Number($("#setting-poll").value),alert:{sellDiscount:Number($("#setting-discount").value)/100,buyPremium:Number($("#setting-premium").value)/100,minProfit:Number($("#setting-profit").value),minVolume48h:Number($("#setting-volume").value)}}; await api("/api/settings",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(body)}); $("#plan-budget").value=body.defaultBudget; $("#plan-cap").value=body.maxPerItem; $("#plan-reserve").value=body.cashReserve; $("#plan-group-cap").value=body.maxPerGroup; $("#plan-conf").value=body.minConfidence; toast("Settings saved and applied.");});
$("#test-notification").addEventListener("click",e=>act(e.currentTarget,async()=>{await api("/api/settings/test-notification",{method:"POST"});toast("Test notification sent.");}));
$("#backup-list").addEventListener("click",async e=>{const btn=e.target.closest("button[data-restore]");if(!btn)return;const answer=await askForm("Restore this backup?",[{name:"confirm",label:'Type "restore" to create a safety backup and restart PlatWatch'}]);if(!answer||answer.confirm.trim().toLowerCase()!=="restore")return;await api("/api/restore",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:btn.dataset.restore})});toast("Restore staged. PlatWatch is restarting…");});

async function fetchLog() {
  const list = await api("/api/whispers");
  const body = $("#log tbody");
  if (!list.length) {
    placeholderRow(body, "Nothing logged yet. Copying a whisper records it here.");
    return;
  }
  body.innerHTML = list.map((w) => `<tr data-id="${w.id}">
    <td class="num">${new Date(w.sent_at).toLocaleString()}</td>
    <td>${marketLink(w.item_slug, w.item_name)}</td>
    <td class="who">${esc(w.ingame_name)}</td>
    <td class="r num">${w.platinum}</td>
    <td>
      ${w.replied === null || w.replied === undefined
        ? `<button class="act" data-r="1">replied</button> <button class="act" data-r="0">no reply</button>`
        : w.replied
          ? `<span class="rate good">replied</span> ${w.traded ? '<span class="rate good">· traded</span>' : '<button class="act" data-t="1">mark traded</button>'}`
          : `<span class="rate bad">no reply</span>`}
    </td>
  </tr>`).join("");
}

$("#log").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn || !btn.closest("tr[data-id]")) return;
  const id = btn.closest("tr").dataset.id;
  const patch = btn.dataset.r !== undefined
    ? { replied: btn.dataset.r === "1" }
    : { traded: true };
  const ok = await act(btn, () => api("/api/whispers/" + id, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  }));
  if (ok) loadLog();
});
$("#log-refresh").addEventListener("click", () => loadLog());

let trades = [];

async function fetchTrades() {
  const [list, p] = await Promise.all([api("/api/trades"), api("/api/pnl")]);
  trades = list;

  const sign = (n) => (n > 0 ? `+${n}` : String(n));
  const cls = (n) => (n > 0 ? "margin" : n < 0 ? "rate bad" : "");
  $("#pnl-bar").innerHTML = `
    <span class="stat">total realised <b class="${cls(p.realised)}">${sign(p.realised)}p</b><small>${sign(p.realised30d)}p last 30d · ${sign(p.realised7d)}p last 7d</small></span>
    <span class="stat">win rate <b>${p.winRate === null ? "–" : Math.round(p.winRate * 100) + "%"}</b><small>${p.wins} wins · ${p.losses} losses</small></span>
    <span class="stat">capital invested <b>${p.openCost}p</b><small>${p.openCount} open position${p.openCount === 1 ? "" : "s"}</small></span>
    <span class="stat">inventory value <b>${p.openMarketValue === null ? "–" : p.openMarketValue + "p"}</b><small>current reachable ask</small></span>
    <span class="stat">expected open profit <b class="${cls(p.expectedOpenProfit || 0)}">${p.expectedOpenProfit === null ? "–" : sign(p.expectedOpenProfit) + "p"}</b><small>if targets fill</small></span>
    <span class="stat">unrealised <b class="${cls(p.openMarkToMarket || 0)}">${p.openMarkToMarket === null ? "–" : sign(p.openMarkToMarket) + "p"}</b><small>marked to current asks</small></span>
    <span class="stat">capital return <b>${p.capitalReturn === null ? "–" : Math.round(p.capitalReturn * 100) + "%"}</b><small>realised profit / closed outlay</small></span>
    <span class="stat">capital sitting <b class="${p.staleCost > 0 ? "rate bad" : ""}">${p.staleCost}p</b><small>${p.averageHoldH === null ? "no closed trades" : `avg hold ${fmtHeld(Number(p.averageHoldH.toFixed(1)))}`}</small></span>`;
  $("#pnl-bar").insertAdjacentHTML("beforeend", `<span class="stat">buy-order fill <b>${p.averageBuyWaitH === null ? "–" : fmtHeld(Number(p.averageBuyWaitH.toFixed(1)))}</b><small>${p.buyWaitSamples} measured fill${p.buyWaitSamples === 1 ? "" : "s"}</small></span>`);

  $("#calib tbody").innerHTML = p.bySource.length
    ? p.bySource.map((c) => {
        const thin = c.closed < 20;
        const rigged = c.exactMatches > 0;
        const notes = [];
        if (rigged) notes.push(`${c.exactMatches} sold at exactly the predicted price`);
        if (thin) notes.push(`only ${c.closed} trade${c.closed === 1 ? "" : "s"}`);
        const adj = c.factor == null ? "–"
          : Math.abs(c.factor - 1) < 0.005 ? "none yet"
          : `×${c.factor.toFixed(2)}`;
        return `<tr>
        <td class="kind">${esc(c.source)}</td>
        <td class="r num">${c.closed}</td>
        <td class="r num">${c.expected === null ? "–" : c.expected.toFixed(1) + "p"}</td>
        <td class="r num">${c.actual === null ? "–" : c.actual.toFixed(1) + "p"}</td>
        <td class="r num ${c.ratio === null ? "" : c.ratio < 0.8 ? "rate bad" : "margin"}">${
          c.ratio === null ? "–" : c.ratio.toFixed(2)}</td>
        <td class="r num" title="${esc(c.note ?? "")}">${adj}</td>
        <td class="rate ${notes.length ? "bad" : "good"}">${
          notes.length ? esc(notes.join("; ")) : "usable"}</td>
      </tr>`;
      }).join("")
    : `<tr><td colspan="7" class="empty">No closed trades yet — calibration needs a few dozen.</td></tr>`;

  $("#trades tbody").innerHTML = list.length
    ? list.map((t, i) => {
        const open = t.profit === null;
        const unreal = open && t.marketNow !== null ? (t.marketNow - t.buyPrice) * t.quantity : null;
        return `<tr data-i="${i}">
          <td>${itemName(t)}${t.variant ? `<span class="variant">${esc(t.variant)}</span>` : ""}
              <div class="kind">${esc(t.source)}${t.parentTradeId ? ` · sold from #${t.parentTradeId}` : ` · #${t.id}`}${t.alertId ? ` · alert #${t.alertId}` : ""}</div></td>
          <td class="r num">${t.quantity}</td>
          <td class="r num">${plat(t.buyPrice)}</td>
          <td class="r num">${open
            ? `${t.targetPrice == null ? "–" : plat(t.targetPrice)}<span class="sub"><button class="linkish" data-act="target">${t.targetPrice == null ? "set target" : "change"}</button></span>`
            : plat(t.sellPrice)}</td>
          <td class="r num">${plat(t.marketNow)}</td>
          <td class="r num ${open ? "" : cls(t.profit)}">${
            open ? (unreal === null ? "–" : `<span class="rate none">${sign(unreal)}p unreal.</span>`) : sign(t.profit) + "p"}</td>
          <td class="r num">${fmtHeld(t.heldH)}</td>
          <td>${open ? decisionCell(t) : adviceCell(t)}</td>
          <td>${open ? `<button class="act" data-act="sold">sold</button> ` : ""}
              <button class="act" data-act="correct">correct</button>
              <button class="act" data-act="audit">history</button>
              <button class="act" data-act="drop" title="delete this record">✕</button></td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="9" class="empty">Nothing yet. Use "bought" on an opportunity to open a position.</td></tr>`;
}

const fmtHeld = (h) => (h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : h < 48 ? `${Math.round(h)}h` : `${(h / 24).toFixed(1)}d`);

/**
 * Exit signals for an open position — the sell leg is where platinum sits
 * waiting. Computed server-side from the same book the ranking reads; the
 * daemon also sends each one as a notification when it first appears.
 */
function exitCell(t) {
  if (!t.exits || !t.exits.length) return "";
  return `<div class="exits">${t.exits.map((x, k) => {
    const cls = x.kind === "target_bid" ? "good" : x.kind === "stale" ? "warn" : "bad";
    return `<div><span class="tag ${cls}" style="margin-left:0">${esc(x.label)}</span> <span class="sub" style="display:inline">${esc(x.detail)}</span>${
      x.whisper ? ` <button class="act" data-act="exit-whisper" data-k="${k}">copy whisper</button>` : ""}</div>`;
  }).join("")}</div>`;
}

async function verifyRow(row, btn) {
  const itemIds = [...new Set([row.itemId, ...(row.parts ?? []).map((p) => p.itemId)])];
  const result = await act(btn, () => api("/api/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ itemIds }),
  }));
  if (!result) return null;
  toast(`Verified ${result.ok}/${itemIds.length} markets just now${result.failed ? ` · ${result.failed} failed` : ""}.`);
  return result;
}

function decisionCell(t) {
  const d = t.sellDecision;
  if (!d) return adviceCell(t);
  const tone = d.kind === "sell_now" ? "good" : d.kind === "reprice" || d.kind === "review" ? "warn" : "none";
  // A listing is whole platinum even when the prediction behind it is not.
  const price = d.price === null ? null : Math.round(d.price);
  const canApply = price !== null && price !== (t.targetPrice == null ? null : Math.round(t.targetPrice)) && d.kind !== "sell_now";
  const canCopy = price !== null && d.kind !== "sell_now";
  return `<div class="decision"><div><span class="tag ${tone}" style="margin-left:0">${esc(d.label)}</span>
    <span class="sub" style="display:inline">${esc(d.detail)}</span></div>
    <div class="decision-actions">${canApply ? `<button class="act" data-act="apply-price" data-price="${price}">use ${price}p target</button>` : ""}
    ${canCopy ? `<button class="act" data-act="copy-listing" data-price="${price}">copy listing</button>` : ""}
    ${d.kind === "sell_now" ? exitCell(t) : ""}</div></div>`;
}

/**
 * The sell leg, which is where the waiting actually happens.
 *
 * Shows both numbers because either alone misleads: undercutting the book gets
 * you seen, the traded median is where people actually buy, and when the book
 * has drifted above the market those are very different prices.
 */
function adviceCell(t) {
  if (t.profit !== null) return `<span class="kind">${esc(t.source)}</span>`;
  const a = t.advice;
  if (!a || a.fairPrice === null) return `<span class="rate none">no price data</span>`;

  // Each wait is labelled with the price it applies to: the fair-price wait is
  // not how long a higher target takes.
  const wait =
    a.estimatedDaysAtFair === null
      ? "no volume to estimate"
      : a.queueAtFair === 0
        ? `at ${a.fairPrice}p: first in queue, ~${a.dailyVolume}/day`
        : `at ${a.fairPrice}p: ${a.queueAtFair} ahead · ${fmtDays(a.estimatedDaysAtFair)}`;
  const e = t.targetEstimate;
  const atTarget = !e ? ""
    : e.days === null ? ` · at your ${Math.round(e.price)}p target: ${e.basis}`
    : ` · at your ${Math.round(e.price)}p target: ${fmtDays(e.days)} (${e.queue} below)`;

  return `<span class="play"><b>${a.fairPrice}p</b>${
    a.quickPrice !== null && a.quickPrice !== a.fairPrice ? ` · quick ${a.quickPrice}p` : ""
  }${a.patientPrice !== null && a.patientPrice > a.fairPrice ? ` · patient ${a.patientPrice}p` : ""}</span>
    <div class="hint-inline">${esc(wait + atTarget)}${
      a.bookAboveMarket ? " · book sits above the traded range" : ""
    }</div>`;
}

$("#trades").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn || !btn.closest("tr[data-i]")) return;
  const t = trades[Number(btn.closest("tr").dataset.i)];

  if (btn.dataset.act === "chart") {
    showHistory(t, { buyAt: t.buyPrice, sellAt: t.targetPrice ?? t.sellPrice });
    return;
  }

  if (btn.dataset.act === "exit-whisper") {
    const x = t.exits[Number(btn.dataset.k)];
    await act(btn, () => copyAndLog(btn, x.whisper, {
      itemId: t.itemId,
      userId: x.buyer.userId,
      ingameName: x.buyer.ingameName,
      platinum: x.buyer.platinum,
      note: `exit: selling ${t.name} to a bid at or above target`,
    }));
    return;
  }

  if (btn.dataset.act === "apply-price") {
    const price = Number(btn.dataset.price);
    const ok = await act(btn, () => api(`/api/trades/${t.id}/target`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetPrice: price }),
    }));
    if (ok) { toast(`${t.name} target set to ${price}p`); loadTrades(); }
    return;
  }

  if (btn.dataset.act === "copy-listing") {
    const price = Number(btn.dataset.price);
    await act(btn, async () => {
      await copyWhisper(`${t.name}${t.variant ? ` (${t.variant})` : ""} — sell ${t.quantity} × ${price}p each`);
      btn.textContent = "copied";
    });
    return;
  }

  if (btn.dataset.act === "target") {
    const form = await askForm(`Target for ${t.name}`, [
      {
        name: "target",
        label: "Sell at, per unit (platinum)",
        type: "number",
        value: t.targetPrice == null ? "" : Math.round(t.targetPrice),
        required: true,
        hint:
          `bought at ${t.buyPrice}p` +
          (t.advice && t.advice.fairPrice !== null ? ` · clears around ${t.advice.fairPrice}p` : "") +
          " · alerts fire when a buyer bids this, when asks undercut it, or when it sits too long",
      },
    ]);
    if (!form) return;
    const ok = await act(btn, () => api(`/api/trades/${t.id}/target`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetPrice: Number(form.target) }),
    }));
    if (ok) loadTrades();
    return;
  }

  if (btn.dataset.act === "correct") {
    const form=await askForm(`Correct ${t.name}`,[{name:"qty",label:"Quantity",type:"number",value:t.quantity,required:true},{name:"buyPrice",label:"Buy price per unit",type:"number",value:t.buyPrice,required:true},{name:"note",label:"Reason for correction",required:true}]);
    if(!form)return; const ok=await act(btn,()=>api(`/api/trades/${t.id}/correct`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({quantity:Number(form.qty),buyPrice:Number(form.buyPrice),note:form.note})})); if(ok)loadTrades(); return;
  }
  if (btn.dataset.act === "audit") {
    const rows=await api(`/api/trades/${t.id}/audit`); $("#why-title").textContent=`History · ${t.name}`; $("#why-summary").textContent="Immutable journal changes"; $("#why-body").innerHTML=rows.length?`<table><thead><tr><th>When</th><th>Change</th><th>Note</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${new Date(r.createdAt).toLocaleString()}</td><td>${esc(r.action.replaceAll("_"," "))}</td><td>${esc(r.note||"")}</td></tr>`).join("")}</tbody></table>`:"<p>No history recorded.</p>"; $("#why").showModal(); return;
  }

  if (btn.dataset.act === "drop") {
    const ok = await askForm(`Delete the ${t.name} position?`, [
      { name: "confirm", label: 'Type "delete" to remove this record permanently' },
    ]);
    if (!ok || ok.confirm.trim().toLowerCase() !== "delete") return;
    if (await act(btn, () => api("/api/trades/" + t.id, { method: "DELETE" }))) loadTrades();
    return;
  }
  if (btn.dataset.act !== "sold") return;

  // Deliberately NOT pre-filled with expectedSell. This number is the one the
  // calibration table measures the prediction against; defaulting it to the
  // prediction makes every trade score a perfect match by construction, and the
  // ratio becomes a statement about the form rather than about the market.
  const form = await askForm(`Sold ${t.name}`, [
    ...(t.quantity > 1 ? [{
      name: "qty",
      label: `Quantity sold (${t.quantity} held)`,
      type: "number",
      value: t.quantity,
      required: true,
      hint: "The unsold quantity remains open at its original cost and target.",
    }] : []),
    {
      name: "got",
      label: "Sold for per unit (platinum)",
      type: "number",
      value: "",
      required: true,
      hint:
        `for reference — predicted ${t.expectedSell ?? "?"}p` +
        (t.marketNow === null ? "" : `, market now ${t.marketNow}p`) +
        (t.advice && t.advice.fairPrice !== null ? `, clears around ${t.advice.fairPrice}p` : ""),
    },
    { name: "to", label: "Sold to (optional)" },
  ], { intro: marketLink(t.item_slug, t.name) });
  if (!form) return;
  const ok = await act(btn, () => api("/api/trades/" + t.id, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sellPrice: Number(form.got),
      quantity: t.quantity > 1 ? Number(form.qty) : 1,
      soldTo: form.to || null,
    }),
  }));
  if (ok) loadTrades();
});

async function fetchDucats() {
  const params = new URLSearchParams();
  const budget = $("#duc-budget").value;
  const cap = $("#duc-cap").value;
  if (budget) params.set("budget", budget);
  if (cap) params.set("maxBuyAt", cap);
  const { rows, total, plan } = await api("/api/ducats?" + params);
  ducatList = rows;

  $("#duc-plan").innerHTML = plan
    ? `<b>${plan.ducats.toLocaleString()}</b> ducats from <b>${plan.items}</b> items
       for <b>${plan.spent}p</b> — <b>${plan.ducatsPerPlat}</b> per plat blended
       <span class="rate none">(${total} conversions qualify)</span>`
    : `<span class="rate none">${total} conversions qualify</span>`;
  renderDucats();
}

let ducatList = [];
function renderDucats() {
  const rows = sortRows("ducats", ducatList);
  $("#ducats tbody").innerHTML = rows.length
    ? rows.map((r) => `<tr>
        <td>${marketLink(r.item_slug, r.name)}</td>
        <td class="r num">${r.ducats}</td>
        <td class="r num">${plat(r.buyAt)}</td>
        <td class="r num margin">${r.ducatsPerPlat}</td>
        <td class="r num">${r.volume48h}</td>
        <td class="r num">${r.tradedMedian === null ? "–" : r.tradedMedian.toFixed(1) + '<span class="u">p</span>'}</td>
        <td class="r num">${freshness(r.bookAgeH, r.liveAt)}</td>
      </tr>`).join("")
    : `<tr><td colspan="7" class="empty">Nothing clears the rate floor right now.</td></tr>`;
}
sortRenderers.ducats = () => renderDucats();

$("#duc-refresh").addEventListener("click", loadDucats);
$("#duc-budget").addEventListener("change", loadDucats);
$("#duc-cap").addEventListener("change", loadDucats);

// ── price history ─────────────────────────────────────────────────────────
// Recent traded prices and volume, so an apparent bargain can be judged
// against the market it sits in: unusual, or just part of a decline.

const hist = { data: null, days: 90, table: false, refs: {}, geo: null };

async function showHistory(item, refs = {}) {
  const dlg = $("#history");
  hist.refs = refs;
  hist.data = null;
  $("#hist-title").innerHTML = marketLink(item.item_slug ?? item.slug, item.name) +
    (item.variant ? ` <span class="variant">${esc(item.variant)}</span>` : "");
  $("#hist-summary").textContent = "Loading price history…";
  $("#hist-body").innerHTML = "";
  paintHistControls();
  if (!dlg.open) dlg.showModal();
  try {
    const params = new URLSearchParams({ itemId: item.itemId, variant: item.variant ?? "", days: "90" });
    hist.data = await api("/api/history?" + params);
    renderHistory();
  } catch (err) {
    $("#hist-summary").textContent = "";
    $("#hist-body").innerHTML = `<p class="empty">Couldn't load price history: ${esc(describeError(err))}</p>`;
  }
}

function paintHistControls() {
  for (const b of document.querySelectorAll("#history .seg button")) {
    b.setAttribute("aria-pressed", String(Number(b.dataset.days) === hist.days));
  }
  $("#hist-view").setAttribute("aria-pressed", String(hist.table));
  $("#hist-view").textContent = hist.table ? "chart" : "table";
}

function renderHistory() {
  const d = hist.data;
  if (!d) return;
  const cutoff = new Date(Date.now() - hist.days * 86_400_000).toISOString().slice(0, 10);
  const days = d.days.filter((x) => x.day >= cutoff && x.median != null);

  const bits = [];
  if (d.median7d != null) bits.push(`traded ${Math.round(d.median7d)}p this week`);
  if (d.median30d != null) bits.push(`${Math.round(d.median30d)}p over 30 days`);
  if (d.trend != null && Math.abs(d.trend) >= 0.05) bits.push(`${d.trend < 0 ? "▼" : "▲"} ${Math.round(Math.abs(d.trend) * 100)}%`);
  if (d.volume7d != null) bits.push(`about ${(d.volume7d / 7).toFixed(1)} sold a day`);
  $("#hist-summary").textContent = bits.join(" · ") || "No trade summary for this item.";

  if (!days.length) {
    $("#hist-body").innerHTML = `<p class="empty">No trades recorded in the last ${hist.days} days.</p>`;
    return;
  }
  $("#hist-body").innerHTML = hist.table ? histTable(days) : histChart(days);
  if (!hist.table) wireCrosshair(days);
}

/** Round tick values: 0 / 20 / 40, never 13.7 / 27.4. */
function niceTicks(lo, hi, count) {
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.001; v += step) ticks.push(Number(v.toFixed(6)));
  if (ticks.at(-1) < hi) ticks.push(ticks.at(-1) + step);
  return ticks;
}

const fmtP = (v) => (v == null ? "–" : Number.isInteger(v) ? String(v) : v.toFixed(1));
const fmtDay = (day) => new Date(day + "T00:00:00Z").toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });

function histChart(days) {
  const W = Math.max(320, $("#hist-body").clientWidth - 44);
  const m = { l: 44, r: 74, t: 22 };
  const PH = 200, GAP = 34, VH = 60, XB = 22;
  const H = m.t + PH + GAP + VH + XB;
  const pw = W - m.l - m.r;

  // A continuous date axis: the API omits days without trades, and squeezing
  // them out would make a quiet week look like a busy one.
  const t0 = Date.parse(days[0].day), t1 = Date.parse(days.at(-1).day);
  const span = Math.max(1, (t1 - t0) / 86_400_000);
  const x = (day) => m.l + ((Date.parse(day) - t0) / 86_400_000 / span) * pw;

  // Price scale from the medians and the trade's own prices. The daily
  // low–high range is clipped rather than allowed to rescale: one 1p sale or
  // 999p outlier would otherwise flatten the line that matters.
  const refs = [["buy", hist.refs.buyAt], ["sell", hist.refs.sellAt]].filter(([, v]) => v != null && v > 0);
  const meds = days.map((d) => d.median);
  let lo = Math.min(...meds, ...refs.map(([, v]) => v));
  let hi = Math.max(...meds, ...refs.map(([, v]) => v));
  const pad = Math.max(1, (hi - lo) * 0.15);
  const ticks = niceTicks(Math.max(0, lo - pad), hi + pad, 4);
  lo = ticks[0]; hi = ticks.at(-1);
  const y = (v) => m.t + PH - ((v - lo) / (hi - lo)) * PH;

  const vTop = m.t + PH + GAP;
  const vMax = niceTicks(0, Math.max(1, ...days.map((d) => d.volume)), 2).at(-1);
  const vy = (v) => vTop + VH - (v / vMax) * VH;
  const barW = Math.max(1, Math.min(24, pw / (span + 1) - 2));

  const band = days.filter((d) => d.min != null && d.max != null);
  const bandPath = band.length > 1
    ? "M" + band.map((d) => `${x(d.day).toFixed(1)},${y(d.max).toFixed(1)}`).join("L") +
      "L" + [...band].reverse().map((d) => `${x(d.day).toFixed(1)},${y(d.min).toFixed(1)}`).join("L") + "Z"
    : "";
  const line = "M" + days.map((d) => `${x(d.day).toFixed(1)},${y(d.median).toFixed(1)}`).join("L");

  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => new Date(t0 + f * (t1 - t0)).toISOString().slice(0, 10));
  const last = days.at(-1);
  const lastY = y(last.median);
  // An end label that would collide with a reference label is dropped, not
  // nudged — the summary line and the tooltip still carry the value.
  const endClear = refs.every(([, v]) => Math.abs(y(v) - lastY) > 13);

  const bars = days.filter((d) => d.volume > 0).map((d) => {
    const bx = x(d.day) - barW / 2, top = vy(d.volume), r = Math.min(2, barW / 2, vTop + VH - top);
    return `<path d="M${bx.toFixed(1)},${vTop + VH}V${(top + r).toFixed(1)}q0,-${r} ${r},-${r}h${(barW - 2 * r).toFixed(1)}q${r},0 ${r},${r}V${vTop + VH}Z" fill="var(--series)" opacity=".7"/>`;
  }).join("");

  hist.geo = { m, pw, PH, GAP, VH, H, W, vTop, xs: days.map((d) => x(d.day)), ys: days.map((d) => y(d.median)) };

  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily traded price and volume over the last ${hist.days} days">
    <defs><clipPath id="plot-clip"><rect x="${m.l}" y="${m.t}" width="${pw}" height="${PH}"/></clipPath></defs>
    <text class="panel-label" x="${m.l}" y="${m.t - 8}">Traded price · daily median, low–high band</text>
    ${ticks.map((v) => `<line class="grid" x1="${m.l}" x2="${m.l + pw}" y1="${y(v)}" y2="${y(v)}"/>
      <text class="axis" x="${m.l - 8}" y="${y(v) + 3}" text-anchor="end">${fmtP(v)}</text>`).join("")}
    <path d="${bandPath}" fill="var(--series)" opacity=".12" clip-path="url(#plot-clip)"/>
    <path d="${line}" fill="none" stroke="var(--series)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${refs.map(([k, v]) => `<line class="ref" x1="${m.l}" x2="${m.l + pw}" y1="${y(v)}" y2="${y(v)}"/>
      <text class="ref-label" x="${m.l + pw + 8}" y="${y(v) + 3}">${k} ${v}p</text>`).join("")}
    <circle cx="${x(last.day)}" cy="${lastY}" r="4" fill="var(--series)" stroke="var(--panel)" stroke-width="2"/>
    ${endClear ? `<text class="end-label" x="${m.l + pw + 8}" y="${lastY + 4}">${fmtP(last.median)}p</text>` : ""}
    <text class="panel-label" x="${m.l}" y="${vTop - 8}">Units traded per day</text>
    <line class="grid" x1="${m.l}" x2="${m.l + pw}" y1="${vTop + VH}" y2="${vTop + VH}"/>
    <line class="grid" x1="${m.l}" x2="${m.l + pw}" y1="${vTop}" y2="${vTop}"/>
    <text class="axis" x="${m.l - 8}" y="${vTop + 3}" text-anchor="end">${vMax}</text>
    <text class="axis" x="${m.l - 8}" y="${vTop + VH + 3}" text-anchor="end">0</text>
    ${bars}
    ${xTicks.map((day, i) => `<text class="axis" x="${x(day)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === 4 ? "end" : "middle"}">${fmtDay(day)}</text>`).join("")}
    <line class="cross" id="hist-cross" x1="0" x2="0" y1="${m.t}" y2="${vTop + VH}" visibility="hidden"/>
    <circle id="hist-dot" r="4" fill="var(--series)" stroke="var(--panel)" stroke-width="2" visibility="hidden"/>
    <rect class="hit" id="hist-hit" tabindex="0" aria-label="Step through days with the arrow keys" x="${m.l}" y="${m.t}" width="${pw}" height="${vTop + VH - m.t}"/>
  </svg></div>
  <p class="hist-note">Hover or use the arrow keys for a day's figures; "table" lists them all.${
    refs.length ? " The lines are this trade's own prices." : ""}</p>`;
}

function wireCrosshair(days) {
  const g = hist.geo;
  const svg = $("#hist-body svg");
  const hit = $("#hist-hit"), cross = $("#hist-cross"), dot = $("#hist-dot");
  const tip = document.createElement("div");
  tip.className = "hist-tip";
  tip.hidden = true;
  $("#hist-body").append(tip);
  let at = days.length - 1;

  const show = (i) => {
    at = Math.max(0, Math.min(days.length - 1, i));
    const d = days[at];
    cross.setAttribute("x1", g.xs[at]); cross.setAttribute("x2", g.xs[at]);
    cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", g.xs[at]); dot.setAttribute("cy", g.ys[at]);
    dot.setAttribute("visibility", "visible");
    // Values lead, labels follow; built with textContent — nothing here is markup.
    tip.replaceChildren();
    const head = document.createElement("div");
    head.textContent = fmtDay(d.day);
    const med = document.createElement("div");
    const key = document.createElement("span"); key.className = "key";
    const val = document.createElement("b"); val.textContent = `${fmtP(d.median)}p`;
    med.append(key, val, document.createTextNode(" median"));
    const range = document.createElement("div");
    range.textContent = `${fmtP(d.min)}–${fmtP(d.max)}p range · ${d.volume} traded`;
    tip.append(head, med, range);
    tip.hidden = false;
    // Position in CSS pixels: the SVG may be scaled to the dialog's width.
    const scale = svg.getBoundingClientRect().width / g.W;
    const left = 22 + g.xs[at] * scale;
    const flip = g.xs[at] > g.W * 0.6;
    tip.style.left = flip ? "" : `${left + 12}px`;
    tip.style.right = flip ? `${$("#hist-body").clientWidth - left + 12}px` : "";
    tip.style.top = `${14 + (g.m.t + 8) * scale}px`;
  };
  const hide = () => {
    tip.hidden = true;
    cross.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
  };
  const nearest = (clientX) => {
    const r = svg.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * g.W;
    let best = 0;
    for (let i = 1; i < g.xs.length; i++) if (Math.abs(g.xs[i] - px) < Math.abs(g.xs[best] - px)) best = i;
    return best;
  };
  hit.addEventListener("pointermove", (e) => show(nearest(e.clientX)));
  hit.addEventListener("pointerleave", hide);
  hit.addEventListener("focus", () => show(at));
  hit.addEventListener("blur", hide);
  hit.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (step) { e.preventDefault(); show(at + step); }
    if (e.key === "Home") { e.preventDefault(); show(0); }
    if (e.key === "End") { e.preventDefault(); show(days.length - 1); }
  });
}

/** The chart's table twin: every value, no hovering required. */
function histTable(days) {
  return `<div class="hist-table"><table><thead><tr>
      <th>Day</th><th class="r">Median</th><th class="r">Low</th><th class="r">High</th><th class="r">Traded</th>
    </tr></thead><tbody>${[...days].reverse().map((d) => `<tr>
      <td class="num">${fmtDay(d.day)}</td><td class="r num">${fmtP(d.median)}</td>
      <td class="r num">${fmtP(d.min)}</td><td class="r num">${fmtP(d.max)}</td><td class="r num">${d.volume}</td>
    </tr>`).join("")}</tbody></table></div>`;
}

$("#hist-close").addEventListener("click", () => $("#history").close());
$("#history").addEventListener("click", (e) => { if (e.target === $("#history")) $("#history").close(); });
$("#why-close").addEventListener("click", () => $("#why").close());
$("#why").addEventListener("click", (e) => { if (e.target === $("#why")) $("#why").close(); });

function showWhy(row) {
  const s = row.profitScenarios;
  $("#why-title").innerHTML = `Why ${marketLink(row.item_slug ?? row.slug, row.name)}?`;
  $("#why-summary").textContent = `${row.kind} · ${row.buyAt}p outlay · ${row.riskScore}/100 confidence score`;
  const scenario = (label, value, note) => `<tr><td>${label}</td><td class="r num">${value ? value.sellAt + "p" : "–"}</td><td class="r num ${value && value.profit > 0 ? "margin" : "loss"}">${value ? signed(value.profit) + "p" : "no reachable bid"}</td><td>${note}</td></tr>`;
  const parts = row.parts?.length ? `<h4>Component evidence</h4><table><tbody>${row.parts.map((p) => `<tr><td>${p.qty}× ${marketLink(p.item_slug, p.name)}</td><td class="r">${p.subtotal}p</td><td>${p.fills.map((f) => `${esc(f.seller.ingameName)}: ${f.units} at ${f.platinum}p`).join(" · ")}</td></tr>`).join("")}</tbody></table>` : "";
  $("#why-body").innerHTML = `<div class="parts">
    <h4>Profit scenarios</h4><table><thead><tr><th>Exit</th><th class="r">Sell at</th><th class="r">Profit</th><th>Meaning</th></tr></thead><tbody>
      ${scenario("Proposed listing", s.proposed, "Current book and ranking policy")}
      ${scenario("Completed-trade median", s.historical, "Where recent completed trades cleared")}
      ${scenario("Immediate buyer", s.immediate, "Reachable bid available now")}
      ${scenario("Price falls 5p", s.downside5, "Simple downside check")}
    </tbody></table>
    <p class="hint-inline">Break-even is ${s.breakEven}p. A ${row.margin}p fall from the proposed ${row.sellAt}p price erases the raw margin.</p>
    <h4>Execution evidence</h4><p>${esc(row.sellBasis)}. Prices are ${row.liveAt ? "live" : row.priceAgeH == null ? "of unknown age" : row.priceAgeH.toFixed(1) + "h old"}. ${row.sellCount} sell orders and ${row.volume48h} units traded in 48h.</p>
    <p>Risk adjustment: ${signed(row.expectedMargin)}p calibrated profit becomes ${signed(row.riskAdjustedMargin)}p. ${row.riskFlags.length ? esc(row.riskFlags.join("; ")) : "No material risk penalties."}</p>
    ${parts}</div>`;
  $("#why").showModal();
}
$("#history .seg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-days]");
  if (!b) return;
  hist.days = Number(b.dataset.days);
  paintHistControls();
  renderHistory();
});
$("#hist-view").addEventListener("click", () => {
  hist.table = !hist.table;
  paintHistControls();
  renderHistory();
});
window.addEventListener("resize", () => { if ($("#history").open && !hist.table) renderHistory(); });

async function fetchStatus() {
  const s = await api("/api/status");
  $("#s-age").textContent = s.sweepAgeH === null ? "none" : s.sweepAgeH + "h ago";
  $("#s-markets").textContent = s.markets.toLocaleString();
  $("#s-orders").textContent = s.ordersTracked.toLocaleString();
  $("#s-alerts").textContent = s.alerts;
  $("#s-whispers").textContent = s.whispers;
  $("#s-jobs").textContent = s.failingJobs ? `${s.failingJobs} failing` : `${s.jobs.length} healthy`;
  $("#s-backup").textContent = s.backup.lastSuccess ? new Date(s.backup.lastSuccess).toLocaleDateString([], { month:"short", day:"numeric" }) : "pending";
  const failed = s.jobs.filter((j) => j.consecutiveFailures > 0);
  $("#stale").textContent = failed.length
    ? `⚠ ${failed.map((j) => `${j.name}: ${j.lastError}`).join(" · ")}`
    : s.sweepAgeH > 24 ? "⚠ baseline over a day old — re-run the sweep" : "";
}

$("#backup-now").addEventListener("click", async (e) => {
  const result = await act(e.currentTarget, () => api("/api/backup", { method:"POST" }));
  if (result) { toast(`Backup saved (${(result.bytes / 1_048_576).toFixed(1)} MB).`); loadStatus(); }
});
/**
 * Record what an alert became, as ONE server operation that creates the trade
 * and links it to the alert together. A retry — after a lost response, or a
 * second click — gets the trade already recorded back, never a duplicate.
 * Resolves to the server's result, or null when the dialog was cancelled.
 */
async function submitAlertTrade(a, body) {
  const result = await api(`/api/alerts/${a.id}/trade`, {
    method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body),
  });
  toast(result.duplicate
    ? `Already recorded — ${a.item_name} is on Trades & P&L; nothing was duplicated.`
    : body.mode === "purchase"
      ? `Recorded ${a.item_name} as an open position on Trades & P&L.`
      : `Recorded the sale of ${a.item_name} on Trades & P&L.`);
  return result;
}

async function recordAlertOutcome(a) {
  const intro = marketLink(a.item_slug, a.item_name);
  if (a.kind === "underpriced_sell") {
    const form = await askForm(`Bought ${a.item_name}`, [
      { name: "buyPrice", label: "Paid per unit (platinum)", type: "number", value: a.platinum, required: true,
        hint: `${a.ingame_name} listed it at ${fmtNum(a.platinum)}p` },
      { name: "qty", label: "Quantity", type: "number", value: 1, min: 1, required: true },
      { name: "targetPrice", label: "Sell target per unit (platinum)", type: "number", min: 1, required: true,
        value: Math.max(1, Math.floor(a.reference)),
        hint: `resale reference ${fmtNum(a.reference)}p, rounded down to a whole-platinum listing` },
    ], { intro: `${intro} <span class="hint-inline">confirm the listing is still there before paying</span>` });
    if (!form) return null;
    return submitAlertTrade(a, {
      mode: "purchase", buyPrice: Number(form.buyPrice), quantity: Number(form.qty), targetPrice: Number(form.targetPrice),
    });
  }

  // A sale reduces inventory you already hold, so its profit comes from what
  // that position really cost. Only without one is an untracked sale offered.
  const positions = await api(`/api/alerts/${a.id}/positions`);
  const saleFields = (qty) => [
    { name: "qty", label: "Quantity sold", type: "number", value: qty, min: 1, required: true },
    { name: "sellPrice", label: "Sold for per unit (platinum)", type: "number", value: a.platinum, required: true,
      hint: `${a.ingame_name} bid ${fmtNum(a.platinum)}p` },
  ];
  if (positions.length) {
    const form = await askForm(`Sold ${a.item_name}`, [
      { name: "position", label: "Sold from", type: "select", value: String(positions[0].id), options: [
        ...positions.map((p) => ({
          value: String(p.id),
          label: `#${p.id} · ${p.quantity} held at ${p.buyPrice}p each${p.boughtFrom ? ` from ${p.boughtFrom}` : ""}`,
        })),
        { value: "untracked", label: "Record untracked sale (enter the original cost)" },
      ] },
      ...saleFields(1),
    ], { intro });
    if (!form) return null;
    if (form.position !== "untracked") {
      return submitAlertTrade(a, {
        mode: "position", tradeId: Number(form.position), quantity: Number(form.qty), sellPrice: Number(form.sellPrice),
      });
    }
  }
  const form = await askForm(`Record untracked sale · ${a.item_name}`, [
    { name: "buyPrice", label: "Original cost per unit (platinum)", type: "number", value: "", required: true,
      hint: "No tracked position is being sold, so the profit needs what you paid." },
    ...saleFields(1),
  ], {
    intro: `${intro}${positions.length ? "" : '<p class="hint-inline">No open position for this item is tracked.</p>'}`,
    okLabel: "Record untracked sale",
  });
  if (!form) return null;
  return submitAlertTrade(a, {
    mode: "untracked", buyPrice: Number(form.buyPrice), quantity: Number(form.qty), sellPrice: Number(form.sellPrice),
  });
}

$("#alerts").addEventListener("change", async (e) => {
  const select = e.target.closest("select[data-outcome]");
  if (!select || !select.value) return;
  const a = alertList[Number(select.closest("tr").dataset.i)];
  select.disabled = true;
  try {
    if (select.value === "bought") {
      if (!(await recordAlertOutcome(a))) { select.value = a.outcome || ""; return; }
    } else {
      await api(`/api/alerts/${a.id}/feedback`, {
        method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ outcome: select.value }),
      });
      toast("Alert outcome saved.");
    }
    await fetchAlerts();
    loadStatus();
  } catch (err) {
    select.value = a.outcome || "";
    toast(`Outcome not saved: ${describeError(err)} Selecting it again is safe — it will not duplicate the trade.`, "error");
  } finally {
    select.disabled = false;
  }
});

let todayItems = [];
function loadToday() { return loadView("today", fetchToday); }
async function fetchToday() {
  const [tradeRows, lists, plan] = await Promise.all([
    api("/api/trades?limit=300"), loadChecklists(),
    api("/api/plan?budget=" + encodeURIComponent($("#plan-budget").value || "500") + "&minConfidence=medium&cashReserve=" + encodeURIComponent($("#plan-reserve").value || "0") + "&maxPerGroup=" + encodeURIComponent($("#plan-group-cap").value || "6")),
  ]);
  const urgent = tradeRows.filter((t) => t.profit === null && t.sellDecision?.kind !== "hold")
    .map((row) => ({ type: "exit", row }));
  // Every active checklist, whether or not the set still ranks: platinum
  // already spent on parts has to be followed through, or deliberately dropped.
  const unfinished = lists.map((checklist) => ({
    type: "checklist", checklist,
    row: checklist.row ?? { itemId: checklist.setItemId, name: checklist.name, item_slug: checklist.item_slug, parts: [] },
  }));
  const next = plan.picks.slice(0, 5).map((row) => ({ type: "opportunity", row }));
  todayItems = [...urgent, ...unfinished, ...next];
  if (setList.length) renderSets();
  $("#today-count").textContent = `${urgent.length} exits · ${unfinished.length} unfinished sets · ${next.length} next trades`;
  const body = $("#today tbody");
  body.innerHTML = todayItems.length ? todayItems.map((item, i) => {
    const r = item.row;
    if (item.type === "exit") return `<tr data-i="${i}"><td><span class="tag warn">position</span></td><td>${marketLink(r.item_slug, r.name)}<span class="sub">${r.quantity} held · ${fmtHeld(r.heldH)}</span></td><td>${esc(r.sellDecision.label)} · ${esc(r.sellDecision.detail)}</td><td><button class="act" data-today="trades">manage sale</button></td></tr>`;
    if (item.type === "checklist") {
      const c = item.checklist;
      const entries = r.parts?.length ? checklistEntries(r) : Object.keys(c.entries);
      const done = entries.filter((key) => checklistStatus(c.entries[key]) === "purchased").length;
      return `<tr data-i="${i}" data-checklist="${esc(c.setItemId)}"><td><span class="tag">purchase</span></td>
        <td>${marketLink(c.item_slug, c.name)}<span class="sub">${done}/${entries.length} purchases acquired${c.currentRow ? "" : " · no longer ranked"}</span></td>
        <td>${c.currentRow ? riskCell(c.currentRow) : '<span class="rate none">no longer a current opportunity — finish, assemble, or remove it</span>'}</td>
        <td>${r.parts?.length ? '<button class="act" data-today="parts">continue checklist</button> ' : ""}<button class="act" data-today="assembled">mark assembled</button> <button class="act" data-today="remove">remove</button></td></tr>`;
    }
    return `<tr data-i="${i}"><td><span class="tag good">next trade</span></td><td>${marketLink(r.item_slug, r.name)}<span class="sub">${r.kind} · ${r.buyAt}p outlay</span></td><td>${riskCell(r)}</td><td><button class="act" data-today="verify">verify before buying</button></td></tr>`;
  }).join("") : '<tr><td colspan="4" class="empty">Nothing needs attention right now.</td></tr>';
}

$("#today").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-today]");
  if (!btn) return;
  const item = todayItems[Number(btn.closest("tr").dataset.i)];
  if (btn.dataset.today === "trades") return document.querySelector('nav button[data-tab="trades"]').click();
  if (btn.dataset.today === "parts") return showParts(item.row);
  if (btn.dataset.today === "assembled" || btn.dataset.today === "remove") {
    const status = btn.dataset.today === "remove" ? "removed" : "assembled";
    if (status === "removed") {
      const answer = await askForm(`Remove the ${item.checklist.name} checklist?`, [
        { name: "confirm", label: 'Type "remove" to stop tracking these purchases' },
      ]);
      if (!answer || answer.confirm.trim().toLowerCase() !== "remove") return;
    }
    const ok = await act(btn, () => api(`/api/checklists/${encodeURIComponent(item.checklist.setItemId)}/status`, {
      method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ status }),
    }));
    if (ok) { toast(status === "removed" ? `Removed the ${item.checklist.name} checklist.` : `${item.checklist.name} marked assembled.`); loadToday(); }
    return;
  }
  if (btn.dataset.today === "verify" && await verifyRow(item.row, btn)) await loadToday();
});
$("#today-refresh").addEventListener("click", loadToday);

document.querySelector("nav").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (!btn) return;
  for (const b of document.querySelectorAll("nav button")) {
    b.setAttribute("aria-selected", String(b === btn));
  }
  $("#mobile-view").value = btn.dataset.tab;
  $("#view-title").textContent = btn.textContent;
  $("#view-description").textContent = viewDescriptions[btn.dataset.tab];
  document.querySelector('.section-index').textContent = 'THE TRADING DESK / ' + String([...btn.parentElement.children].indexOf(btn) + 1).padStart(2, '0');
  for (const id of ["today", "ops", "sets", "plan", "alerts", "log", "trades", "ducats", "settings"]) {
    document.getElementById("tab-" + id).hidden = id !== btn.dataset.tab;
  }
  if (btn.dataset.tab === "today") loadToday();
  if (btn.dataset.tab === "sets") loadSets();
  if (btn.dataset.tab === "plan") loadPlan();
  if (btn.dataset.tab === "alerts") loadAlerts();
  if (btn.dataset.tab === "log") loadLog();
  if (btn.dataset.tab === "trades") loadTrades();
  if (btn.dataset.tab === "ducats") loadDucats();
  if (btn.dataset.tab === "settings") loadSettings();
});

$("#mobile-view").addEventListener('change', (e) => {
  document.querySelector('nav button[data-tab="' + e.target.value + '"]').click();
});
$("#kind").addEventListener("change", loadOps);
$("#sort").addEventListener("change", () => { clearSort("ops"); loadOps(); });
$("#capital").addEventListener("change", loadOps);
$("#watched-only").addEventListener("change", loadOps);
$("#filter").addEventListener("input", renderOps);
$("#refresh").addEventListener("click", loadOps);

// ── connection recovery ─────────────────────────────────────────────────────
// When the daemon restarts, requests fail for a few seconds. Probe until it
// answers, then clear the stale connection errors and refresh the open view —
// no page reload needed.
const tabLoaders = { today: loadToday, ops: loadOps, sets: loadSets, plan: loadPlan, alerts: loadAlerts, log: loadLog, trades: loadTrades, ducats: loadDucats, settings: loadSettings };
const activeTab = () => document.querySelector('nav button[aria-selected="true"]')?.dataset.tab ?? "today";
let reconnectProbe = null;
connection.addEventListener("down", () => {
  $("#stale").textContent = "⚠ PlatWatch isn't answering — reconnecting automatically…";
  $("#stale").dataset.connection = "down";
  reconnectProbe ??= setInterval(() => { api("/api/status").catch(() => {}); }, 3000);
});
connection.addEventListener("reconnected", () => {
  clearInterval(reconnectProbe);
  reconnectProbe = null;
  delete $("#stale").dataset.connection;
  $("#stale").textContent = "";
  for (const feedback of document.querySelectorAll('.load-feedback[data-error="true"]')) {
    feedback.hidden = true;
    feedback.dataset.error = "false";
  }
  toast("Reconnected to PlatWatch — refreshing this view.");
  loadStatus();
  Promise.resolve(tabLoaders[activeTab()]?.()).catch(() => {});
});

loadStatus();
loadSettings().then(()=>{ $("#plan-budget").value=$("#setting-budget").value; $("#plan-cap").value=$("#setting-cap").value; $("#plan-reserve").value=$("#setting-reserve").value; $("#plan-group-cap").value=$("#setting-group-cap").value; $("#plan-conf").value=$("#setting-confidence").value; }).catch(() => {});
loadOps();
importLegacyChecklists()
  .catch((err) => toast(`Couldn't move this browser's saved checklists: ${describeError(err)}`, "error"))
  .finally(() => loadToday());
setInterval(loadStatus, 30000);

