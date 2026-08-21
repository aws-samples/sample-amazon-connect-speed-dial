import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPreflight, type PreflightPorts } from '../src/commands/preflight.js'

function ports(over: Partial<PreflightPorts> = {}): PreflightPorts {
  return {
    identity: {
      accountId: async () => '123456789012',
      accountIdOrNull: async () => '123456789012',
    },
    stacks: { exists: async () => true },
    models: { accessible: async () => true },
    sso: { visible: async () => true },
    toolchain: {
      cdkAvailable: async () => true,
      bootstrap: async () => { throw new Error('bootstrap must not run unless requested') },
    },
    ...over,
  }
}

describe('runPreflight', () => {
  it('passes on a healthy account', async () => {
    const r = await runPreflight({ region: 'us-east-1', bootstrap: false }, ports())
    expect(r.account).toBe('123456789012')
  })

  it('rejects an unsupported region', async () => {
    await expect(runPreflight({ region: 'eu-west-1', bootstrap: false }, ports()))
      .rejects.toThrow("unsupported region 'eu-west-1' (use us-east-1 or eu-central-1)")
  })

  it('fails without credentials', async () => {
    await expect(runPreflight({ region: 'us-east-1', bootstrap: false },
      ports({ identity: { accountId: async () => '', accountIdOrNull: async () => null } })))
      .rejects.toThrow("AWS credentials not configured. Run 'aws configure' or set AWS_PROFILE.")
  })

  it('fails when CDK is not installed, with the install guidance', async () => {
    await expect(runPreflight({ region: 'us-east-1', bootstrap: false },
      ports({ toolchain: { cdkAvailable: async () => false, bootstrap: async () => {} } })))
      .rejects.toThrow("CDK not installed. Run 'npm install -g aws-cdk@2.1135.0' or 'npm install'.")
  })

  it('probes bootstrap state through the shared Stacks port, by stack name', async () => {
    // Was a second, private DescribeStacks adapter; teardown already had one.
    const asked: string[] = []
    await runPreflight({ region: 'eu-central-1', bootstrap: false },
      ports({ stacks: { exists: async (n) => { asked.push(n); return true } } }))
    expect(asked).toEqual(['CDKToolkit'])
  })

  it('fails when not bootstrapped and --bootstrap is absent', async () => {
    await expect(runPreflight({ region: 'us-east-1', bootstrap: false },
      ports({ stacks: { exists: async () => false } })))
      .rejects.toThrow('CDKToolkit stack not found in us-east-1 — rerun with --bootstrap to bootstrap it')
  })

  it('bootstraps the resolved account when --bootstrap is present', async () => {
    let bootstrapped = ''
    await runPreflight({ region: 'us-east-1', bootstrap: true }, ports({
      stacks: { exists: async () => false },
      toolchain: { cdkAvailable: async () => true, bootstrap: async (a) => { bootstrapped = a } },
    }))
    expect(bootstrapped).toBe('123456789012')
  })

  it('fails when the Bedrock model is inaccessible, with the console link', async () => {
    await expect(runPreflight({ region: 'us-east-1', bootstrap: false },
      ports({ models: { accessible: async () => false } })))
      .rejects.toThrow('Bedrock model amazon.nova-pro-v1:0 not accessible')
  })

  it('surfaces an unexpected model-check failure instead of reporting "not accessible"', async () => {
    // A network or credential failure is not the same finding as "enable model
    // access in the console", and must not be reported as one.
    await expect(runPreflight({ region: 'us-east-1', bootstrap: false },
      ports({ models: { accessible: async () => { throw new Error('ThrottlingException') } } })))
      .rejects.toThrow('ThrottlingException')
  })

  describe('Identity Center gate', () => {
    function idcOrder(withSaml: boolean, samlContent = '<EntityDescriptor>x</EntityDescriptor>'): string {
      const dir = mkdtempSync(join(tmpdir(), 'csp-pf-'))
      const orderFile = join(dir, 'order.json')
      writeFileSync(orderFile, JSON.stringify({ projectName: 'p', identityCenterEnabled: true }))
      if (withSaml) writeFileSync(join(dir, 'saml-metadata.xml'), samlContent)
      return orderFile
    }

    it('fails when identityCenterEnabled and saml-metadata.xml is missing', async () => {
      await expect(runPreflight(
        { region: 'us-east-1', orderFile: idcOrder(false), bootstrap: false }, ports()))
        .rejects.toThrow('saml-metadata.xml not found')
    })

    it('fails when the file is not SAML metadata', async () => {
      await expect(runPreflight(
        { region: 'us-east-1', orderFile: idcOrder(true, 'not xml'), bootstrap: false }, ports()))
        .rejects.toThrow('does not look like SAML metadata')
    })

    it('only warns when no Identity Center instance is visible', async () => {
      const r = await runPreflight(
        { region: 'us-east-1', orderFile: idcOrder(true), bootstrap: false },
        ports({ sso: { visible: async () => false } }))
      expect(r.warnings.some((w) => w.includes('No Identity Center instance visible'))).toBe(true)
    })
  })
})
