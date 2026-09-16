import type { CdkOutputs } from './cdkDeploy.js'
import { stackOutput } from './cdkDeploy.js'
import type { Prefs } from '../core/prefs.js'
import { BOLD, YELLOW, NC } from '../lib/ui.js'

export function nextStepsText(a: {
  orderRaw: Record<string, unknown>; prefs: Prefs; outputs: CdkOutputs
  project: string; region: string; cwd: string; projectDir: string
  cspPath: string; locale: string
}): string {
  const parts: string[] = []
  parts.push(`\n${BOLD}=== Deployment complete — next steps ===${NC}`)
  // Always required: CDK creates only the orchestration agent's $LATEST draft.
  // Tool calling stays inert until the agent version is published from the
  // console — there is no API for this publish step.
  parts.push(`
${YELLOW}REQUIRED${NC} — publish the orchestration AI agent to activate tool calling (console step):
  The deploy created the agent's $LATEST draft only; tool calling stays inert
  until the agent version is published from the console (no settings change).
  1. Connect admin console → AI Agents → find the row for '${a.project}-orchestrator'
  2. Select it with the radio button at the LEFT of the row — do NOT click the
     agent's name, which opens a read-only view with no publish button
  3. Press 'Edit' in the list toolbar (top right, between 'Delete' and 'Create AI Agent')
  4. Press 'Save and Publish' (nothing needs changing)
  Until this is done the agent lists the MCP gateway tools but never calls them.`)

  if (a.orderRaw.frontendEnabled === true) {
    const url = stackOutput(a.outputs, '-WebcallWidget', 'CloudFrontUrl') ?? '<see WebcallWidget stack outputs>'
    parts.push(`
Web-call frontend (console steps required):
  Web-call site URL:  ${url}
  1. Connect admin console → Communication widgets → create a widget for flow '${a.project}-basic-agent-flow'
     — under allowed domains, add the site URL above (${url})
  2. Copy the FULL <script> embed snippet into a file: ${a.cwd}/widget-embed.txt
  3. Copy the widget's security key, then run:
       ${a.cspPath} setup-widget ${a.projectDir} ${a.cwd}/widget-embed.txt '<SECURITY_KEY>' ${a.region}
  4. Create a sign-in + matching Customer Profile for a test user:
       ${a.cspPath} setup-test-users ${a.projectDir} --user <user> --first <First> --last <Last> \\
         --email <email> --phone <+E164> --customer-number 0000100042 --locale ${a.locale}
     (customer number 0000100042 ties the user to the seeded sample orders)
  5. Open ${url} and sign in to place a call.`)
  }

  if (a.orderRaw.identityCenterEnabled === true) {
    parts.push(`
Identity Center SSO (finish in the console — values from the stack outputs):
  Relay state:        ${stackOutput(a.outputs, '-ConnectInstance', 'SamlRelayStateUrl')}
  Role mapping pair:  ${stackOutput(a.outputs, '-ConnectInstance', 'SamlFederationRoleArn')},${stackOutput(a.outputs, '-ConnectInstance', 'SamlProviderArn')}
  Then: attribute mappings, assign users, create matching Connect users.
  Full walkthrough: references/identity-center-sso.md`)
  }

  if (a.orderRaw.customerProfilesEnabled !== false && a.orderRaw.frontendEnabled !== true) {
    parts.push(`
Customer Profiles: create a profile for a real caller (profile-only, no Cognito):
       ${a.cspPath} setup-test-users ${a.projectDir} --user <user> --first <First> --last <Last> \\
         --email <email> --phone <+E164> --customer-number 0000100042 --locale ${a.locale}
     (customer number 0000100042 ties the caller to the seeded sample orders)`)
  }

  if (!a.prefs.claimUkDid && a.orderRaw.frontendEnabled !== true) {
    parts.push(`
Phone number (manual): Connect console → Phone numbers → Claim a number,
  then set its contact flow to '${a.project}-basic-agent-flow'.`)
  }

  if (a.orderRaw.knowledgeBaseEnabled === true && a.prefs.kbContent === 'skip') {
    parts.push(`
Knowledge base is EMPTY. Populate anytime:
       ${a.cspPath} sync-kb ${a.projectDir} <content-path> ${a.region}`)
  }

  const csp = a.cspPath
  parts.push(`
Agent prompts: edit ${a.cwd}/prompts/*.md (seed them first with ${csp} init-prompts
if missing), then re-render + deploy with csp redeploy below — prompt files in the
working dir survive re-renders and are the source of truth.
Update the deployed stacks (after editing files in ${a.projectDir.split('/').pop()}/):
       cd ${a.projectDir} && npx cdk deploy --all
Re-render from the skill templates (only after changes under templates/cdk-app/;
wipes and regenerates the project dir — your order/values files are preserved):
       ${csp} redeploy ${a.projectDir}
Tear down:
       cd ${a.projectDir} && npx cdk destroy --all
`)
  return parts.join('\n')
}
