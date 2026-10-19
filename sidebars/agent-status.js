// Agent status sidebar: workspaces grouped by what they need from you,
// styled after a Warp redesign (rows with "4m" + a state icon).
//
// Sections, top to bottom (like the built-in Attention Queue, but by agent
// state): Pinned > Needs you > New (done, not read) > Working > Done > Sleeping.
// Above them, the Claude Code usage limit and when it resets.
//
// What cmux doesn't know comes from workspace descriptions, written by
// scripts/last-prompt-sync.py: "last prompt @<epoch> · bg · zz@<epoch> · lim:… · lang:…".
// cmux forgets latestAt on restart, calls a tab done as soon as Claude ends its
// turn, and has no place for account-wide data, so the description carries it.
//
// Select: cmux sidebar select agent-status   Check: cmux sidebar validate agent-status

const INACTIVE_AFTER = 24 * 3600;
const ORANGE = "#F5A524";
const BLUE = "#4C9EEB";
const VIOLET = "#9B7BFF";
const GREEN = "#34C759";
const RED = "#FF453A";
const GRAY = "#8E8E93";
// The working spinner walks through these, one per clock tick.
const SPINNER_COLORS = ["#5B8CFF", "#8B5CF6", "#EC4899", "#F59E0B", "#14B8A6"];

// --- language ----------------------------------------------------------------------
// Picked with right-click on the limit card or a section header, stored as a
// "lang:uk|en" token; until then, macOS's language.
const STRINGS = {
  en: {
    pinned: "Pinned", needs: "Needs you", unread: "New", working: "Working", done: "Done", inactive: "Sleeping",
    now: "now", m: "m", h: "h", d: "d",
    openHere: "Open here", worktree: "Claude on its own branch (worktree)", anotherClaude: "Another Claude",
    preview: (p) => "Preview localhost:" + p + " in the Dock", noServer: "Site preview (no server running)",
    simulator: "iOS Simulator", sleep: "Put to sleep", wake: "Wake up", rename: "Rename", pin: "Pin", unpin: "Unpin",
    markRead: "Mark as Read", markUnread: "Mark as Unread", closeOthers: "Close Others", close: "Close",
    wsName: "Workspace name", limit: "5-hour limit", limitShort: "5h", week: "week",
    today: "Today", prompts: "prompts", inClaude: "in Claude", agents: "agents",
    streak: (n) => n + (n === 1 ? " day" : " days"), sessionTime: "in this project", noSession: "No session selected",
    minShort: "m", hourShort: "h",
    resets: (at, left) => "at " + at + " · in " + left, resetDone: "limit has reset",
  },
  uk: {
    pinned: "Закріплені", needs: "Чекає на тебе", unread: "Нове", working: "В роботі", done: "Готово", inactive: "Сплять",
    now: "now", m: "m", h: "h", d: "d",
    openHere: "Відкрити тут", worktree: "Claude в окремій гілці (worktree)", anotherClaude: "Ще один Claude",
    preview: (p) => "Прев'ю localhost:" + p + " у Dock", noServer: "Прев'ю сайту (сервер не запущено)",
    simulator: "Симулятор iOS", sleep: "Приспати (у «Сплять»)", wake: "Розбудити", rename: "Перейменувати",
    pin: "Закріпити", unpin: "Відкріпити", markRead: "Позначити прочитаним", markUnread: "Позначити непрочитаним",
    closeOthers: "Закрити інші", close: "Закрити", wsName: "Назва", limit: "Ліміт на 5 год", limitShort: "5 год", week: "тиждень",
    today: "Сьогодні", prompts: "промптів", inClaude: "у Claude", agents: "агентів",
    streak: (n) => n + " " + (n % 10 === 1 && n % 100 !== 11 ? "день" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "дні" : "днів"),
    sessionTime: "у цьому проєкті", noSession: "Сесію не вибрано", minShort: " хв", hourShort: " год",
    resets: (at, left) => "о " + at + " · через " + left, resetDone: "ліміт оновився",
  },
};
const DURATION = { en: ["h", "m"], uk: [" год", " хв"] };

const token = (w, name) => {
  const m = new RegExp("(?:^| · )" + name + "([^ ]+)").exec(w?.description ?? "");
  return m ? m[1] : null;
};
// Account-wide tokens live on one workspace (the sync job picks it).
const globalToken = (name) => {
  for (const w of data.workspaces() ?? []) {
    const v = token(w, name);
    if (v) return { w, v };
  }
  return null;
};

function systemLang() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale.startsWith("uk") ? "uk" : "en";
  } catch (e) {
    return "en";
  }
}

const [langOverride, setLangOverride] = signal(null);
const lang = () => langOverride() ?? globalToken("lang:")?.v ?? systemLang();
const t = (key) => STRINGS[lang()]?.[key] ?? STRINGS.en[key];

function setLang(code) {
  setLangOverride(code);
  const owner = globalToken("lim:")?.w ?? globalToken("lang:")?.w ?? (data.workspaces() ?? [])[0];
  if (!owner) return;
  const parts = (owner.description ?? "").split(" · ").filter((p) => p && !p.startsWith("lang:"));
  parts.push("lang:" + code);
  cmux("workspace.action", { action: "set_description", workspace_id: owner.id, description: parts.join(" · ") });
}

