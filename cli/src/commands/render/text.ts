/** Replace every `{{key}}` with String(value). split/join (not a regex with
 *  the value as replacement) so `$&`/`$1` in user text can't inject. This is
 *  values are single-line by validation. */
export function substitutePlaceholders(content: string, values: Record<string, unknown>): string {
  let out = content
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{{${key}}}`).join(String(value))
  }
  return out
}

/** The leftover check: grep -n '{{[a-zA-Z_]'. Runtime vars like {{$.x}} don't
 *  match (they start with `$`). Returns the offending lines for the error. */
export function findLeftoverPlaceholders(content: string): string[] {
  return content.split('\n').filter((line) => /\{\{[a-zA-Z_]/.test(line))
}

/** awk port: print the snippet's lines immediately before every line that
 *  starts with `messages:`. */
export function injectSnippetBeforeMessages(promptContent: string, snippetContent: string): string {
  const snippetLines = snippetContent.replace(/\n$/, '').split('\n')
  const out: string[] = []
  // Preserve the exact trailing-newline shape: operate on lines-with-known-end.
  const hadTrailingNewline = promptContent.endsWith('\n')
  const lines = (hadTrailingNewline ? promptContent.slice(0, -1) : promptContent).split('\n')
  for (const line of lines) {
    if (/^messages:/.test(line)) out.push(...snippetLines)
    out.push(line)
  }
  return out.join('\n') + (hadTrailingNewline ? '\n' : '')
}
