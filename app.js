/* Desk PWA. Talks to /api. Never builds FOMO urls itself. */

const view = document.getElementById("view");
const sheetRoot = document.getElementById("sheet");
const searchBar = document.getElementById("search-bar");
const searchInput = document.getElementById("search-input");
const bellDot = document.getElementById("bell-dot");

let STATE = null;
let TAB = "home";
let SCREEN = "tab";
let MINT = "";
let COIN = null;
let AUDIT = null;
let errorText = "";
let loading = false;
let sheetOpen = false;
let lastStamp = null;
let streamAbort = null;
let RANGE = "LIVE";
let auditValues = true;
let query = "";

function captureHash() {
  const raw = location.hash.replace(/^#/, "");
  if (!raw) return;
  if ((raw.startsWith("t=") || raw.includes("&t=") || raw.startsWith("d=")) && !raw.startsWith("/")) {
    history.replaceState(null, "", location.pathname + location.search);
    return;
  }
  applyRoute(raw);
}

function token() {
  return "demo";
}

function applyRoute(raw) {
  const path = (raw || "").replace(/^#?\/?/, "");
  const parts = path.split("/").filter(Boolean);
  const head = parts[0] || "home";
  if (head === "coin" && parts[1]) {
    SCREEN = "coin"; MINT = parts[1]; TAB = "activity";
  } else if (head === "auditor") {
    SCREEN = "auditor"; MINT = parts[1] || ""; TAB = "agents";
  } else if (["home", "agents", "activity", "account"].includes(head)) {
    SCREEN = "tab"; MINT = ""; TAB = head;
  }
}

function setRoute(path) {
  const next = path.startsWith("/") ? path : "/" + path;
  if (location.hash !== "#" + next) history.pushState(null, "", "#" + next);
  applyRoute(next);
  view.scrollTop = 0;
  if (SCREEN === "coin") loadCoin(MINT);
  else if (SCREEN === "auditor") loadAudit(MINT);
  else render();
}

function headers(json) {
  const out = {};
  if (json) out["Content-Type"] = "application/json";
  return out;
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    Object.entries(attrs).forEach(([key, value]) => {
      if (value == null || value === false) return;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "style" && typeof value === "object") {
        Object.entries(value).forEach(([sk, sv]) => {
          if (sk.startsWith("--")) node.style.setProperty(sk, sv);
          else node.style[sk] = sv;
        });
      }
      else if (key === "html") node.innerHTML = value;
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
      else if (key === "pressed") node.setAttribute("aria-pressed", value ? "true" : "false");
      else node.setAttribute(key, value);
    });
  }
  (children || []).forEach((child) => {
    if (child == null) return;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  });
  return node;
}

function usd(amount, signed) {
  const value = Number(amount) || 0;
  const body = Math.abs(value).toLocaleString("en-US", { style: "currency", currency: "USD" });
  if (!signed) return body;
  if (value > 0) return `+${body}`;
  if (value < 0) return `-${body}`;
  return body;
}