const languageMenu = () => [
  Button("Українська", () => setLang("uk")),
  Button("English", () => setLang("en")),
];

const SECTIONS = [
  { id: "pinned", color: GRAY, icon: "pin.fill" },
  { id: "needs", color: ORANGE, icon: "hand.raised.fill" },
  { id: "unread", color: BLUE, icon: "sparkles" },
  { id: "working", color: VIOLET, icon: "bolt.fill" },
  { id: "done", color: GREEN, icon: "checkmark.seal.fill" },
  { id: "inactive", color: GRAY, icon: "moon.zzz.fill" },
];

// --- time --------------------------------------------------------------------------
// Epochs arrive in seconds; guard against milliseconds just in case.
const secs = (v) => (v == null ? null : (v > 1e12 ? v / 1000 : v));
const nowSecs = () => secs(data.clock()?.epoch) ?? Date.now() / 1000;

function lastPromptAt(w) {
  const m = /last prompt @(\d+)/.exec(w.description ?? "");
  return Math.max(secs(w.latestAt) ?? 0, m ? Number(m[1]) : 0) || null;
}

function ago(since) {
  if (!since) return "";
  const s = Math.max(0, nowSecs() - since);
  if (s < 60) return t("now");
  if (s < 3600) return Math.floor(s / 60) + t("m");
  if (s < 86400) return Math.floor(s / 3600) + t("h");
  return Math.floor(s / 86400) + t("d");
}

function duration(s) {
  const [h, m] = DURATION[lang()] ?? DURATION.en;
  const hours = Math.floor(s / 3600);
  const mins = Math.max(1, Math.round((s % 3600) / 60));
  return hours > 0 ? hours + h + " " + mins + m : mins + m;
}

const clockTime = (epoch) => {
  const d = new Date(epoch * 1000);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
};

// --- manual sleep ------------------------------------------------------------------
// Drag a row into Sleeping (or right-click → Put to sleep) to park it there until
// you write in it again. Stored as "zz@<epoch>"; the sync job keeps it. An agent
// that is working or waiting on you still wins.
const sleepOverride = new Map();
const [sleepTick, setSleepTick] = signal(0);

function sleptAt(w) {
  sleepTick();
  const m = /zz@(\d+)/.exec(w.description ?? "");
  const stored = m ? Number(m[1]) : null;
  if (sleepOverride.has(w.id)) {
    const wanted = sleepOverride.get(w.id);
    if (!!stored === !!wanted) sleepOverride.delete(w.id); // caught up
    else return wanted;
  }
  return stored;
}

const isAsleep = (w) => {
  const at = sleptAt(w);
  return !!at && !((lastPromptAt(w) ?? 0) > at);
};

function setAsleep(w, on) {
  const at = on ? Math.floor(nowSecs()) : null;
  sleepOverride.set(w.id, at);
  setSleepTick(sleepTick() + 1);
  const parts = (w.description ?? "").split(" · ").filter((p) => p && !p.startsWith("zz@"));
  if (on) parts.push("zz@" + at);
  cmux("workspace.action", { action: "set_description", workspace_id: w.id, description: parts.join(" · ") });
}

// --- agent state -------------------------------------------------------------------
// needs you (permission prompt or question) > working (incl. background work) >
// sleeping (parked by hand) > new (finished while you were elsewhere) > done >
// sleeping (no prompt for a day).
function agentState(w) {
  if (!w) return { kind: "inactive", since: null };
  const agents = w.agents ?? [];
  const needs = agents.find((a) => a.status === "needs_input");
  if (needs || w.status === "needs-attention") {
    return { kind: "needs", since: secs(needs?.sinceEpoch ?? needs?.lastActivityAt) ?? lastPromptAt(w) };
  }
  const working = agents.find((a) => a.status === "working");
  if (working) return { kind: "working", since: secs(working.sinceEpoch ?? working.lastActivityAt) };
  const last = lastPromptAt(w);
  // Turn ended, but a background shell or background agents are still going
  // and Claude will pick up when they finish (flag from the sync job).
  if (/(^| · )bg( · |$)/.test(w.description ?? "")) return { kind: "working", since: last };
  if (isAsleep(w)) return { kind: "inactive", since: last };
  if (w.unread > 0) return { kind: "unread", since: last };
  if (!last || nowSecs() - last > INACTIVE_AFTER) return { kind: "inactive", since: last };
  return { kind: "done", since: last };
}

// Claude Code prefixes the terminal title with its own spinner glyph (✳ ◐ …);
// the state icon already says that, so drop it from the name.
const cleanTitle = (s) => (s ?? "").replace(/^[\s✳✶✻✽✢✦·•●○◐◓◑◒⠀-⣿*]+/, "");

// cmux names a workspace after its focused tab, so opening a simulator or a
// browser renames a project to "Simulator". Keep the Claude tab's name then.
function workspaceTitle(w) {
  if (!w) return "";
  const tabs = w.tabs ?? [];
  const agentPanels = new Set((w.agents ?? []).map((a) => a.panelId));
  const borrowed = tabs.some((x) => x.title === w.title && !agentPanels.has(x.id));
  const agentTab = tabs.find((x) => agentPanels.has(x.id));
  return borrowed && agentTab ? agentTab.title : w.title;
}

