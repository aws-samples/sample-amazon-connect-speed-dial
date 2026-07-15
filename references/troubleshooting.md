# Troubleshooting Guide

This document covers common failure modes and solutions for the Amazon Connect Nova Sonic Blueprint.

## Table of Contents

- [Preflight Failures](#preflight-failures)
- [CDK Deployment Failures](#cdk-deployment-failures)
- [UK DID Claiming Failures](#uk-did-claiming-failures)
- [Smoke Test Failures](#smoke-test-failures)
- [General Tips](#general-tips)

---

## Preflight Failures

### AWS Credentials Not Configured

**Symptom:**
```
✗ AWS credentials not configured. Run 'aws configure' or set AWS_PROFILE.
```

**Solution:**
1. Run `aws configure` and enter your AWS access key ID, secret access key, and default region
2. Or set `AWS_PROFILE=<profile-name>` to use a named profile from `~/.aws/credentials`
3. Verify with: `aws sts get-caller-identity`

---

### CDK Not Installed

**Symptom:**
```
✗ CDK not installed. Run 'npm install -g aws-cdk@2.1128.0' or 'npm install'.
```

**Solution:**
1. Install CDK globally: `npm install -g aws-cdk@2.1128.0`
2. Or use a pinned npx (no install needed): `npx aws-cdk@2.1128.0 --version`
3. Verify with: `cdk --version` (should show 2.130.0 or higher)

---

### CDK Bootstrap Fails

**Symptom:**
```
✗ CDK bootstrap failed
```

**Cause:**
Insufficient IAM permissions to create the CDKToolkit stack.

**Solution:**
1. Ensure your IAM user/role has permissions to:
   - Create CloudFormation stacks
   - Create S3 buckets
   - Create IAM roles
   - Create ECR repositories
2. Required managed policies: `AdministratorAccess` or `PowerUserAccess` + `IAMFullAccess`
3. Manually run: `cdk bootstrap aws://<account-id>/us-east-1`
4. If still failing, check CloudFormation console for detailed errors:
   https://console.aws.amazon.com/cloudformation/home?region=us-east-1

---

### Bedrock Model Not Accessible

**Symptom:**
```
⚠ Bedrock model amazon.nova-sonic-v2:0 not accessible
```

**Cause:**
Model access not granted in Bedrock console.

**Solution:**
1. Visit: https://console.aws.amazon.com/bedrock/home?region=us-east-1#/modelaccess
2. Find "Amazon Nova Sonic v2" in the model list
3. Click "Edit" and enable access
4. Click "Save changes"
5. Wait 1-2 minutes for propagation
6. Re-run preflight.sh

**Note:** Model access is account-wide and only needs to be granted once per account.

---

## CDK Deployment Failures

### InvalidContactFlowException on ContactFlowStack

**Symptom:**
```
ContactFlowStack | CREATE_FAILED | AWS::Connect::ContactFlow
InvalidContactFlowException: Invalid contact flow content
```

**Cause:**
The AI Agent block JSON in the contact flow is malformed or references invalid IDs.

**Root Cause:**
The contact flow JSON must embed the exact AI Agent block structure that Connect expects. If the Q in Connect assistant ARN or AI Agent ID is incorrect, Connect rejects the flow.

**Solution:**

1. **Verify Stack Dependency**
   The ContactFlowStack depends on QConnectAssistantStack. If the assistant stack fails, the flow stack will also fail.

   Check:
   ```bash
   aws cloudformation describe-stacks \
     --stack-name QConnectAssistantStack \
     --region us-east-1 \
     --query 'Stacks[0].StackStatus' \
     --output text
   ```

   Expected: `CREATE_COMPLETE`

2. **Re-Capture AI Agent Block JSON**
   If the flow content is stale, re-generate it:

   a. Create a test flow in the Connect console with an AI Agent block
   b. Export the flow JSON from the console
   c. Copy the `parameters` section of the AI Agent block
   d. Update `templates/cdk-app/flows/nova-sonic-qa.json` (and other flavors) with the new structure

3. **Validate Flow JSON**
   ```bash
   jq . templates/cdk-app/flows/nova-sonic-qa.json
   ```
   If this fails, the JSON is malformed.

4. **Check AI Agent ARN Format**
   The flow references the assistant ARN. Ensure the CDK stack uses:
   ```typescript
   assistantArn: qConnectStack.assistant.attrAssistantArn
   ```

5. **Retry Deployment**
   After fixing, redeploy:
   ```bash
   npx cdk deploy ContactFlowStack --require-approval never
   ```

---

### CDK Deploy Hangs on "Creating CloudFormation Stack"

**Symptom:**
Deploy command hangs for >10 minutes with no progress.

**Cause:**
CloudFormation stack is stuck in CREATE_IN_PROGRESS.

**Solution:**
1. Open the CloudFormation console: https://console.aws.amazon.com/cloudformation/home?region=us-east-1
2. Find the stuck stack (e.g., ConnectInstanceStack)
3. Check the "Events" tab for errors
4. If truly stuck (no events for >5 minutes), cancel the stack:
   ```bash
   aws cloudformation cancel-update-stack --stack-name <stack-name> --region us-east-1
   ```
5. Then delete the stack:
   ```bash
   npx cdk destroy <stack-name>
   ```
6. Retry deployment

---

### IAM Permission Denied During Deploy

**Symptom:**
```
CREATE_FAILED | AWS::Connect::Instance | is not authorized to perform: connect:CreateInstance
```

**Cause:**
IAM user/role lacks Connect permissions.

**Solution:**
Attach these managed policies to your IAM user/role:
- `AmazonConnect_FullAccess`
- `AWSCloudFormationFullAccess`
- `IAMFullAccess` (for creating service roles)

Or create a custom policy with:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "connect:*",
        "qconnect:*",
        "bedrock:InvokeModel",
        "iam:CreateRole",
        "iam:AttachRolePolicy",
        "cloudformation:*"
      ],
      "Resource": "*"
    }
  ]
}
```

---

### Outputs File Not Created

**Symptom:**
After `cdk deploy --all`, the `cdk-outputs.json` file is missing.

**Cause:**
Deploy failed before outputs could be written.

**Solution:**
1. Check CloudFormation console for failed stacks
2. Fix the error and redeploy
3. Manually export outputs:
   ```bash
   aws cloudformation describe-stacks \
     --stack-name ConnectInstanceStack \
     --region us-east-1 \
     --query 'Stacks[0].Outputs' \
     --output json > cdk-outputs.json
   ```

---

## UK DID Claiming Failures

### No UK DIDs Available

**Symptom:**
```
✗ No UK DIDs available
```

**Cause:**
Connect has no UK DIDs in inventory for the current search.

**Solution:**

1. **Retry the claim script**
   DID inventory changes frequently. Wait 30 seconds and retry:
   ```bash
   scripts/claim-uk-did.sh <instance-id> <flow-id>
   ```

2. **Widen the search**
   Edit `scripts/claim-uk-did.sh` and increase `--max-results`:
   ```bash
   aws connect search-available-phone-numbers \
     --target-arn "$INSTANCE_ARN" \
     --phone-number-country-code GB \
     --phone-number-type DID \
     --max-results 50 \  # increased from 5
     --region "$REGION" \
     --output json
   ```

3. **Try a different number type**
   If DIDs are unavailable, try TOLL_FREE:
   ```bash
   aws connect search-available-phone-numbers \
     --target-arn "$INSTANCE_ARN" \
     --phone-number-country-code GB \
     --phone-number-type TOLL_FREE \
     --max-results 5 \
     --region "$REGION" \
     --output json
   ```

4. **Claim manually in the console**
   The script only knows how to claim UK DIDs (the API accepts those without a regulatory address bundle). For US, other countries, UK toll-free, or UK mobile, claim in the console — it will walk you through any address bundle required:
   - Go to: https://console.aws.amazon.com/connect/v2/app/instances/<instance-id>/phone-numbers
   - Click "Claim a number"
   - Pick country/type and complete any address fields the console requests
   - Set the contact flow to `<projectName>-nova-sonic`

---

### Phone Number Already Claimed by Another Account

**Symptom:**
```
An error occurred (ConflictException) when calling the ClaimPhoneNumber operation: Phone number already claimed
```

**Cause:**
The number was claimed by another AWS account between the search and claim operations.

**Solution:**
Retry the claim script immediately. The script will search for a different number:
```bash
scripts/claim-uk-did.sh <instance-id> <flow-id>
```

---

### Phone Number Association Fails

**Symptom:**
```
An error occurred (ResourceNotFoundException) when calling the AssociatePhoneNumberContactFlow operation
```

**Cause:**
The contact flow ID is invalid or the instance ID is wrong.

**Solution:**
1. Verify the flow ID:
   ```bash
   aws connect list-contact-flows \
     --instance-id <instance-id> \
     --region us-east-1 \
     --query 'ContactFlowSummaryList[].{Id:Id,Name:Name}' \
     --output table
   ```

2. Verify the instance ID:
   ```bash
   aws connect list-instances --region us-east-1
   ```

3. Retry with correct IDs:
   ```bash
   scripts/claim-uk-did.sh <correct-instance-id> <correct-flow-id>
   ```

---

## Smoke Test Failures

### Instance Not ACTIVE

**Symptom:**
```
✗ Instance status: CREATE_IN_PROGRESS (expected ACTIVE)
```

**Cause:**
Connect instance is still being created.

**Solution:**
Wait 1-2 minutes and re-run smoke test:
```bash
scripts/smoke-test.sh <instance-id> <flow-id> <assistant-id> <ai-agent-id>
```

Instance creation typically takes 3-5 minutes.

---

### Contact Flow Not PUBLISHED

**Symptom:**
```
✗ Contact flow status: SAVED (expected PUBLISHED)
```

**Cause:**
Contact flow is in draft mode and hasn't been published.

**Solution:**
1. Verify the CDK stack publishes the flow:
   ```typescript
   new CfnContactFlow(this, 'NovaFlow', {
     instanceArn: props.instanceArn,
     type: 'CONTACT_FLOW',
     name: 'Nova Sonic Q&A',
     content: JSON.stringify(flowContent),
     state: 'ACTIVE'  // ← must be ACTIVE
   });
   ```

2. Or manually publish in the console:
   - Go to: https://console.aws.amazon.com/connect/v2/app/instances/<instance-id>/contact-flows
   - Find the flow
   - Click "Publish"

3. Re-run smoke test

---

### AI Agent Not ACTIVE

**Symptom:**
```
✗ AI Agent status: CREATE_IN_PROGRESS (expected ACTIVE or CREATE_COMPLETE)
```

**Cause:**
Q in Connect AI Agent is still being created.

**Solution:**
Wait 30-60 seconds and re-run smoke test. AI Agent creation is fast but not instant.

---

### No Phone Number Associated with Flow

**Symptom:**
```
⚠ No UK DID associated with flow (skip claim-uk-did.sh? — claim manually to receive calls)
```

**Cause:**
Phase 5 was skipped (or hasn't been run yet), and no number has been attached to the contact flow.

**Solution (option A — claim a UK DID via the script):**
```bash
scripts/claim-uk-did.sh <instance-id> <flow-id>
```

**Solution (option B — claim any country/type in the console):**
1. Open: `https://console.aws.amazon.com/connect/v2/app/instances/<instance-id>/phone-numbers`
2. Click **Claim a number**, choose country/type, and complete any regulatory address bundle the console requests
3. Set the **contact flow** on the claimed number to `<projectName>-nova-sonic`

The smoke test prints a warning here rather than failing, so this is non-blocking — you can deploy first and decide on a number later.

---

## General Tips

### Cleaning Up Failed Deployments

If a deployment fails midway, clean up:

```bash
cd <project-dir>
npx cdk destroy --all
```

This deletes all stacks. You can then retry from scratch.

**Note:** Claimed phone numbers are NOT deleted by `cdk destroy`. Release them manually:

```bash
aws connect release-phone-number \
  --phone-number-id <phone-number-id> \
  --region us-east-1
```

Or in the console: https://console.aws.amazon.com/connect/v2/app/instances/<instance-id>/phone-numbers

---

### Debugging CDK Synthesis

To see the CloudFormation template before deploying:

```bash
npx cdk synth ConnectInstanceStack
```

This prints the full CloudFormation JSON. Useful for verifying resource properties.

---

### Checking CloudFormation Events

For detailed deployment errors:

```bash
aws cloudformation describe-stack-events \
  --stack-name <stack-name> \
  --region us-east-1 \
  --query 'StackEvents[?ResourceStatus==`CREATE_FAILED`]' \
  --output table
```

---

### Re-Running Idempotent Scripts

All scripts are idempotent:
- **preflight.sh**: Safe to re-run anytime
- **render-templates.sh**: Overwrites destination directory
- **claim-uk-did.sh**: Detects existing associations and skips claiming. Takes `<instance-id> <flow-id>` (no Ofcom address — the API doesn't require one for UK DIDs).
- **smoke-test.sh**: Read-only, always safe

If a script fails, fix the issue and re-run. No need to start from scratch.

---

### Cost Optimization

To minimize AWS costs during testing:

1. **Destroy stacks when done:**
   ```bash
   npx cdk destroy --all
   ```

2. **Release phone numbers:**
   Claimed DIDs incur monthly charges (~$0.03/day in the UK). Release them:
   ```bash
   aws connect release-phone-number \
     --phone-number-id <phone-number-id> \
     --region us-east-1
   ```

3. **Check Connect usage:**
   Monitor usage at: https://console.aws.amazon.com/billing/home

---

### Support

For issues not covered here:
- AWS Connect docs: https://docs.aws.amazon.com/connect/
- Q in Connect docs: https://docs.aws.amazon.com/connect/latest/adminguide/amazon-q-connect.html
- Bedrock docs: https://docs.aws.amazon.com/bedrock/
- CDK docs: https://docs.aws.amazon.com/cdk/

Report bugs or feature requests in the skill repository.
