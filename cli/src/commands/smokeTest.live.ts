import { CliError } from '../lib/errors.js'
import { readOutputs, resolveRegion } from './shared.js'
import { idsFrom } from './smokeTest.js'
import type { SmokeTestInput } from './smokeTest.js'

// Wiring and I/O for `csp smoke-test`: resolve the region, read the outputs
// file, build the adapters, print the report, decide the exit code. The command
// itself stays pure. No top-level `@aws-sdk/*` or adapter import — main.ts
// imports this file statically, and an SDK here would land on `csp --help`.

/** Run the checks against real AWS, print the report, throw when a check failed. */
export async function smokeTestLive(input: SmokeTestInput): Promise<void> {
  const { region } = input
  const [{ smokeTest, renderReport }, connect, qconnect, eventbridge, bedrockAgent] =
    await Promise.all([
      import('./smokeTest.js'),
      import('../adapters/connect.js'),
      import('../adapters/qconnect.js'),
      import('../adapters/eventbridge.js'),
      import('../adapters/bedrockAgent.js'),
    ])

  const report = await smokeTest(input, {
    instances: connect.connectInstances(region),
    flows: connect.connectContactFlows(region),
    phoneNumbers: connect.connectPhoneNumbers(region),
    agents: qconnect.qConnectAiAgents(region),
    rules: eventbridge.eventBridgeRules(region),
    knowledgeBases: bedrockAgent.bedrockKnowledgeBases(region),
  })

  for (const line of renderReport(report)) console.log(line)
  if (!report.ok) throw new CliError('Smoke test failed')
}

/** The `csp smoke-test <project-dir>` entry point: every id comes from the
 *  deploy's own cdk-outputs.json, so a missing output names itself. */
export async function smokeTestProject(
  projectDir: string, regionArg: string | undefined, didExpected: boolean,
): Promise<void> {
  const region = resolveRegion(projectDir, regionArg)
  const outputs = readOutputs(projectDir)
  await smokeTestLive({ ...idsFrom(outputs), region, didExpected, outputs })
}
