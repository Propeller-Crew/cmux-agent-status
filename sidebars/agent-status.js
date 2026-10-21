// Agent status sidebar: workspaces grouped by what they need from you,
// styled after a Warp redesign (rows with "4m" + a state icon).
//
// Sections, top to bottom (like the built-in Attention Queue, but by agent
// state): Pinned > Needs you > New (done, not read) > Working > No task yet > Done > Sleeping.
// Above them, the Claude Code usage limit and when it resets.
//
// What cmux doesn't know comes from workspace descriptions, written by
// scripts/last-prompt-sync.py: "last prompt @<epoch> · bg · remote@<epoch> · zz@<epoch> · lim:… · lang:…".
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
const TEAL = "#5AC8FA";
// The working spinner walks through these, one per clock tick.
const SPINNER_COLORS = ["#5B8CFF", "#8B5CF6", "#EC4899", "#F59E0B", "#14B8A6"];

// --- language ----------------------------------------------------------------------
// Picked with right-click on the limit card or a section header, stored as a
// "lang:uk|en" token; until then, macOS's language.
const STRINGS = {
  en: {
    pinned: "Pinned", needs: "Needs you", unread: "New", working: "Working", fresh: "No task yet", done: "Done", inactive: "Sleeping",
    now: "now", m: "m", h: "h", d: "d",
    openHere: "Open here", worktree: "Claude on its own branch (worktree)", anotherClaude: "Another Claude",
    preview: (p) => "Preview localhost:" + p + " in the Dock", noServer: "Site preview (no server running)",
    simulator: "iOS Simulator", sleep: "Put to sleep", wake: "Wake up", rename: "Rename", pin: "Pin", unpin: "Unpin",
    markRead: "Mark as Read", markUnread: "Mark as Unread", closeOthers: "Close Others", close: "Close",
    wsName: "Workspace name", limit: "5-hour limit", limitShort: "5h", week: "week",
    more: (n) => n + " more",
    today: "Today", prompts: "prompts", inClaude: "in Claude", agents: "agents",
    streak: (n) => n + (n === 1 ? " day" : " days"), sessionTime: "in project", noSession: "No session selected",
    minUnit: "min", hourUnit: "h",
    focus: "Focus", start: "Start", stop: "Stop", focusIdle: "25 min, no distractions",
    paste: "Paste", hide: "Hide", closeQ: "Close?",
    focusDone: "Focus done", focusDoneBody: "25 minutes behind you. Take five?",
    resets: (at, left) => "at " + at + " · " + left, resetDone: "limit has reset",
    spinner: "Working indicator", spinColor: "Colour", spinPulse: "Pulse", spinDots: "Three dots", spinBraille: "Braille ⠋⠙⠹",
    newVersion: (v) => "New version " + v, update: "Update", whatsNew: "What's new", hideVersion: "Hide this version",
    tabsSkill: "Tasks in new tabs", tabsSkillHelp: "Claude opens a separate task in a new tab of this workspace. On by default; a change applies to new Claude sessions.",
  },
  uk: {
    pinned: "Закріплені", needs: "Чекає на тебе", unread: "Нове", working: "В роботі", fresh: "Без задачі", done: "Готово", inactive: "Сплять",
    now: "now", m: "m", h: "h", d: "d",
    openHere: "Відкрити тут", worktree: "Claude в окремій гілці (worktree)", anotherClaude: "Ще один Claude",
    preview: (p) => "Прев'ю localhost:" + p + " у Dock", noServer: "Прев'ю сайту (сервер не запущено)",
    simulator: "Симулятор iOS", sleep: "Приспати (у «Сплять»)", wake: "Розбудити", rename: "Перейменувати",
    pin: "Закріпити", unpin: "Відкріпити", markRead: "Позначити прочитаним", markUnread: "Позначити непрочитаним",
    closeOthers: "Закрити інші", close: "Закрити", wsName: "Назва", limit: "Ліміт на 5 год", limitShort: "5 год", week: "тиж.",
    more: (n) => "ще " + n,
    today: "Сьогодні", prompts: "промптів", inClaude: "у Claude", agents: "агентів",
    streak: (n) => n + " " + (n % 10 === 1 && n % 100 !== 11 ? "день" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "дні" : "днів"),
    sessionTime: "у проєкті", noSession: "Сесію не вибрано", minUnit: "хв", hourUnit: "год",
    focus: "Фокус", start: "Старт", stop: "Стоп", focusIdle: "25 хв без відволікань",
    paste: "Вставити", hide: "Сховати", closeQ: "Закрити?",
    focusDone: "Фокус завершено", focusDoneBody: "25 хвилин позаду. Перерва на п'ять?",
    resets: (at, left) => "о " + at + " · " + left, resetDone: "ліміт оновився",
    spinner: "Індикатор", spinColor: "Колір", spinPulse: "Пульс", spinDots: "Три крапки", spinBraille: "Брайль ⠋⠙⠹",
    newVersion: (v) => "Нова версія " + v, update: "Оновити", whatsNew: "Що нового", hideVersion: "Сховати цю версію",
    tabsSkill: "Задачі в нові вкладки", tabsSkillHelp: "Окрему задачу Claude відкриває в новій вкладці цього воркспейсу. Увімкнено за замовчуванням; зміна діє на нові сесії Claude.",
  },
};
const DURATION = { en: ["h", "m"], uk: [" год", " хв"] };

// --- keeping the bindings cheap ----------------------------------------------------
// cmux gives each call into the sidebar 0.25 s and then stops it for good ("JavaScript
// execution terminated", 20.10.2026), and every binding that re-runs sends cmux an op,
// changed or not. A data update hands over a new object for every workspace, so a
// binding that reads data.workspaces() re-runs on each one: about 900 per update and
// 360 per clock tick with 35 workspaces. So bindings read memos instead: computed()
// wakes its readers only when the value differs (Object.is), and stable() keeps the
// previous object while the new one has the same JSON.
function stable(fn) {
  let last, lastJson;
  return computed(() => {
    const v = fn();
    const json = JSON.stringify(v);
    if (json !== lastJson) {
      lastJson = json;
      last = v;
    }
    return last;
  });
}

// Workspaces by id: one Map per data update instead of a find() in every binding.
const wsById = computed(() => new Map((data.workspaces() ?? []).map((w) => [w.id, w])));

const TOKEN_RE = new Map();
const token = (w, name) => {
  let re = TOKEN_RE.get(name);
  if (!re) TOKEN_RE.set(name, (re = new RegExp("(?:^| · )" + name + "([^ ]+)")));
  const m = re.exec(w?.description ?? "");
  return m ? m[1] : null;
};
// Account-wide tokens live on one workspace (the sync job picks it); read once per
// data update. { id, v }: the owner's id and the value.
const GLOBAL_TOKENS = ["lim:", "day:", "win:", "focus:", "dl:", "dlseen:", "lang:", "spin:", "tabs:", "upd:", "updhide:"];
const globalTokens = stable(() => {
  const out = {};
  for (const w of data.workspaces() ?? []) {
    for (const name of GLOBAL_TOKENS) {
      const v = out[name] ? null : token(w, name);
      if (v) out[name] = { id: w.id, v };
    }
  }
  return out;
});
const globalToken = (name) => globalTokens()[name] ?? null;

