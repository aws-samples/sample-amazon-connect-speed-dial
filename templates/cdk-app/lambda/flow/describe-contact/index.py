"""
Describe Contact Lambda

Invoked from an Amazon Connect contact flow to call DescribeContact
and log the full contact metadata to CloudWatch for observability
and debugging.

Returns a subset of useful fields back to the flow.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import boto3

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logger = logging.getLogger(__name__)
logger.setLevel(getattr(logging, LOG_LEVEL, logging.INFO))

connect = boto3.client("connect")


def handler(event: dict, context: Any) -> dict:
    """Lambda entry point.

    Calls DescribeContact and logs key sections individually for easy
    CloudWatch Logs Insights querying.
    """
    contact_data = event.get("Details", {}).get("ContactData", {})
    contact_id = contact_data.get("ContactId")
    instance_arn = contact_data.get("InstanceARN")

    logger.info("Received event: contactId=%s, instanceArn=%s", contact_id, instance_arn)

    if not contact_id or not instance_arn:
        logger.error("Missing ContactId or InstanceARN")
        return {"statusCode": "400", "error": "Missing ContactId or InstanceARN"}

    instance_id = instance_arn.rsplit("/", 1)[-1]
    logger.info("Calling DescribeContact: InstanceId=%s, ContactId=%s", instance_id, contact_id)

    try:
        response = connect.describe_contact(
            InstanceId=instance_id,
            ContactId=contact_id,
        )
    except Exception as e:
        logger.error("DescribeContact failed: %s", str(e))
        return {"statusCode": "500", "error": str(e)}

    contact = response.get("Contact", {})

    # Log key sections individually for easy filtering
    logger.info("Contact ID: %s", contact.get("Id"))
    logger.info("Channel: %s", contact.get("Channel"))
    logger.info("InitiationMethod: %s", contact.get("InitiationMethod"))
    logger.info("InitiationTimestamp: %s", contact.get("InitiationTimestamp"))
    logger.info("DisconnectTimestamp: %s", contact.get("DisconnectTimestamp"))
    # Log only non-sensitive identifiers, not the full nested objects — QueueInfo/
    # AgentInfo/WisdomInfo can carry injected session context or user attributes.
    logger.info("QueueName: %s", contact.get("QueueInfo", {}).get("QueueName", ""))
    logger.info("AgentId: %s", contact.get("AgentInfo", {}).get("Id", ""))
    logger.info("WisdomSessionArn: %s", contact.get("WisdomInfo", {}).get("SessionArn", ""))

    # Return useful fields to the flow
    return {
        "statusCode": "200",
        "contactId": contact.get("Id", contact_id),
        "channel": contact.get("Channel", "unknown"),
        "initiationMethod": contact.get("InitiationMethod", "unknown"),
        "queueName": contact.get("QueueInfo", {}).get("QueueName", ""),
        "agentId": contact.get("AgentInfo", {}).get("Id", ""),
    }
