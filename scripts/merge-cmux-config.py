#!/usr/bin/env python3
"""Merge config/cmux.snippet.jsonc into ~/.config/cmux/cmux.json without losing anything.

cmux.json is JSONC (comments, trailing commas), so it's edited as text: only keys
the person doesn't have yet are inserted, copied from the snippet with their
formatting and the comment above them. Values they already set are never changed,
only reported. `commands` entries match by name and tab-strip buttons by action,
so missing ones are appended to their lists.

  merge-cmux-config.py SNIPPET TARGET [--dry-run] [--cmux BIN]

Exit codes: 0 merged (or nothing to do), 2 merged but something needs a manual fix,
3 target can't be parsed (left untouched), 4 cmux rejected the result (backup restored).
"""
import os
import shutil
import subprocess
import sys
import time

REQUIRED = {("automation", "socketControlMode"): "automation"}
KEYED_ARRAYS = {("commands",): "name", ("ui", "surfaceTabBar", "buttons"): "action"}


# --- JSONC parser that keeps source positions --------------------------------------

class ParseError(Exception):
    pass


class Node:
    def __init__(self, kind, start):
        self.kind, self.start = kind, start
        self.end = None          # position after the value
        self.close = None        # position of } or ] for containers
        self.members = []        # objects: (key, key_start, lead_start, value)
        self.items = []          # arrays: (lead_start, value)
        self.value = None        # scalars


class Parser:
    def __init__(self, text):
        self.s, self.i = text, 0

    def skip(self):
        s = self.s
        while self.i < len(s):
            c = s[self.i]
            if c in " \t\r\n﻿":
                self.i += 1
            elif s.startswith("//", self.i):
                j = s.find("\n", self.i)
                self.i = len(s) if j < 0 else j
            elif s.startswith("/*", self.i):
                j = s.find("*/", self.i + 2)
                if j < 0:
                    raise ParseError("unclosed /* comment")
                self.i = j + 2
            else:
                break

    def peek(self):
        self.skip()
        return self.s[self.i] if self.i < len(self.s) else ""

    def expect(self, c):
        if self.peek() != c:
            raise ParseError(f"expected {c!r} at offset {self.i}")
        self.i += 1

    def parse(self):
        v = self.value()
        if self.peek():
            raise ParseError(f"unexpected text at offset {self.i}")
        return v

    def string(self):
        s, i = self.s, self.i + 1
        out = []
        while i < len(s):
            c = s[i]
            if c == '"':
                self.i = i + 1
                return "".join(out)
            if c == "\\":
                e = s[i + 1:i + 2]
                if e == "u":
                    out.append(chr(int(s[i + 2:i + 6], 16)))
                    i += 6
                    continue
                out.append({"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f"}.get(e, e))
                i += 2
                continue
            if c == "\n":
                break
            out.append(c)
            i += 1
        raise ParseError(f"unterminated string at offset {self.i}")

    def value(self):
        c = self.peek()
        start = self.i
        if c == "{":
            n = Node("object", start)
            self.i += 1
            while True:
                lead = self.i
                c = self.peek()
                if c == "}":
                    n.close = self.i
                    self.i += 1
                    break
                if c != '"':
                    raise ParseError(f"expected a key at offset {self.i}")
                key_start = self.i
                key = self.string()
                self.expect(":")
                n.members.append((key, key_start, lead, self.value()))
                c = self.peek()
                if c == ",":
                    self.i += 1
                elif c != "}":
                    raise ParseError(f"expected , or }} at offset {self.i}")
            n.end = self.i
            return n
        if c == "[":
            n = Node("array", start)
            self.i += 1
            while True:
                lead = self.i
                c = self.peek()
                if c == "]":
                    n.close = self.i
                    self.i += 1
                    break
                n.items.append((lead, self.value()))
                c = self.peek()
                if c == ",":
                    self.i += 1
                elif c != "]":
                    raise ParseError(f"expected , or ] at offset {self.i}")
            n.end = self.i
            return n
        n = Node("scalar", start)
        if c == '"':
            n.value = self.string()
        else:
            j = self.i
            while j < len(self.s) and self.s[j] not in ",]}/ \t\r\n":
                j += 1
            word = self.s[self.i:j]
            if word in ("true", "false", "null"):
                n.value = {"true": True, "false": False, "null": None}[word]
            else:
                try:
                    n.value = float(word) if any(x in word for x in ".eE") else int(word)
                except ValueError:
                    raise ParseError(f"unexpected {word or 'end of file'!r} at offset {self.i}")
            self.i = j
        n.end = self.i
        return n


