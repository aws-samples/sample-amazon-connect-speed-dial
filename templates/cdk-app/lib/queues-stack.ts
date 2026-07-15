import * as cdk from 'aws-cdk-lib';
import * as connect from 'aws-cdk-lib/aws-connect';
import { Construct } from 'constructs';
import { BlueprintStack } from './blueprint-stack';

export interface QueuesStackProps extends cdk.StackProps {
  instanceArn: string;
}

/**
 * Creates the default queue, hours-of-operation, and routing profile.
 *
 * Provides a 24×7 hours-of-operation, a default voice queue for human
 * transfers, and a routing profile that routes voice contacts to that queue.
 */
export class QueuesStack extends BlueprintStack {
  public readonly defaultQueueArn: string;
  public readonly hoursOfOperationArn: string;

  constructor(scope: Construct, id: string, props: QueuesStackProps) {
    super(scope, id, props);
    this.templateOptions.description = 'Default queue, hours-of-operation, and routing profile for human transfers';

    const hoo = new connect.CfnHoursOfOperation(this, 'HoursOfOperation', {
      instanceArn: props.instanceArn,
      name: this.namer.connect('24x7'),
      description: 'Always open',
      timeZone: 'UTC',
      config: ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY'].map(day => ({
        day,
        startTime: { hours: 0, minutes: 0 },
        endTime: { hours: 23, minutes: 59 },
      })),
    });

    const queue = new connect.CfnQueue(this, 'DefaultQueue', {
      instanceArn: props.instanceArn,
      name: this.namer.connect('default-queue'),
      description: 'Default queue for human transfers',
      hoursOfOperationArn: hoo.attrHoursOfOperationArn,
    });

    new connect.CfnRoutingProfile(this, 'DefaultRoutingProfile', {
      instanceArn: props.instanceArn,
      name: this.namer.connect('default-routing-profile'),
      description: 'Default routing profile',
      defaultOutboundQueueArn: queue.attrQueueArn,
      mediaConcurrencies: [{ channel: 'VOICE', concurrency: 1 }],
      queueConfigs: [{
        queueReference: { channel: 'VOICE', queueArn: queue.attrQueueArn },
        priority: 1,
        delay: 0,
      }],
    });

    this.defaultQueueArn = queue.attrQueueArn;
    this.hoursOfOperationArn = hoo.attrHoursOfOperationArn;

    new cdk.CfnOutput(this, 'QueueArn', { value: this.defaultQueueArn });
    new cdk.CfnOutput(this, 'HoursOfOperationArn', { value: this.hoursOfOperationArn });
  }
}
