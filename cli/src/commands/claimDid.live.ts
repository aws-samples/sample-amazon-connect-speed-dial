// Wiring for `csp claim-did`. No top-level `@aws-sdk/*` or adapter import —
// main.ts imports this statically, and an SDK here would land on `csp --help`.
export async function claimDidLive(
  instanceId: string, flowId: string, region: string,
): Promise<void> {
  const [{ claimDid, renderClaim }, sts, connect] = await Promise.all([
    import('./claimDid.js'),
    import('../adapters/sts.js'),
    import('../adapters/connect.js'),
  ])
  const report = await claimDid(instanceId, flowId, region, {
    identity: sts.stsIdentity(region),
    phoneNumbers: connect.connectPhoneNumbers(region),
  })
  for (const line of renderClaim(report)) console.log(line)
}
