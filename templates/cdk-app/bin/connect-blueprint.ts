#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ConnectInstanceStack, ConnectInstanceStackProps, DEMO_PROFILE_PHONE } from '../lib/connect-instance-stack';
import { QueuesStack } from '../lib/queues-stack';
import { LexBotStack } from '../lib/lex-bot-stack';
import { WisdomStack } from '../lib/wisdom-stack';
import { ContactFlowStack } from '../lib/contact-flow-stack';
import { PostDeployStack } from '../lib/post-deploy-stack';
import { AgentCoreGatewayStack } from '../lib/agentcore-gateway-stack';
import { WebcallWidgetStack, WebcallWidgetStackProps } from '../lib/webcall-widget-stack';
import { ConnectFlowLambdasStack } from '../lib/connect-flow-lambdas-stack';
import { ContactEventsStack } from '../lib/contact-events-stack';

import { config, resolvePrefix } from '../lib/config';
import { ProjectTagAspect } from '../lib/project-tag-aspect';

const app = new cdk.App();

// Region is pinned to the region the user selected at setup time, rendered into
// this file from `.connect-skill-values.json`. This is deliberate: relying on
// `CDK_DEFAULT_REGION`/`AWS_REGION` in the shell is fragile — if the inline env
// var fails to reach the node process, CDK silently falls back to the profile's
// region and deploys to the wrong place (e.g. us-east-1 with eu.* model IDs,
// which then fail as "not available in this region"). Hardcoding the rendered
// region removes that failure mode. The account still comes from the environment.
// (An unrendered template leaves the region placeholder here, which render-time
// validation rejects, and `resolvePrefix()` throws on deploy — so a placeholder
// can never become a real region.)
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: '{{region}}',
};

// Single source of truth: the project prefix drives the stack-ID namespace and,
// via each stack's ResourceNamer, every physical resource name. Construct IDs
// inside stacks are kept stable (prefix-free) so logical IDs never churn when
// the project is renamed.
const stackPrefix = resolvePrefix();

// Bucket cleanup: each stack controls its own S3 teardown behavior independently.
// Default: do not auto-delete. Set to true per-stack when teardown cleanup is desired.
const autoDeleteConnectBuckets = false;
const autoDeleteWebcallBuckets = false;

const instance = new ConnectInstanceStack(app, `${stackPrefix}-ConnectInstance`, {
  env,
  autoDeleteBuckets: autoDeleteConnectBuckets,
});

const queues = new QueuesStack(app, `${stackPrefix}-Queues`, {
  env, instanceArn: instance.instanceArn,
});
queues.addDependency(instance);

// The AgentCore gateway registers itself with the instance as an MCP server.
// It is created before Wisdom so the orchestration agent can both allow-list
// the gateway's tools and grant them on its security profile (by gateway-id
// namespace). The gateway depends only on the instance, so this ordering is
// safe and cycle-free.
const gateway = new AgentCoreGatewayStack(app, `${stackPrefix}-AgentCoreGateway`, {
  env,
  instanceAlias: instance.instanceAlias,
  instanceId: instance.instanceId,
  instanceArn: instance.instanceArn,
});
gateway.addDependency(instance);

const wisdom = new WisdomStack(app, `${stackPrefix}-Wisdom`, {
  env,
  instanceArn: instance.instanceArn,
  instanceId: instance.instanceId,
  gatewayNamespace: gateway.gatewayId,
});
wisdom.addDependency(instance);

// When tool calling is enabled, the orchestration agent allow-lists the
// gateway's MCP tools by id and grants them on its security profile. Both only
// resolve once the gateway is registered as an MCP server integration on the
// instance (done in the gateway stack), so Wisdom must deploy after it.
if (config.toolEnabled) {
  wisdom.addDependency(gateway);
}

const lex = new LexBotStack(app, `${stackPrefix}-LexBot`, {
  env, instanceArn: instance.instanceArn, assistantArn: wisdom.assistantArn,
});
lex.addDependency(instance);
lex.addDependency(wisdom);

// FlowLambdas is created before ContactFlow so the flow can reference the
// context-injection Lambda's ARN when contextInjectionEnabled.
const flowLambdas = new ConnectFlowLambdasStack(app, `${stackPrefix}-FlowLambdas`, {
  env,
  connectInstanceId: instance.instanceId,
  connectInstanceArn: instance.instanceArn,
  assistantId: wisdom.assistantId,
  contextInjectionEnabled: config.contextInjectionEnabled,
  customerProfilesEnabled: config.customerProfilesEnabled,
  profilesDomainName: instance.customerProfilesDomainName,
  demoProfilePhone: DEMO_PROFILE_PHONE,
});
flowLambdas.addDependency(instance);
flowLambdas.addDependency(wisdom);

const flow = new ContactFlowStack(app, `${stackPrefix}-ContactFlow`, {
  env,
  instanceArn: instance.instanceArn,
  instanceId: instance.instanceId,
  lexBotAliasArn: lex.botAliasArn,
  assistantArn: wisdom.assistantArn,
  orchestrationAgentArn: wisdom.orchestrationAgentArn,
  queueArn: queues.defaultQueueArn,
  transferEnabled: config.transferEnabled,
  toolEnabled: config.toolEnabled,
  contextInjectionEnabled: config.contextInjectionEnabled,
  contextInjectionLambdaArn: flowLambdas.updateSessionContextFunction?.functionArn,
  customerProfilesEnabled: config.customerProfilesEnabled,
  profileLookupLambdaArn: flowLambdas.profileLookupFunction?.functionArn,
  recordingEnabled: config.recordingEnabled,
});
flow.addDependency(lex);
flow.addDependency(wisdom);
flow.addDependency(queues);
// The flow invokes the context-injection / profile-lookup Lambdas, so they must
// exist (and be associated with the instance) first.
if (config.contextInjectionEnabled || config.customerProfilesEnabled) {
  flow.addDependency(flowLambdas);
}

const contactEvents = new ContactEventsStack(app, `${stackPrefix}-ContactEvents`, {
  env,
  connectInstanceArn: instance.instanceArn,
});
contactEvents.addDependency(instance);

// Webcall Widget: only deploy when at least one widget is fully configured
// Webcall Widget frontend: deploy when frontendEnabled is true.
// The stack provisions CloudFront, Cognito, and API Gateway regardless of
// widget configuration — widgets are added in the Connect console after the
// instance exists and the CloudFront URL is known.
if (config.frontendEnabled) {
  const webcallWidget = new WebcallWidgetStack(app, `${stackPrefix}-WebcallWidget`, {
    env,
    autoDeleteBuckets: autoDeleteWebcallBuckets,
  });
  webcallWidget.addDependency(instance);
} else {
  console.log(
    '\x1b[33m[WebcallWidget]\x1b[0m Skipped — frontendEnabled is false. ' +
    'Re-run with frontendEnabled set to true to deploy the sample web-call frontend.',
  );
}

// PostDeploy: set default AI agents on the assistant
const post = new PostDeployStack(app, `${stackPrefix}-PostDeploy`, {
  env,
  instanceArn: instance.instanceArn,
  instanceId: instance.instanceId,
  assistantId: wisdom.assistantId,
  orchestrationAgentId: wisdom.orchestrationAgentId,
  selfServiceAgentId: wisdom.selfServiceAgentId,
  orchestratorUseCase: 'Connect.SelfService',
});
post.addDependency(flow);

// Apply a 'project' tag to every taggable resource in all stacks.
cdk.Aspects.of(app).add(new ProjectTagAspect(stackPrefix));

app.synth();
