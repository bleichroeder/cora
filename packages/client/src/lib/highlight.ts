import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import xml from 'highlight.js/lib/languages/xml';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import powershell from 'highlight.js/lib/languages/powershell';
import yaml from 'highlight.js/lib/languages/yaml';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import csharp from 'highlight.js/lib/languages/csharp';
import java from 'highlight.js/lib/languages/java';
import sql from 'highlight.js/lib/languages/sql';

for (const [n, l] of Object.entries({ typescript, javascript, css, json, markdown, xml, python, bash, powershell, yaml, go, rust, csharp, java, sql })) hljs.registerLanguage(n, l);

const BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  css: 'css', scss: 'css', json: 'json', jsonl: 'json', md: 'markdown', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  py: 'python', sh: 'bash', bash: 'bash', ps1: 'powershell', psm1: 'powershell', yml: 'yaml', yaml: 'yaml', go: 'go', rs: 'rust', cs: 'csharp', java: 'java', sql: 'sql',
};
export const langOf = (path: string) => BY_EXT[path.split('.').pop()?.toLowerCase() ?? ''] ?? null;

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/** Highlighted HTML for a piece of code (one line, or part of one); plain escaped text when the language isn't known. */
export function highlight(code: string, lang: string | null): string {
  if (!lang || !code) return esc(code);
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return esc(code);
  }
}
