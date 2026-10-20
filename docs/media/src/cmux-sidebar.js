// Runs the real sidebar (sidebars/agent-status.js) in a browser, for pictures of it:
// the cmux sidebar API (VStack, Text, .frame, signal, data…) as a one-shot renderer to
// HTML. No live updates or input: every binding is read once. Layout follows cmux's
// model, where modifiers are props of one node: padding inside, then background,
// border and corners, then the frame.
//
//   const el = runSidebar(source, { workspaces, epoch, appearance: "dark", width: 252 });

(function () {
  const val = (x) => (typeof x === "function" ? x() : x);
  const SEMANTIC = {
    dark: { primary: "#FFFFFF", secondary: "#FFFFFF8C", tertiary: "#FFFFFF40", regularMaterial: "#2A2A2EE6" },
    light: { primary: "#000000", secondary: "#0000008C", tertiary: "#00000040", regularMaterial: "#F2F2F2E6" },
  };
  // SF Symbols the sidebar uses, as 24×24 paths.
  const SYM = {
    "progress.indicator": (c) => {
      let s = "";
      for (let i = 0; i < 8; i += 1) {
        const a = (i / 8) * Math.PI * 2;
        s += `<line x1="${12 + Math.cos(a) * 5.5}" y1="${12 + Math.sin(a) * 5.5}" x2="${12 + Math.cos(a) * 10}" y2="${12 + Math.sin(a) * 10}" stroke="${c}" stroke-width="2.6" stroke-linecap="round" opacity="${0.25 + 0.75 * (i / 7)}"/>`;
      }
      return s;
    },
    "record.circle": (c) => `<circle cx="12" cy="12" r="10" fill="none" stroke="${c}" stroke-width="2.2"/><circle cx="12" cy="12" r="5" fill="${c}"/>`,
    "checkmark.circle.fill": (c) => `<circle cx="12" cy="12" r="11" fill="${c}"/><path d="m7 12.3 3.2 3.2L17 8.6" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`,
    checkmark: (c) => `<path d="M20 6 9 17l-5-5" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
    "moon.fill": (c) => `<path fill="${c}" d="M20 15A9 9 0 1 1 9 3.5 7.5 7.5 0 0 0 20 15z"/>`,
    "square.and.pencil": (c) => `<path d="M12 3.5H6a2.5 2.5 0 0 0-2.5 2.5v12A2.5 2.5 0 0 0 6 20.5h12a2.5 2.5 0 0 0 2.5-2.5v-6" fill="none" stroke="${c}" stroke-width="2.6" stroke-linecap="round"/><path d="M18.5 2.8a2.1 2.1 0 1 1 3 3L12.5 14.8l-4 1 1-4z" fill="none" stroke="${c}" stroke-width="2.6" stroke-linejoin="round"/>`,
    "chevron.right": (c) => `<path d="m9 5 7 7-7 7" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
    "chevron.down": (c) => `<path d="m5 9 7 7 7-7" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
    xmark: (c) => `<path d="M5 5l14 14M19 5 5 19" stroke="${c}" stroke-width="3.4" stroke-linecap="round"/>`,
    "arrow.down.circle": (c) => `<circle cx="12" cy="12" r="10" fill="none" stroke="${c}" stroke-width="2.2"/><path d="M12 7v9m-4-4 4 4 4-4" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
    photo: (c) => `<rect x="2.5" y="4" width="19" height="16" rx="3" fill="none" stroke="${c}" stroke-width="2.2"/><path d="m3 18 5.5-6 4 4 3-3 5.5 5" fill="none" stroke="${c}" stroke-width="2.2"/>`,
    doc: (c) => `<path d="M6 2.5h8l5 5v14H6z" fill="none" stroke="${c}" stroke-width="2.2" stroke-linejoin="round"/>`,
    "pin.fill": (c) => `<path fill="${c}" d="M15 2l7 7-3 1-4 4 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 4-4z"/>`,
    "hand.raised.fill": (c) => `<path fill="${c}" d="M7 11V5.5a1.5 1.5 0 0 1 3 0V10h.5V3.5a1.5 1.5 0 0 1 3 0V10h.5V4.8a1.5 1.5 0 0 1 3 0V11h.4V7.5a1.5 1.5 0 0 1 3 0V15a8 8 0 0 1-8 8h-1a7.5 7.5 0 0 1-5.6-2.5L2.6 16a1.6 1.6 0 0 1 2.3-2.2L7 15.6z"/>`,
    sparkles: (c) => `<path fill="${c}" d="M10 2.5 12 9l6.5 2-6.5 2-2 6.5L8 13l-6.5-2L8 9zM19 1l.9 2.6 2.6.9-2.6.9L19 8l-.9-2.6-2.6-.9 2.6-.9z"/>`,
    "bolt.fill": (c) => `<path fill="${c}" d="M13.5 1.5 3.5 14h7.2l-1.2 8.5L20.5 9.8h-7.3z"/>`,
    "checkmark.seal.fill": (c) => `<path fill="${c}" d="m12 1 2.6 2 3.3-.4 1.2 3.1 3.1 1.2-.4 3.3 2 2.6-2 2.6.4 3.3-3.1 1.2-1.2 3.1-3.3-.4L12 23l-2.6-2-3.3.4-1.2-3.1-3.1-1.2.4-3.3L0 12l2.2-2.6-.4-3.3 3.1-1.2 1.2-3.1 3.3.4z"/><path d="m7.5 12.2 3 3 6-6.4" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`,
    "moon.zzz.fill": (c) => `<path fill="${c}" d="M19 15.5A8.5 8.5 0 1 1 9 4a7 7 0 0 0 10 11.5z"/><path d="M15 2h5l-5 5h5" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  };

  class View {
    constructor(kind, opts = {}, children = []) {
      this.kind = kind; this.opts = opts; this.children = children; this.p = {};
    }
  }
  const MODS = ["frame", "font", "weight", "color", "fill", "opacity", "cornerRadius", "background", "borderWidth", "borderColor",
    "padding", "paddingHorizontal", "paddingVertical", "paddingTop", "paddingBottom", "paddingLeading", "paddingTrailing",
    "rotation", "lineLimit", "truncation"];
  for (const m of MODS) View.prototype[m] = function (x) { this.p[m] = x; return this; };
  View.prototype.fixedSize = function () { this.p.fixedSize = true; return this; };
  View.prototype.showOnHover = function () { this.p.showOnHover = true; return this; };
  // Interaction and hints that a still picture doesn't show.
  for (const m of ["onTap", "onDoubleTap", "contextMenu", "cursor", "hoverBackground", "hideOnHover", "layoutPriority", "marquee", "fixed", "destructive"]) {
    View.prototype[m] = function () { return this; };
  }

  function runSidebar(source, { workspaces, epoch, appearance = "dark", width = 252 }) {
    const sem = SEMANTIC[appearance];
    const color = (c) => (c == null ? null : sem[c] ?? c);
    let root = null;
    const api = {
      signal: (init) => { let v = init; return [() => v, (x) => { v = x; }]; },
      computed: (fn) => fn,
      data: { workspaces: () => workspaces, clock: () => ({ epoch }), selectedId: () => workspaces.find((w) => w.selected)?.id ?? null },
      cmux: () => null,
      sidebar: (build, opts) => { root = { build, opts }; },
      VStack: (o, c) => new View("v", o, c), HStack: (o, c) => new View("h", o, c), ZStack: (o, c) => new View("z", o, c),
      Text: (s) => new View("text", { s }), Image: (name) => new View("image", { name }),
      TextField: (s) => new View("text", { s }), Rectangle: () => new View("rect"), Capsule: () => new View("capsule"),
      Circle: () => new View("circle"), Spacer: (o = {}) => new View("spacer", o), Divider: () => new View("divider"),
      Button: () => new View("none"), Menu: () => new View("none"),
      ForEach: (o, build) => new View("each", o, [build]), Reorderable: (o, build) => new View("each", { ...o, stack: true }, [build]),
    };
    new Function(...Object.keys(api), source)(...Object.values(api));
    const host = document.createElement("div");
    host.style.cssText = `width:${width}px;display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;-webkit-font-smoothing:antialiased`;
    host.appendChild(place(render(root.build(), "v"), "v"));
    return host;

    // As in SwiftUI, a stack is as flexible as its children: a Spacer or an infinite
    // frame inside makes the stack itself take the room it is offered.
    function place(el, parent) {
      const s = el.style;
      if (el._spacer) { s.flex = "1 1 0"; return el; }
      if (parent === "h") {
        // Text keeps its own width in a row and only gives way when the row runs out.
        if (el._fw) { s.flexGrow = "1"; s.flexBasis = el._text ? "auto" : "0"; s.minWidth = s.minWidth || "0"; }
        if (el._fh) s.alignSelf = "stretch";
      } else if (parent === "v") {
        if (el._fh) s.flexGrow = "1";
        if (el._fw) s.alignSelf = "stretch";
      } else {
        if (el._fw) s.justifySelf = "stretch";
        if (el._fh) s.alignSelf = "stretch";
      }
      return el;
    }

    function render(n, axis) {
      if (n.kind === "each") {
        const items = val(n.opts.items) ?? [];
        const kids = items.map((it) => n.children[0](() => it));
        if (!n.opts.stack) {
          // A conditional view: one item or none, laid out in place.
          if (!kids.length) { const d = document.createElement("div"); d.style.display = "none"; return d; }
          if (kids.length === 1) return render(kids[0], axis);
        }
        return render(Object.assign(new View("v", { spacing: n.opts.spacing ?? 0 }, kids), { p: {} }), axis);
      }
      const el = document.createElement("div");
      const s = el.style, p = n.p;
      s.boxSizing = "border-box"; s.position = "relative";
      if (n.kind === "v" || n.kind === "h") {
        const v = n.kind === "v";
        s.display = "flex"; s.flexDirection = v ? "column" : "row"; s.gap = (n.opts.spacing ?? 8) + "px";
        const al = n.opts.alignment;
        s.alignItems = v ? (al === "leading" ? "flex-start" : al === "trailing" ? "flex-end" : "center")
          : (al === "top" ? "flex-start" : al === "bottom" ? "flex-end" : "center");
        for (const c of n.children) {
          const k = place(render(c, n.kind), n.kind);
          el.appendChild(k);
          if (k._fw || (k._spacer && !v)) el._fw = true;
          if (k._fh || (k._spacer && v)) el._fh = true;
        }
      } else if (n.kind === "z") {
        s.display = "grid"; s.gridTemplate = "minmax(0, 1fr) / minmax(0, 1fr)";
        const al = n.opts.alignment ?? "center";
        s.alignItems = /top/i.test(al) ? "start" : /bottom/i.test(al) ? "end" : "center";
        s.justifyItems = /leading/i.test(al) ? "start" : /trailing/i.test(al) ? "end" : "center";
        for (const c of n.children) {
          const k = place(render(c, "z"), "z");
          k.style.gridArea = "1 / 1"; el.appendChild(k);
          if (k._fw) el._fw = true;
          if (k._fh) el._fh = true;
        }
      } else if (n.kind === "text") {
        el.textContent = val(n.opts.s) ?? "";
        s.whiteSpace = "pre"; s.fontSize = (p.font ?? 13) + "px"; s.lineHeight = "1.2";
        s.fontWeight = { bold: 700, semibold: 600, medium: 500, regular: 400 }[val(p.weight)] ?? 400;
        s.color = color(val(p.color)) ?? sem.primary;
        if (p.lineLimit === 1 || p.truncation) { s.overflow = "hidden"; s.textOverflow = "ellipsis"; }
        // A truncating line takes the width it's offered, so it starts at the leading edge.
        if (p.truncation) el._fw = el._text = true;
        s.minWidth = "0"; s.flexShrink = p.fixedSize ? "0" : "1";
      } else if (n.kind === "image") {
        const name = val(n.opts.name), sz = (p.font ?? 13) * 1.15;
        const c = color(val(p.color)) ?? sem.primary;
        el.innerHTML = `<svg viewBox="0 0 24 24" width="${sz}" height="${sz}" style="display:block">${(SYM[name] ?? SYM.doc)(c)}</svg>`;
        s.flexShrink = "0";
      } else if (n.kind === "rect" || n.kind === "capsule" || n.kind === "circle") {
        s.background = color(val(p.fill)) ?? sem.primary;
        if (n.kind !== "rect") s.borderRadius = n.kind === "circle" ? "50%" : "999px";
        s.flexShrink = "0";
      } else if (n.kind === "spacer") {
        el._spacer = true; s[axis === "h" ? "minWidth" : "minHeight"] = (n.opts.minLength ?? 8) + "px";
      } else if (n.kind === "divider") {
        s.height = "1px"; s.alignSelf = "stretch"; s.background = sem.tertiary;
      } else if (n.kind === "none") {
        s.display = "none";
      }

      // padding, background, border, corners, frame
      const pad = { t: 0, r: 0, b: 0, l: 0 };
      if (p.padding != null) pad.t = pad.r = pad.b = pad.l = val(p.padding);
      if (p.paddingHorizontal != null) pad.l = pad.r = val(p.paddingHorizontal);
      if (p.paddingVertical != null) pad.t = pad.b = val(p.paddingVertical);
      if (p.paddingTop != null) pad.t = val(p.paddingTop);
      if (p.paddingBottom != null) pad.b = val(p.paddingBottom);
      if (p.paddingLeading != null) pad.l = val(p.paddingLeading);
      if (p.paddingTrailing != null) pad.r = val(p.paddingTrailing);
      s.padding = `${pad.t}px ${pad.r}px ${pad.b}px ${pad.l}px`;
      const bg = color(val(p.background));
      if (bg) s.background = bg;
      const bw = val(p.borderWidth), bc = color(val(p.borderColor));
      if (bw && bc) s.boxShadow = `inset 0 0 0 ${bw}px ${bc}`;
      const cr = val(p.cornerRadius);
      if (cr) { s.borderRadius = cr + "px"; s.overflow = "hidden"; }
      if (p.opacity != null) s.opacity = val(p.opacity);
      if (p.showOnHover) s.opacity = 0;
      if (p.rotation != null) s.transform = `rotate(${val(p.rotation) % 360}deg)`;
      if (p.fixedSize) s.flexShrink = "0";
      const f = val(p.frame);
      if (f) {
        const grow = (x) => x === "infinity";
        if (f.width != null) { s.width = f.width + "px"; s.flexShrink = "0"; }
        if (f.height != null) { s.height = f.height + "px"; s.flexShrink = "0"; if (f.height === 0) s.overflow = "hidden"; }
        if (f.width === 0) s.overflow = "hidden";
        if (f.minWidth != null) s.minWidth = f.minWidth + "px";
        if (f.minHeight != null) s.minHeight = f.minHeight + "px";
        if (grow(f.maxWidth)) el._fw = true;
        if (grow(f.maxHeight)) el._fh = true;
        if (f.width != null) el._fw = false;
        if (f.height != null) el._fh = false;
        if (n.kind === "h") s.justifyContent = /leading/i.test(f.alignment ?? "") ? "flex-start" : /trailing/i.test(f.alignment ?? "") ? "flex-end" : "center";
        if (n.kind === "v" && f.height != null) s.justifyContent = /top/i.test(f.alignment ?? "top") ? "flex-start" : "center";
      }
      return el;
    }
  }

  window.runSidebar = runSidebar;
})();
