import {diffLineType} from './diff.js';

// Regex rules are deliberately shallow, as in lite.js's prism-lite; the stream
// state only tracks constructs that can continue onto another line.
const S = String.raw;
const words = (s) => S`(?<![\w.$@])(?:${s.replace(/ /g, '|')})(?![\w.])`;
const string = S`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`;
const number = S`(?<![\w.])(?:0[xX][\da-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)(?![\w.])`;
const common = [
  ['string', string], ['number', number],
  ['operator', S`[-+*/%^=<>!&|~?:]+`], ['punctuation', S`[()[\]{},;]`],
];
const call = ['variableName.function', S`(?<![\w.$@])[A-Za-z_$][\w$]*(?=[ \t]*\()`];
const js = [
  ['comment', S`//.*`],
  ['regexp', S`(?<=(?:^|[=(,:;!&|?{}\[]|\breturn)[ \t]*)/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\[])+/[a-z]*`],
  ['keyword', words('const let var function return if else for while do switch case break continue new delete typeof instanceof in of class extends import export from default async await try catch finally throw yield this super void with interface type enum implements')],
  ['bool', words('true false')], ['null', words('null undefined NaN Infinity')], call, ...common,
];
const python = [
  ['comment', S`#.*`], ['string', S`(?<!\w)[rRbBfFuU]{0,2}(?:${string})`],
  ['meta', S`@[\w.]+`],
  ['keyword', words('def class return if elif else for while in not and or is import from as with try except finally raise pass break continue lambda yield global nonlocal del assert async await')],
  ['bool', words('True False')], ['null', words('None')], call, ...common,
];
const r = [
  ['comment', S`#.*`],
  ['keyword', words('if else repeat while function for next break in')],
  ['bool', words('TRUE FALSE')], ['null', words('NULL NA NA_integer_ NA_real_ NA_character_ Inf NaN')],
  ['variableName.function', S`(?<![\w.])[A-Za-z.][\w.]*(?=\()`],
  ['operator', S`%[^%\n]*%`], ...common,
];
const shell = [
  ['comment', S`(?<!\S)#.*`], ['variableName.special', S`\$(?:\w+|\{[^}]*\}|[@*#?$!-])`],
  ['keyword', words('if then else elif fi for in do done while until case esac function return exit local export')],
  ['variableName.standard', words('echo cd pwd source set unset read printf test eval exec alias shift trap')],
  ...common,
];
const json = [
  ['propertyName', S`"(?:\\.|[^"\\])*"(?=\s*:)`], ['bool', words('true false')],
  ['null', words('null')], ['punctuation', S`[:,{}\[\]]`], ['string', string], ['number', number],
];
const css = [
  ['meta', S`@[\w-]+`], ['tagName', S`[^{}\s;@/(][^{};]*(?=\{)`],
  ['propertyName', S`-{0,2}[a-zA-Z][\w-]*(?=\s*:)`],
  ['variableName.special', S`--[\w-]+`], ['string.special', string],
  ['number', S`#[\da-fA-F]{3,8}\b|(?<![\w-])-?(?:\d+\.?\d*|\.\d+)(?:%|[a-zA-Z]+)?`],
  ['variableName.function', S`[\w-]+(?=\()`], ['punctuation', S`[{}():;,]`],
];
const html = [
  ['tagName', S`<\/?[A-Za-z][\w:-]*`], ['meta', S`<![^>]*>`],
  ['attributeName', S`[\w:-]+(?=\s*=)`], ['attributeValue', string],
  ['punctuation', S`\/?>|=`], ['string.special', S`&(?:#\d+|#[xX][\da-fA-F]+|[A-Za-z][A-Za-z\d]*);`],
];
const yaml = [
  ['comment', S`#.*`], ['meta', S`(?<=^|[ \t-])[\w.-]+(?=:\s|:$)`],
  ['variableName.special', S`[&*][\w-]+`], ['string', string], ['bool', words('true false')],
  ['null', words('null')], ['number', number], ['punctuation', S`[:,\[\]{}]`],
];
const sql = [
  ['comment', S`--.*`], ['string', S`'(?:''|[^'])*'|"(?:""|[^"])*"`],
  ['keyword', words('select from where and or not in is like between exists as on join inner outer left right full cross union all distinct group by order having limit offset with case when then else end insert into values update set delete create alter drop table view index if primary key foreign references unique default asc desc')],
  ['variableName.standard', words('int integer bigint real float double decimal numeric char varchar text boolean date time timestamp')],
  ['bool', words('true false')], ['null', words('null')], call, ...common,
];
const tex = [
  ['keyword', S`\\(?:[a-zA-Z@]+\*?|[^a-zA-Z])`], ['comment', S`%.*`],
  ['variableName.special', S`\$\$.*?\$\$|\$[^$]*\$`], ['punctuation', S`[{}\[\]&]`],
];
const markdown = [
  ['heading', S`^#{1,6}[ \t].*`], ['string', S`\x60[^\x60]+\x60`],
  ['link', S`!?\[[^\]]*\]\([^)]*\)|\[[^\]]*\]\[[^\]]*\]|https?://[^\s)>\]]+`],
  ['strong', S`\*\*[^*]+\*\*|__[^_]+__`],
  ['emphasis', S`\*[^*\s][^*]*\*|(?<!\w)_[^_\s][^_]*_(?!\w)`],
  ['punctuation', S`^[ \t]*(?:[-*+]|\d+[.)]|>+)(?=[ \t])`],
];
const generic = [
  ['comment', S`//.*|(?<!\S)#.*|(?<!\S)--\s.*`], ...common,
];

