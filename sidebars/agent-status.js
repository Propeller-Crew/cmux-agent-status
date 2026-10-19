// Agent status sidebar: workspaces grouped by what they need from you,
// styled after a Warp redesign (rows with "4m" + a state icon).
//
// Sections, top to bottom (like the built-in Attention Queue, but by agent
// state): Pinned > Needs you > New (done, not read) > Working > Done > Inactive.
//
// "When did I last write here" and "still busy in the background" come from
// the workspace description ("last prompt @<epoch>[ · bg]"), written by
// ~/.config/cmux/last-prompt-sync.py, because cmux forgets latestAt on restart
// and calls a tab done as soon as Claude ends its turn.
//
// Select: cmux sidebar select agent-status   Check: cmux sidebar validate agent-status

const INACTIVE_AFTER = 24 * 3600;
const ORANGE = "#F5A524";
const BLUE = "#4C9EEB";
// The working spinner walks through these, one per clock tick.
const SPINNER_COLORS = ["#5B8CFF", "#8B5CF6", "#EC4899", "#F59E0B", "#14B8A6"];

// Each section is a coloured pill with its own icon, so the list splits into
// blocks at a glance (the blue "Нове" pill is what the rest were modelled on).
const VIOLET = "#9B7BFF";
const GREEN = "#34C759";
const GRAY = "#8E8E93";
const SECTIONS = [
  { id: "pinned", title: "Закріплені", color: GRAY, icon: "pin.fill" },
  { id: "needs", title: "Чекає на тебе", color: ORANGE, icon: "hand.raised.fill" },
  { id: "unread", title: "Нове", color: BLUE, icon: "sparkles" },
  { id: "working", title: "В роботі", color: VIOLET, icon: "bolt.fill" },
  { id: "done", title: "Готово", color: GREEN, icon: "checkmark.seal.fill" },
  { id: "inactive", title: "Сплять", color: GRAY, icon: "moon.zzz.fill" },
];

// --- time --------------------------------------------------------------------------
// Epochs arrive in seconds; guard against milliseconds just in case.
const secs = (t) => (t == null ? null : (t > 1e12 ? t / 1000 : t));
const nowSecs = () => secs(data.clock()?.epoch) ?? Date.now() / 1000;

function lastPromptAt(w) {
  const m = /@(\d{9,})/.exec(w.description ?? "");
  return Math.max(secs(w.latestAt) ?? 0, m ? Number(m[1]) : 0) || null;
}

function ago(since) {
  if (!since) return "";
  const s = Math.max(0, nowSecs() - since);
  if (s < 60) return "now";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}

// --- agent state -------------------------------------------------------------------
// needs you (agent asked a question / wants permission) > working > new
// (finished while you were elsewhere) > done > inactive (no prompt for a day).
// --- manual sleep ----------------------------------------------------------------
// Drag a row into «Сплять» (or right-click → Приспати) to park it there until you
// write in it again. Stored as "zz@<epoch>" in the description; last-prompt-sync.py
// keeps it. An agent that is working or waiting on you still wins.
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
  // and Claude will pick up when they finish (flag from last-prompt-sync.py).
  if (/(^| · )bg( · |$)/.test(w.description ?? "")) return { kind: "working", since: last };
  if (isAsleep(w)) return { kind: "inactive", since: last };
  if (w.unread > 0) return { kind: "unread", since: last };
  if (!last || nowSecs() - last > INACTIVE_AFTER) return { kind: "inactive", since: last };
  return { kind: "done", since: last };
}

// Claude Code prefixes the terminal title with its own spinner glyph (✳ ◐ …);
// the state icon already says that, so drop it from the name.
const cleanTitle = (t) => (t ?? "").replace(/^[\s✳✶✻✽✢✦·•●○◐◓◑◒⠀-⣿*]+/, "");

// cmux names a workspace after its focused tab, so opening a simulator or a
// browser renames "Нотч алерт" to "Simulator". Keep the Claude tab's name then.
function workspaceTitle(w) {
  if (!w) return "";
  const tabs = w.tabs ?? [];
  const agentPanels = new Set((w.agents ?? []).map((a) => a.panelId));
  const borrowed = tabs.some((t) => t.title === w.title && !agentPanels.has(t.id));
  const agentTab = tabs.find((t) => agentPanels.has(t.id));
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
      for (const t of w.tabs) out.push({ kind: "tab", id: w.id + "/" + t.id, wsId: w.id, tabId: t.id });
    }
  }
  return out;
});

const sectionCount = (id) => visibleWorkspaces().filter((w) => sectionOf(w) === id).length;

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

// Background agents as segments: "12/16" from last-prompt-sync.py via
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
function tabState(w, t) {
  const agent = (w?.agents ?? []).find((a) => a.panelId === t?.id);
  if (agent?.status === "needs_input") return { kind: "needs", since: secs(agent.sinceEpoch) };
  if (agent?.status === "working") return { kind: "working", since: secs(agent.sinceEpoch) };
  if (t?.hasUnread) return { kind: "unread", since: secs(t.latestAt) };
  return { kind: agent ? "done" : "none", since: secs(t?.latestAt) };
}

function tabRow(entry) {
  const w = () => (data.workspaces() ?? []).find((x) => x.id === entry.wsId);
  const t = () => (w()?.tabs ?? []).find((x) => x.id === entry.tabId);
  const st = () => tabState(w(), t());
  const isCurrent = () => isSelected(w()) && !!t()?.focused;
  return HStack({ spacing: 8 }, [
    Rectangle().fill("#7f7f7f40").frame({ width: 1, height: 14 }),
    Text(() => cleanTitle(t()?.title))
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
      if (t()?.surfaceId) cmux("surface.focus", { surface_id: t().surfaceId, workspace_id: w().id });
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
  return Menu("Відкрити тут", [
    Button("Claude в окремій гілці (worktree)", newTerminal("claude -w")),
    Button("Ще один Claude", newTerminal("claude")),
    Divider(),
    Button(() => (port() ? "Прев'ю localhost:" + port() + " у Dock" : "Прев'ю сайту (сервер не запущено)"), () => {
      if (port()) cmux("surface.create", { workspace_id: w().id, type: "browser", placement: "dock", url: "http://localhost:" + port() });
    }),
    Button("Симулятор iOS", () => cmux("surface.create", { workspace_id: w().id, type: "simulator", focus: true })),
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
    Button(() => (isAsleep(w()) ? "Розбудити" : "Приспати (у «Сплять»)"), () => setAsleep(w(), !isAsleep(w()))),
    Button("Rename", () => setEditingId(w().id)),
    Button(() => (w()?.pinned ? "Unpin" : "Pin"), () =>
      cmux("workspace.action", { action: w()?.pinned ? "unpin" : "pin", workspace_id: w().id })),
    Button(() => (w()?.unread > 0 ? "Mark as Read" : "Mark as Unread"), () =>
      cmux("workspace.action", { action: w()?.unread > 0 ? "mark_read" : "mark_unread", workspace_id: w().id })),
    Divider(),
    Button("Close Others", act("close_others")).destructive(),
    Button("Close", () => closeWorkspace(w().id)).destructive(),
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
      placeholder: "Workspace name",
      onSubmit: (t) => {
        const title = (t ?? "").trim();
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
      Text(s.title).font(12).weight("semibold").color(s.color),
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
    .onTap(() => toggleSection(id));
}

// Sections are computed from state, so the only drop that means anything is
// into «Сплять» (park it) or out of it (wake it). Anything else springs back.
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