function systemLang() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale.startsWith("uk") ? "uk" : "en";
  } catch (e) {
    return "en";
  }
}

const [langOverride, setLangOverride] = signal(null);
const lang = computed(() => langOverride() ?? globalToken("lang:")?.v ?? systemLang());
const t = (key) => STRINGS[lang()]?.[key] ?? STRINGS.en[key];

// Writes (or with value null, removes) an account-wide token on the workspace that
// carries them; the sync job keeps it there.
function setGlobalToken(prefix, value) {
  const ws = data.workspaces() ?? [];
  const ownerId = globalToken("lim:")?.id ?? globalToken(prefix)?.id;
  const owner = ws.find((w) => w.id === ownerId) ?? ws[0];
  if (!owner) return;
  const parts = (owner.description ?? "").split(" · ").filter((p) => p && !p.startsWith(prefix));
  if (value != null) parts.push(prefix + value);
  cmux("workspace.action", { action: "set_description", workspace_id: owner.id, description: parts.join(" · ") });
}

function setLang(code) {
  setLangOverride(code);
  setGlobalToken("lang:", code);
}

const languageMenu = () => [
  Button("Українська", () => setLang("uk")),
  Button("English", () => setLang("en")),
];

// --- working indicator -------------------------------------------------------------
// How a working row shows it works, picked from the right-click menu and stored as a
// "spin:" token. Each steps once a clock tick (a sidebar has no faster timer); a turning
// or tweened icon is out: cmux animates it and lays out the whole window every frame.
const SPINNERS = [["color", "spinColor"], ["pulse", "spinPulse"], ["dots", "spinDots"], ["braille", "spinBraille"]];
const BRAILLE = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const [spinOverride, setSpinOverride] = signal(null);
const spinner = computed(() => spinOverride() ?? globalToken("spin:")?.v ?? "dots");

function setSpinner(name) {
  setSpinOverride(name);
  setGlobalToken("spin:", name);
}

const spinnerMenu = () => Menu(() => t("spinner"), SPINNERS.map(([name, label]) =>
  Button(() => (spinner() === name ? "✓ " : "") + t(label), () => setSpinner(name))));

// --- tasks in new tabs -------------------------------------------------------------
// A tick in the right-click menu turns on the skill in skills/cmux-tabs: Claude opens a
// separate task in a new tab of the workspace. Stored as "tabs:on|off"; the sync job links
// the skill into ~/.claude/skills or takes the link away, so new Claude sessions see it.
// On until unticked: no token means on.
const [tabsOverride, setTabsOverride] = signal(null);
const tabsSkill = computed(() => (tabsOverride() ?? globalToken("tabs:")?.v) !== "off");

function toggleTabsSkill() {
  const v = tabsSkill() ? "off" : "on";
  setTabsOverride(v);
  setGlobalToken("tabs:", v);
}

const tabsSkillItem = () =>
  Button(() => (tabsSkill() ? "✓ " : "") + t("tabsSkill"), toggleTabsSkill).help(() => t("tabsSkillHelp"));
const panelMenu = () => [...languageMenu(), Divider(), spinnerMenu(), tabsSkillItem()];

// A view that exists only while cond() holds (there is no conditional view helper):
// a keyed list of one item mounts it, and of none unmounts it.
const when = (cond, build) => ForEach({ items: () => (cond() ? ["on"] : []), key: (k) => k }, () => build());

const SECTIONS = [
  { id: "pinned", color: GRAY, icon: "pin.fill" },
  { id: "needs", color: ORANGE, icon: "hand.raised.fill" },
  { id: "unread", color: BLUE, icon: "sparkles" },
  { id: "working", color: VIOLET, icon: "bolt.fill" },
  { id: "fresh", color: TEAL, icon: "square.and.pencil" },
  { id: "done", color: GREEN, icon: "checkmark.seal.fill" },
  { id: "inactive", color: GRAY, icon: "moon.zzz.fill" },
];

// --- time --------------------------------------------------------------------------
// Epochs arrive in seconds; guard against milliseconds just in case.
const secs = (v) => (v == null ? null : (v > 1e12 ? v / 1000 : v));
const nowSecs = () => secs(data.clock()?.epoch) ?? Date.now() / 1000;

// Every helper below accepts a missing workspace: a row's bindings can still
// re-run for a moment after its workspace was closed.
// A Claude on a server (ssh, mosh or et in a tab) leaves no transcripts here, so for such
// a workspace the sync job writes "remote@<epoch>": when that terminal's screen last
// changed. It counts like a prompt, so a live ssh session doesn't read as asleep.
function lastPromptAt(w) {
  if (!w) return null;
  const d = w.description ?? "";
  const m = /last prompt @(\d+)/.exec(d);
  const r = d.includes("remote@") ? /(?:^| · )remote@(\d+)/.exec(d) : null;
  return Math.max(secs(w.latestAt) ?? 0, m ? Number(m[1]) : 0, r ? Number(r[1]) : 0) || null;
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
  if (!w) return null;
  const m = /zz@(\d+)/.exec(w.description ?? "");
  const stored = m ? Number(m[1]) : null;
  if (sleepOverride.has(w.id)) {
    const wanted = sleepOverride.get(w.id);
    if (!!stored === !!wanted) sleepOverride.delete(w.id); // caught up
    else return wanted;
  }
  return stored;
}

// last: lastPromptAt(w), when the caller has it already.
const isAsleep = (w, last = lastPromptAt(w)) => {
  const at = sleptAt(w);
  return !!at && !((last ?? 0) > at);
};

function setAsleep(w, on) {
  if (!w) return;
  const at = on ? Math.floor(nowSecs()) : null;
  sleepOverride.set(w.id, at);
  setSleepTick(sleepTick() + 1);
  const parts = (w.description ?? "").split(" · ").filter((p) => p && !p.startsWith("zz@"));
  if (on) parts.push("zz@" + at);
  cmux("workspace.action", { action: "set_description", workspace_id: w.id, description: parts.join(" · ") });
}

// --- agent state -------------------------------------------------------------------
// needs you (permission prompt or question) > working (incl. background work) >
// sleeping (parked by hand) > new (finished while you were elsewhere) > no task yet
// (a live Claude without a prompt) > done > sleeping (no prompt for a day).
// Asked by every row, the section sort, the counts and the octopus, so it's worked out
// once per workspace object and second. A hit reads the clock and sleepTick like a
// miss does, so its readers still wake when either moves.
const stateCache = new WeakMap();
function agentState(w) {
  if (!w) return { kind: "inactive", since: null };
  const now = nowSecs();
  const tick = sleepTick();
  const hit = stateCache.get(w);
  if (hit && hit.now === now && hit.tick === tick) return hit.st;
  const st = computeAgentState(w);
  stateCache.set(w, { now, tick, st });
  return st;
}

