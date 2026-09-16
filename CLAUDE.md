# CLAUDE.md

## TypeScript Standards
- Target: ES2022, strict mode enabled
- Runtime: Node.js 22 / browser (specify per file if mixed)
- Formatter: Prettier 3.x, tab width 2
- Linter: ESLint with @typescript-eslint/recommended-type-checked

## Type Conventions
- Prefer `interface` for object shapes that will be extended
- Use `type` for unions, intersections, mapped types
- Never use `any` — use `unknown` and narrow, or `never` for exhaustive checks
- Export types alongside implementations, not in separate files

See **[AGENTS.md](AGENTS.md)** for the canonical project guidance (what this repo is, the
template → render → deploy model, the golden rule about editing `templates/cdk-app/` rather than
rendered project dirs, placeholder conventions, capabilities, and validation).

`AGENTS.md` is the single source of truth; this file only points to it to avoid drift.