function mode(rules, multiline = [], insensitive = false) {
  const regex = new RegExp(rules.map(([, pattern], i) => `(?<t${i}>${pattern})`).join('|'),
    insensitive ? 'iy' : 'y');
  return {
    startState: () => ({end: '', style: '', escapes: false}),
    token(stream, state) {
      if (!state.end) {
        for (const [start, end, style, escapes] of multiline) {
          let match;
          if (typeof start === 'string') match = stream.string.startsWith(start, stream.pos) && start;
          else { start.lastIndex = stream.pos; match = start.exec(stream.string)?.[0]; }
          if (!match) continue;
          stream.pos += match.length;
          state.end = end; state.style = style; state.escapes = escapes;
          break;
        }
      }
      if (state.end) {
        while (!stream.eol()) {
          if (stream.string.startsWith(state.end, stream.pos)) {
            stream.pos += state.end.length;
            state.end = '';
            break;
          }
          if (state.escapes && stream.next() === '\\' && !stream.eol()) stream.next();
          else if (!state.escapes) stream.next();
        }
        return state.style;
      }
      regex.lastIndex = stream.pos;
      const match = regex.exec(stream.string);
      if (!match) { if (!stream.eatWhile(/[\w$]/)) stream.next(); return null; }
      stream.pos = regex.lastIndex;
      const index = Number(Object.keys(match.groups).find((key) => match.groups[key] !== undefined).slice(1));
      return rules[index][0];
    },
  };
}

