import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupWidget, type SetupWidgetPorts } from '../src/commands/setupWidget.js'
import { CliError } from '../src/lib/errors.js'

const SECURITY_KEY = 'super-secret-widget-key-XYZZY'

const EMBED = `
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
`

const WIDGET = {
  id: 'wid-abc123',
  snippetId: 'QVlCQyE9PQ==',
  scriptUrl: 'https://my-alias.my.connect.aws/connectwidget/static/widget.js',
}

interface FakeState {
  events: string[]
  /** Secrets actually written, so a test can assert none were. */
  written: Array<{ name: string; value: string }>
}

let projectDir: string
let skillRoot: string
let embedFile: string
let stdout: string[]
let stderr: string[]

/** Ports whose cdk deploy writes cdk-outputs.json like the real
 *  `--outputs-file` does, unless overridden. */
function ports(over: Partial<{
  deployStackExclusively: (projectDir: string, stackName: string) => void
  put: (name: string, value: string) => Promise<void>
}> = {}): SetupWidgetPorts & FakeState {
  const events: string[] = []
  const written: FakeState['written'] = []
  return {
    events,
    written,
    toolchain: {
      deployStackExclusively(dir, stackName) {
        events.push(`deploy:${dir}:${stackName}`)
        if (over.deployStackExclusively) {
          over.deployStackExclusively(dir, stackName)
          return
        }
        writeFileSync(join(dir, 'cdk-outputs.json'), JSON.stringify({
          [stackName]: { CloudFrontUrl: 'https://dfresh.cloudfront.net' },
        }))
      },
    },
    secrets: {
      async put(name, value) {
        events.push(`secret:${name}`)
        if (over.put) return over.put(name, value)
        written.push({ name, value })
      },
    },
  }
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'csp-widget-proj-'))
  skillRoot = mkdtempSync(join(tmpdir(), 'csp-widget-root-'))
  mkdirSync(join(projectDir, 'lib'))
  writeFileSync(join(projectDir, 'lib', 'deployment-values.json'), JSON.stringify({
    prefix: 'proj',
    connectInstanceAlias: 'proj-alias',
    connectWidgets: [],
  }, null, 2) + '\n')
  writeFileSync(join(projectDir, '.connect-skill-values.json'), JSON.stringify({
    projectName: 'proj',
    connectWidgets: [{ id: 'stale-old', snippetId: 'OLD', scriptUrl: 'https://old' }],
  }, null, 2) + '\n')
  embedFile = join(projectDir, 'embed.txt')
  writeFileSync(embedFile, EMBED)
  stdout = []
  stderr = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { stdout.push(a.join(' ')) })
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { stderr.push(a.join(' ')) })
})
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true })
  rmSync(skillRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>

describe('setupWidget validation', () => {
  it('rejects an unsupported region verbatim (checked before anything else)', async () => {
    const deps = ports()
    await expect(setupWidget(projectDir, embedFile, SECURITY_KEY, 'ap-south-1', deps, skillRoot))
      .rejects.toThrow(new CliError(
        "unsupported region 'ap-south-1' (pass it as the 4th arg: us-east-1 or eu-central-1)"))
    expect(deps.events).toEqual([])
  })

  it('fails verbatim when deployment-values.json is missing', async () => {
    rmSync(join(projectDir, 'lib', 'deployment-values.json'))
    const path = join(projectDir, 'lib', 'deployment-values.json')
    await expect(setupWidget(projectDir, embedFile, SECURITY_KEY, 'us-east-1', ports(), skillRoot))
      .rejects.toThrow(new CliError(
        `deployment-values.json not found at ${path} (is <project-dir> a rendered project?)`))
  })

  it('fails verbatim when the embed file is missing', async () => {
    const missing = join(projectDir, 'nope.txt')
    await expect(setupWidget(projectDir, missing, SECURITY_KEY, 'us-east-1', ports(), skillRoot))
      .rejects.toThrow(new CliError(`embed file not found: ${missing}`))
  })

  it('fails verbatim when the security key is empty', async () => {
    await expect(setupWidget(projectDir, embedFile, '', 'us-east-1', ports(), skillRoot))
      .rejects.toThrow(new CliError('security key is empty'))
  })

  it('fails verbatim when deployment-values.json has no prefix', async () => {
    writeFileSync(join(projectDir, 'lib', 'deployment-values.json'), '{}\n')
    const deps = ports()
    await expect(setupWidget(projectDir, embedFile, SECURITY_KEY, 'us-east-1', deps, skillRoot))
      .rejects.toThrow(new CliError(
        'deployment-values.json has an empty prefix — render the project first'))
    expect(deps.events).toEqual([])
  })
})

describe('setupWidget region validation', () => {
  // Region PRECEDENCE lives in resolveRegionFrom (11 cases in
  // shared.test.ts). What belongs here is that the command refuses a
  // region it cannot deploy to, whatever resolved it.
  it('rejects an unsupported region verbatim, before touching anything', async () => {
    const p = ports()
    await expect(setupWidget(projectDir, embedFile, SECURITY_KEY, 'ca-central-1', p, skillRoot))
      .rejects.toThrow(new CliError(
        "unsupported region 'ca-central-1' (pass it as the 4th arg: us-east-1 or eu-central-1)"))
    expect(p.events).toEqual([])
  })

  it('names the region it is deploying to', async () => {
    await setupWidget(projectDir, embedFile, SECURITY_KEY, 'eu-central-1', ports(), skillRoot)
    expect(stdout.map(strip)).toContain(
      '→ Deploying proj-WebcallWidget stack in eu-central-1 (this can take a few minutes)...')
  })
})

describe('setupWidget happy path', () => {
  it('patches, persists, deploys, stores the secret, then prints the summary — in order', async () => {
    const deps = ports()
    // Stale outputs from the original full deploy — must be refreshed after the
    // widget deploy before the CloudFront URL is reported.
    writeFileSync(join(projectDir, 'cdk-outputs.json'), JSON.stringify({
      'proj-WebcallWidget': { CloudFrontUrl: 'https://dstale.cloudfront.net' },
    }))

    await setupWidget(projectDir, embedFile, SECURITY_KEY, 'us-east-1', deps, skillRoot)

    // deploy before secret, exactly once each
    expect(deps.events).toEqual(['deploy:' + projectDir + ':proj-WebcallWidget', 'secret:proj-widget-secret-wid-abc123'])
    expect(deps.written).toEqual([{ name: 'proj-widget-secret-wid-abc123', value: SECURITY_KEY }])

    // deployment-values.json patched via upsert (other keys preserved)
    const dv = readJson(join(projectDir, 'lib', 'deployment-values.json'))
    expect(dv.prefix).toBe('proj')
    expect(dv.connectInstanceAlias).toBe('proj-alias')
    expect(dv.connectWidgets).toEqual([WIDGET])
    // jq-compatible serialization: 2-space indent + trailing newline
    const rawDv = readFileSync(join(projectDir, 'lib', 'deployment-values.json'), 'utf8')
    expect(rawDv).toBe(JSON.stringify(dv, null, 2) + '\n')

    // .connect-skill-values.json: connectWidgets REPLACED wholesale (stale entry gone)
    const sv = readJson(join(projectDir, '.connect-skill-values.json'))
    expect(sv.projectName).toBe('proj')
    expect(sv.connectWidgets).toEqual([WIDGET])
    const rawSv = readFileSync(join(projectDir, '.connect-skill-values.json'), 'utf8')
    expect(rawSv).toBe(JSON.stringify(sv, null, 2) + '\n')

    // message order + verbatim text, with the refreshed CloudFront URL
    expect(stdout.map(strip)).toEqual([
      '→ Extracting widget fields and patching deployment-values.json...',
      '✓ Widget wid-abc123 extracted; deployment-values.json patched (prefix: proj)',
      '✓ Widget persisted to .connect-skill-values.json (survives re-render)',
      '→ Deploying proj-WebcallWidget stack in us-east-1 (this can take a few minutes)...',
      '✓ Widget stack deployed',
      '→ Storing security key in Secrets Manager secret: proj-widget-secret-wid-abc123',
      '✓ Security key stored',
      '',
      '==========================================',
      'Web-call widget configured',
      '==========================================',
      'Web-call site:  https://dfresh.cloudfront.net',
      'Widget ID:      wid-abc123',
      'Secret:         proj-widget-secret-wid-abc123',
      '',
      '✓ Done. Create a Cognito login for the user pool, then open the site and click to call.',
      '  (No login yet? Add one in the Cognito console for the proj-webcall-users pool.)',
    ])
    expect(stderr).toEqual([])
  })

  it('replaces an existing entry with the same id in deployment-values.json (idempotent)', async () => {
    writeFileSync(join(projectDir, 'lib', 'deployment-values.json'), JSON.stringify({
      prefix: 'proj',
      connectWidgets: [
        { id: 'wid-abc123', snippetId: 'STALE', scriptUrl: 'https://stale' },
        { id: 'wid-other', snippetId: 'KEEP', scriptUrl: 'https://keep' },
      ],
    }) + '\n')
    await setupWidget(projectDir, embedFile, SECURITY_KEY, 'us-east-1', ports(), skillRoot)
    const dv = readJson(join(projectDir, 'lib', 'deployment-values.json'))
    expect(dv.connectWidgets).toEqual([
      WIDGET,
      { id: 'wid-other', snippetId: 'KEEP', scriptUrl: 'https://keep' },
    ])
  })

  it('omits the Web-call site line when the refreshed outputs lack the CloudFront URL', async () => {
    const deps = ports({
      deployStackExclusively(dir, stackName) {
        writeFileSync(join(dir, 'cdk-outputs.json'), JSON.stringify({ [stackName]: {} }))
      },
    })
    await setupWidget(projectDir, embedFile, SECURITY_KEY, 'us-east-1', deps, skillRoot)
    const clean = stdout.map(strip)
    expect(clean).not.toContainEqual(expect.stringContaining('Web-call site:'))
    expect(clean).toContain('Widget ID:      wid-abc123')
  })

  it('tolerates a missing cdk-outputs.json after deploy (no URL line, no crash)', async () => {
    const deps = ports({ deployStackExclusively() { /* writes no outputs file */ } })
    await setupWidget(projectDir, embedFile, SECURITY_KEY, 'us-east-1', deps, skillRoot)
    expect(stdout.map(strip)).not.toContainEqual(expect.stringContaining('Web-call site:'))
    expect(stdout.map(strip)).toContain('Secret:         proj-widget-secret-wid-abc123')
  })
})

describe('setupWidget persistence fallback', () => {
  it('falls back to the repo-root .connect-skill-values.json (legacy layout)', async () => {
    rmSync(join(projectDir, '.connect-skill-values.json'))
    writeFileSync(join(skillRoot, '.connect-skill-values.json'),
      JSON.stringify({ projectName: 'legacy' }) + '\n')
    await setupWidget(projectDir, embedFile, SECURITY_KEY, 'us-east-1', ports(), skillRoot)
    const sv = readJson(join(skillRoot, '.connect-skill-values.json'))
    expect(sv.connectWidgets).toEqual([WIDGET])
    expect(sv.projectName).toBe('legacy')
    expect(stdout.map(strip)).toContain(
      '✓ Widget persisted to .connect-skill-values.json (survives re-render)')
  })

  it('warns on stderr and continues when no values file exists anywhere', async () => {
    rmSync(join(projectDir, '.connect-skill-values.json'))
    const deps = ports()
    await setupWidget(projectDir, embedFile, SECURITY_KEY, 'us-east-1', deps, skillRoot)
    expect(stderr.map(strip)).toEqual([
      '⚠ Could not find .connect-skill-values.json to persist widget — re-render will lose it'])
    expect(existsSync(join(projectDir, '.connect-skill-values.json'))).toBe(false)
    expect(existsSync(join(skillRoot, '.connect-skill-values.json'))).toBe(false)
    // still deploys + stores the secret
    expect(deps.events).toEqual(['deploy:' + projectDir + ':proj-WebcallWidget', 'secret:proj-widget-secret-wid-abc123'])
  })
})

describe('setupWidget failure wrapping', () => {
  it('wraps a deploy failure verbatim and never reaches the secret', async () => {
    const deps = ports({ deployStackExclusively() { throw new Error('boom from cdk') } })
    await expect(setupWidget(projectDir, embedFile, SECURITY_KEY, 'us-east-1', deps, skillRoot))
      .rejects.toThrow(new CliError('cdk deploy of proj-WebcallWidget failed'))
    expect(deps.written).toEqual([])
  })

  it('wraps a PutSecretValue failure verbatim', async () => {
    const deps = ports({ async put() { throw new Error('AccessDenied') } })
    await expect(setupWidget(projectDir, embedFile, SECURITY_KEY, 'us-east-1', deps, skillRoot))
      .rejects.toThrow(new CliError(
        'failed to write security key to secret proj-widget-secret-wid-abc123'))
  })
})

describe('setupWidget secret safety', () => {
  it('never prints the security key on stdout or stderr (happy path)', async () => {
    rmSync(join(projectDir, '.connect-skill-values.json')) // also exercise the warn path
    await setupWidget(projectDir, embedFile, SECURITY_KEY, 'us-east-1', ports(), skillRoot)
    for (const line of [...stdout, ...stderr]) expect(line).not.toContain(SECURITY_KEY)
  })

  it('never includes the security key in error messages (secret write failure)', async () => {
    const deps = ports({ async put() { throw new Error(`refused ${SECURITY_KEY}`) } })
    const err = await setupWidget(projectDir, embedFile, SECURITY_KEY, 'us-east-1', deps, skillRoot)
      .catch((e: unknown) => e as Error)
    expect((err as Error).message).not.toContain(SECURITY_KEY)
    for (const line of [...stdout, ...stderr]) expect(line).not.toContain(SECURITY_KEY)
  })

  it('does not persist the security key into either JSON file', async () => {
    await setupWidget(projectDir, embedFile, SECURITY_KEY, 'us-east-1', ports(), skillRoot)
    expect(readFileSync(join(projectDir, 'lib', 'deployment-values.json'), 'utf8'))
      .not.toContain(SECURITY_KEY)
    expect(readFileSync(join(projectDir, '.connect-skill-values.json'), 'utf8'))
      .not.toContain(SECURITY_KEY)
  })
})
