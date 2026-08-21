import {
  AppIntegrationsClient,
  ListApplicationsCommand,
  DeleteApplicationCommand,
} from '@aws-sdk/client-appintegrations'
import type { Applications } from '../core/ports.js'

export function appIntegrationsApplications(region: string): Applications {
  const appIntegrations = new AppIntegrationsClient({ region })
  return {
    async findArnsByName(name) {
      // ListApplications has no paginator helper in the SDK, so the NextToken
      // loop is hand-rolled. Reading only the first page silently left
      // applications behind during teardown.
      const arns: string[] = []
      let nextToken: string | undefined
      do {
        const r = await appIntegrations.send(new ListApplicationsCommand({ NextToken: nextToken }))
        for (const app of r.Applications ?? []) {
          if (app.Name === name && app.Arn) arns.push(app.Arn)
        }
        nextToken = r.NextToken
      } while (nextToken)
      return arns
    },
    async delete(arn) {
      await appIntegrations.send(new DeleteApplicationCommand({ Arn: arn }))
    },
  }
}