// --- optimistic UI -----------------------------------------------------------------
// Clicks flip local state the same frame; the data context (~1s) catches up.
let selectOverride = null;
const [selectTick, setSelectTick] = signal(0);

function isSelected(w) {
  selectTick();
  if (!w) return false;
  if (selectOverride) {
    if (data.selectedId() === selectOverride) selectOverride = null; // caught up
    else return w.id === selectOverride;
  }
  return !!w.selected;
}

function selectWorkspace(id) {
  if (!id) return;
  selectOverride = id;
  setSelectTick(selectTick() + 1);
  cmux("workspace.select", { workspace_id: id });
}

const closedOverride = new Set();
const [closeTick, setCloseTick] = signal(0);

function closeWorkspace(id) {
  closedOverride.add(id);
  setCloseTick(closeTick() + 1);
  cmux("workspace.close", { workspace_id: id });
}

function visibleWorkspaces() {
  closeTick();
  const ws = data.workspaces() ?? [];
  for (const id of Array.from(closedOverride)) {
    if (!ws.some((w) => w.id === id)) closedOverride.delete(id); // caught up
  }
  return ws.filter((w) => !closedOverride.has(w.id));
}

// Sleeping starts folded: the sidebar scrolls as one piece, so a long list would push
// the activity card off the bottom.
const [collapsed, setCollapsed] = signal({ inactive: true });
const toggleSection = (id) => setCollapsed({ ...collapsed(), [id]: !collapsed()[id] });

const [editingId, setEditingId] = signal(null);

// --- sections ----------------------------------------------------------------------
const sectionOf = (w) => (w.pinned ? "pinned" : agentState(w).kind);

const flatEntries = computed(() => {
  const buckets = Object.fromEntries(SECTIONS.map((s) => [s.id, []]));
  for (const w of visibleWorkspaces()) buckets[sectionOf(w)].push(w);
  const editing = editingId();
  const out = [];
  for (const s of SECTIONS) {
    const rows = buckets[s.id];
    if (rows.length === 0) continue;
    rows.sort((a, b) => (agentState(b).since ?? 0) - (agentState(a).since ?? 0));
    out.push({ kind: "header", id: "h:" + s.id, section: s.id });
    if (collapsed()[s.id]) continue;
    for (const w of rows) {
      out.push({ kind: "ws", id: w.id + (editing === w.id ? ":edit" : ""), wsId: w.id, editing: editing === w.id });
      // Tabs get their own rows once a workspace has more than one, so a
      // second agent in the same project is as visible as the first.
      if (s.id === "inactive" || (w.tabs ?? []).length < 2) continue;
      for (const x of w.tabs) out.push({ kind: "tab", id: w.id + "/" + x.id, wsId: w.id, tabId: x.id });
    }
  }
  return out;
});

const sectionCount = (id) => visibleWorkspaces().filter((w) => sectionOf(w) === id).length;

// --- activity card ---------------------------------------------------------------
// Bottom-left, styled like an iPhone Live Activity: the Router octopus on the left
// reacting to the agents, pages on the right (click the card or a dot to flip;
// cmux sidebars get no swipe gestures). Data comes as tokens from the sync job:
// "lim:<5h %>/<5h reset>/<week %>/<week reset>", "day:<prompts>/<min>/<agents>/<streak>"
// and "win:<points>" on one workspace, and "st:<prompts>/<min>" on each.
const LIMIT_SEGMENTS = 16;
const PAGES = ["limit", "today", "session"];
const [page, setPage] = signal(0);
const CARD_BG = "#141418";
const CARD_TEXT = "#FFFFFF";
const CARD_DIM = "#FFFFFF8C";

function limits() {
  const v = globalToken("lim:")?.v;
  if (!v) return null;
  const [pct, reset, weekPct, weekReset] = v.split("/").map(Number);
  const now = nowSecs();
  return { pct: reset > now ? pct : 0, reset, fresh: !(reset > now), weekPct: weekReset > now ? weekPct : 0 };
}

function today() {
  const v = globalToken("day:")?.v;
  if (!v) return null;
  const [prompts, minutes, agents, streak] = v.split("/").map(Number);
  return { prompts, minutes, agents, streak };
}

function sessionStats() {
  const w = (data.workspaces() ?? []).find((x) => isSelected(x));
  const v = token(w, "st:");
  if (!w || !v) return null;
  const [prompts, minutes] = v.split("/").map(Number);
  return { title: cleanTitle(workspaceTitle(w)), prompts, minutes };
}

const limitColor = (pct) => (pct >= 90 ? RED : pct >= 70 ? ORANGE : GREEN);
const hoursText = (min) => {
  if (min < 60) return min + t("minShort");
  const h = Math.round(min / 6) / 10;
  return String(h).replace(".", lang() === "uk" ? "," : ".") + t("hourShort");
};

