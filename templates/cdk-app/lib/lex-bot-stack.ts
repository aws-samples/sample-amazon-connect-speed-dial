import * as cdk from 'aws-cdk-lib';
import * as lex from 'aws-cdk-lib/aws-lex';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { BlueprintStack } from './blueprint-stack';

export interface LexBotStackProps extends cdk.StackProps {
  instanceArn: string;
  assistantArn: string;
}

/**
 * Deploys an Amazon Lex V2 bot with a QInConnect intent for AI Agent self-service.
 *
 * The bot is associated with the Connect instance and routes all utterances
 * through Q-in-Connect orchestration (Nova Sonic). A versioned alias named
 * "live" is created and exported for use in the contact flow.
 */
export class LexBotStack extends BlueprintStack {
  public readonly botId: string;
  public readonly botAliasArn: string;

  constructor(scope: Construct, id: string, props: LexBotStackProps) {
    super(scope, id, props);
    this.templateOptions.description = 'Amazon Lex V2 bot for AI Agent self-service';

    // IAM role for Lex bot — includes Wisdom permissions for QInConnectIntent
    const botRole = new iam.Role(this, 'BotRole', {
      assumedBy: new iam.ServicePrincipal('lexv2.amazonaws.com'),
      description: 'Allows the Lex bot to invoke Q-in-Connect for AI Agent self-service',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonLexRunBotsOnly'),
      ],
      inlinePolicies: {
        QInConnectAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'QInConnectAssistantPolicy',
              actions: ['wisdom:CreateSession', 'wisdom:GetAssistant'],
              resources: [props.assistantArn, `${props.assistantArn}/*`],
            }),
            new iam.PolicyStatement({
              sid: 'QInConnectSessionsPolicy',
              actions: ['wisdom:SendMessage', 'wisdom:GetNextMessage'],
              resources: [
                cdk.Arn.format({
                  service: 'wisdom',
                  resource: 'session',
                  resourceName: `${cdk.Arn.split(props.assistantArn, cdk.ArnFormat.SLASH_RESOURCE_NAME).resourceName}/*`,
                }, this),
              ],
            }),
          ],
        }),
      },
    });

    const bot = new lex.CfnBot(this, 'Bot', {
      name: this.namer.lex('bot'),
      description: 'Conversational AI bot for Connect AI Agent self-service',
      roleArn: botRole.roleArn,
      dataPrivacy: { ChildDirected: false },
      idleSessionTtlInSeconds: 300,
      botLocales: [{
        localeId: '{{lexLocaleId}}',
        nluConfidenceThreshold: 0.4,
        intents: [
          // AMAZON.QInConnectIntent — the primary intent that enables AI Agent self-service.
          // Routes all utterances to Q-in-Connect for orchestration via Nova Sonic.
          {
            name: 'QInConnectIntent',
            parentIntentSignature: 'AMAZON.QInConnectIntent',
            qInConnectIntentConfiguration: {
              qInConnectAssistantConfiguration: {
                assistantArn: props.assistantArn,
              },
            },
          },
          // FallbackIntent is required by every Lex bot locale but won't fire
          // when QInConnectIntent is active (it catches all unclassified utterances).
          {
            name: 'FallbackIntent',
            parentIntentSignature: 'AMAZON.FallbackIntent',
          },
        ],
      }],
      autoBuildBotLocales: true,
      // Connect requires this tag on the bot to surface it in the Conversational
      // AI menu and allow association; without it the console returns a 403
      // ("does not have the required tag set").
      botTags: [{ key: 'AmazonConnectEnabled', value: 'True' }],
    });

    const botVersion = new lex.CfnBotVersion(this, 'BotVersion', {
      botId: bot.attrId,
      botVersionLocaleSpecification: [{
        localeId: '{{lexLocaleId}}',
        botVersionLocaleDetails: { sourceBotVersion: 'DRAFT' },
      }],
    });
    botVersion.addDependency(bot);

    const alias = new lex.CfnBotAlias(this, 'BotAlias', {
      botId: bot.attrId,
      botAliasName: 'live',
      botVersion: botVersion.attrBotVersion,
      // Enabling a locale on the ALIAS is separate from building it on the bot
      // version. Without this the Lex runtime rejects GetUserInput from the
      // contact flow with "BotAliasId ... does not have Language <locale> enabled".
      botAliasLocaleSettings: [{
        localeId: '{{lexLocaleId}}',
        botAliasLocaleSetting: { enabled: true },
      }],
      // Same Connect tag requirement as the bot (see botTags above).
      botAliasTags: [{ key: 'AmazonConnectEnabled', value: 'True' }],
    });

    new connect.CfnIntegrationAssociation(this, 'LexAssociation', {
      instanceId: props.instanceArn,
      integrationType: 'LEX_BOT',
      integrationArn: alias.attrArn,
    });

    this.botId = bot.attrId;
    this.botAliasArn = alias.attrArn;

    new cdk.CfnOutput(this, 'BotId', { value: this.botId });
    new cdk.CfnOutput(this, 'BotAliasArn', { value: this.botAliasArn });
  }
}
