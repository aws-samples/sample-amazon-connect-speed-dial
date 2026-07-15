#!/usr/bin/env node
'use strict';

/**
 * extract-widget.js — parse a pasted Amazon Connect communication-widget embed
 * snippet and patch `config.connectWidgets` in a rendered project's lib/config.ts.
 *
 * Usage:
 *   node extract-widget.js --config <path/to/lib/config.ts> --embed <path/to/embed.txt>
 *
 * Prints a JSON object to stdout describing what it extracted and the project
 * prefix (read from config.ts), so the calling shell script can derive the
 * Secrets Manager secret name and run the redeploy:
 *
 *   {"id":"...","snippetId":"...","scriptUrl":"...","prefix":"..."}
 *
 * The script is idempotent: re-running with the same widget replaces the existing
 * connectWidgets array rather than appending a duplicate.
 */

const fs = require('fs');

function die(msg) {
  process.stderr.write(`extract-widget: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--config') out.config = val;
    else if (key === '--embed') out.embed = val;
    else die(`unknown argument: ${key}`);
  }
  if (!out.config) die('missing --config <path to lib/config.ts>');
  if (!out.embed) die('missing --embed <path to embed snippet file>');
  return out;
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
 */
function extractWidget(embed) {
  const scriptUrl = (embed.match(/\.src\s*=\s*['"]([^'"]+)['"]/) || [])[1];
  const id = (embed.match(/['"]amazon_connect['"]\s*,\s*['"]([^'"]+)['"]/) || [])[1];
  const snippetId = (embed.match(/amazon_connect\(\s*['"]snippetId['"]\s*,\s*['"]([^'"]+)['"]/) || [])[1];

  const missing = [];
  if (!id) missing.push('id (4th argument to the embed IIFE)');
  if (!snippetId) missing.push("snippetId (amazon_connect('snippetId', '...') call)");
  if (!scriptUrl) missing.push('scriptUrl (the script src URL)');
  if (missing.length) {
    die(
      'could not extract from embed snippet:\n  - ' +
        missing.join('\n  - ') +
        '\nMake sure you pasted the full <script> embed block from the Connect console.',
    );
  }
  return { id, snippetId, scriptUrl };
}

/** Read config.prefix from config.ts so callers can name the secret. */
function readPrefix(source) {
  const m = source.match(/prefix:\s*['"]([^'"]+)['"]/);
  if (!m) die('could not read config.prefix from config.ts');
  if (m[1].includes('{{')) die('config.prefix is still an unrendered placeholder — render the project first');
  return m[1];
}

/**
 * Replace the `connectWidgets: [ ... ]` array value in config.ts.
 *
 * Locates the assignment on a non-comment line, then bracket-matches from the
 * first `[` to its closing `]`. Widget field values (UUID, base64 with the
 * +/= alphabet, https URL) never contain `[` or `]`, so naive bracket counting
 * is safe here.
 */
function patchConfig(source, widget) {
  const lines = source.split('\n');
  let assignLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('//')) continue; // skip the commented example
    // Match only the array-literal assignment (`connectWidgets: [`), not the
    // interface field declaration (`connectWidgets: ConnectWidgetConfig[]`).
    if (/\bconnectWidgets\s*:\s*\[/.test(lines[i])) {
      assignLineIdx = i;
      break;
    }
  }
  if (assignLineIdx === -1) die('could not find connectWidgets array assignment in config.ts');

  // Compute absolute offset of the assignment, then find the array brackets.
  const before = lines.slice(0, assignLineIdx).join('\n');
  const assignOffset = before.length + (assignLineIdx > 0 ? 1 : 0); // +1 for the joining newline
  const openIdx = source.indexOf('[', assignOffset);
  if (openIdx === -1) die('could not find opening [ for connectWidgets array');

  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']') {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx === -1) die('could not find closing ] for connectWidgets array');

  const newArray = [
    '[',
    `    { id: '${widget.id}', snippetId: '${widget.snippetId}', scriptUrl: '${widget.scriptUrl}' },`,
    '  ]',
  ].join('\n');

  return source.slice(0, openIdx) + newArray + source.slice(closeIdx + 1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const embed = fs.readFileSync(args.embed, 'utf8');
  const source = fs.readFileSync(args.config, 'utf8');

  const widget = extractWidget(embed);

  // Guard: widget field values must not contain a single quote (would break the
  // generated TS string literal). Connect's values never do, but fail loudly.
  for (const [k, v] of Object.entries(widget)) {
    if (v.includes("'")) die(`extracted ${k} contains a single quote — refusing to write unsafe TypeScript`);
  }

  const prefix = readPrefix(source);
  const patched = patchConfig(source, widget);
  fs.writeFileSync(args.config, patched);

  process.stdout.write(JSON.stringify({ ...widget, prefix }) + '\n');
}

main();