const OCTO_PALETTE = {"k": "#10121C", "c": "#398FE2", "C": "#70B6F6", "b": "#1C529C", "p": "#2468B8", "r": "#FF8A7A", "R": "#FFBAAA", "s": "#E26660", "e": "#10121C", "w": "#FFFFFF", "h": "#FF6274", "m": "#8C243A", "y": "#FFD45C"};
const OCTO_FRAMES = {
  sleep: [
    ["..pppppbbppppp..", ".......bb.......", ".....kkkkkk.....", "....kCccccck....", "...kCCcccccck...", "..kbbbbbbbbbbk..", ".krRrrrrrrrrrrk.", ".kRrrrrrrrrrrrk.", ".krreerrreerrrk.", ".krhrrrmmrrrhrk.", ".krrrrrrrrrrrrk.", "..krrrrrrrrrrk..", "...kssssssssk...", "...rr.rrrr.rr...", "..s...r..r...s..", ".s...s....s...s."],
  ],
  idle: [
    ["..pppppbbppppp..", ".......bb.......", ".....kkkkkk.....", "....kCccccck....", "...kCCcccccck...", "..kbbbbbbbbbbk..", ".krRrrrrrrrrrrk.", ".kRrewrrrewrrrk.", ".krreerrreerrrk.", ".krhrrrmmrrrhrk.", ".krrrrrrrrrrrrk.", "..krrrrrrrrrrk..", "...kssssssssk...", "...rr.rrrr.rr...", "..s...r..r...s..", ".s...s....s...s."],
    ["..pppppbbppppp..", ".......bb.......", ".....kkkkkk.....", "....kCccccck....", "...kCCcccccck...", "..kbbbbbbbbbbk..", ".krRrrrrrrrrrrk.", ".kRrewrrrewrrrk.", ".krreerrreerrrk.", ".krhrrrmmrrrhrk.", ".krrrrrrrrrrrrk.", "..krrrrrrrrrrk..", "...kssssssssk...", "...rr.rrrr.rr...", "..s...r..r...s..", ".s...s....s...s."],
    ["..pppppbbppppp..", ".......bb.......", ".....kkkkkk.....", "....kCccccck....", "...kCCcccccck...", "..kbbbbbbbbbbk..", ".krRrrrrrrrrrrk.", ".kRrewrrrewrrrk.", ".krreerrreerrrk.", ".krhrrrmmrrrhrk.", ".krrrrrrrrrrrrk.", "..krrrrrrrrrrk..", "...kssssssssk...", "...rr.rrrr.rr...", "..s...r..r...s..", ".s...s....s...s."],
    ["..pppppbbppppp..", ".......bb.......", ".....kkkkkk.....", "....kCccccck....", "...kCCcccccck...", "..kbbbbbbbbbbk..", ".krRrrrrrrrrrrk.", ".kRrrrrrrrrrrrk.", ".krreerrreerrrk.", ".krhrrrmmrrrhrk.", ".krrrrrrrrrrrrk.", "..krrrrrrrrrrk..", "...kssssssssk...", "...rr.rrrr.rr...", "..s...r..r...s..", ".s...s....s...s."],
  ],
  work: [
    ["..pppppbbppppp..", ".......bb.......", ".....kkkkkk.....", "....kCccccck....", "...kCCcccccck...", "..kbbbbbbbbbbk..", ".krRrrrrrrrrrrk.", ".kRrewrrrewrrrk.", ".krreerrreerrrk.", ".krhrrrmmrrrhrk.", ".krrrrrrrrrrrrk.", "..krrrrrrrrrrk..", "...kssssssssk...", "...rr.rrrr.rr...", "..s...r..r...s..", ".s...s....s...s."],
    ["....CppbbppC....", ".......bb.......", ".....kkkkkk.....", "....kCccccck....", "...kCCcccccck...", "..kbbbbbbbbbbk..", ".krRrrrrrrrrrrk.", ".kRrewrrrewrrrk.", ".krreerrreerrrk.", ".krhrrrmmrrrhrk.", ".krrrrrrrrrrrrk.", "..krrrrrrrrrrk..", "...kssssssssk...", "...rr.rrrr.rr...", "..s...r..r...s..", "..s...s..s...s.."],
  ],
  needs: [
    ["..pppppbbppppp..", ".......bb.......", ".....kkkkkk.....", "....kCccccck....", "...kCCcccccck...", "..kbbbbbbbbbbk..", ".krRrrrrrrrrrrk.", ".kRrewrrrewrrrk.", ".krreerrreerrrkr", ".krhrrrmmrrrhrkr", ".krrrrrrrrrrrrkr", "..krrrrrrrrrrkr.", "...kssssssssk...", "...rr.rrrr......", "..s...r..r......", ".s...s....s....."],
    ["..pppppbbppppp..", ".......bb.......", ".....kkkkkk.....", "....kCccccck....", "...kCCcccccck...", "..kbbbbbbbbbbk..", ".krRrrrrrrrrrrk.", ".kRrewrrrewrrrr.", ".krreerrreerrrk.", ".krhrrrmmrrrhrkr", ".krrrrrrrrrrrrkr", "..krrrrrrrrrrkr.", "...kssssssssk...", "...rr.rrrr......", "..s...r..r......", "..s...s..s......"],
  ],
  party: [
    ["....CppbbppC....", ".......bb.......", ".....kkkkkk.....", "....kCccccck....", "...kCCcccccck...", "..kbbbbbbbbbbk..", ".krRrrrrrrrrrrk.", ".kRrrerrrrerrrk.", ".krrererrererrkr", "rkrhrrrmmrrrhrkr", "rkrrrrrrrrrrrrkr", ".rkrrrrrrrrrrkr.", "...kssssssssk...", "......rrrr......", "......r..r......", ".....s....s....."],
    ["..pppppbbppppp..", ".......bb.......", ".....kkkkkk.....", "....kCccccck....", "...kCCcccccck...", "..kbbbbbbbbbbk..", ".krRrrrrrrrrrrk.", ".kRrrerrrrerrrr.", ".krrererrererrk.", "rkrhrrrmmrrrhrkr", "rkrrrrrrrrrrrrkr", ".rkrrrrrrrrrrkr.", "...kssssssssk...", "......rrrr......", "......r..r......", "......s..s......"],
  ],
};

