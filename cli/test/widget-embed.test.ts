import { describe, it, expect } from 'vitest';
import { extractWidget, upsertWidget, WidgetEntry } from '../src/commands/widgetEmbed.js';
import { CliError } from '../src/lib/errors.js';

describe('extractWidget', () => {
  const realEmbed = `
    <script type="text/javascript">
      (function(w,d,n,c,id){
        w[n]=w[n]||{},w[n].q=[],
        s=d.createElement('script'),
        s.async=!0,s.src='https://my-alias.my.connect.aws/connectwidget/static/widget.js';
        d.head.appendChild(s);
      })(window, document, 'amazon_connect', 'wid-abc123');
      amazon_connect('snippetId', 'QVlCQyE9PQ==');
      amazon_connect('styles', {variant: 'light'});
    </script>
  `;

  it('should extract all three fields from a realistic embed snippet', () => {
    const result = extractWidget(realEmbed);
    expect(result).toEqual({
      id: 'wid-abc123',
      snippetId: 'QVlCQyE9PQ==',
      scriptUrl: 'https://my-alias.my.connect.aws/connectwidget/static/widget.js',
    });
  });

  it('should tolerate reordered and extra amazon_connect calls', () => {
    const reordered = `
      (function(w,d,n,c,id){
        s.src='https://test.my.connect.aws/connectwidget/static/widget.js';
      })(window, document, 'amazon_connect', 'wid-xyz');
      amazon_connect('styles', {});
      amazon_connect('snippetId', 'BASE64ENCODED');
      amazon_connect('supportedMessagingContentTypes', [...]);
    `;
    const result = extractWidget(reordered);
    expect(result).toEqual({
      id: 'wid-xyz',
      snippetId: 'BASE64ENCODED',
      scriptUrl: 'https://test.my.connect.aws/connectwidget/static/widget.js',
    });
  });

  it('should throw CliError if id is missing', () => {
    const missingId = `
      (function(w,d,n,c,id){
        s.src='https://x.my.connect.aws/connectwidget/static/widget.js';
      })(window, document, 'amazon_connect', '');
      amazon_connect('snippetId', 'QVlCQyE9PQ==');
    `;
    expect(() => extractWidget(missingId)).toThrow(CliError);
    // Assert the message directly: behind `if (e instanceof CliError)` these
    // assertions silently stop running if the error class ever changes.
    expect(() => extractWidget(missingId)).toThrow('could not extract from embed snippet:');
    expect(() => extractWidget(missingId)).toThrow('id (4th argument to the embed IIFE)');
  });

  it('should throw CliError if snippetId is missing', () => {
    const missingSnippetId = `
      (function(w,d,n,c,id){
        s.src='https://x.my.connect.aws/connectwidget/static/widget.js';
      })(window, document, 'amazon_connect', 'wid-123');
    `;
    expect(() => extractWidget(missingSnippetId)).toThrow(CliError);
    expect(() => extractWidget(missingSnippetId)).toThrow('could not extract from embed snippet:');
    expect(() => extractWidget(missingSnippetId))
      .toThrow("snippetId (amazon_connect('snippetId', '...') call)");
  });

  it('should throw CliError if scriptUrl is missing', () => {
    const missingUrl = `
      (function(w,d,n,c,id){
      })(window, document, 'amazon_connect', 'wid-123');
      amazon_connect('snippetId', 'QVlCQyE9PQ==');
    `;
    expect(() => extractWidget(missingUrl)).toThrow(CliError);
    expect(() => extractWidget(missingUrl)).toThrow('could not extract from embed snippet:');
    expect(() => extractWidget(missingUrl)).toThrow('scriptUrl (the script src URL)');
  });

  it('should list all three missing fields in order when all are missing', () => {
    const allMissing = `
      (function(w,d,n,c,id){
      })(window, document, 'amazon_connect', '');
    `;
    expect(() => extractWidget(allMissing)).toThrow(CliError);
    let msg = '';
    try { extractWidget(allMissing); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('could not extract from embed snippet:');
    // Each label must be PRESENT before comparing order: indexOf returns -1 for
    // an absent label, and -1 < <positive> is true — so the ordering assertions
    // alone passed even when a label had been removed or reworded, which is the
    // regression this test exists to catch.
    const idIdx = msg.indexOf('id (4th argument to the embed IIFE)');
    const snippetIdIdx = msg.indexOf("snippetId (amazon_connect('snippetId', '...') call)");
    const scriptUrlIdx = msg.indexOf('scriptUrl (the script src URL)');
    expect(idIdx).toBeGreaterThanOrEqual(0);
    expect(snippetIdIdx).toBeGreaterThanOrEqual(0);
    expect(scriptUrlIdx).toBeGreaterThanOrEqual(0);
    expect(idIdx).toBeLessThan(snippetIdIdx);
    expect(snippetIdIdx).toBeLessThan(scriptUrlIdx);
  });

  it('should include the instruction message in the error', () => {
    const allMissing = `
      (function(w,d,n,c,id){
      })(window, document, 'amazon_connect', '');
    `;
    // This assertion used to sit inside a bare try/catch with no toThrow guard:
    // if extractWidget stopped throwing, the catch never ran, ZERO assertions
    // executed, and the test still passed green.
    expect(() => extractWidget(allMissing))
      .toThrow('Make sure you pasted the full <script> embed block from the Connect console.');
  });
});

describe('upsertWidget', () => {
  it('should append a new widget to an empty array', () => {
    const values = { connectWidgets: [] as WidgetEntry[] };
    const widget: WidgetEntry = {
      id: 'wid-new',
      snippetId: 'NEW',
      scriptUrl: 'https://new.my.connect.aws/widget.js',
    };
    const result = upsertWidget(values, widget);
    expect(result.connectWidgets).toEqual([widget]);
  });

  it('should replace a widget with the same id', () => {
    const existing: WidgetEntry = {
      id: 'wid-1',
      snippetId: 'OLD',
      scriptUrl: 'https://old.my.connect.aws/widget.js',
    };
    const values = { connectWidgets: [existing] as WidgetEntry[] };
    const updated: WidgetEntry = {
      id: 'wid-1',
      snippetId: 'UPDATED',
      scriptUrl: 'https://updated.my.connect.aws/widget.js',
    };
    const result = upsertWidget(values, updated);
    expect(result.connectWidgets).toHaveLength(1);
    const widgets = result.connectWidgets as WidgetEntry[];
    expect(widgets[0]).toEqual(updated);
  });

  it('should append a new widget when id does not exist', () => {
    const existing: WidgetEntry = {
      id: 'wid-1',
      snippetId: 'OLD',
      scriptUrl: 'https://old.my.connect.aws/widget.js',
    };
    const values = { connectWidgets: [existing] as WidgetEntry[] };
    const newWidget: WidgetEntry = {
      id: 'wid-2',
      snippetId: 'NEW',
      scriptUrl: 'https://new.my.connect.aws/widget.js',
    };
    const result = upsertWidget(values, newWidget);
    expect(result.connectWidgets).toHaveLength(2);
    const widgets = result.connectWidgets as WidgetEntry[];
    expect(widgets[0]).toEqual(existing);
    expect(widgets[1]).toEqual(newWidget);
  });

  it('should create connectWidgets array if it does not exist', () => {
    const values: Record<string, unknown> = { prefix: 'my-prefix' };
    const widget: WidgetEntry = {
      id: 'wid-new',
      snippetId: 'NEW',
      scriptUrl: 'https://new.my.connect.aws/widget.js',
    };
    const result = upsertWidget(values, widget);
    expect(result.connectWidgets).toEqual([widget]);
    expect(result.prefix).toBe('my-prefix');
  });

  it('should not mutate the input object', () => {
    const values: Record<string, unknown> = { connectWidgets: [] as WidgetEntry[], prefix: 'test' };
    const originalValues = JSON.parse(JSON.stringify(values));
    const widget: WidgetEntry = {
      id: 'wid-new',
      snippetId: 'NEW',
      scriptUrl: 'https://new.my.connect.aws/widget.js',
    };
    const result = upsertWidget(values, widget);
    expect(values).toEqual(originalValues);
    expect(result).not.toBe(values);
  });

  it('should preserve other properties in values', () => {
    const values: Record<string, unknown> = {
      prefix: 'my-prefix',
      connectWidgets: [] as WidgetEntry[],
      otherProp: 'should-remain',
    };
    const widget: WidgetEntry = {
      id: 'wid-new',
      snippetId: 'NEW',
      scriptUrl: 'https://new.my.connect.aws/widget.js',
    };
    const result = upsertWidget(values, widget);
    expect(result.prefix).toBe('my-prefix');
    expect(result.otherProp).toBe('should-remain');
  });

  it('should handle multiple replaces (idempotency)', () => {
    const initial: WidgetEntry = {
      id: 'wid-1',
      snippetId: 'V1',
      scriptUrl: 'https://v1.my.connect.aws/widget.js',
    };
    const values = { connectWidgets: [initial] as WidgetEntry[] };

    const update1: WidgetEntry = {
      id: 'wid-1',
      snippetId: 'V2',
      scriptUrl: 'https://v2.my.connect.aws/widget.js',
    };
    const result1 = upsertWidget(values, update1);
    expect(result1.connectWidgets).toHaveLength(1);
    const widgets1 = result1.connectWidgets as WidgetEntry[];
    expect(widgets1[0].snippetId).toBe('V2');

    const update2: WidgetEntry = {
      id: 'wid-1',
      snippetId: 'V3',
      scriptUrl: 'https://v3.my.connect.aws/widget.js',
    };
    const result2 = upsertWidget(result1, update2);
    expect(result2.connectWidgets).toHaveLength(1);
    const widgets2 = result2.connectWidgets as WidgetEntry[];
    expect(widgets2[0].snippetId).toBe('V3');
  });
});
