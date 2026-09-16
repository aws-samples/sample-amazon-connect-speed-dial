import { CliError } from '../lib/errors.js';

export interface WidgetEntry {
  id: string;
  snippetId: string;
  scriptUrl: string;
}

/**
 * Extract the three widget fields from the embed snippet.
 *
 * The embed code looks like:
 *   s.src='https://<alias>.my.connect.aws/connectwidget/static/...js';
 *   })(window, document, 'amazon_connect', '<widget-id>');
 *   amazon_connect('snippetId', '<base64>');
 *
 * Connect's snippet format has been stable: the script src, the 4th IIFE arg,
 * and the snippetId call. We match each independently so reordering or extra
 * amazon_connect(...) calls (styles, supportedMessagingContentTypes) don't matter.
 *
 * Throws CliError listing the exact field descriptions if any are missing.
 */
export function extractWidget(embed: string): WidgetEntry {
  const scriptUrl = (embed.match(/\.src\s*=\s*['"]([^'"]+)['"]/) || [])[1];
  const id = (embed.match(/['"]amazon_connect['"]\s*,\s*['"]([^'"]+)['"]/) || [])[1];
  const snippetId = (embed.match(/amazon_connect\(\s*['"]snippetId['"]\s*,\s*['"]([^'"]+)['"]/) || [])[1];

  const missing = [];
  if (!id) missing.push('id (4th argument to the embed IIFE)');
  if (!snippetId) missing.push("snippetId (amazon_connect('snippetId', '...') call)");
  if (!scriptUrl) missing.push('scriptUrl (the script src URL)');

  if (missing.length) {
    throw new CliError(
      'could not extract from embed snippet:\n  - ' +
        missing.join('\n  - ') +
        '\nMake sure you pasted the full <script> embed block from the Connect console.',
    );
  }

  return { id, snippetId, scriptUrl };
}

/**
 * Upsert a widget entry into the connectWidgets array of a deployment-values object.
 *
 * - If the array exists and already has an entry with the same id, replace it.
 * - If the array doesn't exist or the id is new, append the entry.
 * - Returns a NEW object; the input is not mutated.
 * - Does NOT validate or touch the prefix.
 */
export function upsertWidget(
  values: Record<string, unknown>,
  w: WidgetEntry,
): Record<string, unknown> {
  // Create a shallow copy of the input object
  const result = { ...values };

  // Get the existing widgets array or create a new one
  const widgets = Array.isArray(result.connectWidgets)
    ? (result.connectWidgets as WidgetEntry[]).slice()
    : [];

  // Find existing entry with same id
  const existing = widgets.findIndex((entry) => entry && entry.id === w.id);

  if (existing >= 0) {
    // Replace existing entry
    widgets[existing] = w;
  } else {
    // Append new entry
    widgets.push(w);
  }

  result.connectWidgets = widgets;
  return result;
}