// What the octopus is doing: waving when an agent waits on you, spinning its
// propeller while agents work, celebrating fresh results, blinking when you were
// here in the last half hour, asleep otherwise.
function octoMood() {
  const ws = data.workspaces() ?? [];
  const states = ws.map((w) => agentState(w).kind);
  if (states.includes("needs")) return "needs";
  if (states.includes("working")) return "work";
  if (states.includes("unread")) return "party";
  const last = Math.max(0, ...ws.map((w) => lastPromptAt(w) ?? 0));
  return nowSecs() - last < 1800 ? "idle" : "sleep";
}

const PIXEL = 3;
function octopus() {
  const pixel = () => {
    const frames = OCTO_FRAMES[octoMood()];
    return frames[(data.clock()?.epoch ?? 0) % frames.length];
  };
  const rows = [];
  for (let y = 0; y < 16; y += 1) {
    const cells = [];
    for (let x = 0; x < 16; x += 1) {
      cells.push(
        Rectangle()
          .fill(() => OCTO_PALETTE[pixel()[y][x]] ?? "#00000000")
          .frame({ width: PIXEL, height: PIXEL })
      );
    }
    rows.push(HStack({ spacing: 0 }, cells));
  }
  return VStack({ spacing: 0 }, rows).fixedSize();
}

// Pages share one slot; the hidden ones collapse to zero height.
const shown = (name) => () => PAGES[page()] === name;
const pageSlot = (name, view) =>
  view.opacity(() => (shown(name)() ? 1 : 0)).frame(() => ({ maxWidth: "infinity", height: shown(name)() ? 58 : 0 }));

function segmentBar(fraction, color, count) {
  const segs = [];
  for (let i = 0; i < count; i += 1) {
    segs.push(
      Capsule()
        .fill(() => ((i + 0.5) / count <= fraction() ? color() : "#FFFFFF26"))
        .frame({ maxWidth: "infinity", height: 4 })
    );
  }
  return HStack({ spacing: 2 }, segs);
}

function limitPage() {
  const lim = () => limits();
  return VStack({ spacing: 5 }, [
    HStack({ spacing: 6 }, [
      Text(() => (lim() ? lim().pct + "%" : "—")).font(22).weight("bold")
        .color(() => limitColor(lim()?.pct ?? 0)).fixedSize(),
      Spacer({ minLength: 4 }),
      Text(() => (lim() ? t("week") + " " + lim().weekPct + "%" : "")).font(10).color(CARD_DIM).fixedSize(),
    ]),
    segmentBar(() => (lim()?.pct ?? 0) / 100, () => limitColor(lim()?.pct ?? 0), LIMIT_SEGMENTS),
    Text(() => {
      const l = lim();
      if (!l) return t("limit");
      return t("limitShort") + " · " + (l.fresh ? t("resetDone") : t("resets")(clockTime(l.reset), duration(l.reset - nowSecs())));
    }).font(10).color(CARD_DIM).lineLimit(1).truncation("tail"),
  ]);
}

function stat(value, label) {
  return VStack({ spacing: 1 }, [
    Text(value).font(17).weight("bold").color(CARD_TEXT).fixedSize(),
    Text(label).font(10).color(CARD_DIM).fixedSize(),
  ]).fixedSize();
}

function todayPage() {
  const d = () => today();
  return VStack({ spacing: 5 }, [
    HStack({ spacing: 6 }, [
      Text(() => t("today")).font(11).weight("semibold").color(CARD_DIM),
      Spacer(),
      Text(() => (d()?.streak ? "🔥 " + t("streak")(d().streak) : "")).font(10).color(ORANGE).fixedSize(),
    ]),
    HStack({ spacing: 8 }, [
      stat(() => String(d()?.prompts ?? 0), () => t("prompts")),
      stat(() => hoursText(d()?.minutes ?? 0), () => t("inClaude")),
      stat(() => String(d()?.agents ?? 0), () => t("agents")),
      Spacer({ minLength: 0 }),
    ]),
  ]);
}

