"""
Update Session Context Lambda

Invoked from an Amazon Connect contact flow to update the Q Connect
session with contextual data. Uses dummy values for demonstration
purposes — replace with real data lookups in production.

Returns updated key count so the flow can confirm success.
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

qconnect = boto3.client("qconnect")
connect = boto3.client("connect")


def handler(event: dict, context: Any) -> dict:
    """Lambda entry point.

    Reads the contact ID from the Connect event, resolves the Q Connect
    session, and pushes dummy session data into it.
    """
    contact_data = event.get("Details", {}).get("ContactData", {})
    parameters = event.get("Details", {}).get("Parameters", {})
    attributes = contact_data.get("Attributes", {})

    assistant_id = parameters.get("assistantId") or os.environ.get("ASSISTANT_ID")
    contact_id = contact_data.get("ContactId")
    instance_arn = contact_data.get("InstanceARN")

    logger.info("Received event: contactId=%s, instanceArn=%s, assistantId=%s",
                contact_id, instance_arn, assistant_id)

    if not contact_id or not instance_arn:
        logger.error("Missing ContactId or InstanceARN in event")
        return {"statusCode": 400, "error": "Missing ContactId or InstanceARN"}

    # Resolve the Q Connect session via DescribeContact
    instance_id = instance_arn.rsplit("/", 1)[-1]
    logger.info("Describing contact: InstanceId=%s, ContactId=%s", instance_id, contact_id)

    describe_resp = connect.describe_contact(
        InstanceId=instance_id,
        ContactId=contact_id,
    )
    wisdom_info = describe_resp.get("Contact", {}).get("WisdomInfo", {})
    session_arn = wisdom_info.get("SessionArn")
    logger.info("SessionArn: %s", session_arn)

    session_id = session_arn.rsplit("/", 1)[-1] if session_arn else contact_id
    logger.info("Using sessionId=%s, assistantId=%s", session_id, assistant_id)

    # -----------------------------------------------------------------
    # Demo session data — *recent activity* context for the caller.
    #
    # This feature owns transactional/activity context; the Customer Profiles
    # feature owns identity (customerName / customerId / accountTier). The two
    # write a DISJOINT set of {{$.Custom.*}} keys so they compose into one story
    # ("who is calling" + "what they recently did") without overwriting each
    # other. recentOrderId / orderStatus line up with the AgentCore gateway's
    # get_order_status sample (ORD-12345 -> Shipped), so Profiles, this context,
    # and the tools all describe one coherent customer.
    #
    # In production, fetch this for the resolved caller — e.g. read the
    # customerId that the profile-lookup step wrote to a contact attribute and
    # look up that customer's latest order. See references/customer-profiles.md.
    # -----------------------------------------------------------------
    session_data = [
        {"key": "recentOrderId", "value": {"stringValue": "ORD-12345"}},
        {"key": "orderStatus", "value": {"stringValue": "Shipped"}},
        {"key": "openCaseCount", "value": {"stringValue": "1"}},
        # Richer order detail so the agent can give a full, demo-worthy answer
        # ("shipped, arriving 2026-06-28, Widget Pro + Cable Kit") from injected
        # context alone — mirrors the get_order_status tool's response shape so
        # the caller experience is identical whether the answer comes from the
        # MCP tool call or this deterministic fallback.
        {"key": "orderItems", "value": {"stringValue": "Widget Pro, Cable Kit"}},
        {"key": "orderEta", "value": {"stringValue": "2026-06-28"}},
        {"key": "orderTotal", "value": {"stringValue": "$149.99"}},
    ]

    logger.info("Updating session with %d keys: %s", len(session_data), [d["key"] for d in session_data])

    try:
        # namespace="Custom" is required so the data is readable from AI prompts
        # via {{$.Custom.<key>}}. Without it the values are stored where the
        # prompt template can't reach them and interpolate to empty strings.
        response = qconnect.update_session_data(
            assistantId=assistant_id,
            sessionId=session_id,
            namespace="Custom",
            data=session_data,
        )
        logger.info("update_session_data succeeded: sessionId=%s, dataCount=%d",
                    session_id, len(session_data))
    except Exception as e:
        logger.error(
            "update_session_data FAILED — assistantId=%s, sessionId=%s, error=%s",
            assistant_id, session_id, str(e),
        )
        raise

    return {
        "statusCode": 200,
        "sessionDataUpdated": "true",
        "dataCount": str(len(session_data)),
    }
