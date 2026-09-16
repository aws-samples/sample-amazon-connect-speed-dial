import {
  CloudFormationClient,
  DescribeStacksCommand,
  DescribeStackResourcesCommand,
  DeleteStackCommand,
  paginateListStacks,
  waitUntilStackDeleteComplete,
} from '@aws-sdk/client-cloudformation'
import type { StackSummary, Stacks } from '../core/ports.js'

/** Poll every 30s for up to an hour — stack deletes with retained data can be slow. */
const DELETE_WAIT_SECONDS = 3600
const DELETE_POLL_SECONDS = 30

/** CloudFormation reports a missing stack as a ValidationError rather than an
 *  empty result, so "absent" has to be recognised by message. Every other
 *  failure propagates — losing an AccessDenied here would report a stack that
 *  exists as missing. */
const isAbsent = (err: unknown): boolean =>
  err instanceof Error && /does not exist/i.test(err.message)

export function cfnStacks(region: string): Stacks {
  const cfn = new CloudFormationClient({ region })
  return {
    async exists(stackName) {
      try {
        await cfn.send(new DescribeStacksCommand({ StackName: stackName }))
        return true
      } catch (err) {
        if (isAbsent(err)) return false
        throw err
      }
    },
    async output(stackName, outputKey) {
      try {
        const r = await cfn.send(new DescribeStacksCommand({ StackName: stackName }))
        return r.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === outputKey)?.OutputValue ?? null
      } catch (err) {
        // A stack that was never deployed means the capability is absent, which
        // is a real answer. Anything else propagates.
        if (isAbsent(err)) return null
        throw err
      }
    },
    async list(prefix) {
      // Paginated: one page silently under-reported the stacks still standing,
      // which made teardown claim it was finished when it was not.
      const stacks: StackSummary[] = []
      for await (const page of paginateListStacks({ client: cfn }, {})) {
        for (const stack of page.StackSummaries ?? []) {
          if (stack.StackName?.startsWith(prefix)) {
            stacks.push({ name: stack.StackName, status: stack.StackStatus ?? '' })
          }
        }
      }
      return stacks
    },
    async deleteFailedResourceIds(stackName) {
      const r = await cfn.send(new DescribeStackResourcesCommand({ StackName: stackName }))
      return (r.StackResources ?? [])
        .filter((res) => res.ResourceStatus === 'DELETE_FAILED')
        .map((res) => res.LogicalResourceId ?? '')
        .filter(Boolean)
    },
    async delete(stackName, retainResources) {
      await cfn.send(new DeleteStackCommand({
        StackName: stackName,
        ...(retainResources.length ? { RetainResources: retainResources } : {}),
      }))
    },
    async waitDeleted(stackName) {
      await waitUntilStackDeleteComplete(
        { client: cfn, maxWaitTime: DELETE_WAIT_SECONDS, minDelay: DELETE_POLL_SECONDS },
        { StackName: stackName })
    },
  }
}