def plain(n):
    if n.kind == "object":
        return {k: plain(v) for k, _, _, v in n.members}
    if n.kind == "array":
        return [plain(v) for _, v in n.items]
    return n.value


def member(n, key):
    found = None
    for k, _, _, v in n.members:
        if k == key:
            found = v       # last one wins, as in JSON
    return found


# --- text helpers --------------------------------------------------------------------

def line_start(s, pos):
    return s.rfind("\n", 0, pos) + 1


def indent_of(s, pos):
    ls = line_start(s, pos)
    j = ls
    while j < len(s) and s[j] in " \t":
        j += 1
    return s[ls:j]


def starts_line(s, pos):
    return s[line_start(s, pos):pos].strip() == ""


def snippet_slice(s, lead, start, end):
    """The snippet's text for one member/item: the comment lines right above it, then the value.
    Returned as lines without their common indent."""
    above = s[lead:start]
    comments = []
    for ln in above.split("\n"):
        t = ln.strip()
        if t.startswith("//"):
            comments.append(t)
        elif t:
            comments = []
    body = s[start:end].split("\n")
    base = indent_of(s, start)
    lines = comments + [body[0]] + [ln[len(base):] if ln.startswith(base) else ln.lstrip() for ln in body[1:]]
    return lines


def child_indent(t, node, entries_starts):
    for p in entries_starts:
        if starts_line(t, p):
            return indent_of(t, p)
    return indent_of(t, node.start) + "  "


def insertion(t, node, last_end, pieces):
    """Text edits that append `pieces` (lists of lines) to an object/array in target text t."""
    starts = [ks for _, ks, _, _ in node.members] if node.kind == "object" else [v.start for _, v in node.items]
    ind = child_indent(t, node, starts)
    # A blank line above a commented entry, as in the snippet.
    block = (",\n").join(("\n" if lines[0].startswith("//") else "") + "\n".join(ind + ln for ln in lines)
                         for lines in pieces)
    if last_end is None:
        # Empty container: open it up onto its own lines.
        return [(node.start + 1, "\n" + block + "\n" + indent_of(t, node.start))]
    # Put the new entries on the lines after the last one, past any comment that trails it.
    eol = t.find("\n", last_end)
    eol = len(t) if eol < 0 else eol
    rest = t[last_end:eol].strip()
    if rest == "":
        return [(last_end, ",\n" + block)]
    if rest.startswith("//"):
        return [(last_end, ","), (eol, "\n" + block)]
    if rest.startswith(","):
        tail = rest[1:].strip()
        if tail == "" or tail.startswith("//"):
            return [(eol, "\n" + block)]        # it already ends in a comma
    # A bracket follows on the same line ({ "a": 1 }): insert right after the value.
    return [(last_end, ",\n" + block)]


# --- merge ---------------------------------------------------------------------------

def fmt(v):
    import json
    return json.dumps(v, ensure_ascii=False)


def merge(snip_text, sn, tgt_text, tn, path, edits, report):
    pieces = []
    for key, ks, lead, sv in sn.members:
        p = path + (key,)
        dotted = ".".join(p)
        tv = member(tn, key)
        if tv is None:
            pieces.append(snippet_slice(snip_text, lead, ks, sv.end))
            report["added"].append(dotted)
            continue
        if sv.kind == "object" and tv.kind == "object":
            merge(snip_text, sv, tgt_text, tv, p, edits, report)
        elif sv.kind == "array" and tv.kind == "array" and p in KEYED_ARRAYS:
            field = KEYED_ARRAYS[p]
            ident = lambda v: v if not isinstance(v, dict) else v.get(field)
            have = {fmt(ident(plain(v))) for _, v in tv.items}
            add = []
            for il, iv in sv.items:
                # cmux's own buttons are left out of a strip someone already arranged.
                if str(ident(plain(iv))).startswith("cmux."):
                    continue
                if fmt(ident(plain(iv))) not in have:
                    add.append(snippet_slice(snip_text, il, iv.start, iv.end))
                    report["added"].append(f"{dotted}[{ident(plain(iv))}]")
            if add:
                last = tv.items[-1][1].end if tv.items else None
                edits += insertion(tgt_text, tv, last, add)
        elif plain(sv) != plain(tv):
            if p in REQUIRED:
                report["fix"].append(f'{dotted} is {fmt(plain(tv))}; set it to {fmt(REQUIRED[p])} '
                                     f'(the sync job runs from launchd, outside cmux, and needs socket access)')
            else:
                report["kept"].append(f"{dotted} = {fmt(plain(tv))}"[:140])
    if pieces:
        last = max(v.end for _, _, _, v in tn.members) if tn.members else None
        edits += insertion(tgt_text, tn, last, pieces)


