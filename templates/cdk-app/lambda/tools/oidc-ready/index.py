"""
OIDC-readiness gate custom-resource handler.

A freshly-created Connect instance is returned as "created" before its public
hostname (<alias>.my.connect.aws) has propagated in DNS. The AgentCore gateway
stabilizes by fetching the instance's OIDC discovery URL, so if it is created
too soon the backend gets UnknownHostException and the whole stack rolls back.
This custom resource polls the discovery URL until it returns HTTP 200, and
the CfnGateway depends on it — turning an intermittent race into a
deterministic wait. Outbound HTTPS only; no IAM beyond basic Lambda logging.
Delete/Update are no-ops (the URL is only gated at first create).
"""

import json
import logging
import time
import urllib.error
import urllib.request

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def handler(event, context):
    logger.info("Event: RequestType=%s", event.get('RequestType'))
    rt = event.get('RequestType')
    props = event.get('ResourceProperties', {})
    try:
        if rt == 'Create':
            wait_for_oidc(props['DiscoveryUrl'])
        # Update/Delete: nothing to gate.
        send(event, context, 'SUCCESS', {'DiscoveryUrl': props.get('DiscoveryUrl', '')})
    except Exception as e:
        logger.error(f"Error: {e}", exc_info=True)
        send(event, context, 'FAILED', reason=str(e))


def wait_for_oidc(url, max_attempts=60, delay=5):
    """Poll the OIDC discovery URL until it returns HTTP 200 (DNS + endpoint ready)."""
    last = None
    for i in range(max_attempts):
        try:
            with urllib.request.urlopen(url, timeout=10) as r:
                if r.status == 200:
                    logger.info(f"OIDC endpoint ready after {i + 1} attempt(s)")
                    return
                last = f"HTTP {r.status}"
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
        except Exception as e:  # URLError (DNS/conn), timeout, etc. — expected while propagating
            last = f"{type(e).__name__}: {e}"
        logger.info(f"OIDC not ready (attempt {i + 1}/{max_attempts}): {last}")
        time.sleep(delay)
    raise TimeoutError(f"OIDC endpoint not ready after {max_attempts * delay}s: {url} ({last})")


def send(event, context, status, data=None, reason=None):
    body = {
        'Status': status,
        'Reason': reason or f"See CloudWatch: {context.log_stream_name}",
        'PhysicalResourceId': event.get('PhysicalResourceId', context.log_stream_name),
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