function computeAgentState(w) {
  const agents = w.agents ?? [];
  const needs = agents.find((a) => a.status === "needs_input");
  // cmux's own workspace status can stay "needs-attention" after a question is answered
  // (seen 20.10.2026: every tab working, the workspace still under Needs you). Trust it
  // only when no agent there says it's working; an agent that does wait shows needs_input.
  const stale = w.status === "needs-attention" && agents.some((a) => a.status === "working");
  if (needs || (w.status === "needs-attention" && !stale)) {
    return { kind: "needs", since: secs(needs?.sinceEpoch ?? needs?.lastActivityAt) ?? lastPromptAt(w) };
  }
  const working = agents.find((a) => a.status === "working");
  if (working) return { kind: "working", since: secs(working.sinceEpoch ?? working.lastActivityAt) };
  const last = lastPromptAt(w);
  // Turn ended, but a background shell or background agents are still going
  // and Claude will pick up when they finish (flag from the sync job).
  if (/(^| · )bg( · |$)/.test(w.description ?? "")) return { kind: "working", since: last };
  // Claude's working line on a server's screen, changing ("rwork@<since>", sync job).
  const remoteWork = (w.description ?? "").includes("rwork@") && /(?:^| · )rwork@(\d+)/.exec(w.description);
  if (remoteWork) return { kind: "working", since: Number(remoteWork[1]) };
  if (isAsleep(w, last)) return { kind: "inactive", since: last };
  if (w.unread > 0) return { kind: "unread", since: last };
  // A workspace you just opened, no prompt yet ("new" from the sync job): every
  // session starts here, and without this it would vanish into folded Sleeping.
  if (!last && /(^| · )new( · |$)/.test(w.description ?? "")) return { kind: "fresh", since: null };
  // Before the sync job has seen it: no history at all and a Claude started minutes ago.
  const startedAt = Math.max(0, ...agents.map((a) => secs(a.sinceEpoch ?? a.lastActivityAt) ?? 0));
  if (!last && !w.description && startedAt && nowSecs() - startedAt < 600) return { kind: "fresh", since: null };
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

// The row hides at once; cmux catches up. Closing is forced: without it cmux refuses
// a workspace whose terminal runs a process (Claude does) and waits for a
// confirmation, and the hidden row never came back. If the close still didn't
// happen, the row reappears after a few seconds instead of vanishing for good.
const closedOverride = new Map();   // workspace id → when the close was asked
const [closeTick, setCloseTick] = signal(0);
const CLOSE_GRACE = 3;

const CLOSE_CONFIRM_SECONDS = 4;
const [closeAsk, setCloseAsk] = signal(null);   // { id, at } while a row asks "Close?"

function askClose(id) {
  setCloseAsk({ id, at: nowSecs() });
}

function cancelClose() {
  if (closeAsk()) setCloseAsk(null);
}

function isConfirmingClose(w) {
  const ask = closeAsk();
  return !!w && !!ask && ask.id === w.id && nowSecs() - ask.at < CLOSE_CONFIRM_SECONDS;
}

function closeWorkspace(id) {
  setCloseAsk(null);
  closedOverride.set(id, nowSecs());
  setCloseTick(closeTick() + 1);
  cmux("workspace.close", { workspace_id: id, force: true });
}

function visibleWorkspaces() {
  closeTick();
  const ws = data.workspaces() ?? [];
  for (const [id, at] of Array.from(closedOverride)) {
    if (!ws.some((w) => w.id === id) || nowSecs() - at > CLOSE_GRACE) closedOverride.delete(id);
  }
  return ws.filter((w) => !closedOverride.has(w.id));
}

// Sleeping starts folded: the sidebar scrolls as one piece, so a long list would push
// the activity card off the bottom.
const [collapsed, setCollapsed] = signal({ inactive: true });
const toggleSection = (id) => {
  if (id === "inactive") setShowAllSleeping(false);
  setCollapsed({ ...collapsed(), [id]: !collapsed()[id] });
};

const [editingId, setEditingId] = signal(null);

const SLEEPING_PREVIEW = 12;
const [showAllSleeping, setShowAllSleeping] = signal(false);

// --- sections ----------------------------------------------------------------------
const sectionOf = (w) => (w.pinned ? "pinned" : agentState(w).kind);

// Every workspace id by section, in the order the sidebar shows them.
const sectionIds = stable(() => {
  const buckets = Object.fromEntries(SECTIONS.map((s) => [s.id, []]));
  for (const w of visibleWorkspaces()) buckets[sectionOf(w)].push(w);
  const out = {};
  for (const [id, rows] of Object.entries(buckets)) {
    rows.sort((a, b) => (agentState(b).since ?? 0) - (agentState(a).since ?? 0));
    out[id] = rows.map((w) => w.id);
  }
  return out;
});

const flatEntries = stable(() => {
  const ids = sectionIds();
  const byId = wsById();
  const editing = editingId();
  const out = [];
  for (const s of SECTIONS) {
    const rows = ids[s.id].map((id) => byId.get(id)).filter(Boolean);
    if (rows.length === 0) continue;
    out.push({ kind: "header", id: "h:" + s.id, section: s.id });
    if (collapsed()[s.id]) continue;
    // Sleeping can hold dozens of rows, and every row re-evaluates each second, so
    // unfolding it all at once lags; show the latest few and a "more" row.
    const capped = s.id === "inactive" && !showAllSleeping() && rows.length > SLEEPING_PREVIEW;
    for (const w of capped ? rows.slice(0, SLEEPING_PREVIEW) : rows) {
      out.push({ kind: "ws", id: w.id + (editing === w.id ? ":edit" : ""), wsId: w.id, editing: editing === w.id });
      // Tabs get their own rows once a workspace has more than one, so a
      // second agent in the same project is as visible as the first.
      if (s.id === "inactive" || (w.tabs ?? []).length < 2) continue;
      for (const x of w.tabs) out.push({ kind: "tab", id: w.id + "/" + x.id, wsId: w.id, tabId: x.id });
    }
    if (capped) out.push({ kind: "more", id: "more:" + s.id, count: rows.length - SLEEPING_PREVIEW });
  }
  return out;
});

const sectionCount = (id) => sectionIds()[id].length;

// Cmd+1…9 pick workspaces by cmux's own order, so that order follows the sidebar:
// Cmd+1 is always the top row. Pushed at most every 2 s, and only when it differs.
const ORDER_EVERY = 2;
let orderPushedAt = 0;

function syncOrder() {
  const wanted = SECTIONS.flatMap((s) => sectionIds()[s.id]);
  const actual = visibleWorkspaces().map((w) => w.id);
  if (wanted.join() === actual.join() || nowSecs() - orderPushedAt < ORDER_EVERY) return;
  orderPushedAt = nowSecs();
  cmux("workspace.reorder_many", { workspace_ids: JSON.stringify(wanted) });
}
// Its own effect: it reads the clock to retry after ORDER_EVERY, and nothing on screen
// has to re-run with it.
computed(syncOrder);

// --- activity card ---------------------------------------------------------------
// Bottom-left, styled like an iPhone Live Activity: the Router octopus on the left
// reacting to the agents, pages on the right (click the card or a dot to flip;
// cmux sidebars get no swipe gestures). Data comes as tokens from the sync job:
// "lim:<5h %>/<5h reset>/<week %>/<week reset>", "day:<prompts>/<min>/<agents>/<streak>"
// and "win:<points>" on one workspace, and "st:<prompts>/<min>" on each.
const LIMIT_SEGMENTS = 16;
const PAGES = ["limit", "focus", "today", "session"];
const [page, setPage] = signal(0);
// cmux hands a sidebar no theme value: the card follows light/dark the way the rows
// do, through a material and the semantic text colours that cmux resolves per theme.
const CARD_BG = "regularMaterial";
const CARD_TEXT = "primary";
const CARD_DIM = "secondary";
const CARD_TRACK = "#7f7f7f40";
// The card's own accents are mid-tones: the panel's bright green and orange fade out
// on a light card (1.8:1), these keep at least 3:1 on the card in both themes
// (measured against #E7E6E6 light and #2A2A2A dark).
const CARD_GREEN = "#1A9450";
const CARD_ORANGE = "#C26A00";
const CARD_RED = "#E0453B";
const CARD_VIOLET = "#8466EC";

const limits = stable(() => {
  const v = globalToken("lim:")?.v;
  if (!v) return null;
  const [pct, reset, weekPct, weekReset] = v.split("/").map(Number);
  const now = nowSecs();
  return { pct: reset > now ? pct : 0, reset, fresh: !(reset > now), weekPct: weekReset > now ? weekPct : 0 };
});

const today = stable(() => {
  const v = globalToken("day:")?.v;
  if (!v) return null;
  const [prompts, minutes, agents, streak] = v.split("/").map(Number);
  return { prompts, minutes, agents, streak };
});

const sessionStats = stable(() => {
  const w = (data.workspaces() ?? []).find((x) => isSelected(x));
  const v = token(w, "st:");
  if (!w || !v) return null;
  const [prompts, minutes] = v.split("/").map(Number);
  return { title: cleanTitle(workspaceTitle(w)), prompts, minutes };
});

const limitColor = (pct) => (pct >= 90 ? CARD_RED : pct >= 70 ? CARD_ORANGE : CARD_GREEN);
// Time as a bare number plus its unit, so the unit can sit in the small label and
// three stats fit side by side: "7,2" over "год у Claude".
function timeStat(min) {
  if (min < 60) return { value: String(min), unit: t("minUnit") };
  const h = Math.round(min / 6) / 10;
  return { value: String(h).replace(".", lang() === "uk" ? "," : "."), unit: t("hourUnit") };
}

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
  if (states.includes("working") || focusStart()) return "work";
  if (states.includes("unread")) return "party";
  const last = Math.max(0, ...ws.map((w) => lastPromptAt(w) ?? 0));
  return nowSecs() - last < 1800 ? "idle" : "sleep";
}

