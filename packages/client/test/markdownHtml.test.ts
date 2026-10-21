import { describe, expect, it } from 'vitest';
import { markdownHtml } from '../src/lib/markdownHtml';

describe('a reply as HTML for the clipboard', () => {
  it('keeps bold, italics, lists, inline code and links', () => {
    const html = markdownHtml('**Fix** the _build_:\n\n- run `npm ci`\n- see [the MR](https://gitlab.example/mr/1)\n\n1. one\n2. two');
    expect(html).toContain('<strong>Fix</strong>');
    expect(html).toContain('<em>build</em>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>run <code>npm ci</code></li>');
    expect(html).toContain('<a href="https://gitlab.example/mr/1">the MR</a>');
    expect(html).toContain('<ol>');
  });

  it('renders GFM tables, code blocks and headings', () => {
    const html = markdownHtml('## Plan\n\n| field | where |\n|---|---|\n| agent_id | hooks |\n\n```ts\nconst a = 1 < 2;\n```');
    expect(html).toContain('<h2>Plan</h2>');
    expect(html).toMatch(/<table>[\s\S]*<th>field<\/th>[\s\S]*<td>agent_id<\/td>[\s\S]*<\/table>/);
    expect(html).toContain('<pre><code class="language-ts">const a = 1 &lt; 2;\n</code></pre>');
  });

  it('raw HTML in the reply stays text, as in the transcript', () => {
    const html = markdownHtml('use <script>alert(1)</script> carefully');
    expect(html).not.toContain('<script>');
    expect(html).toContain('carefully');
  });

  it('has none of the transcript chrome (copy buttons on code blocks)', () => {
    const html = markdownHtml('```\nls\n```');
    expect(html).not.toContain('button');
    expect(html).not.toContain('codeblock');
  });
});
