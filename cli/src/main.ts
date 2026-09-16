// Entry point. The `csp` npm script execs this file; everything it needs lives
// in program.ts, which has no side effects so tests can import it freely.
import { runMain } from './program.js'

await runMain(process.argv)
