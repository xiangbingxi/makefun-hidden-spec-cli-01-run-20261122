# mend

`mend` applies an edit written by an AI model to a tree of text files.
Run it as:

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory (the root of
  the tree). When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` forces one format: `unified`, `search-replace`, `v4a` or
  `json`. The default `auto` detects the format: a first non-blank line of
  `*** Begin Patch` is V4A, a first `[` or `{` is JSON, a `<<<<<<< SEARCH`
  line is SEARCH/REPLACE, a `diff --git` line or a `---`/`+++` pair is a
  unified diff.
- `--check` does everything but write: same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order; `--` ends the options.

Exit codes: `2` for a usage error, an unreadable patch file, an
undetectable format, or a parse error (`error: parse <N>`); `1` when one or
more edits failed (`error: <code> <path>` per failed edit, then
`failed: <k> of <n> edits`) — in that case no file is written at all;
`0` when every edit applied, printing one line per changed path
(`A`/`D`/`M`, or `R <old> -> <new>` for a move) and `ok: <n> files`.

## The four formats

- **Unified diff** (`unified`): `diff --git` sections with `---`/`+++`
  headers and `@@ -A[,B] +C[,D] @@` hunks. Line numbers are only a hint:
  each hunk takes the occurrence of its old lines nearest to `A - 1 + d`
  (d is the drift from earlier hunks in the section). Handles creation
  (`/dev/null` old path or `new file mode`), deletion, renames/moves, empty
  old text (insertion after `A + d` lines), and `\ No newline at end of file`.
- **SEARCH/REPLACE** (`search-replace`): a path line, then
  `<<<<<<< SEARCH` / old lines / `=======` / new lines / `>>>>>>> REPLACE`.
  The path is the nearest non-blank, non-fence line before the block, or the
  previous block's path. Empty old text creates the file; otherwise the old
  text must occur exactly once or the block fails `ambiguous`.
- **V4A** (`v4a`): between `*** Begin Patch` and `*** End Patch`, sections
  `*** Add File:`, `*** Delete File:`, `*** Update File:` (optionally with
  `*** Move to:` first). Update chunks start at `@@ <anchor>` (or at a body
  line for the first chunk) and are applied in order with a cursor that moves
  past each anchor and each replacement; `*** End of File` anchors a chunk
  to the file's last line.
- **JSON** (`json`): one JSON array of edit objects, or one edit object per
  line (JSON Lines). Commands: `create` (`file_text`, byte for byte),
  `str_replace` (`old_str` must occur exactly once, exact match),
  `insert` (`insert_line`, 0 is the top).

## Matching

Old lines are found at the first of three tiers that has an occurrence:
tier 0 (exact), tier 1 (trailing spaces/tabs ignored), tier 2 (leading and
trailing spaces/tabs ignored). At tier 2, new lines are re-indented: the
leading whitespace of the patch's first old line is replaced by that of the
file's first matched line. Context lines are always written as the file's
own matched lines. `--strict` tries tier 0 only.

A changed file keeps its own line break (CRLF or LF) and its final line
break (except where a unified hunk's `\ No newline` line says otherwise);
a created file uses LF and ends with a line break unless the format says
otherwise. Paths must be safe (relative, no `\`, no empty/`.`/`..`
segments); directories are created as needed. Edits apply in patch order
to the tree as earlier edits left it, and a failed edit changes nothing.
