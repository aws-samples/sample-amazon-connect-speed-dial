import * as cdk from 'aws-cdk-lib';
import { IConstruct } from 'constructs';

/**
 * CDK Aspect that applies a `project` tag to every taggable resource in the app.
 *
 * The tag value is the deployment prefix (project name), making it trivial to
 * identify which resources belong to which deployment in shared accounts. Applied
 * at the app level so it covers all stacks uniformly — including any future stacks
 * added to the blueprint.
 */
export class ProjectTagAspect implements cdk.IAspect {
  constructor(private readonly projectName: string) {}

  visit(node: IConstruct): void {
    if (cdk.TagManager.isTaggable(node)) {
      cdk.Tags.of(node).add('project', this.projectName);
    }
  }
}
