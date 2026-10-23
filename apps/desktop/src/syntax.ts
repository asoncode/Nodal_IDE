import type * as Monaco from 'monaco-editor';
import { language as typescript } from 'monaco-editor/languages/definitions/typescript/typescript.js';
import { language as javascript } from 'monaco-editor/languages/definitions/javascript/javascript.js';
import { language as python } from 'monaco-editor/languages/definitions/python/python.js';
import { language as rust } from 'monaco-editor/languages/definitions/rust/rust.js';
import { language as go } from 'monaco-editor/languages/definitions/go/go.js';
import { language as java } from 'monaco-editor/languages/definitions/java/java.js';
import { language as cpp } from 'monaco-editor/languages/definitions/cpp/cpp.js';
import { language as csharp } from 'monaco-editor/languages/definitions/csharp/csharp.js';

// Ink & gold syntax: one muted family around the app's gold. Every hue sits at a similar
// lightness so no token class shouts; comments recede, punctuation stays quiet.
const palette = {
  text: 'd2d1cc', comment: '55555c', punctuation: '7a7a82', operator: '9d9aac',
  keyword: 'ab96e6', function: 'e7c66f', type: '7fb2d6', string: 'a8c47e', number: 'e0956a', key: 'f4f2ec',
};

export const nodalTheme: Monaco.editor.IStandaloneThemeData = {
  base: 'vs-dark', inherit: true,
  rules: [
    { token: '', foreground: palette.text },
    { token: 'comment', foreground: palette.comment, fontStyle: 'italic' },
    { token: 'keyword', foreground: palette.keyword }, { token: 'typeof', foreground: palette.keyword },
    { token: 'function', foreground: palette.function },
    { token: 'type', foreground: palette.type }, { token: 'keyword.type', foreground: palette.type }, { token: 'namespace', foreground: palette.type }, { token: 'typedef', foreground: palette.type },
    { token: 'string', foreground: palette.string }, { token: 'string.escape', foreground: palette.number },
    { token: 'number', foreground: palette.number }, { token: 'constant', foreground: palette.number }, { token: 'regexp', foreground: palette.number },
    { token: 'macro', foreground: palette.number }, { token: 'annotation', foreground: palette.number }, { token: 'keyword.directive', foreground: palette.number },
    { token: 'tag', foreground: palette.keyword }, { token: 'metatag', foreground: palette.keyword },
    { token: 'attribute.name', foreground: palette.function }, { token: 'attribute.value', foreground: palette.string },
    { token: 'string.key.json', foreground: palette.key }, { token: 'string.value.json', foreground: palette.string }, { token: 'keyword.json', foreground: palette.keyword },
    { token: 'identifier', foreground: palette.text }, { token: 'variable', foreground: palette.text },
    { token: 'delimiter', foreground: palette.punctuation }, { token: 'operator', foreground: palette.operator },
  ],
  colors: {
    'editor.background': '#101012', 'editor.foreground': `#${palette.text}`, 'editor.lineHighlightBackground': '#141417', 'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': '#36363c', 'editorLineNumber.activeForeground': '#d9b45b', 'editorCursor.foreground': '#d9b45b',
    'editor.selectionBackground': '#d9b45b33', 'editor.inactiveSelectionBackground': '#d9b45b1a', 'editor.findMatchBackground': '#d9b45b55', 'editor.findMatchHighlightBackground': '#d9b45b22',
    'editor.wordHighlightBackground': '#d9b45b14', 'editor.wordHighlightStrongBackground': '#d9b45b1f', 'editor.selectionHighlightBackground': '#d9b45b14',
    'editorIndentGuide.background1': '#1b1b1f', 'editorIndentGuide.activeBackground1': '#34343b',
    'editorBracketMatch.background': '#d9b45b1f', 'editorBracketMatch.border': '#d9b45b66',
    'editorBracketHighlight.foreground1': `#${palette.function}`, 'editorBracketHighlight.foreground2': `#${palette.keyword}`, 'editorBracketHighlight.foreground3': `#${palette.type}`,
    'editorWidget.background': '#17171a', 'editorWidget.border': '#28282e', 'input.background': '#121215', 'focusBorder': '#d9b45b', 'editorGutter.background': '#101012',
    'scrollbarSlider.background': '#ffffff10', 'scrollbarSlider.hoverBackground': '#ffffff1c',
    'diffEditor.insertedTextBackground': '#a8c47e1f', 'diffEditor.removedTextBackground': '#f0665f22',
  },
};

// Monarch tokenizers do not mark function names, so calls and definitions would render as plain
// identifiers. Tag a lowercase identifier followed by "(" as a function, still letting keywords win.
const functionCall: Monaco.languages.IMonarchLanguageRule = [/[a-z_$][\w$]*(?=\s*\()/, { cases: { '@keywords': 'keyword', '@default': 'function' } }];
const withFunctionCalls = (language: Monaco.languages.IMonarchLanguage, state: string): Monaco.languages.IMonarchLanguage => ({
  ...language, tokenizer: { ...language.tokenizer, [state]: [functionCall, ...language.tokenizer[state]] },
});

export function installNodalSyntax(monaco: typeof Monaco) {
  monaco.editor.defineTheme('nodal', nodalTheme);
  const languages: [string, Monaco.languages.IMonarchLanguage, string][] = [
    ['typescript', typescript, 'common'], ['javascript', javascript, 'common'], ['python', python, 'root'], ['rust', rust, 'root'],
    ['go', go, 'root'], ['java', java, 'root'], ['cpp', cpp, 'root'], ['c', cpp, 'root'], ['csharp', csharp, 'root'],
  ];
  // An explicitly set provider takes precedence over Monaco's lazily loaded default for the language.
  for (const [id, language, state] of languages) monaco.languages.setMonarchTokensProvider(id, withFunctionCalls(language, state));
}
