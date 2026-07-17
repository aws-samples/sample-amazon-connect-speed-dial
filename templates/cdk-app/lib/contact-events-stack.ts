import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { Construct } from 'constructs';
import { BlueprintStack } from './blueprint-stack';

export interface ContactEventsStackProps extends cdk.StackProps {
  /** ARN of the Connect instance — used to scope the event pattern. */
  connectInstanceArn: string;
}

/**
 * Captures Amazon Connect contact lifecycle events via EventBridge and
 * forwards them to a Lambda that logs structured data to CloudWatch.
 *
 * Currently scoped to DISCONNECTED events on this instance (any channel).
 * Extend the event pattern or add additional rules as needed.
 */
export class ContactEventsStack extends BlueprintStack {
  constructor(scope: Construct, id: string, props: ContactEventsStackProps) {
    super(scope, id, props);
    this.templateOptions.description = 'EventBridge rules for Connect contact lifecycle events';

    // --- Lambda: log disconnect events ---
    const disconnectLogger = new nodejs.NodejsFunction(this, 'DisconnectLogger', {
      entry: path.join(__dirname, '..', 'lambda', 'events', 'contact-disconnected', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      logRetention: logs.RetentionDays.TWO_WEEKS,
      description: 'Logs disconnect events from Amazon Connect',
    });

    // --- EventBridge rule ---
    // Amazon Connect publishes contact lifecycle events to the default bus
    // automatically. The detail-type is "Amazon Connect Contact Event" and the
    // channel value uses mixed case ("Voice", "Chat", "Task", "Email").
    // We match all DISCONNECTED events for this instance regardless of channel.
    const rule = new events.Rule(this, 'ClientDisconnectRule', {
      ruleName: this.namer.connect('client-disconnect'),
      description: 'Matches contacts disconnected on this Connect instance',
      eventPattern: {
        source: ['aws.connect'],
        detailType: ['Amazon Connect Contact Event'],
        detail: {
          instanceArn: [props.connectInstanceArn],
          eventType: ['DISCONNECTED'],
        },
      },
    });

    rule.addTarget(new targets.LambdaFunction(disconnectLogger));

    // --- Outputs ---
    new cdk.CfnOutput(this, 'DisconnectLoggerFnArn', {
      value: disconnectLogger.functionArn,
      description: 'ARN of the disconnect-logger Lambda',
    });
    new cdk.CfnOutput(this, 'RuleArn', {
      value: rule.ruleArn,
      description: 'ARN of the client-disconnect EventBridge rule',
    });
  }
}