// 2.5 pt = exactly 5 screen pixels on Retina; a fractional pixel (2.75 pt) rounded
// differently from frame to frame and made the card, and the sidebar, jitter.
const PIXEL = 2.5;
function octopus() {
  // The mood once per update, and a computed per row of the frame: a cell redraws only
  // when its row changes (a blink is one row), not 256 cells every second.
  const mood = computed(octoMood);
  const frame = computed(() => {
    const frames = OCTO_FRAMES[mood()];
    return frames[(data.clock()?.epoch ?? 0) % frames.length];
  });
  const rows = [];
  for (let y = 0; y < 16; y += 1) {
    const line = computed(() => frame()[y]);
    const cells = [];
    for (let x = 0; x < 16; x += 1) {
      cells.push(
        Rectangle()
          .fill(() => OCTO_PALETTE[line()[x]] ?? "#00000000")
          .frame({ width: PIXEL, height: PIXEL })
      );
    }
    rows.push(HStack({ spacing: 0 }, cells));
  }
  return VStack({ spacing: 0 }, rows).frame({ width: PIXEL * 16, height: PIXEL * 16 });
}

// Pages share one slot; the hidden ones collapse to zero height.
const shown = (name) => () => PAGES[page()] === name;
const pageSlot = (name, view) =>
  view.opacity(() => (shown(name)() ? 1 : 0)).frame(() => ({ maxWidth: "infinity", height: shown(name)() ? 58 : 0 }));

function segmentBar(fraction, color, count) {
  // How many are lit, so a segment redraws when it flips, not with every fraction.
  const lit = computed(() => {
    let n = 0;
    while (n < count && (n + 0.5) / count <= fraction()) n += 1;
    return n;
  });
  const segs = [];
  for (let i = 0; i < count; i += 1) {
    segs.push(
      Capsule()
        .fill(() => (i < lit() ? color() : CARD_TRACK))
        .frame({ maxWidth: "infinity", height: 4 })
    );
  }
  return HStack({ spacing: 2 }, segs);
}

function limitPage() {
  const lim = () => limits();
  return VStack({ spacing: 5 }, [
    HStack({ spacing: 5 }, [
      Text(() => (lim() ? lim().pct + "%" : "—")).font(22).weight("bold")
        .color(() => limitColor(lim()?.pct ?? 0)).fixedSize(),
      Text(() => t("limitShort")).font(10).color(CARD_DIM).fixedSize(),
      Spacer({ minLength: 4 }),
      Text(() => (lim() ? t("week") + " " + lim().weekPct + "%" : "")).font(10).color(CARD_DIM).fixedSize(),
    ]),
    segmentBar(() => (lim()?.pct ?? 0) / 100, () => limitColor(lim()?.pct ?? 0), LIMIT_SEGMENTS),
    Text(() => {
      const l = lim();
      if (!l) return t("limit");
      return l.fresh ? t("resetDone") : t("resets")(clockTime(l.reset), duration(l.reset - nowSecs()));
    }).font(10).color(CARD_DIM).lineLimit(1).truncation("tail"),
  ]);
}

// Focus timer: 25 minutes, started and stopped from the card. The start time is a
// "focus:<epoch>" token, so the timer survives a sidebar reload; at the end cmux posts
// a notification and the token goes away.
const FOCUS_SECONDS = 25 * 60;
let focusOverride;                       // undefined: follow the token; null: stopped; number: started
const [focusTick, setFocusTick] = signal(0);
const focusNotified = new Set();

