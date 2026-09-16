import { EventBridgeClient, DescribeRuleCommand } from '@aws-sdk/client-eventbridge'
import { CliError } from '../lib/errors.js'
import type { EventRules } from '../core/ports.js'

export function eventBridgeRules(region: string): EventRules {
  const events = new EventBridgeClient({ region })
  return {
    async state(ruleName) {
      const r = await events.send(new DescribeRuleCommand({ Name: ruleName }))
      if (!r.State) throw new CliError(`DescribeRule returned no state for rule ${ruleName}`)
      return r.State
    },
  }
}
