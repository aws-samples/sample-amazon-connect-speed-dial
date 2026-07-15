import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ResourceNamer, resolvePrefix } from './config';

/**
 * Base class for every stack in the blueprint.
 *
 * Centralizes the project-prefix wiring: it resolves the prefix from `config`
 * once and exposes a ready-built `ResourceNamer`. Stacks call `this.namer.*`
 * for physical names and use stable, prefix-free construct IDs — so the prefix
 * is enforced deterministically in one place and renaming the project never
 * churns CloudFormation logical IDs.
 */
export abstract class BlueprintStack extends cdk.Stack {
  /** Centralized namer for all physical resource names in this stack. */
  protected readonly namer: ResourceNamer;
  /** The resolved project prefix (single source of truth). */
  protected readonly prefix: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    this.prefix = resolvePrefix();
    this.namer = new ResourceNamer(this.prefix, this.account);
  }
}
