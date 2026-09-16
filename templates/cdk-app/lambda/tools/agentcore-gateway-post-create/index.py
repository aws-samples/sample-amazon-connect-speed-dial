"""
Custom Resource handler: AgentCore gateway post-create configuration.

Waits for the gateway to reach READY status, then updates the JWT
allowedAudience from the placeholder value to the real gateway ID. Runs
after the CfnGateway is created and before the gateway is registered with
Connect (the MCP-server association requires the audience to match).
"""

import json
import logging
import time
import urllib.request

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def handler(event, context):
    # Log only non-sensitive request metadata — never the full event, which
    # carries ResourceProperties config values.
    logger.info(
        "Event: RequestType=%s PhysicalResourceId=%s",
        event.get('RequestType'),
        event.get('PhysicalResourceId', '-'),
    )
    rt = event.get('RequestType')
    props = event.get('ResourceProperties', {})
    try:
        if rt in ('Create', 'Update'):
            res = handle_create(props)
        elif rt == 'Delete':
            res = handle_delete(event)
        else:
            raise ValueError(f"Unknown RequestType: {rt}")
        send(event, context, 'SUCCESS', res)
    except Exception as e:
        logger.error(f"Error: {e}", exc_info=True)
        send(event, context, 'FAILED', reason=str(e))


def wait_for_gateway(client, gw_id, max_attempts=30):
    """Poll until the gateway reaches READY status."""
    for i in range(max_attempts):
        try:
            r = client.get_gateway(gatewayIdentifier=gw_id)
            status = r.get('status')
            logger.info(f"Gateway {gw_id} status: {status} (attempt {i + 1})")
            if status == 'READY':
                return r
            if status in ('FAILED', 'DELETE_FAILED'):
                raise RuntimeError(f"Gateway in terminal state: {status}")
        except ClientError as e:
            if i < 5:
                logger.warning(f"GetGateway error (attempt {i + 1}): {e}")
            else:
                raise
        time.sleep(2)
    raise TimeoutError(f"Gateway {gw_id} did not reach READY in {max_attempts * 2}s")


def handle_create(props):
    gw_id = props['GatewayId']
    gw_name = props['GatewayName']
    role_arn = props['RoleArn']
    discovery_url = props['DiscoveryUrl']

    ac_client = boto3.client('bedrock-agentcore-control')

    # Step 1: Wait for gateway to be READY
    logger.info("Step 1: Waiting for gateway to be READY...")
    wait_for_gateway(ac_client, gw_id)

    # Step 2: Update allowedAudience from 'placeholder' to the real gateway ID
    logger.info(f"Step 2: Updating allowedAudience to [{gw_id}]...")
    ac_client.update_gateway(
        gatewayIdentifier=gw_id,
        name=gw_name,
        roleArn=role_arn,
        protocolType='MCP',
        authorizerType='CUSTOM_JWT',
        authorizerConfiguration={
            'customJWTAuthorizer': {
                'discoveryUrl': discovery_url,
                'allowedAudience': [gw_id],
            }
        },
    )
    logger.info("Gateway audience updated successfully")

    # Wait for gateway to stabilize after update
    gw_info = wait_for_gateway(ac_client, gw_id)
    gw_url = gw_info.get('gatewayUrl', '')

    return {
        'GatewayId': gw_id,
        'GatewayUrl': gw_url,
    }


def handle_delete(event):
    # Nothing to clean up — the CfnGateway resource handles gateway deletion.
    return {}


def send(event, context, status, data=None, reason=None):
    phys_id = (data or {}).get('GatewayId', event.get('PhysicalResourceId', context.log_stream_name))
    body = {
        'Status': status,
        'Reason': reason or f"See CloudWatch: {context.log_stream_name}",
        'PhysicalResourceId': phys_id,
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
    }
    if data:
        body['Data'] = data
    req = urllib.request.Request(
        event['ResponseURL'],
        data=json.dumps(body).encode(),
        headers={'Content-Type': ''},
        method='PUT',
    )
    urllib.request.urlopen(req)
