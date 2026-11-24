export function diffLines(text) {
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

export function diffLineType(line, state) {
  if (line.startsWith('diff --')) { state.inHunk = false; return 'header'; }
  if (line.startsWith('@@ ')) { state.inHunk = true; return 'hunk'; }
  if (state.inHunk && line.startsWith('+')) return 'added';
  if (state.inHunk && line.startsWith('-')) return 'removed';
  if (!state.inHunk && /^(?:index |--- |\+\+\+ )/.test(line)) return 'header';
  return '';
}