function sessionPage() {
  const st = () => sessionStats();
  return VStack({ spacing: 5 }, [
    Text(() => st()?.title ?? t("noSession")).font(11).weight("semibold").color(CARD_DIM).lineLimit(1).truncation("tail"),
    HStack({ spacing: 12 }, [
      stat(() => (st() ? hoursText(st().minutes) : "—"), () => t("sessionTime")),
      stat(() => (st() ? String(st().prompts) : "—"), () => t("prompts")),
      Spacer({ minLength: 0 }),
    ]),
  ]);
}

function pageDots() {
  const dots = PAGES.map((_, i) =>
    Circle()
      .fill(() => (page() === i ? CARD_TEXT : "#FFFFFF40"))
      .frame({ width: 5, height: 5 })
      .onTap(() => setPage(i))
  );
  return HStack({ spacing: 5 }, [Spacer(), ...dots, Spacer()]);
}

function activityCard() {
  return VStack({ spacing: 8 }, [
    HStack({ spacing: 10 }, [
      octopus(),
      VStack({ spacing: 0 }, [
        pageSlot("limit", limitPage()),
        pageSlot("today", todayPage()),
        pageSlot("session", sessionPage()),
      ]).frame({ maxWidth: "infinity" }),
    ]),
    pageDots(),
  ])
    .padding(12)
    .background(CARD_BG)
    .borderColor("#FFFFFF14")
    .borderWidth(1)
    .cornerRadius(20)
    .paddingHorizontal(4)
    .paddingTop(6)
    .frame({ maxWidth: "infinity", height: CARD_H })
    .cursor("pointer")
    .onTap(() => setPage((page() + 1) % PAGES.length))
    .contextMenu(languageMenu());
}

// --- views -------------------------------------------------------------------------
function stateIcon(st) {
  return ZStack({}, [
    Image("progress.indicator")
      .font(12).weight("bold")
      .color(() => SPINNER_COLORS[(data.clock()?.epoch ?? 0) % SPINNER_COLORS.length])
      .rotation(() => (st().kind === "working" ? (data.clock()?.epoch ?? 0) * 360 : 0))
      .opacity(() => (st().kind === "working" ? 1 : 0)),
    Image("record.circle")
      .font(13).color(ORANGE)
      .opacity(() => (st().kind === "needs" ? 1 : 0)),
    Image("checkmark.circle.fill")
      .font(13).color(BLUE)
      .opacity(() => (st().kind === "unread" ? 1 : 0)),
    Image("checkmark")
      .font(10).weight("semibold").color("tertiary")
      .opacity(() => (st().kind === "done" ? 1 : 0)),
    Image("moon.fill")
      .font(10).color("tertiary")
      .opacity(() => (st().kind === "inactive" ? 1 : 0)),
  ]).frame({ width: 16, height: 16 });
}

// Background agents as segments: "12/16" from the sync job via
// `cmux set-progress`, drawn as 16 dashes with 12 lit in the spinner colours.
const MAX_SEGMENTS = 24;

function progressCounts(w) {
  const m = /^(\d+)\/(\d+)$/.exec(w?.progress?.label ?? "");
  return m ? { done: Number(m[1]), total: Math.min(Number(m[2]), MAX_SEGMENTS) } : null;
}

function progressSegments(w) {
  const segs = [];
  for (let i = 0; i < MAX_SEGMENTS; i += 1) {
    segs.push(
      Capsule()
        .fill(() => {
          const p = progressCounts(w());
          return p && i < p.done ? SPINNER_COLORS[i % SPINNER_COLORS.length] : "#7f7f7f40";
        })
        .frame(() => ({ width: (progressCounts(w())?.total ?? 0) > i ? 7 : 0, height: 3 }))
    );
  }
  return HStack({ spacing: 2 }, [...segs, Spacer({ minLength: 0 })])
    .frame(() => ({ maxWidth: "infinity", height: progressCounts(w()) ? 3 : 0 }))
    .opacity(() => (progressCounts(w()) ? 1 : 0));
}

// One tab under its workspace: indented, smaller, with that tab's own agent state.
function tabState(w, tab) {
  const agent = (w?.agents ?? []).find((a) => a.panelId === tab?.id);
  if (agent?.status === "needs_input") return { kind: "needs", since: secs(agent.sinceEpoch) };
  if (agent?.status === "working") return { kind: "working", since: secs(agent.sinceEpoch) };
  if (tab?.hasUnread) return { kind: "unread", since: secs(tab.latestAt) };
  return { kind: agent ? "done" : "none", since: secs(tab?.latestAt) };
}

