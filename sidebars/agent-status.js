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
    wsName: "Workspace name", limit: "5-hour limit", week: "week",
    resets: (at, left) => "at " + at + " · in " + left, resetDone: "limit has reset",
  },
  uk: {
    pinned: "Закріплені", needs: "Чекає на тебе", unread: "Нове", working: "В роботі", done: "Готово", inactive: "Сплять",
    now: "now", m: "m", h: "h", d: "d",
    openHere: "Відкрити тут", worktree: "Claude в окремій гілці (worktree)", anotherClaude: "Ще один Claude",
    preview: (p) => "Прев'ю localhost:" + p + " у Dock", noServer: "Прев'ю сайту (сервер не запущено)",
    simulator: "Симулятор iOS", sleep: "Приспати (у «Сплять»)", wake: "Розбудити", rename: "Перейменувати",
    pin: "Закріпити", unpin: "Відкріпити", markRead: "Позначити прочитаним", markUnread: "Позначити непрочитаним",
    closeOthers: "Закрити інші", close: "Закрити", wsName: "Назва", limit: "Ліміт на 5 год", week: "тиждень",
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

const [collapsed, setCollapsed] = signal({});
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

// --- usage limit -------------------------------------------------------------------
// "lim:<5h %>/<5h reset>/<week %>/<week reset>", from Claude Code's status line
// input via the sync job. A reset that has passed means the limit is fresh.
const LIMIT_SEGMENTS = 20;

function limits() {
  const v = globalToken("lim:")?.v;
  if (!v) return null;
  const [pct, reset, weekPct, weekReset] = v.split("/").map(Number);
  const now = nowSecs();
  return {
    pct: reset > now ? pct : 0, reset, fresh: !(reset > now),
    weekPct: weekReset > now ? weekPct : 0,
  };
}

const limitColor = (pct) => (pct >= 90 ? RED : pct >= 70 ? ORANGE : GREEN);

function limitCard() {
  const lim = () => limits();
  const segs = [];
  for (let i = 0; i < LIMIT_SEGMENTS; i += 1) {
    segs.push(
      Capsule()
        .fill(() => {
          const l = lim();
          return l && (i + 0.5) * (100 / LIMIT_SEGMENTS) <= l.pct ? limitColor(l.pct) : "#7f7f7f33";
        })
        .frame({ maxWidth: "infinity", height: 4 })
    );
  }
  return VStack({ spacing: 6 }, [
    HStack({ spacing: 6 }, [
      Image("gauge.with.needle").font(11).color(() => limitColor(lim()?.pct ?? 0)),
      Text(() => t("limit")).font(12).weight("semibold").color("secondary"),
      Spacer(),
      Text(() => (lim() ? lim().pct + "%" : "")).font(12).weight("bold").color(() => limitColor(lim()?.pct ?? 0)),
    ]),
    HStack({ spacing: 2 }, segs),
    HStack({ spacing: 6 }, [
      Text(() => {
        const l = lim();
        if (!l) return "";
        return l.fresh ? t("resetDone") : t("resets")(clockTime(l.reset), duration(l.reset - nowSecs()));
      }).font(11).color("tertiary").lineLimit(1).truncation("tail"),
      Spacer({ minLength: 4 }),
      Text(() => (lim() ? t("week") + " " + lim().weekPct + "%" : "")).font(11).color("tertiary").fixedSize(),
    ]),
  ])
    .padding(10)
    .background("#7f7f7f1a")
    .cornerRadius(10)
    .paddingHorizontal(4)
    .paddingBottom(6)
    .frame(() => ({ maxWidth: "infinity", height: lim() ? 84 : 0 }))
    .opacity(() => (lim() ? 1 : 0))
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
    .frame({ maxWidth: "infinity" })
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
    .frame({ maxWidth: "infinity" })
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
    .frame({ maxWidth: "infinity" });
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
    .frame({ maxWidth: "infinity" })
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

// --- root --------------------------------------------------------------------------
sidebar(() =>
  VStack({ spacing: 2 }, [
    limitCard(),
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
  ]),
  { surface: "glass" }
)