const blockComment = ['/*', '*/', 'comment', false],
  template = ['`', '`', 'string', true],
  jsMode = mode(js, [blockComment, template]),
  pythonMode = mode(python, [
    [/(?<!\w)(?:[rRbBfFuU]{0,2})"""/y, '"""', 'string', true],
    [/(?<!\w)(?:[rRbBfFuU]{0,2})'''/y, "'''", 'string', true],
  ]),
  rMode = mode(r),
  shellMode = mode(shell), jsonMode = mode(json), cssMode = mode(css, [blockComment]),
  htmlBase = mode(html, [['<!--', '-->', 'comment', false]]), yamlMode = mode(yaml),
  sqlMode = mode(sql, [blockComment], true), texMode = mode(tex),
  markdownBase = mode(markdown, [['<!--', '-->', 'comment', false]]),
  genericMode = mode(generic, [blockComment]);

function copyState(parser, state) {
  return parser.copyState ? parser.copyState(state) : {...state};
}

const htmlMode = {
  startState: () => ({base: htmlBase.startState(), opening: '', embedded: '', inner: null}),
  copyState: (state) => ({...state, base: copyState(htmlBase, state.base),
    inner: state.inner && copyState(state.embedded === 'script' ? jsMode : cssMode, state.inner)}),
  token(stream, state) {
    if (state.embedded) {
      const close = new RegExp(`</${state.embedded}\\s*>`, 'ig');
      close.lastIndex = stream.pos;
      const match = close.exec(stream.string);
      if (match?.index === stream.pos) {
        state.embedded = ''; state.inner = null;
      } else {
        const parser = state.embedded === 'script' ? jsMode : cssMode, original = stream.string;
        if (match) stream.string = original.slice(0, match.index);
        try { return parser.token(stream, state.inner); }
        finally { stream.string = original; }
      }
    }
    if (!state.base.end && state.opening) {
      if (stream.match('/>')) { state.opening = ''; return 'punctuation'; }
      if (stream.match('>')) {
        state.embedded = state.opening; state.opening = '';
        state.inner = (state.embedded === 'script' ? jsMode : cssMode).startState();
        return 'punctuation';
      }
    } else if (!state.base.end) {
      const open = stream.match(/^<(script|style)\b/i);
      if (open) {
        state.opening = open[1].toLowerCase();
        return 'tagName';
      }
    }
    return htmlBase.token(stream, state.base);
  },
};

const markdownMode = {
  startState: () => ({first: true, front: false, fence: '', length: 0,
    inner: null, innerState: null, base: markdownBase.startState()}),
  copyState: (state) => ({...state, base: copyState(markdownBase, state.base),
    innerState: state.innerState && copyState(state.inner, state.innerState)}),
  blankLine(state) {
    state.first = false;
    state.inner?.blankLine?.(state.innerState);
  },
  token(stream, state) {
    if (stream.sol()) {
      const first = state.first;
      state.first = false;
      if (!state.fence && !state.front && first && /^---[ \t]*$/.test(stream.string)) {
        state.front = true; state.inner = yamlMode; state.innerState = yamlMode.startState();
        stream.skipToEnd(); return 'punctuation';
      }
      if (state.front && /^(?:---|\.\.\.)[ \t]*$/.test(stream.string)) {
        state.front = false; state.inner = null; state.innerState = null;
        stream.skipToEnd(); return 'punctuation';
      }
      if (state.fence) {
        const close = /^[ \t]*(`+|~+)[ \t]*$/.exec(stream.string);
        if (close && close[1][0] === state.fence && close[1].length >= state.length) {
          state.fence = ''; state.inner = null; state.innerState = null;
          stream.skipToEnd(); return 'punctuation';
        }
      } else if (!state.front && !state.base.end) {
        const open = /^[ \t]*(`{3,}|~{3,})[ \t]*\{?\.?([\w+-]*)/.exec(stream.string);
        if (open) {
          state.fence = open[1][0]; state.length = open[1].length;
          state.inner = open[2] && !plain.has(open[2].toLowerCase()) ? languageMode(open[2]) : null;
          state.innerState = state.inner?.startState() || null;
          stream.skipToEnd(); return 'punctuation';
        }
      }
    }
    if (state.fence || state.front) {
      if (state.inner) return state.inner.token(stream, state.innerState);
      stream.skipToEnd(); return null;
    }
    return markdownBase.token(stream, state.base);
  },
};

const diffStyles = {header: 'comment', hunk: 'tagName', added: 'inserted', removed: 'deleted'};
const diffMode = {
  startState: () => ({inHunk: false}),
  token(stream, state) {
    const style = diffStyles[diffLineType(stream.string, state)] || null;
    stream.skipToEnd();
    return style;
  },
};

const modes = {
  js: jsMode, javascript: jsMode, mjs: jsMode, cjs: jsMode, jsx: jsMode,
  ts: jsMode, typescript: jsMode, tsx: jsMode,
  json: jsonMode, py: pythonMode, python: pythonMode, r: rMode,
  sh: shellMode, bash: shellMode, zsh: shellMode, css: cssMode,
  html: htmlMode, htm: htmlMode, xml: htmlMode, svg: htmlMode,
  yaml: yamlMode, yml: yamlMode, sql: sqlMode, tex: texMode, latex: texMode,
  md: markdownMode, markdown: markdownMode, rmd: markdownMode, qmd: markdownMode,
  diff: diffMode, patch: diffMode,
};
const plain = new Set(['text', 'plain', 'txt', 'output', 'none', 'pele']);

export function languageMode(name) {
  name = name.toLowerCase();
  return Object.hasOwn(modes, name) ? modes[name] : genericMode;
}