function tabRow(entry) {
  const w = () => (data.workspaces() ?? []).find((x) => x.id === entry.wsId);
  const tab = () => (w()?.tabs ?? []).find((x) => x.id === entry.tabId);
  const st = () => tabState(w(), tab());
  const isCurrent = () => isSelected(w()) && !!tab()?.focused;
  return HStack({ spacing: 8 }, [
    Rectangle().fill("#7f7f7f40").frame({ width: 1, height: 14 }),
    Text(() => cleanTitle(tab()?.title))
      .font(12)
      .weight(() => (st().kind === "unread" ? "semibold" : "regular"))
      .lineLimit(1)
      .truncation("tail")
      .color(() => (isCurrent() ? "primary" : "secondary")),
    Spacer({ minLength: 0 }),
    HStack({ spacing: 8 }, [
      Text(() => (st().kind === "none" ? "" : ago(st().since))).font(11).color("tertiary"),
      stateIcon(st).opacity(() => (st().kind === "none" ? 0 : 1)),
    ])
      .fixedSize()
      .layoutPriority(2),
  ])
    .paddingLeading(18)
    .paddingTrailing(10)
    .paddingVertical(3)
    .cornerRadius(6)
    .background(() => (isCurrent() ? "#7f7f7f24" : (st().kind === "unread" ? "#4C9EEB1c" : null)))
    .hoverBackground("#7f7f7f1c")
    .frame({ maxWidth: "infinity", height: TAB_H })
    .fixed()
    .onTap(() => {
      selectWorkspace(w()?.id);
      if (tab()?.surfaceId) cmux("surface.focus", { surface_id: tab().surfaceId, workspace_id: w().id });
    });
}

// "Open here": a second Claude in this project (optionally on its own git
// worktree so two agents don't overwrite each other), a localhost preview in
// the Dock, or an iOS simulator tab.
function openHereMenu(w) {
  const newTerminal = (input) => () =>
    cmux("surface.create", {
      workspace_id: w().id,
      working_directory: w().directory,
      initial_input: input + "\r",
      focus: true,
    });
  // Menu items can't be hidden (no conditional views), so the preview item
  // is always there and says when there is no server to preview.
  const port = () => (w()?.ports ?? [])[0];
  return Menu(() => t("openHere"), [
    Button(() => t("worktree"), newTerminal("claude -w")),
    Button(() => t("anotherClaude"), newTerminal("claude")),
    Divider(),
    Button(() => (port() ? t("preview")(port()) : t("noServer")), () => {
      if (port()) cmux("surface.create", { workspace_id: w().id, type: "browser", placement: "dock", url: "http://localhost:" + port() });
    }),
    Button(() => t("simulator"), () => cmux("surface.create", { workspace_id: w().id, type: "simulator", focus: true })),
  ]);
}

function rowBackground(w, st, hover) {
  if (isSelected(w)) return "#7f7f7f3d";
  if (st.kind === "unread") return hover ? "#4C9EEB38" : "#4C9EEB24";
  return hover ? "#7f7f7f24" : null;
}

function workspaceMenu(w) {
  const act = (action) => () => cmux("workspace.action", { action, workspace_id: w().id });
  return [
    openHereMenu(w),
    Divider(),
    Button(() => (isAsleep(w()) ? t("wake") : t("sleep")), () => setAsleep(w(), !isAsleep(w()))),
    Button(() => t("rename"), () => setEditingId(w().id)),
    Button(() => (w()?.pinned ? t("unpin") : t("pin")), () =>
      cmux("workspace.action", { action: w()?.pinned ? "unpin" : "pin", workspace_id: w().id })),
    Button(() => (w()?.unread > 0 ? t("markRead") : t("markUnread")), () =>
      cmux("workspace.action", { action: w()?.unread > 0 ? "mark_read" : "mark_unread", workspace_id: w().id })),
    Divider(),
    Button(() => t("closeOthers"), act("close_others")).destructive(),
    Button(() => t("close"), () => closeWorkspace(w().id)).destructive(),
  ];
}

function workspaceRow(w) {
  // Title on the left, "4m" + state icon on the right; on hover the time and
  // icon yield to the close button.
  const st = () => agentState(w());
  return ZStack({ alignment: "trailing" }, [
    VStack({ spacing: 4 }, [
      HStack({ spacing: 8 }, [
        Text(() => cleanTitle(workspaceTitle(w())))
          .font(13)
          .weight(() => (st().kind === "unread" ? "semibold" : "regular"))
          .lineLimit(1)
          .truncation("tail")
          .marquee()
          .color(() => (st().kind === "inactive" && !isSelected(w()) ? "tertiary" : "primary")),
        Spacer({ minLength: 0 }),
        HStack({ spacing: 8 }, [
          Text(() => w()?.progress?.label ?? ago(st().since))
            .font(12)
            .color(() => (st().kind === "needs" ? ORANGE : (st().kind === "unread" ? BLUE : "secondary"))),
          stateIcon(st),
        ])
          .fixedSize()
          .layoutPriority(2)
          .hideOnHover(),
      ])
        .frame({ maxWidth: "infinity" }),
      progressSegments(w),
    ]),
    Image("xmark")
      .font(9).weight("semibold").color("secondary")
      .padding(4)
      .cornerRadius(9)
      .hoverBackground("#7f7f7f4a")
      .showOnHover()
      .onTap(() => closeWorkspace(w().id)),
  ])
    .paddingHorizontal(10)
    .paddingVertical(6)
    .cornerRadius(8)
    .background(() => rowBackground(w(), st(), false))
    .hoverBackground(() => rowBackground(w(), st(), true))
    .frame(() => ({ maxWidth: "infinity", height: progressCounts(w()) ? ROW_PROGRESS_H : ROW_H }))
    .onTap(() => selectWorkspace(w().id))
    .onDoubleTap(() => setEditingId(w().id))
    .contextMenu(workspaceMenu(w));
}