function focusStart() {
  focusTick();
  const stored = Number(globalToken("focus:")?.v) || null;
  if (focusOverride !== undefined) {
    if (focusOverride === stored) focusOverride = undefined; // caught up
    else return focusOverride;
  }
  return stored;
}

function setFocus(on) {
  focusOverride = on ? Math.floor(nowSecs()) : null;
  setGlobalToken("focus:", focusOverride);
  setFocusTick(focusTick() + 1);
}

// A finished timer is over: the notification goes out only right after the
// end, 15 s (a sidebar reload must not repeat it), and the sync job drops the expired
// token itself in case the sidebar's own write didn't land.
function focusLeft() {
  const start = focusStart();
  if (!start) return null;
  const left = start + FOCUS_SECONDS - nowSecs();
  if (left > 0) return left;
  if (left > -15 && !focusNotified.has(start)) {
    focusNotified.add(start);
    cmux("notification.create", { title: t("focusDone"), body: t("focusDoneBody") });
  }
  focusOverride = null;
  return null;
}

const mmss = (s) => String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(Math.floor(s % 60)).padStart(2, "0");

function focusPage() {
  const left = computed(focusLeft);
  return VStack({ spacing: 5 }, [
    HStack({ spacing: 6 }, [
      Text(() => (left() == null ? mmss(FOCUS_SECONDS) : mmss(left()))).font(22).weight("bold")
        .color(() => (left() == null ? CARD_TEXT : CARD_VIOLET)).fixedSize(),
      Spacer({ minLength: 4 }),
      Text(() => (left() == null ? "▶ " + t("start") : "■ " + t("stop")))
        .font(11).weight("semibold").color(() => (left() == null ? "#FFFFFF" : CARD_TEXT))
        .paddingHorizontal(10).paddingVertical(4)
        .background(() => (left() == null ? VIOLET : CARD_TRACK))
        .cornerRadius(10)
        .fixedSize()
        .cursor("pointer")
        .onTap(() => setFocus(left() == null)),
    ]),
    segmentBar(() => (left() == null ? 0 : 1 - left() / FOCUS_SECONDS), () => CARD_VIOLET, LIMIT_SEGMENTS),
    Text(() => (left() == null ? t("focusIdle") : t("focus") + " · " + t("resets")(clockTime(focusStart() + FOCUS_SECONDS), duration(left()))))
      .font(10).color(CARD_DIM).lineLimit(1).truncation("tail"),
  ]);
}

function stat(value, label) {
  return VStack({ spacing: 1, alignment: "leading" }, [
    Text(value).font(16).weight("bold").color(CARD_TEXT).fixedSize(),
    // Keep labels short (the unit moved here from the number): a row wider than the
    // card widens the whole sidebar over the terminal.
    Text(label).font(9).color(CARD_DIM).fixedSize(),
  ]);
}

function todayPage() {
  const d = () => today();
  return VStack({ spacing: 5 }, [
    HStack({ spacing: 6 }, [
      Text(() => t("today")).font(11).weight("semibold").color(CARD_DIM).fixedSize(),
      Spacer(),
      Text(() => (d()?.streak ? "🔥 " + t("streak")(d().streak) : "")).font(10).color(CARD_ORANGE).fixedSize(),
    ]),
    HStack({ spacing: 8 }, [
      stat(() => String(d()?.prompts ?? 0), () => t("prompts")),
      stat(() => timeStat(d()?.minutes ?? 0).value, () => timeStat(d()?.minutes ?? 0).unit + " " + t("inClaude")),
      stat(() => String(d()?.agents ?? 0), () => t("agents")),
    ]).frame({ maxWidth: "infinity", alignment: "leading" }),
  ]);
}

function sessionPage() {
  const st = () => sessionStats();
  return VStack({ spacing: 5 }, [
    Text(() => st()?.title ?? t("noSession")).font(11).weight("semibold").color(CARD_DIM).lineLimit(1).truncation("tail"),
    HStack({ spacing: 12 }, [
      stat(() => (st() ? timeStat(st().minutes).value : "—"), () => (st() ? timeStat(st().minutes).unit + " " : "") + t("sessionTime")),
      stat(() => (st() ? String(st().prompts) : "—"), () => t("prompts")),
    ]).frame({ maxWidth: "infinity", alignment: "leading" }),
  ]);
}

function pageDots() {
  const dots = PAGES.map((_, i) =>
    Circle()
      .fill(() => (page() === i ? CARD_TEXT : CARD_TRACK))
      .frame({ width: 5, height: 5 })
      .onTap(() => setPage(i))
  );
  return HStack({ spacing: 5 }, [Spacer(), ...dots, Spacer()]);
}

function activityCard() {
  // The outer margin lives on a wrapper: in a JS sidebar the modifiers are props of
  // one node, not layers, so a second .paddingHorizontal would replace the first.
  // 6 pt, like the list's wrapper: the card's edges line up with a row's background.
  return VStack({ spacing: 0 }, [activityCardBody()])
    .paddingHorizontal(6)
    .paddingTop(6)
    .frame({ maxWidth: "infinity", height: CARD_H });
}

function activityCardBody() {
  return VStack({ spacing: 8 }, [
    HStack({ spacing: 8 }, [
      octopus(),
      // All four pages are laid out at once (the hidden ones only lose height), and
      // their fixed-size labels add up to more than a sidebar's width: without
      // minWidth 0 the widest page pushed the whole sidebar under the terminal pane,
      // so the card and the rows ran into its right edge.
      VStack({ spacing: 0 }, [
        pageSlot("limit", limitPage()),
        pageSlot("focus", focusPage()),
        pageSlot("today", todayPage()),
        pageSlot("session", sessionPage()),
      ]).frame({ minWidth: 0, maxWidth: "infinity" }),
    ]),
    pageDots(),
  ])
    .paddingHorizontal(14)
    .paddingVertical(14)
    .background(CARD_BG)
    .borderColor("#7f7f7f26")
    .borderWidth(1)
    .cornerRadius(22)
    .frame({ maxWidth: "infinity", height: CARD_BODY_H })
    .cursor("pointer")
    .onTap(() => setPage((page() + 1) % PAGES.length))
    .contextMenu(panelMenu());
}

