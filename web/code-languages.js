import {StreamLanguage, syntaxHighlighting, HighlightStyle} from '@codemirror/language';
import {tags} from '@lezer/highlight';

const plain = new Set(['txt', 'text', 'plain', 'output', 'none', 'pele']);
const languages = new Map(), xcode = HighlightStyle.define([
  {tag: tags.comment, color: '#6e7781', fontStyle: 'italic'},
  {tag: tags.punctuation, color: '#999'},
  {tag: tags.tagName, color: '#aa0d91'},
  {tag: [tags.bool, tags.number, tags.null], color: '#1c00cf'},
  {tag: [tags.propertyName, tags.attributeName, tags.string, tags.standard(tags.variableName)], color: '#c41a16'},
  {tag: [tags.operator, tags.special(tags.string), tags.link], color: '#9a6e3a'},
  {tag: [tags.meta, tags.attributeValue, tags.keyword], color: '#836c28'},
  {tag: [tags.function(tags.variableName), tags.className], color: '#d35400'},
  {tag: [tags.regexp, tags.special(tags.variableName)], color: '#5c2699'},
  {tag: tags.heading, color: '#5c2699', fontWeight: 'bold'},
  {tag: tags.strong, fontWeight: 'bold'},
  {tag: tags.emphasis, fontStyle: 'italic'},
  {tag: tags.inserted, backgroundColor: '#ccffd8'},
  {tag: tags.deleted, backgroundColor: '#ffebe9'},
]);

export async function codeLanguage(path) {
  const name = path.split('/').pop(), dot = name.lastIndexOf('.'),
    extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (plain.has(extension)) return [];
  const {languageMode} = await import('./code-modes.js'), mode = languageMode(extension || 'unknown');
  if (!languages.has(mode)) languages.set(mode, StreamLanguage.define(mode));
  return [languages.get(mode), syntaxHighlighting(xcode)];
}