function workspaceEditRow(w) {
  return HStack({ spacing: 8 }, [
    TextField(() => w()?.title ?? "", {
      placeholder: t("wsName"),
      onSubmit: (text) => {
        const title = (text ?? "").trim();
        cmux("workspace.action", title
          ? { action: "rename", workspace_id: w().id, title }
          : { action: "clear_name", workspace_id: w().id });
        setEditingId(null);
      },
      onCancel: () => setEditingId(null),
    }).font(13),
  ])
    .paddingHorizontal(10)
    .paddingVertical(6)
    .cornerRadius(8)
    .background("#7f7f7f3d")
    .frame({ maxWidth: "infinity", height: ROW_H });
}

function sectionHeader(id) {
  // A coloured pill (icon, name, count) is the divider; no extra lines needed.
  const s = SECTIONS.find((x) => x.id === id);
  const isFirst = () => flatEntries()[0]?.id === "h:" + id;
  return HStack({ spacing: 6 }, [
    HStack({ spacing: 5 }, [
      Image(s.icon).font(10).color(s.color),
      Text(() => t(id)).font(12).weight("semibold").color(s.color),
      Text(() => String(sectionCount(id))).font(11).weight("bold").color(s.color).opacity(0.7),
    ])
      .paddingHorizontal(9)
      .paddingVertical(4)
      .background(s.color + "26")
      .cornerRadius(11)
      .fixedSize(),
    Spacer(),
    Image("chevron.right")
      .font(9).weight("semibold").color("tertiary")
      .rotation(() => (collapsed()[id] ? 0 : 90))
      .frame({ width: 14, height: 14 }),
  ])
    .paddingLeading(6)
    .paddingTrailing(10)
    .paddingTop(() => (isFirst() ? 4 : 14))
    .paddingBottom(4)
    .frame(() => ({ maxWidth: "infinity", height: isFirst() ? HEADER_FIRST_H : HEADER_H }))
    .fixed()
    .cursor("pointer")
    .onTap(() => toggleSection(id))
    .contextMenu(languageMenu());
}

// Sections are computed from state, so the only drop that means anything is
// into Sleeping (park it) or out of it (wake it). Anything else springs back.
function handleMove(id, index) {
  const entries = flatEntries().filter((e) => e.id !== id);
  let target = SECTIONS[0].id;
  for (let i = Math.min(index, entries.length) - 1; i >= 0; i -= 1) {
    if (entries[i].kind === "header") { target = entries[i].section; break; }
  }
  const w = (data.workspaces() ?? []).find((x) => x.id === id);
  if (!w) return;
  if (target === "inactive" && !isAsleep(w)) setAsleep(w, true);
  else if (target !== "inactive" && isAsleep(w)) setAsleep(w, false);
}

// --- keeping the card at the bottom -------------------------------------------------
// A cmux sidebar scrolls as one piece and can't pin anything to its bottom, and it
// doesn't know the window height. The sync job reports that ("win:<points>"), every
// row has a fixed height, and a spacer fills what's left above the card.
const HEADER_FIRST_H = 30;
const HEADER_H = 40;
const ROW_H = 30;
const ROW_PROGRESS_H = 37;
const TAB_H = 22;
const CARD_H = 104;
const LIST_SPACING = 2;
const SIDEBAR_CHROME = 60;   // title bar above the list and the footer buttons below it

function listHeight() {
  const entries = flatEntries();
  let h = Math.max(0, entries.length - 1) * LIST_SPACING;
  entries.forEach((e, i) => {
    if (e.kind === "header") h += i === 0 ? HEADER_FIRST_H : HEADER_H;
    else if (e.kind === "tab") h += TAB_H;
    else {
      const w = (data.workspaces() ?? []).find((x) => x.id === e.wsId);
      h += progressCounts(w) ? ROW_PROGRESS_H : ROW_H;
    }
  });
  return h;
}

function spacerHeight() {
  const win = Number(globalToken("win:")?.v ?? 0);
  if (!win) return 12;
  return Math.max(12, win - SIDEBAR_CHROME - listHeight() - CARD_H - 2 * 2);
}

// --- root --------------------------------------------------------------------------
sidebar(() =>
  VStack({ spacing: 2 }, [
    Reorderable(
      { items: flatEntries, key: (e) => e.id, spacing: 2, onMove: handleMove },
      (e) => {
        const entry = e(); // kind, ids and editing are stable per key
        if (entry.kind === "header") return sectionHeader(entry.section);
        if (entry.kind === "tab") return tabRow(entry);
        const w = () => (data.workspaces() ?? []).find((x) => x.id === entry.wsId);
        return entry.editing ? workspaceEditRow(w) : workspaceRow(w);
      }
    ),
    Rectangle().fill("#00000000").frame(() => ({ maxWidth: "infinity", height: spacerHeight() })),
    activityCard(),
  ]).frame({ maxWidth: "infinity", maxHeight: "infinity" }),
  { surface: "glass" }
)