// --- views -------------------------------------------------------------------------
// kind: the row's state kind (a memo).
function stateIcon(kind) {
  // Only the picked indicator of a working row is mounted, so only it reads the clock;
  // the others cost nothing (see "working indicator"). It doesn't turn: cmux animates
  // a rotation, and every frame of it laid out the whole window again, a full core of
  // cmux for as long as one agent worked (20.10.2026).
  const spinning = (name) => () => kind() === "working" && spinner() === name;
  const tick = () => data.clock()?.epoch ?? 0;
  return ZStack({}, [
    when(spinning("color"), () => Image("progress.indicator")
      .font(12).weight("bold")
      .color(() => SPINNER_COLORS[tick() % SPINNER_COLORS.length])),
    when(spinning("pulse"), () => Circle().fill(VIOLET).frame({ width: 8, height: 8 })
      .opacity(() => (tick() % 2 ? 0.3 : 1))),
    when(spinning("dots"), () => HStack({ spacing: 2 }, [0, 1, 2].map((i) =>
      Circle().fill(VIOLET).frame({ width: 4, height: 4 }).opacity(() => (tick() % 3 === i ? 1 : 0.25))))),
    when(spinning("braille"), () => Text(() => BRAILLE[tick() % BRAILLE.length])
      .font(13).monospaced().color(VIOLET)),
    Image("record.circle")
      .font(13).color(ORANGE)
      .opacity(() => (kind() === "needs" ? 1 : 0)),
    Image("checkmark.circle.fill")
      .font(13).color(BLUE)
      .opacity(() => (kind() === "unread" ? 1 : 0)),
    Image("checkmark")
      .font(10).weight("semibold").color("secondary")
      .opacity(() => (kind() === "done" ? 1 : 0)),
    Image("moon.fill")
      .font(10).color("secondary")
      .opacity(() => (kind() === "inactive" ? 1 : 0)),
    Image("square.and.pencil")
      .font(10).color(TEAL)
      .opacity(() => (kind() === "fresh" ? 1 : 0)),
  ]).frame({ width: 16, height: 16 });
}

// Background agents as segments: "12/16" from the sync job via
// `cmux set-progress`, drawn as 16 dashes with 12 lit in the spinner colours.
const MAX_SEGMENTS = 24;

function progressCounts(w) {
  const m = /^(\d+)\/(\d+)$/.exec(w?.progress?.label ?? "");
  return m ? { done: Number(m[1]), total: Math.min(Number(m[2]), MAX_SEGMENTS) } : null;
}

// progress: the row's "done/total" memo, "" without a batch running. The segments are
// mounted only while there is one (24 hidden ones in every row sent hundreds of ops on
// each data update); the empty strip stays, so the row keeps its spacing.
function progressSegments(progress) {
  const counts = () => {
    const [done, total] = progress().split("/").map(Number);
    return progress() ? { done, total } : null;
  };
  const segments = () => {
    const segs = [];
    for (let i = 0; i < MAX_SEGMENTS; i += 1) {
      segs.push(
        Capsule()
          .fill(() => {
            const p = counts();
            return p && i < p.done ? SPINNER_COLORS[i % SPINNER_COLORS.length] : "#7f7f7f40";
          })
          .frame(() => ({ width: (counts()?.total ?? 0) > i ? 7 : 0, height: 3 }))
      );
    }
    return HStack({ spacing: 2 }, [...segs, Spacer({ minLength: 0 })]);
  };
  return HStack({ spacing: 0 }, [when(() => progress() !== "", segments)])
    .frame(() => ({ maxWidth: "infinity", height: progress() ? 3 : 0 }))
    .opacity(() => (progress() ? 1 : 0));
}

// The "done/total" a row's segments draw, or "".
const progressKey = (w) => {
  const p = progressCounts(w);
  return p ? p.done + "/" + p.total : "";
};

// One tab under its workspace: indented, smaller, with that tab's own agent state.
function tabState(w, tab) {
  const agent = (w?.agents ?? []).find((a) => a.panelId === tab?.id);
  if (agent?.status === "needs_input") return { kind: "needs", since: secs(agent.sinceEpoch) };
  if (agent?.status === "working") return { kind: "working", since: secs(agent.sinceEpoch) };
  if (tab?.hasUnread) return { kind: "unread", since: secs(tab.latestAt) };
  return { kind: agent ? "done" : "none", since: secs(tab?.latestAt) };
}

