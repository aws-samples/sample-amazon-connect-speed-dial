"""
Custom Resource handler: Q in Connect AI guardrail.

The AWS::Wisdom::AIGuardrail CloudFormation resource is unreliable (opaque
GeneralServiceException, no visibilityStatus support), so this handler calls
the qconnect API directly with the exact camelCase policy config that the
CLI accepts. Create returns the guardrail id; Update updates in place; Delete
removes it. The guardrail is created with visibilityStatus PUBLISHED so the
AI agents can reference it immediately.

The calling stack passes a ConfigHash property derived from this file's
contents; editing the policy constants below changes the hash, which
triggers a CloudFormation Update on the custom resource (publishing a new
guardrail version).
"""

import json
import logging
import urllib.request

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

BLOCKED_INPUT = 'I cannot process that request. Please rephrase your question about our services.'
BLOCKED_OUTPUT = 'I cannot provide that information. Let me help you with something else.'

CONTENT_POLICY = {
    'filtersConfig': [
        {'type': 'HATE', 'inputStrength': 'MEDIUM', 'outputStrength': 'HIGH'},
        {'type': 'INSULTS', 'inputStrength': 'MEDIUM', 'outputStrength': 'HIGH'},
        {'type': 'SEXUAL', 'inputStrength': 'HIGH', 'outputStrength': 'HIGH'},
        {'type': 'VIOLENCE', 'inputStrength': 'HIGH', 'outputStrength': 'HIGH'},
        {'type': 'MISCONDUCT', 'inputStrength': 'HIGH', 'outputStrength': 'HIGH'},
        # PROMPT_ATTACK only supports input filtering — outputStrength MUST be NONE.
        {'type': 'PROMPT_ATTACK', 'inputStrength': 'HIGH', 'outputStrength': 'NONE'},
    ]
}

TOPIC_POLICY = {
    'topicsConfig': [
        {
            'name': 'off-topic',
            'type': 'DENY',
            'definition': 'Requests unrelated to company services, products, orders, accounts, or support. Includes general knowledge, personal advice, coding help, or topics outside customer service.',
            'examples': [
                'What is the meaning of life?',
                'Write me a poem',
                'Help me with my homework',
                'What is the weather today?',
            ],
        }
    ]
}

SENSITIVE_POLICY = {
    'piiEntitiesConfig': [
        {'type': 'CREDIT_DEBIT_CARD_NUMBER', 'action': 'ANONYMIZE'},
        {'type': 'US_SOCIAL_SECURITY_NUMBER', 'action': 'ANONYMIZE'},
        {'type': 'US_BANK_ACCOUNT_NUMBER', 'action': 'ANONYMIZE'},
        {'type': 'CREDIT_DEBIT_CARD_CVV', 'action': 'BLOCK'},
        {'type': 'PIN', 'action': 'BLOCK'},
        {'type': 'PASSWORD', 'action': 'BLOCK'},
    ]
}

WORD_POLICY = {'managedWordListsConfig': [{'type': 'PROFANITY'}]}


def create_guardrail(client, assistant_id, name):
    resp = client.create_ai_guardrail(
        assistantId=assistant_id,
        name=name,
        visibilityStatus='PUBLISHED',
        blockedInputMessaging=BLOCKED_INPUT,
        blockedOutputsMessaging=BLOCKED_OUTPUT,
        description='Service agent guardrail - blocks harmful content, PII, off-topic, and prompt attacks',
        contentPolicyConfig=CONTENT_POLICY,
        topicPolicyConfig=TOPIC_POLICY,
        sensitiveInformationPolicyConfig=SENSITIVE_POLICY,
        wordPolicyConfig=WORD_POLICY,
    )
    return resp['aiGuardrail']['aiGuardrailId']


def update_guardrail(client, assistant_id, guardrail_id):
    client.update_ai_guardrail(
        assistantId=assistant_id,
        aiGuardrailId=guardrail_id,
        visibilityStatus='PUBLISHED',
        blockedInputMessaging=BLOCKED_INPUT,
        blockedOutputsMessaging=BLOCKED_OUTPUT,
        description='Service agent guardrail - blocks harmful content, PII, off-topic, and prompt attacks',
        contentPolicyConfig=CONTENT_POLICY,
        topicPolicyConfig=TOPIC_POLICY,
        sensitiveInformationPolicyConfig=SENSITIVE_POLICY,
        wordPolicyConfig=WORD_POLICY,
    )


def publish_version(client, assistant_id, guardrail_id):
    # AI agents must reference a guardrail by a version qualifier (id:version),
    # not the bare id. Publish a version and return the qualified id.
    resp = client.create_ai_guardrail_version(
        assistantId=assistant_id,
        aiGuardrailId=guardrail_id,
    )
    version = resp['versionNumber']
    return f"{guardrail_id}:{int(version)}"


def handler(event, context):
    logger.info(f"RequestType: {event.get('RequestType')}")
    rt = event.get('RequestType')
    props = event.get('ResourceProperties', {})
    assistant_id = props['AssistantId']
    name = props['Name']
    client = boto3.client('qconnect')

    try:
        if rt == 'Create':
            gid = create_guardrail(client, assistant_id, name)
            qualified = publish_version(client, assistant_id, gid)
            send(event, context, 'SUCCESS',
                 {'AIGuardrailId': gid, 'QualifiedId': qualified}, physical_id=gid)
        elif rt == 'Update':
            gid = event.get('PhysicalResourceId', '')
            try:
                update_guardrail(client, assistant_id, gid)
            except ClientError as e:
                # If the existing guardrail can't be updated, create a fresh one.
                logger.warning(f"Update failed ({e}); creating a new guardrail")
                gid = create_guardrail(client, assistant_id, name)
            # Publish a new version so the update is reflected in a qualifier.
            qualified = publish_version(client, assistant_id, gid)
            send(event, context, 'SUCCESS',
                 {'AIGuardrailId': gid, 'QualifiedId': qualified}, physical_id=gid)
        elif rt == 'Delete':
            gid = event.get('PhysicalResourceId', '')
            if gid and gid.count('-') >= 4:  # looks like a real id, not a failed-create token
                try:
                    client.delete_ai_guardrail(assistantId=assistant_id, aiGuardrailId=gid)
                except ClientError as e:
                    logger.warning(f"Delete tolerated error: {e}")
            send(event, context, 'SUCCESS', {}, physical_id=gid or 'none')
        else:
            send(event, context, 'FAILED', {}, reason=f"Unknown RequestType {rt}")
    except Exception as e:
        logger.error(f"Error: {e}", exc_info=True)
        send(event, context, 'FAILED', {}, reason=str(e), physical_id=event.get('PhysicalResourceId', 'none'))


def send(event, context, status, data, reason=None, physical_id=None):
    body = {
        'Status': status,
        'Reason': reason or f"See CloudWatch: {context.log_stream_name}",
        'PhysicalResourceId': physical_id or context.log_stream_name,
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'Data': data,
    }
    req = urllib.request.Request(
        event['ResponseURL'],
        data=json.dumps(body).encode(),
        headers={'Content-Type': ''},
        method='PUT',
    )
    urllib.request.urlopen(req)