def plan(snip_text, tgt_text):
    sn = Parser(snip_text).parse()
    tn = Parser(tgt_text).parse()
    if tn.kind != "object":
        raise ParseError("the top level isn't an object")
    edits, report = [], {"added": [], "kept": [], "fix": []}
    merge(snip_text, sn, tgt_text, tn, (), edits, report)
    out = tgt_text
    # From the end backwards, so positions stay valid; edits at one spot keep their order.
    for _, (pos, text) in sorted(enumerate(edits), key=lambda e: (e[1][0], e[0]), reverse=True):
        out = out[:pos] + text + out[pos:]
    return out, report


def main():
    args = sys.argv[1:]
    dry = "--dry-run" in args
    cmux = None
    if "--cmux" in args:
        cmux = args[args.index("--cmux") + 1]
    snippet, target = [a for i, a in enumerate(args) if not a.startswith("--") and (i == 0 or args[i - 1] != "--cmux")][:2]
    snip_text = open(snippet, encoding="utf-8").read()
    say = lambda m: print("  " + m)

    if not os.path.exists(target):
        say(f"{target} doesn't exist yet: {'would create' if dry else 'creating'} it from the snippet")
        if not dry:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            lines = snip_text.split("\n")
            if lines and lines[0].startswith("//"):
                lines[0] = "// Created by cmux-agent-status's install.sh from config/cmux.snippet.jsonc."
            with open(target, "w", encoding="utf-8") as f:
                f.write("\n".join(lines))
        return validate(cmux, target, None, dry)

    tgt_text = open(target, encoding="utf-8").read()
    try:
        out, report = plan(snip_text, tgt_text)
    except ParseError as e:
        say(f"Can't read {target} ({e}), so it was left as it is.")
        say(f"Merge the keys from {snippet} into it by hand, then run: cmux reload-config")
        return 3

    for k in report["added"]:
        say(("would add " if dry else "added ") + k)
    for k in report["kept"]:
        say("kept yours: " + k)
    for k in report["fix"]:
        say("NEEDS A FIX: " + k)
    if out == tgt_text:
        say("nothing to add, cmux.json already has every key")
        return 2 if report["fix"] else 0
    try:
        Parser(out).parse()     # self-check before anything is written
    except ParseError as e:
        say(f"Merging would break the file ({e}), so it was left as it is. Merge {snippet} by hand.")
        return 3
    if dry:
        return 2 if report["fix"] else 0

    real = os.path.realpath(target)
    backup = target + ".bak-" + time.strftime("%Y%m%d-%H%M%S")
    shutil.copy2(real, backup)
    tmp = real + ".tmp-agent-status"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(out)
    shutil.copymode(real, tmp)
    os.replace(tmp, real)
    say(f"backup of the previous version: {backup}")
    rc = validate(cmux, target, backup, dry)
    return rc or (2 if report["fix"] else 0)


def validate(cmux, target, backup, dry):
    if dry or not cmux:
        return 0
    r = subprocess.run([cmux, "config", "validate", "--path", target], capture_output=True, text=True)
    if r.returncode == 0:
        return 0
    print("  cmux rejected the merged file:")
    print("    " + "\n    ".join((r.stdout + r.stderr).strip().splitlines()[-8:]))
    if backup:
        shutil.copy2(backup, os.path.realpath(target))
        print(f"  restored the previous version from {backup}")
    return 4


if __name__ == "__main__":
    sys.exit(main())