function tabRow(entry) {
  const w = () => wsById().get(entry.wsId);
  const tab = () => (w()?.tabs ?? []).find((x) => x.id === entry.tabId);
  // Memos: the bindings below wake only when one of these changes (see stable()).
  const kind = computed(() => tabState(w(), tab()).kind);
  const since = computed(() => tabState(w(), tab()).since);
  const isCurrent = computed(() => isSelected(w()) && !!tab()?.focused);
  const title = computed(() => cleanTitle(tab()?.title));
  const agoText = computed(() => (kind() === "none" ? "" : ago(since())));
  return HStack({ spacing: 8 }, [
    Rectangle().fill("#7f7f7f40").frame({ width: 1, height: 14 }),
    Text(title)
      .font(12)
      .weight(() => (kind() === "unread" ? "semibold" : "regular"))
      .lineLimit(1)
      .truncation("tail")
      .color(() => (isCurrent() ? "primary" : "secondary")),
    Spacer({ minLength: 0 }),
    HStack({ spacing: 8 }, [
      Text(agoText).font(11).color("secondary"),
      stateIcon(kind).opacity(() => (kind() === "none" ? 0 : 1)),
    ])
      .fixedSize()
      .layoutPriority(2),
  ])
    .paddingLeading(18)
    .paddingTrailing(10)
    .paddingVertical(3)
    .cornerRadius(6)
    .background(() => (isCurrent() ? "#7f7f7f24" : (kind() === "unread" ? "#4C9EEB1c" : null)))
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
  const port = computed(() => (w()?.ports ?? [])[0]);
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

function rowBackground(sel, kind, hover) {
  if (sel) return "#7f7f7f3d";
  if (kind === "unread") return hover ? "#4C9EEB38" : "#4C9EEB24";
  return hover ? "#7f7f7f24" : null;
}

function workspaceMenu(w) {
  const act = (action) => () => cmux("workspace.action", { action, workspace_id: w().id });
  return [
    openHereMenu(w),
    Divider(),
    Button(computed(() => (isAsleep(w()) ? t("wake") : t("sleep"))), () => setAsleep(w(), !isAsleep(w()))),
    Button(() => t("rename"), () => setEditingId(w().id)),
    Button(computed(() => (w()?.pinned ? t("unpin") : t("pin"))), () =>
      cmux("workspace.action", { action: w()?.pinned ? "unpin" : "pin", workspace_id: w().id })),
    Button(computed(() => (w()?.unread > 0 ? t("markRead") : t("markUnread"))), () =>
      cmux("workspace.action", { action: w()?.unread > 0 ? "mark_read" : "mark_unread", workspace_id: w().id })),
    Divider(),
    Button(() => t("closeOthers"), act("close_others")).destructive(),
    Button(() => t("close"), () => closeWorkspace(w().id)).destructive(),
  ];
}

function workspaceRow(w) {
  // Title on the left, "4m" + state icon on the right; on hover the time and
  // icon yield to the close button. Memos: the bindings below wake only when one of
  // these changes, not on every data update and clock tick (see stable()).
  const kind = computed(() => agentState(w()).kind);
  const since = computed(() => agentState(w()).since);
  const sel = computed(() => isSelected(w()));
  const title = computed(() => cleanTitle(workspaceTitle(w())));
  const progress = computed(() => progressKey(w()));
  const confirming = computed(() => isConfirmingClose(w()));
  const label = computed(() => w()?.progress?.label ?? ago(since()));
  return ZStack({ alignment: "trailing" }, [
    VStack({ spacing: 4 }, [
      HStack({ spacing: 8 }, [
        Text(title)
          .font(13)
          .weight(() => (kind() === "unread" ? "semibold" : "regular"))
          .lineLimit(1)
          .truncation("tail")
          .marquee()
          .color(() => (kind() === "inactive" && !sel() ? "secondary" : "primary")),
        Spacer({ minLength: 0 }),
        HStack({ spacing: 8 }, [
          Text(label)
            .font(12)
            .color(() => (kind() === "needs" ? ORANGE : kind() === "unread" ? BLUE : "secondary")),
          stateIcon(kind),
        ])
          .fixedSize()
          .layoutPriority(2)
          .opacity(() => (confirming() ? 0 : 1))
          .hideOnHover(),
      ])
        .frame({ maxWidth: "infinity" }),
      progressSegments(progress),
    ]),
    // Close asks first, like Cmd+W: the first click turns into a red "Close?",
    // the second closes. Either control closes while asking, so it doesn't matter
    // which of the two stacked views the click lands on. Trailing-aligned, so the X
    // sits where the state icon was, not centred in the wider "Close?" pill's box.
    ZStack({ alignment: "trailing" }, [
      Text(() => t("closeQ"))
        .font(11).weight("semibold").color("#FFFFFF")
        .paddingHorizontal(8).paddingVertical(2)
        .background(RED)
        .cornerRadius(8)
        .fixedSize()
        .opacity(() => (confirming() ? 1 : 0))
        // Hidden is not untappable: at opacity 0 the pill still sits over the time
        // and icon, so a plain click there closed the workspace at once. Close only
        // while asking; otherwise the click selects the row like the rest of it.
        .onTap(() => {
          if (isConfirmingClose(w())) return closeWorkspace(w().id);
          cancelClose();
          selectWorkspace(w().id);
        }),
      Image("xmark")
        .font(9).weight("semibold").color("secondary")
        .padding(4)
        .cornerRadius(9)
        .hoverBackground("#7f7f7f4a")
        .showOnHover()
        .opacity(() => (confirming() ? 0 : 1))
        .onTap(() => (isConfirmingClose(w()) ? closeWorkspace(w().id) : askClose(w().id))),
    ]),
  ])
    .paddingHorizontal(10)
    .paddingVertical(6)
    .cornerRadius(8)
    .background(() => (confirming() ? "#FF453A26" : rowBackground(sel(), kind(), false)))
    .hoverBackground(() => (confirming() ? "#FF453A33" : rowBackground(sel(), kind(), true)))
    .frame(() => ({ maxWidth: "infinity", height: progress() ? ROW_PROGRESS_H : ROW_H }))
    .onTap(() => {
      cancelClose();
      selectWorkspace(w().id);
    })
    .onDoubleTap(() => setEditingId(w().id))
    .contextMenu(workspaceMenu(w));
}

function workspaceEditRow(w) {
  return HStack({ spacing: 8 }, [
    TextField(computed(() => w()?.title ?? ""), {
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
  // A coloured pill (icon, name, count) is the divider; no extra lines needed. A section
  // colour on its own tint over the glass sidebar drops under 2:1 in light mode, and no
  // one shade holds up in both themes. So the name and count are the text colour over
  // the section colour: very dark green in light mode, pale green in dark.
  const s = SECTIONS.find((x) => x.id === id);
  const isFirst = () => flatEntries()[0]?.id === "h:" + id;
  const inked = (text, size, weight, ink) => ZStack({}, [
    Text(text).font(size).weight(weight).color(s.color),
    Text(text).font(size).weight(weight).color("primary").opacity(ink),
  ]).fixedSize();
  return HStack({ spacing: 6 }, [
    HStack({ spacing: 5 }, [
      Image(s.icon).font(10).color(s.color),
      inked(() => t(id), 12, "semibold", 0.7),
      inked(() => String(sectionCount(id)), 11, "bold", 0.45),
    ])
      .paddingHorizontal(9)
      .paddingVertical(4)
      .background(s.color + "33")
      .cornerRadius(11)
      .fixedSize(),
    Spacer(),
    Image("chevron.right")
      .font(9).weight("semibold").color("secondary")
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
    .contextMenu(panelMenu());
}

function moreRow(entry) {
  return HStack({ spacing: 6 }, [
    Text(() => t("more")(entry.count)).font(12).color("secondary"),
    Image("chevron.down").font(9).weight("semibold").color("secondary"),
    Spacer(),
  ])
    .paddingHorizontal(10)
    .cornerRadius(8)
    .hoverBackground("#7f7f7f1c")
    .frame({ maxWidth: "infinity", height: ROW_H })
    .fixed()
    .cursor("pointer")
    .onTap(() => setShowAllSleeping(true));
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
const CARD_H = 108;
const CARD_BODY_H = 99;
const LIST_SPACING = 2;
const SIDEBAR_CHROME = 82;   // title bar above the list, the footer buttons below it, and a few points of slack
                             // so rounding never makes the sidebar scroll (a scroll bar shows on its edge).
                             // At 66 the card's bottom 12 pt sat in cmux's fade above the footer buttons.

const listHeight = computed(() => {
  const entries = flatEntries();
  const byId = wsById();
  let h = Math.max(0, entries.length - 1) * LIST_SPACING;
  entries.forEach((e, i) => {
    if (e.kind === "header") h += i === 0 ? HEADER_FIRST_H : HEADER_H;
    else if (e.kind === "tab") h += TAB_H;
    else if (e.kind === "more") h += ROW_H;
    else h += progressCounts(byId.get(e.wsId)) ? ROW_PROGRESS_H : ROW_H;
  });
  return h;
});

function spacerHeight() {
  const win = Number(globalToken("win:")?.v ?? 0);
  if (!win) return 12;
  // Root children: list, spacer, chips, card; hidden chips keep their gaps.
  const chip = chipsHeight();
  return Math.max(12, win - SIDEBAR_CHROME - listHeight() - chip - CARD_H - 3 * 2);
}

// The new-version and download chips share one root slot, each its height while shown.
const chipsHeight = () => (newVersion() ? UPD_H : 0) + (latestDownload() ? DL_H : 0);

// --- latest download ---------------------------------------------------------------
// A screenshot AirDropped from the iPhone lands in ~/Downloads; the watcher reports
// the newest file ("dl:<epoch>:<url-quoted path>") and this chip pastes it into the
// open Claude tab, where Claude Code turns an image path into an attachment.
const DL_H = 40;
const DL_FRESH = 30 * 60;
// Hidden or pasted is remembered as "dlseen:<epoch>" (the sync job carries it), so
// a reload of the sidebar doesn't bring back a file you already dealt with.
let seenOverride = 0;
const [dlTick, setDlTick] = signal(0);

const latestDownload = stable(() => {
  dlTick();
  const v = globalToken("dl:")?.v;
  if (!v) return null;
  const i = v.indexOf(":");
  const at = Number(v.slice(0, i));
  let path;
  try {
    path = decodeURIComponent(v.slice(i + 1));
  } catch (e) {
    return null;
  }
  const seen = Math.max(seenOverride, Number(globalToken("dlseen:")?.v) || 0);
  if (nowSecs() - at > DL_FRESH || at <= seen) return null;
  return { at, path, name: path.split("/").pop() };
});

function hideDownload(at) {
  seenOverride = at;
  setDlTick(dlTick() + 1);
  setGlobalToken("dlseen:", at);
}

function pasteDownload() {
  const d = latestDownload();
  const w = (data.workspaces() ?? []).find((x) => isSelected(x));
  const tab = (w?.tabs ?? []).find((x) => x.focused) ?? (w?.tabs ?? [])[0];
  if (!d || !tab?.surfaceId) return;
  cmux("terminal.paste", { workspace_id: w.id, surface_id: tab.surfaceId, text: d.path + " ", submit_key: "none" });
  hideDownload(d.at);
}

function downloadChip() {
  const d = () => latestDownload();
  const isImage = () => /\.(png|jpe?g|heic|gif|webp|tiff?)$/i.test(d()?.name ?? "");
  const body = HStack({ spacing: 8 }, [
    Image(() => (isImage() ? "photo" : "doc")).font(12).color(BLUE),
    Text(() => d()?.name ?? "").font(12).color("primary").lineLimit(1).truncation("middle"),
    Spacer({ minLength: 4 }),
    ZStack({}, [
      Text(() => (d() ? ago(d().at) : "")).font(11).color("secondary").fixedSize().hideOnHover(),
      Image("xmark")
        .font(9).weight("semibold").color("secondary")
        .padding(4)
        .cornerRadius(9)
        .hoverBackground("#7f7f7f4a")
        .showOnHover()
        .onTap(() => d() && hideDownload(d().at)),
    ]),
    Text(() => t("paste")).font(11).weight("semibold").color(BLUE).fixedSize(),
  ])
    .paddingHorizontal(12)
    .paddingVertical(8)
    .background("#4C9EEB1f")
    .hoverBackground("#4C9EEB33")
    .cornerRadius(12)
    .frame({ maxWidth: "infinity" })
    .cursor("pointer")
    .onTap(pasteDownload)
    .contextMenu([Button(() => t("hide"), () => d() && hideDownload(d().at))]);
  // Wrapper for the margin (modifiers are props of one node, not layers).
  return VStack({ spacing: 0 }, [body])
    .paddingHorizontal(6)
    .frame(() => ({ maxWidth: "infinity", height: d() ? DL_H : 0 }))
    .opacity(() => (d() ? 1 : 0));
}

// --- new version -------------------------------------------------------------------
// Once a day the sync job asks GitHub for the latest release; while one is out that's
// newer than the installed release, it sets "upd:<tag>:<release page>" (never on a
// development clone: on a branch, or with local changes). Click: scripts/update.sh in a
// new terminal tab, where its output stays to read. A hidden version is "updhide:<tag>",
// carried by the sync job; the chip comes back for the next release. No clock in here:
// the chip only re-runs when the tokens change.
const UPD_H = 40;
let updHiddenOverride = null;
const [updTick, setUpdTick] = signal(0);

const newVersion = stable(() => {
  updTick();
  const v = globalToken("upd:")?.v;
  if (!v) return null;
  const i = v.indexOf(":");
  const tag = v.slice(0, i);
  if (tag === updHiddenOverride || tag === globalToken("updhide:")?.v) return null;
  let url;
  try {
    url = decodeURIComponent(v.slice(i + 1));
  } catch (e) {
    return null;
  }
  // "v0.3.0" reads "v0.3"; a patch release keeps its number.
  return { tag, url, label: tag.replace(/\.0$/, "") };
});

function hideVersion(tag) {
  updHiddenOverride = tag;
  setUpdTick(updTick() + 1);
  setGlobalToken("updhide:", tag);
}

function runUpdate() {
  const ws = data.workspaces() ?? [];
  const w = ws.find((x) => isSelected(x)) ?? ws[0];
  if (!w) return;
  cmux("surface.create", { workspace_id: w.id, initial_input: "sh ~/.config/cmux/update.sh\r", focus: true });
}

function updateChip() {
  const u = () => newVersion();
  const body = HStack({ spacing: 8 }, [
    Image("arrow.down.circle").font(12).color(BLUE),
    Text(() => (u() ? t("newVersion")(u().label) : "")).font(12).color("primary").lineLimit(1).truncation("tail"),
    Spacer({ minLength: 4 }),
    Text(() => t("update")).font(11).weight("semibold").color(BLUE).fixedSize(),
  ])
    .paddingHorizontal(12)
    .paddingVertical(8)
    .background("#4C9EEB1f")
    .hoverBackground("#4C9EEB33")
    .cornerRadius(12)
    .frame({ maxWidth: "infinity" })
    .cursor("pointer")
    .onTap(() => u() && runUpdate())
    .contextMenu([
      Button(() => t("whatsNew"), () => u() && openURL(u().url)),
      Button(() => t("hideVersion"), () => u() && hideVersion(u().tag)),
    ]);
  return VStack({ spacing: 0 }, [body])
    .paddingHorizontal(6)
    .frame(() => ({ maxWidth: "infinity", height: u() ? UPD_H : 0 }))
    .opacity(() => (u() ? 1 : 0));
}

// --- root --------------------------------------------------------------------------
function list() {
  return Reorderable(
    { items: flatEntries, key: (e) => e.id, spacing: 2, onMove: handleMove },
    (e) => {
      const entry = e(); // kind, ids and editing are stable per key
      if (entry.kind === "header") return sectionHeader(entry.section);
      if (entry.kind === "tab") return tabRow(entry);
      if (entry.kind === "more") return moreRow(entry);
      const w = () => wsById().get(entry.wsId);
      return entry.editing ? workspaceEditRow(w) : workspaceRow(w);
    }
  );
}

// The spacer's height follows the clock (the download chip goes stale); as a memo it
// redraws only when the number changes.
const spacer = computed(spacerHeight);

sidebar(() =>
  VStack({ spacing: 2 }, [
    // Wrapper for a side margin, so a selected row doesn't touch the terminal.
    VStack({ spacing: 0 }, [list()]).paddingHorizontal(6),
    Rectangle().fill("#00000000").frame(() => ({ maxWidth: "infinity", height: spacer() })),
    VStack({ spacing: 0 }, [updateChip(), downloadChip()]),
    activityCard(),
  ]).frame({ maxWidth: "infinity", maxHeight: "infinity" }),
  { surface: "glass" }
)
