// mend: apply an AI-written edit to a tree of text files.
// Formats: unified diff, SEARCH/REPLACE, V4A patch, JSON edits (SPEC.md).
// Node 22, standard library only; run as `node main.ts [options] [PATCH]`.

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// A file split into lines: br is its line break, final says it ends with one.
type FileParts = { lines: string[]; br: string; final: boolean };
function fileParts(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text.endsWith(br)) return { lines: text.slice(0, -br.length).split(br), br, final: true };
  return { lines: text.split(br), br, final: false };
}
function joinParts(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const onlyWS = (s: string): boolean => s === '' || /^[ \t]+$/.test(s);

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** True when the path can become a file in the tree as it now stands:
   *  no ancestor is a file, the path is not a directory on disk, and the
   *  path is not an ancestor of a file in the tree. */
  creatable(p: string): boolean {
    const parts = p.split('/');
    for (let k = 1; k < parts.length; k += 1) {
      if (this.get(parts.slice(0, k).join('/')) !== null) return false;
    }
    try {
      if (statSync(p).isDirectory()) return false;
    } catch {
      // not on disk
    }
    for (const q of this.now.keys()) {
      if (this.now.get(q) !== null && q.startsWith(p + '/')) return false;
    }
    return true;
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Section 5: matching lines at three tiers ----

const tierEq = (a: string, b: string, tier: number): boolean => {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimST(a) === trimST(b);
};

// Positions where O matches file lines, at one tier, at or after `from`.
function occAtTier(file: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= file.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!tierEq(file[i + j]!, o[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

// First tier (0, then 1, then 2; strict: only 0) with an occurrence at/after from.
function findTier(file: string[], o: string[], strict: boolean, from: number): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occAtTier(file, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

// Tier-2 re-indent for one new line: F is the file's first matched line's
// leading spaces/tabs, P is O's first line's. Empty / whitespace-only lines
// and lines not starting with P are written as they are.
function reindent(line: string, f: string, p: string): string {
  if (onlyWS(line)) return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

// One new line of a hunk/chunk: context lines come from the file itself.
type NewLine = { text: string; ctx: boolean; oIdx: number };
function buildNew(n: NewLine[], file: string[], pos: number, o: string[], tier: number): string[] {
  if (tier !== 2) return n.map((e) => (e.ctx ? file[pos + e.oIdx]! : e.text));
  const f = leadST(file[pos]!);
  const p = leadST(o[0]!);
  return n.map((e) => (e.ctx ? file[pos + e.oIdx]! : reindent(e.text, f, p)));
}

// ---- Section 9: JSON edits ----

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      if (!tree.creatable(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const parts = fileParts(before);
      const lines = [...parts.lines];
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinParts(lines, parts.br, parts.final));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Section 6: unified diffs ----

type BodyItem = { kind: string; text: string; raw: string };
type Hunk = { a: number; body: BodyItem[]; o: string[]; n: NewLine[]; lastNoNL: boolean };
type Section = {
  diffOld: string | null; diffNew: string | null;
  minusOld: string | null | undefined; minusNew: string | null | undefined;
  renameOld: string | undefined; renameNew: string | undefined;
  isCreate: boolean; isDelete: boolean; hunks: Hunk[];
};

function headerPath(raw: string): string | null {
  let s = raw.split('\t')[0]!.trim();
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s === '/dev/null' ? null : s;
}

function makeHunk(a: number, body: BodyItem[]): Hunk {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const it of body) {
    if (it.kind === ' ') { o.push(it.text); n.push({ text: it.text, ctx: true, oIdx: o.length - 1 }); }
    else if (it.kind === '-') o.push(it.text);
    else if (it.kind === '+') n.push({ text: it.text, ctx: false, oIdx: -1 });
  }
  let lastNoNL = false;
  for (let k = body.length - 1; k >= 0; k -= 1) {
    if (body[k]!.kind === ' ' || body[k]!.kind === '+') {
      lastNoNL = body[k + 1] !== undefined && body[k + 1]!.kind === '\\';
      break;
    }
  }
  return { a, body, o, n, lastNoNL };
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const parts = fileParts(text);
  const lines = [...parts.lines];
  let final = parts.final;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const atEnd = Math.min(Math.max(h.a + d, 0), lines.length) === lines.length;
      const at = Math.min(Math.max(h.a + d, 0), lines.length);
      const add = h.n.map((e) => e.text);
      if (add.length > 0) {
        lines.splice(at, 0, ...add);
        if (atEnd) final = !h.lastNoNL;
      }
      d += add.length;
      continue;
    }
    const found = findTier(lines, h.o, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.pos[0]!;
    for (const q of found.pos) {
      if (Math.abs(q - target) < Math.abs(pos - target)) pos = q;
    }
    const endsAtEnd = pos + h.o.length === lines.length;
    const repl = buildNew(h.n, lines, pos, h.o, found.tier);
    lines.splice(pos, h.o.length, ...repl);
    d += repl.length - h.o.length;
    if (endsAtEnd) final = repl.length === 0 ? lines.length > 0 : !h.lastNoNL;
  }
  return joinParts(lines, parts.br, final);
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.minusOld !== undefined ? sec.minusOld : sec.renameOld !== undefined ? sec.renameOld : sec.diffOld;
  const newP = sec.minusNew !== undefined ? sec.minusNew : sec.renameNew !== undefined ? sec.renameNew : sec.diffNew;
  const isCreate = sec.minusOld === null || sec.isCreate;
  const isDelete = !isCreate && (sec.minusNew === null || sec.isDelete);
  const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
  return (tree) => {
    if (isCreate) {
      const p = newP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      if (!tree.creatable(p)) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const it of h.body) if (it.kind === '+') plus.push(it.text);
      let noNL = false;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
        const body = sec.hunks[hi]!.body;
        for (let k = body.length - 1; k >= 0; k -= 1) {
          if (body[k]!.kind === '+') { noNL = body[k + 1] !== undefined && body[k + 1]!.kind === '\\'; break outer; }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noNL ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = (isMove ? oldP : oldP) ?? '';
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (isMove) {
      const np = newP ?? '';
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(before, sec.hunks, strict, p);
      tree.now.set(np, out);
      tree.now.set(p, null);
      tree.moves.push([p, np]);
      return;
    }
    tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const fresh = (o: string | null, n: string | null): Section => ({ diffOld: o, diffNew: n, minusOld: undefined, minusNew: undefined, renameOld: undefined, renameNew: undefined, isCreate: false, isDelete: false, hunks: [] });
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh(m[1]!, m[2]!);
      sections.push(cur);
      inHeader = true;
      i += 1;
    } else if (cur !== null && inHeader && line.startsWith('--- ')) {
      if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      cur.minusOld = headerPath(line.slice(4));
      cur.minusNew = headerPath(lines[i + 1]!.slice(4));
      i += 2;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = fresh(null, null);
      cur.minusOld = headerPath(line.slice(4));
      cur.minusNew = headerPath(lines[i + 1]!.slice(4));
      sections.push(cur);
      inHeader = true;
      i += 2;
    } else if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      // B and D are the hunk's old/new line counts (1 when omitted). They
      // are not used to apply the hunk. They only help tell a `--- ` /
      // `+++ ` pair that is body content (e.g. a `-` line `-- old` followed
      // by a `+` line `++ new`) from a new section's header: the pair ends
      // the body once the hunk's counts are met. Before that, the pair is
      // body content -- unless what follows it starts a new section (a
      // hunk header, after any section-header lines, a `diff --git ` line,
      // or another header pair). That lookahead is what keeps a wrong
      // count from swallowing a real header: SPEC §6 says B and D are not
      // used, so a count written one too large must not change the parse.
      // But the lookahead alone cannot tell a same-file second hunk from
      // a new file's first hunk: both look like a pair followed by `@@`.
      // So the pair itself is asked first (see the body loop below): it
      // is body when its two paths name different files and neither is
      // /dev/null (no plain modify header does that), or when it names
      // this section's own file on both sides and taking it as one `-`
      // line and one `+` line completes the hunk's counts exactly.
      // Completing the counts alone is not body evidence: with B and D
      // both written one too large, a real header pair for the next file
      // completes them too, and the old rule swallowed it as body.
      // Known limits, neither shape told apart from the lines alone: a
      // body pair naming a different file than this section, whose counts
      // happen to complete exactly, is read as a header; a bare rename
      // pair after an unmet-count hunk is read as body; a hunk-less
      // section at the very end of the patch is read as body; and a
      // second section for this same file after an unmet-count hunk is
      // read as body when its pair would complete the counts.
      const oldCount = m[2] === undefined ? 1 : parseInt(m[2], 10);
      const newCount = m[4] === undefined ? 1 : parseInt(m[4], 10);
      const headerAhead = (k: number): boolean => {
        let t = k + 2;
        while (t < lines.length) {
          const s = lines[t]!;
          if (s.startsWith('index ') || s.startsWith('old mode') || s.startsWith('new mode') ||
              s.startsWith('similarity index') || s.startsWith('dissimilarity index') ||
              s.startsWith('Index:') || s.startsWith('new file mode') || s.startsWith('deleted file mode') ||
              s.startsWith('rename from ') || s.startsWith('rename to ')) { t += 1; continue; }
          break;
        }
        if (t >= lines.length) return false;
        const s = lines[t]!;
        if (/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$/.test(s)) return true;
        if (s.startsWith('diff --git ')) return true;
        if (s.startsWith('--- ') && (lines[t + 1] ?? '').startsWith('+++ ')) return true;
        return false;
      };
      let oldSeen = 0;
      let newSeen = 0;
      let j = i + 1;
      const body: BodyItem[] = [];
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) {
          // Ask the pair itself before the lookahead: a same-file second
          // hunk and a new file's first hunk both follow a pair with
          // `@@`, so `headerAhead` alone would split both. The pair is
          // body content when its two paths name different files and
          // neither is /dev/null (a plain modify header names one file
          // on both sides; a create/delete pair has a /dev/null side
          // and is still read as a header), or when it names this
          // section's own file on both sides and taking it as one `-`
          // line and one `+` line completes this hunk's counts exactly
          // (a body line `-- <own file>` changed to `++ <own file>`).
          // Completing the counts alone is NOT body evidence: B and D
          // are not used (SPEC §6), so both may be written one too
          // large, and then a real header pair for the next file
          // completes them too and would be swallowed as body (it was:
          // `error: no-match` on the first file, the second untouched).
          const oldPath = headerPath(l.slice(4));
          const newPath = headerPath(lines[j + 1]!.slice(4));
          const looksBody = oldPath !== null && newPath !== null && oldPath !== newPath;
          const ownPath = oldPath !== null && oldPath === newPath &&
            (oldPath === cur.minusOld || oldPath === cur.minusNew ||
             oldPath === cur.renameOld || oldPath === cur.renameNew ||
             oldPath === cur.diffOld || oldPath === cur.diffNew);
          const completes = oldSeen + 1 === oldCount && newSeen + 1 === newCount;
          const isBody = looksBody || (ownPath && completes);
          if ((oldSeen >= oldCount && newSeen >= newCount) || (!isBody && headerAhead(j))) break;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
          body.push({ kind: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1), raw: l });
          if (l === '' || l[0] === ' ') { oldSeen += 1; newSeen += 1; }
          else if (l[0] === '-') oldSeen += 1;
          else if (l[0] === '+') newSeen += 1;
          j += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
      cur.hunks.push(makeHunk(parseInt(m[1]!, 10), body));
      inHeader = false;
      i = j;
    } else if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i += 1;
    } else {
      i += 1;
    }
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchIdx = i;
    let sep = -1;
    let end = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') { sep = j; break; }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    for (let j = sep + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') { end = j; break; }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        if (!tree.creatable(p)) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const parts = fileParts(before);
      const found = findTier(parts.lines, oldLines, strict, 0);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const pos = found.pos[0]!;
      let repl: string[];
      if (found.tier === 2) {
        const f = leadST(parts.lines[pos]!);
        const pp = leadST(oldLines[0]!);
        repl = newLines.map((l) => reindent(l, f, pp));
      } else repl = [...newLines];
      const out = [...parts.lines];
      out.splice(pos, oldLines.length, ...repl);
      tree.now.set(p, joinParts(out, parts.br, parts.final));
    });
    prevPath = p;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

// ---- Section 8: V4A patches ----

type VChunk = { anchor: string | null; eof: boolean; o: string[]; n: NewLine[] };
type VSection = { kind: string; path: string; moveTo: string | null; lines: string[]; chunks: VChunk[] };

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = lines.length - 1 - [...lines].reverse().findIndex((l) => !blank(l));
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) { i += 1; continue; }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      const start = i;
      i += 1;
      const raw: string[] = [];
      while (i < last && !isSectionStart(lines[i]!)) { raw.push(lines[i]!); i += 1; }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      for (let k = 0; k < raw.length; k += 1) {
        if (!(raw[k]!.startsWith('+') || raw[k]! === '')) throw new Exit2(`error: parse ${start + 2 + k}`);
      }
      sections.push({ kind: 'add', path, moveTo: null, lines: raw.map((l) => (l === '' ? '' : l.slice(1))), chunks: [] });
    } else if (line.startsWith('*** Delete File: ')) {
      sections.push({ kind: 'delete', path: line.slice(17).trim(), moveTo: null, lines: [], chunks: [] });
      i += 1;
    } else if (line.startsWith('*** Update File: ')) {
      const path = line.slice(17).trim();
      const updateLine = i + 1;
      i += 1;
      const raw: { text: string; no: number }[] = [];
      while (i < last && !isSectionStart(lines[i]!)) { raw.push({ text: lines[i]!, no: i + 1 }); i += 1; }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      let moveTo: string | null = null;
      let body = raw;
      if (body.length > 0 && body[0]!.text.startsWith('*** Move to: ')) {
        moveTo = body[0]!.text.slice(13).trim();
        body = body.slice(1);
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const o: string[] = [];
      const n: NewLine[] = [];
      // Build chunks from body lines, keeping o/n per chunk.
      const curO: string[] = [];
      const curN: NewLine[] = [];
      const flush = (): void => {
        if (cur !== null) { cur.o = [...curO]; cur.n = [...curN]; chunks.push(cur); cur = null; curO.length = 0; curN.length = 0; }
      };
      for (const item of body) {
        const l = item.text;
        if (l.startsWith('@@')) {
          flush();
          cur = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, o: [], n: [] };
        } else if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${item.no}`);
          cur.eof = true;
          flush();
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) cur = { anchor: null, eof: false, o: [], n: [] };
          if (l === '') { curO.push(''); curN.push({ text: '', ctx: true, oIdx: curO.length - 1 }); }
          else if (l[0] === ' ') { curO.push(l.slice(1)); curN.push({ text: l.slice(1), ctx: true, oIdx: curO.length - 1 }); }
          else if (l[0] === '-') curO.push(l.slice(1));
          else curN.push({ text: l.slice(1), ctx: false, oIdx: -1 });
        } else {
          throw new Exit2(`error: parse ${item.no}`);
        }
      }
      flush();
      void o; void n;
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      sections.push({ kind: 'update', path, moveTo, lines: [], chunks });
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return sections.map((sec) => v4aSectionEdit(sec, strict));
}

function v4aSectionEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    if (sec.kind === 'add') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      if (!tree.creatable(sec.path)) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    // update
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const parts = fileParts(before);
    const lines = [...parts.lines];
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let foundAt = -1;
        for (const t of tiers) {
          for (let k = cursor; k < lines.length; k += 1) {
            if (tierEq(lines[k]!, ch.anchor, t)) { foundAt = k; break; }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', sec.path);
        cursor = foundAt + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const add = ch.n.map((e) => e.text);
        lines.splice(at, 0, ...add);
        cursor = at + add.length;
        continue;
      }
      let found: { tier: number; pos: number[] } | null = null;
      if (ch.eof) {
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          const pos = occAtTier(lines, ch.o, t, cursor).filter((q) => q + ch.o.length === lines.length);
          if (pos.length > 0) { found = { tier: t, pos }; break; }
        }
      } else {
        found = findTier(lines, ch.o, strict, cursor);
      }
      if (found === null || found.pos.length === 0) throw new Fail('no-match', sec.path);
      const pos = found.pos[0]!;
      const repl = buildNew(ch.n, lines, pos, ch.o, found.tier);
      lines.splice(pos, ch.o.length, ...repl);
      cursor = pos + repl.length;
    }
    const out = joinParts(lines, parts.br, parts.final);
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, out);
      tree.now.set(sec.path, null);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

// ---- Sections 1, 2 and 10: invocation, output, atomicity ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const doneMoves = tree.moves.filter(([o, n]) => tree.original(o) !== null && tree.original(n) === null && tree.now.get(o) === null && tree.now.get(n) !== null);
  const moveOld = new Set(doneMoves.map(([o]) => o));
  const moveNew = new Map(doneMoves.map(([o, n]) => [n, o] as [string, string]));
  type Row = { key: string; text: string };
  const rows: Row[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (moveOld.has(p)) continue;
    if (moveNew.has(p)) rows.push({ key: p, text: `R ${moveNew.get(p)} -> ${p}` });
    else rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const keys = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  // Pre-write validation: the final tree must have no file that is an
  // ancestor of another file, and no file where a directory stands. The
  // edit-phase checks should have caught these; this is the last gate
  // before anything touches the disk. It runs for --check too, so --check
  // reports the same outcome as a real write.
  for (const p of keys) {
    if (tree.now.get(p) === null) continue;
    if (!tree.creatable(p)) return { code: 1, out: [`error: exists ${p}`] };
  }
  if (!check) {
    // Snapshot every touched path's original bytes, so a failure halfway
    // through the write can put the tree back exactly as it was. The
    // snapshot holds raw bytes (Buffer), not a UTF-8 string: the promise
    // is to restore the original bytes.
    const snap = new Map<string, Buffer | null>();
    for (const p of keys) {
      let b: Buffer | null = null;
      try {
        if (statSync(p).isFile()) b = readFileSync(p);
      } catch {
        b = null;
      }
      snap.set(p, b);
    }
    // Every path is recorded in `touched` BEFORE anything is done to it:
    // a write that truncates or partly rewrites the file it is working on
    // and then throws must still be rolled back. Each new file is written
    // to a temporary file in the same directory and renamed over the
    // target, so the target is either untouched or fully replaced.
    const touched: string[] = [];
    let current = '';
    let tmpSeq = 0;
    const writeAtomic = (p: string, data: string | Buffer): void => {
      const dir = dirname(p);
      const tmp = `${dir === '.' ? '' : `${dir}/`}.mend-tmp-${process.pid}-${tmpSeq}`;
      tmpSeq += 1;
      // `made` is set the moment exclusive creation succeeds, before any
      // content is written: if the write itself throws (the file is
      // already created, possibly partly written), the cleanup below must
      // still remove it. Setting it only after a whole writeFileSync
      // returned left such a file behind as `.mend-tmp-*`. A creation
      // that fails (e.g. a name collision) leaves `made` false, so
      // another file of the same name is never deleted.
      let made = false;
      let fd = -1;
      try {
        fd = openSync(tmp, 'wx');
        made = true;
        const buf = typeof data === 'string' ? Buffer.from(data) : data;
        let off = 0;
        while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
        closeSync(fd);
        fd = -1;
        renameSync(tmp, p);
      } catch (e) {
        if (fd >= 0) {
          try { closeSync(fd); } catch { /* best effort */ }
        }
        if (made) {
          try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
        }
        throw e;
      }
    };
    try {
      for (const p of keys) {
        current = p;
        touched.push(p);
        const now = tree.now.get(p)!;
        if (now === null) rmSync(p, { force: true });
        else {
          mkdirSync(dirname(p), { recursive: true });
          writeAtomic(p, now);
        }
      }
    } catch {
      // Roll back every touched path, including the one that failed, then
      // drop any parent directories the write created that are now empty.
      // A leftover temporary file is removed by writeAtomic itself.
      for (const p of touched) {
        const orig = snap.get(p)!;
        try {
          if (orig === null) rmSync(p, { force: true });
          else { mkdirSync(dirname(p), { recursive: true }); writeAtomic(p, orig); }
        } catch { /* best effort */ }
      }
      const dirs = new Set<string>();
      for (const p of touched) {
        let d = dirname(p);
        while (d !== '' && d !== '.') { dirs.add(d); const up = dirname(d); if (up === d) break; d = up; }
      }
      for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
        try { rmdirSync(d); } catch { /* not empty, a file, or gone */ }
      }
      return { code: 1, out: [`error: write ${current}`] };
    }
  }
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