function pct(amount, digits) {
  const value = Number(amount) || 0;
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits == null ? 2 : digits)}%`;
}

function ago(ts) {
  if (!ts) return "no heartbeat";
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function clock(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function tone(amount) {
  if (amount > 0) return "up";
  if (amount < 0) return "down";
  return "flat";
}

function fomoLink(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "fomo.family") return null;
    if (parsed.searchParams.has("r") && parsed.searchParams.get("r") !== "savipww") return null;
    if (parsed.pathname.startsWith("/r/") && parsed.pathname !== "/r/savipww") return null;
    const hasReferral = parsed.searchParams.get("r") === "savipww" || parsed.pathname === "/r/savipww";
    return hasReferral ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function kindLabel(kind) {
  const map = { rejected: "Rejected", bought: "Bought", sold: "Sold", stopped: "Stopped" };
  return map[kind] || (kind ? kind[0].toUpperCase() + kind.slice(1) : "Update");
}

let lastOdometer = null;
function odometer(value) {
  const formatted = usd(value);
  const wrap = el("div", { class: "odometer", "aria-label": formatted });
  const animate = lastOdometer !== formatted;
  lastOdometer = formatted;
  formatted.split("").forEach((ch) => {
    if (/[0-9]/.test(ch)) {
      const col = el("span", { class: "digit" });
      const strip = el("span");
      for (let n = 0; n <= 9; n += 1) strip.append(el("span", { text: String(n) }));
      col.append(strip);
      const offset = Number(ch);
      if (!animate) {
        strip.style.transition = "none";
        strip.style.transform = `translateY(${-offset * 10}%)`;
      } else {
        requestAnimationFrame(() => { strip.style.transform = `translateY(${-offset * 10}%)`; });
      }
      wrap.append(col);
    } else {
      wrap.append(el("span", { class: ch === "$" ? "sym" : "sep", text: ch }));
    }
  });
  return wrap;
}

function rangeSeries() {
  const rows = STATE.balance || [];
  const now = Date.now() / 1000;
  const windows = { LIVE: 3600, "1H": 3600, "4H": 14400, "1D": 86400, "1W": 604800, ALL: Infinity };
  const span = windows[RANGE] || 3600;
  const cut = Number.isFinite(span) ? now - span : 0;
  const values = rows.filter((row) => !cut || row.ts >= cut);
  return values.length ? values : rows.slice(-2);
}

function render() {
  markTabs();
  const badge = document.getElementById("paper-badge");
  if (badge && STATE) {
    badge.textContent = STATE.mode === "LIVE" ? "LIVE" : "PAPER";
    badge.classList.toggle("live", STATE.mode === "LIVE");
  }
  const unread = STATE && (STATE.activity || []).length > 0;
  bellDot.hidden = !unread;
  if (sheetOpen) return;
  const keepScroll = view.dataset.screen === `${SCREEN}:${TAB}:${MINT}`;
  const scroll = keepScroll ? view.scrollTop : 0;
  view.dataset.screen = `${SCREEN}:${TAB}:${MINT}`;
  view.replaceChildren();
  if (!token()) view.append(needToken());
  else if (!STATE && errorText) view.append(errorState());
  else if (!STATE) view.append(loadingState());
  else if (SCREEN === "coin") renderCoin();
  else if (SCREEN === "auditor") renderAuditor();
  else if (TAB === "home") renderHome();
  else if (TAB === "agents") renderAgents();
  else if (TAB === "activity") renderActivity();
  else renderAccount();
  view.scrollTop = scroll;
  requestAnimationFrame(paintCharts);
}

function markTabs() {
  document.querySelectorAll(".tabs button").forEach((button) => {
    if (button.dataset.tab === TAB) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}

function needToken() {
  return el("div", { class: "empty-box" }, [
    el("h2", { text: "Open this desk once" }),
    el("p", { text: "Add this phone with the private link, then the token stays here." }),
  ]);
}
function loadingState() {
  return el("div", { class: "empty-box" }, [el("div", { class: "spinner" }), el("p", { text: "Reading the desk…" })]);
}
function errorState() {
  return el("div", { class: "error-box" }, [
    el("h2", { text: "Can't reach the desk" }),
    el("p", { text: errorText || "The local process is not answering." }),
    el("div", { class: "actions" }, [
      el("button", { class: "btn", type: "button", text: "Try again", onclick: () => pull() }),
    ]),
  ]);
}

function banners() {
  const bits = [];
  if (STATE && STATE.paused) bits.push(el("div", { class: "banner", text: "Entries paused. Open risk still runs." }));
  if (errorText) bits.push(el("div", { class: "banner bad", text: errorText }));
  return bits;
}

function renderHome() {
  const series = rangeSeries();
  const start = series.length ? Number(series[0].value) : STATE.stack;
  const pctToday = STATE.pnl_today_pct;
  const mult = STATE.multiplier || 1;
  view.append(
    ...banners(),
    el("section", { class: "stack-block" }, [
      el("p", { class: "stack-label", text: STATE.mode === "LIVE" ? "Live stack" : "Paper stack" }),
      odometer(STATE.stack),
      el("div", { class: "stack-meta" }, [
        el("span", { class: tone(pctToday), text: `${pct(pctToday)} today` }),
        el("span", { class: `pill ${mult >= 1 ? "up" : "down"}`, text: `×${mult.toFixed(2)}` }),
      ]),
    ]),
    el("section", { class: "chart-card" }, [
      el("canvas", {
        "data-chart": "line",
        "data-payload": JSON.stringify({ values: series, start }),
        role: "img",
        "aria-label": "Stack",
      }),
      el("div", { class: "ranges" }, ["LIVE", "1H", "4H", "1D", "1W", "ALL"].map((name) => el("button", {
        type: "button",
        text: name,
        pressed: RANGE === name,
        onclick: () => { RANGE = name; render(); },
      }))),
    ])
  );
  if (!STATE.positions.length) {
    view.append(el("p", { class: "empty", text: "Waiting for the first trade" }));
  } else {
    const card = el("section", { class: "card" });
    STATE.positions.forEach((pos) => card.append(activityRow(posToRow(pos))));
    view.append(card);
  }

  const agents = STATE.agents || [];
  const running = STATE.running != null ? STATE.running : agents.filter((a) => a.ok && !a.paused).length;
  view.append(el("div", { class: "section-head" }, [
    el("h2", null, ["Agents ", el("span", { class: "dim", text: `· ${running} running` })]),
  ]));
  renderCarousel(agents);

  const recent = (STATE.activity || []).slice(0, 5);
  view.append(el("div", { class: "section-head" }, [
    el("h2", { text: "Activity" }),
    el("button", { class: "see-all", type: "button", text: "See all", onclick: () => setRoute("/activity") }),
  ]));
  if (!recent.length) {
    view.append(el("p", { class: "empty", text: "Fills, stops, and rejects land here." }));
  } else {
    const card = el("section", { class: "card" });
    recent.forEach((item) => card.append(activityRow(item)));
    view.append(card);
  }
}

function cardRadius() {
  const vw = Math.min(window.innerWidth, 430);
  const w = vw - 32;
  return (42 * w) / 504;
}

function renderCarousel(agents) {
  const radius = `${cardRadius()}px`;
  const track = el("div", { class: "carousel", id: "agent-carousel" });
  agents.forEach((agent) => {
    const card = el("button", {
      class: "agent-card",
      type: "button",
      style: { borderRadius: radius, "--accent": agent.color || "#8e8e93" },
      onclick: () => setRoute(agent.id === "auditor" ? "/auditor" : "/agents"),
    }, [
      el("p", { class: "agent-kicker", text: agent.label }),
      el("h3", { text: agent.headline || agent.label }),
      el("div", { class: "body" }, [agentBody(agent)]),
    ]);
    track.append(card);
  });
  view.append(el("div", { class: "carousel-wrap" }, [track]));
}

function agentBody(agent) {
  if (agent.id === "scanner") {
    const items = agent.feed || [];
    if (!items.length) return el("p", { class: "empty", text: "No pools yet today." });
    return el("ul", { class: "feed" }, items.map((item) => {
      const li = el("li", { class: item.struck ? "struck" : item.to_auditor ? "pass" : "" });
      const symbol = item.symbol || "";
      let reason = item.reason || "";
      if (symbol && reason) {
        const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        reason = reason.replace(new RegExp(esc + "\\s*·\\s*", "i"), "").trim();
      }
      li.append([symbol, reason].filter(Boolean).join(" · ") || "Pool");
      if (item.to_auditor) li.append(el("span", { class: "to", text: " → auditor" }));
      return li;
    }));
  }
  if (agent.id === "auditor") {
    const layers = agent.layers || [];
    const grid = el("div", { class: "strips" });
    (layers.length ? layers : new Array(8).fill(null)).slice(0, 8).forEach((layer, i) => {
      const klass = layer && layer.passed === true ? "on" : layer && layer.passed === false ? "off" : "";
      grid.append(el("div", { class: "strip" }, [
        el("i", { class: klass }),
        el("span", { text: (layer && layer.name) || `L${i + 1}` }),
      ]));
    });
    return el("div", null, [grid, el("p", { class: "rejected-line", text: `${agent.rejected || 0} rejected` })]);
  }
  if (agent.id === "analyst") {
    const score = agent.score == null ? 0 : agent.score;
    return el("div", { class: "ring-wrap" }, [
      el("canvas", { "data-chart": "ring", "data-payload": JSON.stringify({ score }) }),
      el("div", { class: "ring-caption", text: agent.score == null ? "Waiting for a score" : "Latest score · green from 70" }),
    ]);
  }
  if (agent.id === "executor") {
    const pctVal = Math.max(0, Math.min(100, Number(agent.stack_pct) || 8));
    const shown = Math.min(100, (Number(agent.ticket_usd) / Math.max(STATE.stack, 1)) * 100);
    return el("div", null, [
      el("p", { class: "exec-line", text: `${usd(agent.ticket_usd)} · ${pctVal}% of stack` }),
      el("div", { class: "bar" }, [el("span", { style: { width: `${shown}%` } })]),
    ]);
  }
  return el("div", { class: "mono-pills" }, [
    el("span", { class: "mono-pill stop", text: `stop -${Number(agent.stop_pct || 6)}%` }),
    el("span", { class: "mono-pill trail", text: `trail ${Number(agent.trail_pct || 12)}%` }),
  ]);
}

function posToRow(pos) {
  return {
    kind: "bought",
    mint: pos.mint,
    title: pos.symbol,
    subtitle: "Open",
    value: pct(pos.pnl_pct),
    ts: pos.opened_at,
    link: pos.link,
  };
}

function activityRow(item) {
  const symbol = item.symbol || "";
  const title = symbol || (item.title && !/^rejected$/i.test(item.title) ? item.title : kindLabel(item.kind));
  let detail = item.subtitle || "";
  if (symbol && detail) {
    const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    detail = detail.replace(new RegExp("^" + esc + "\\s*·\\s*", "i"), "").trim();
    detail = detail.replace(new RegExp(esc, "i"), "").replace(/^[·\s]+|[·\s]+$/g, "").trim();
  }
  if (detail && detail.toLowerCase() === title.toLowerCase()) detail = "";
  const sub = [kindLabel(item.kind), detail].filter(Boolean).join(" · ");
  return el("button", {
    class: "row",
    type: "button",
    onclick: item.mint ? () => setRoute("/coin/" + item.mint) : null,
  }, [
    el("div", { class: "row-main" }, [
      el("div", { class: "row-title", text: title }),
      el("div", { class: "row-sub", text: sub }),
    ]),
    el("div", { class: "row-value" }, [
      el("div", { text: item.value || "" }),
      el("small", { text: clock(item.ts) }),
    ]),
  ]);
}

function renderAgents() {
  view.append(...banners());
  view.append(el("div", { class: "section-head" }, [
    el("h2", null, ["Agents ", el("span", { class: "dim", text: `· ${(STATE.running != null ? STATE.running : 0)} running` })]),
  ]));
  (STATE.agents || []).forEach((agent) => {
    const card = el("section", { class: "full-agent" });
    const sw = el("button", {
      class: "switch",
      type: "button",
      pressed: !agent.paused,
      disabled: agent.locked ? "disabled" : null,
      "aria-label": agent.paused ? "Resume" : "Pause",
      onclick: (ev) => {
        ev.stopPropagation();
        if (agent.locked) return;
        send({ op: agent.paused ? "resume_agent" : "pause_agent", agent: agent.id });
      },
    });
    card.append(el("div", { class: "top" }, [
      el("div", { class: agent.ok && !agent.paused ? "dot on" : "dot off" }),
      el("div", { class: "row-main" }, [
        el("div", { class: "row-title", text: agent.label }),
        el("div", { class: "row-sub", text: `${agent.headline || ""} · ${ago(agent.ts)}` }),
      ]),
      el("button", {
        class: "shortcut",
        type: "button",
        text: "Settings",
        onclick: (ev) => { ev.stopPropagation(); setRoute("/account"); },
      }),
      sw,
    ]));
    if (agent.locked) card.append(el("p", { class: "empty", text: "Risk stays on while a position is open." }));
    const decisions = agent.decisions || [];
    if (!decisions.length) card.append(el("p", { class: "empty", text: "No decisions yet today." }));
    else decisions.forEach((item) => card.append(decisionRow(item)));
    view.append(card);
  });
  const audit = STATE.live_audit;
  if (audit && audit.layers && audit.layers.some((layer) => layer.passed != null) && audit.mint) {
    view.append(el("div", { class: "section-head" }, [el("h2", { text: "Live audit" })]));
    const box = el("button", {
      class: "card pad",
      type: "button",
      style: { width: "100%", textAlign: "left", border: 0, color: "inherit", background: "#1c1c1e" },
      onclick: () => setRoute("/auditor/" + audit.mint),
    }, [el("h2", { text: audit.symbol || "Mint" })]);
    audit.layers.forEach((layer) => box.append(valueRow(layer)));
    view.append(box);
  }
}

function decisionRow(item) {
  const safe = fomoLink(item.link);
  const title = item.symbol || item.title || kindLabel(item.kind);
  let detail = item.subtitle || "";
  if (title && detail) {
    const esc = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    detail = detail.replace(new RegExp(esc, "i"), "").replace(/^[·\s]+|[·\s]+$/g, "").trim();
  }
  return el("div", { class: "row" }, [
    el("div", { class: "row-main" }, [
      el("div", { class: "row-title", text: title }),
      el("div", { class: "row-sub", text: detail || kindLabel(item.kind) }),
    ]),
    el("div", { class: "row-value" }, [
      el("div", { text: item.value || "" }),
      el("small", { text: clock(item.ts) }),
    ]),
    safe ? el("a", {
      class: "linkish",
      href: safe,
      target: "_blank",
      rel: "noopener noreferrer",
      text: "FOMO",
      onclick: (ev) => ev.stopPropagation(),
    }) : null,
  ]);
}

function renderActivity() {
  view.append(...banners(), el("div", { class: "section-head" }, [el("h2", { text: "Activity" })]));
  let rows = STATE.activity || [];
  if (query) {
    const q = query.toLowerCase();
    rows = rows.filter((item) => `${item.title} ${item.subtitle} ${item.symbol || ""} ${item.mint || ""}`.toLowerCase().includes(q));
  }
  if (!rows.length) {
    view.append(el("div", { class: "empty-box" }, [
      el("h2", { text: "Nothing yet" }),
      el("p", { text: "Fills, stops, and rejects land here." }),
    ]));
    return;
  }
  const card = el("section", { class: "card" });
  rows.forEach((item) => card.append(activityRow(item)));
  view.append(card);
}

function backButton(to, label) {
  return el("button", { class: "back", type: "button", text: "‹ " + (label || "Back"), onclick: () => setRoute(to) });
}

function valueRow(layer) {
  const pending = layer.passed == null;
  const klass = pending ? "flat" : layer.passed ? "up" : "down";
  const text = layer.value || (pending ? "Not checked" : layer.passed ? "Pass" : "Fail");
  return el("div", { class: "setting" }, [
    el("b", { text: `${layer.layer}. ${layer.name}` }),
    el("span", { class: klass, text }),
  ]);
}

function renderAuditor() {
  view.append(backButton("/agents", "Agents"), ...banners());
  const audit = AUDIT || (STATE && STATE.live_audit) || { layers: [], mint: MINT };
  const layers = (audit.layers && audit.layers.length) ? audit.layers : new Array(8).fill(0).map((_, i) => ({ layer: i + 1, name: ["mintAuthority","freezeAuthority","dev","top10","lp","age","bundled","delegates"][i], passed: null }));
  const link = fomoLink(audit.link);
  if (audit.symbol || audit.mint) {
    view.append(el("section", { class: "card pad" }, [
      el("h2", { text: audit.symbol || "Mint" }),
      audit.name ? el("p", { class: "row-sub", text: audit.name }) : null,
      audit.mint ? el("p", { class: "mint-mono", text: audit.mint }) : null,
    ]));
  } else {
    view.append(el("p", { class: "empty", text: "No audit is running. Discs stay dim until a coin reaches the auditor." }));
  }
  const stack = el("div", { class: "discs" }, [el("div", { class: "beam" })]);
  layers.forEach((layer) => {
    const klass = layer.passed === true ? "disc pass" : layer.passed === false ? "disc fail" : "disc";
    stack.append(el("div", { class: klass, title: layer.name }));
  });
  view.append(el("section", { class: "card pad" }, [stack]));
  view.append(el("div", { class: "section-head" }, [
    el("h2", { text: "Values" }),
    el("button", {
      class: "see-all",
      type: "button",
      text: auditValues ? "Hide" : "Show",
      onclick: () => { auditValues = !auditValues; render(); },
    }),
  ]));
  if (auditValues) {
    const box = el("section", { class: "card pad" });
    layers.forEach((layer) => box.append(valueRow(layer)));
    view.append(box);
  }
  if (link) {
    view.append(el("div", { class: "actions" }, [
      el("a", { class: "btn", href: link, target: "_blank", rel: "noopener noreferrer", text: "Open on FOMO" }),
    ]));
  }
}

function renderCoin() {
  view.append(backButton("/activity", "Activity"), ...banners());
  if (!COIN && loading) { view.append(loadingState()); return; }
  if (!COIN) {
    view.append(el("div", { class: "empty-box" }, [el("h2", { text: "Coin not found" }), el("p", { text: "This mint is not in the book." })]));
    return;
  }
  const link = fomoLink(COIN.link);
  const scan = COIN.scan || {};
  const pos = COIN.position;
  view.append(el("section", { class: "card pad" }, [
    el("h2", { text: COIN.symbol || "Coin" }),
    el("p", { class: "row-sub", text: COIN.name || "" }),
    el("p", { class: "mint-mono", text: COIN.mint }),
  ]));
  view.append(el("section", { class: "chart-card" }, [
    el("canvas", {
      class: "candles",
      "data-chart": "candles",
      "data-payload": JSON.stringify({ candles: COIN.candles || [], stop: pos && pos.stop_price }),
      role: "img",
      "aria-label": "Price",
    }),
  ]));
  view.append(el("h2", { class: "section-title", text: "Stats" }));
  view.append(el("section", { class: "card pad" }, [
    settingLine("Verdict", scan.verdict ? `${scan.verdict}${scan.reason ? " · " + scan.reason : ""}` : "—"),
    settingLine("Liquidity", scan.liquidity_usd != null ? usd(scan.liquidity_usd) : "—"),
    settingLine("Top 10", scan.top10_pct != null ? `${Number(scan.top10_pct).toFixed(1)}%` : "—"),
    settingLine("1h change", scan.h1_change_pct != null ? pct(scan.h1_change_pct, 1) : "—"),
    settingLine("Age", scan.age_min != null ? `${Math.round(scan.age_min)} min` : "—"),
  ]));
  if (pos) {
    view.append(el("h2", { class: "section-title", text: "Position" }));
    view.append(el("section", { class: "card pad" }, [
      settingLine("Size", usd(pos.size_usd)),
      settingLine("Entry", String(pos.entry_price)),
      settingLine("Mark", String(pos.price)),
      settingLine("Stop", String(pos.stop_price)),
      settingLine("P&L", `${usd(pos.pnl_usd, true)} · ${pct(pos.pnl_pct)}`),
    ]));
  }
  if (link) {
    view.append(el("div", { class: "actions" }, [
      el("a", { class: "btn", href: link, target: "_blank", rel: "noopener noreferrer", text: "Buy on FOMO" }),
      pos ? el("a", { class: "btn-quiet", href: link, target: "_blank", rel: "noopener noreferrer", text: "Sell on FOMO" }) : null,
    ]));
  }
}

function settingLine(label, value) {
  return el("div", { class: "setting" }, [el("b", { text: label }), el("span", { text: value })]);
}

function renderAccount() {
  view.append(...banners());
  const profile = fomoLink(STATE.profile_url);
  const signup = fomoLink(STATE.signup_url);
  view.append(el("section", { class: "card pad" }, [
    el("h2", { text: "Mode" }),
    el("p", { class: "row-sub", text: "Live still only sends links. Nothing is signed and no funds move." }),
    el("div", { class: "segment", style: { marginTop: "10px" } }, [
      el("button", { type: "button", pressed: STATE.mode !== "LIVE", text: "Paper", onclick: () => send({ op: "paper" }) }),
      el("button", { type: "button", pressed: STATE.mode === "LIVE", text: "Live", onclick: () => openLive() }),
    ]),
  ]));
  const stackInput = el("input", { type: "number", step: "0.01", value: String(STATE.paper_start_stack ?? "") });
  view.append(el("section", { class: "card pad" }, [
    el("h2", { text: "Stack" }),
    el("p", { class: "row-sub", text: `Equity ${usd(STATE.stack)}` }),
    el("div", { class: "stack-field", style: { display: "flex", justifyContent: "flex-end", marginTop: "8px" } }, [stackInput]),
    el("div", { class: "actions" }, [
      el("button", { class: "btn-quiet", type: "button", text: "Save stack", onclick: () => send({ op: "set", key: "desk.paper_start_stack", value: stackInput.value }) }),
    ]),
  ]));
  const profileRow = el("button", {
    class: "row",
    type: "button",
    onclick: () => { if (profile) window.open(profile, "_blank", "noopener,noreferrer"); },
  }, [
    el("div", { class: "row-main" }, [
      el("div", { class: "row-title", text: STATE.fomo_handle || "FOMO profile" }),
      el("div", { class: "row-sub", text: "Open your FOMO profile" }),
    ]),
    el("span", { class: "linkish", text: "›" }),
  ]);
  const invite = el("button", { class: "row", type: "button", onclick: () => inviteFriend(signup) }, [
    el("div", { class: "row-main" }, [
      el("div", { class: "row-title", text: "Invite a friend" }),
      el("div", { class: "row-sub", text: "Share your referral link" }),
    ]),
    el("span", { class: "linkish", text: "Share" }),
  ]);
  view.append(el("section", { class: "card" }, [profileRow, invite]));

  const groups = (STATE.settings && STATE.settings.groups) || [];
  groups.forEach((group) => {
    view.append(el("h2", { class: "section-title", text: group.name }));
    const card = el("section", { class: "card pad" });
    (group.items || []).forEach((item) => card.append(settingControl(item)));
    view.append(card);
  });

  const tg = STATE.telegram || {};
  view.append(el("h2", { class: "section-title", text: "Telegram" }));
  view.append(el("section", { class: "card pad" }, [
    el("div", { class: "setting" }, [
      el("b", { text: "Status" }),
      el("span", { class: tg.ok ? "up" : "down", text: tg.ok ? "Connected" : "Quiet" }),
    ]),
    el("div", { class: "actions" }, [
      el("button", { class: "btn", type: "button", text: "Send test push", onclick: () => send({ op: "test_push" }) }),
    ]),
  ]));
  view.append(el("p", { class: "foot" }, [
    "New to FOMO? ",
    signup ? el("a", { class: "linkish", href: signup, target: "_blank", rel: "noopener noreferrer", text: signup }) : "https://fomo.family/r/savipww",
  ]));
}

function settingControl(item) {
  const label = item.unit ? `${item.label} (${item.unit})` : item.label;
  if (!item.editable) {
    return el("div", { class: "setting" }, [el("b", { text: label }), el("span", { text: formatSetting(item.value) })]);
  }
  if (item.type === "bool") {
    const sw = el("button", {
      class: "switch",
      type: "button",
      pressed: !!item.value,
      onclick: () => send({ op: "set", key: item.key, value: !item.value }),
    });
    return el("div", { class: "setting" }, [el("b", { text: label }), sw]);
  }
  if (item.type === "enum" && item.options) {
    const wrap = el("div", { class: "segment", style: { margin: "8px 0" } });
    item.options.forEach((option) => {
      wrap.append(el("button", {
        type: "button",
        text: option,
        pressed: option === item.value,
        onclick: () => send({ op: "set", key: item.key, value: option }),
      }));
    });
    return el("div", { class: "slider-row" }, [el("label", { text: label }), wrap]);
  }
  if (item.type === "number") {
    const min = 0;
    const current = Number(item.value);
    const maxGuess = Math.max(Math.abs(current) * 2, 10);
    const range = el("input", { type: "range", min: String(min), max: String(maxGuess), step: "any", value: String(current) });
    const number = el("input", { type: "number", step: "any", value: String(item.value) });
    const commit = () => send({ op: "set", key: item.key, value: number.value });
    range.addEventListener("input", () => { number.value = range.value; });
    range.addEventListener("change", commit);
    number.addEventListener("change", commit);
    return el("div", { class: "slider-row" }, [
      el("label", null, [el("span", { text: label }), number]),
      range,
    ]);
  }
  const input = el("input", { type: "text", value: String(item.value ?? "") });
  return el("div", { class: "slider-row" }, [
    el("label", { text: label }),
    el("div", { style: { display: "flex", justifyContent: "flex-end" } }, [input]),
    el("div", { class: "actions" }, [
      el("button", { class: "btn-quiet", type: "button", text: "Save", onclick: () => send({ op: "set", key: item.key, value: input.value }) }),
    ]),
  ]);
}

function formatSetting(value) {
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (value == null) return "—";
  return String(value);
}

async function inviteFriend(url) {
  const safe = fomoLink(url);
  if (!safe) return;
  const text = `New to FOMO? ${safe}`;
  try {
    if (navigator.share) await navigator.share({ title: "FOMO", text, url: safe });
    else if (navigator.clipboard) await navigator.clipboard.writeText(text);
  } catch { /* cancelled */ }
}

function openSheet(node) {
  sheetOpen = true;
  sheetRoot.hidden = false;
  sheetRoot.replaceChildren(node);
}
function closeSheet() {
  sheetOpen = false;
  sheetRoot.hidden = true;
  sheetRoot.replaceChildren();
  render();
}

function openLive() {
  if (STATE && STATE.mode === "LIVE") return;
  const input = el("input", { id: "live-confirm", autocapitalize: "characters", autocomplete: "off", placeholder: "LIVE" });
  const go = el("button", { class: "btn danger", type: "button", text: "Switch to Live", disabled: "disabled" });
  input.addEventListener("input", () => {
    if (input.value === "LIVE") go.removeAttribute("disabled");
    else go.setAttribute("disabled", "disabled");
  });
  go.addEventListener("click", async () => {
    if (input.value !== "LIVE") return;
    const result = await send({ op: "live", confirm: "LIVE" }, true);
    if (result.ok) closeSheet();
    else go.textContent = result.message || "Not confirmed";
  });
  openSheet(el("div", { class: "sheet" }, [
    el("h2", { text: "Go live" }),
    el("p", { text: "Live still only sends links. You tap them. Type LIVE to unlock the switch." }),
    input,
    el("div", { class: "actions" }, [
      go,
      el("button", { class: "btn-quiet", type: "button", text: "Stay on paper", onclick: closeSheet }),
    ]),
  ]));
  input.focus();
}

function openBell() {
  const rows = (STATE && STATE.activity) ? STATE.activity.slice(0, 8) : [];
  const box = el("div", { class: "sheet" }, [
    el("h2", { text: "Notifications" }),
    rows.length ? null : el("p", { text: "No new activity." }),
  ]);
  rows.forEach((item) => box.append(activityRow(item)));
  box.append(el("div", { class: "actions" }, [
    el("button", { class: "btn-quiet", type: "button", text: "Close", onclick: closeSheet }),
  ]));
  openSheet(box);
}

const DEMO_BUNDLE = { coins: {}, audits: {} };

function demoApply(body) {
  if (!STATE) return { ok: false, message: "Not loaded." };
  const op = (body && body.op) || "";
  if (op === "paper") STATE.mode = "PAPER";
  else if (op === "live" && body.confirm === "LIVE") STATE.mode = "LIVE";
  else if (op === "pause_agent" || op === "resume_agent") {
    const agent = (STATE.agents || []).find((row) => row.id === body.agent);
    if (agent && agent.locked && op === "pause_agent") return { ok: false, message: "Risk stays on while a position is open." };
    if (agent) agent.paused = op === "pause_agent";
  } else if (op === "set" && body.key && STATE.settings && STATE.settings.groups) {
    STATE.settings.groups.forEach((group) => {
      (group.items || []).forEach((item) => {
        if (item.key === body.key) item.value = body.value;
      });
    });
  } else if (op === "test_push") {
    return { ok: true, message: "Demo only — no push is sent." };
  }
  STATE.updated_at = Date.now() / 1000;
  render();
  return { ok: true };
}

async function send(body, quiet) {
  const result = demoApply(body);
  // booleans written as True/False below are fixed after this replace
  return result;
}

function acceptState(data) {
  errorText = "";
  const stamp = data.updated_at;
  const changed = stamp !== lastStamp || !STATE;
  STATE = data;
  lastStamp = stamp;
  if (changed || !sheetOpen) render();
}

async function pull() {
  loading = !STATE;
  try {
    const response = await fetch("example.json", { cache: "no-store" });
    if (!response.ok) throw new Error("bad status");
    const payload = await response.json();
    DEMO_BUNDLE.coins = payload.coins || {};
    DEMO_BUNDLE.audits = payload.audits || {};
    acceptState(payload.state);
  } catch (err) {
    errorText = "Can't load the example data.";
    render();
  } finally {
    loading = false;
  }
}

async function loadCoin(mint) {
  COIN = (DEMO_BUNDLE.coins && DEMO_BUNDLE.coins[mint]) || null;
  loading = false;
  render();
}

async function loadAudit(mint) {
  AUDIT = (DEMO_BUNDLE.audits && mint && DEMO_BUNDLE.audits[mint])
    || (STATE && STATE.live_audit && (!mint || STATE.live_audit.mint === mint) && STATE.live_audit)
    || null;
  render();
}

async function listen() {
  return;
}

document.querySelectorAll(".tabs button").forEach((button) => {
  button.addEventListener("click", () => setRoute("/" + button.dataset.tab));
});
document.getElementById("nav-avatar").addEventListener("click", () => setRoute("/account"));
document.getElementById("nav-brand").addEventListener("click", () => setRoute("/home"));
document.getElementById("search-btn").addEventListener("click", () => {
  searchBar.hidden = !searchBar.hidden;
  if (!searchBar.hidden) searchInput.focus();
});
document.getElementById("bell-btn").addEventListener("click", openBell);
searchInput.addEventListener("input", () => {
  query = searchInput.value.trim();
  if (TAB !== "activity") setRoute("/activity");
  else render();
});
sheetRoot.addEventListener("click", (event) => { if (event.target === sheetRoot) closeSheet(); });
window.addEventListener("resize", () => { paintCharts(); });
window.addEventListener("hashchange", () => {
  applyRoute(location.hash.replace(/^#/, ""));
  view.scrollTop = 0;
  view.dataset.screen = "";
  if (SCREEN === "coin") loadCoin(MINT);
  else if (SCREEN === "auditor") loadAudit(MINT);
  else render();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

captureHash();
if (!location.hash || location.hash === "#") history.replaceState(null, "", "#/home");
applyRoute(location.hash.replace(/^#/, "") || "/home");
pull();
listen();
setInterval(pull, 15000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) { pull(); listen(); }
});
