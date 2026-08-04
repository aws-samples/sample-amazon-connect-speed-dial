"""
Update Session Context Lambda

Invoked from an Amazon Connect contact flow to look up the caller in
Amazon Connect Customer Profiles and push the resulting identity data into
the Q Connect session so the Nova Sonic orchestration agent can read it
via the ``{{$.Custom.<key>}}`` prompt syntax.

Lookup key resolution (first match wins):
  1. The caller's phone number (voice contacts with an ANI) → _phone search.
  2. An ``email`` or ``emailAddress`` contact attribute (web-call / chat
     widgets pass the authenticated user's email) → _email search.
  3. A ``customerId`` contact attribute (set by the web-call widget JWT —
     surfaces as $.Attributes.customerId) → _account search.

On no match the function returns gracefully — the prompt's
``{{$.Custom.*}}`` variables interpolate to empty strings and the agent
proceeds without caller context.

Environment variables:
    ASSISTANT_ID     – Q Connect assistant id (fallback when not passed as a param).
    PROFILES_DOMAIN  – Customer Profiles domain name to search.
    LOG_LEVEL        – logging level (default ERROR).
"""

from __future__ import annotations

import logging
import os
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key

LOG_LEVEL = os.environ.get("LOG_LEVEL", "ERROR").upper()
logger = logging.getLogger(__name__)
logger.setLevel(getattr(logging, LOG_LEVEL, logging.ERROR))

qconnect = boto3.client("qconnect")
connect = boto3.client("connect")
profiles = boto3.client("customer-profiles")
dynamodb = boto3.resource("dynamodb")


# ---------------------------------------------------------------------------
# Profile resolution
# ---------------------------------------------------------------------------

def _search(domain: str, key_name: str, value: str) -> dict | None:
    """Return the first matching profile, or None."""
    if not value:
        return None
    try:
        resp = profiles.search_profiles(
            DomainName=domain, KeyName=key_name, Values=[value]
        )
    except Exception as e:  # noqa: BLE001 — lookups must never hard-fail the call
        code = (
            getattr(e, "response", {}).get("Error", {}).get("Code", "")
            if hasattr(e, "response")
            else ""
        )
        logger.warning("SearchProfiles failed (key=%s): %s %s", key_name, type(e).__name__, code)
        return None
    items = resp.get("Items", [])
    logger.info("SearchProfiles key=%s -> %d match(es)", key_name, len(items))
    return items[0] if items else None


def _resolve_profile(domain: str, contact_data: dict, attributes: dict) -> dict | None:
    """Resolve the caller's profile via phone, email, or customerId.

    Lookup key resolution (first match wins):
      1. Caller phone number (voice ANI) → _phone search.
      2. Email attribute (web-call / chat widget) → _email search.
      3. customerId attribute from the web-call widget JWT → _account search.
    """
    # 1. Caller phone (voice ANI).
    endpoint = contact_data.get("CustomerEndpoint") or {}
    phone = endpoint.get("Address", "")
    profile = _search(domain, "_phone", phone)
    if profile:
        return profile

    # 2. Email attribute (web-call / chat — passed as a contact attribute).
    email = attributes.get("email", "") or attributes.get("emailAddress", "")
    profile = _search(domain, "_email", email)
    if profile:
        return profile

    # 3. customerId attribute from the web-call widget JWT (searched as _account).
    customer_id = attributes.get("customerId", "")
    return _search(domain, "_account", customer_id)


# ---------------------------------------------------------------------------
# Latest-order lookup (SAP orders DynamoDB table)
# ---------------------------------------------------------------------------

def _derive_order_status(items: list[dict]) -> str:
    """Derive an order's lifecycle status from its record types.

    Mirrors derive_order_lifecycle in the SAP gateway tool so the pre-populated
    status matches what get_order_status would return.
    """
    sk = [i.get("SK", "") for i in items]
    if any(s.startswith("INVOICE#") for s in sk):
        return "Invoiced"
    if any(i.get("actualGoodsIssueDate") for i in items if i.get("SK", "").startswith("DELIVERY#")):
        return "Delivered"
    if any(s.startswith("DELIVERY#") for s in sk):
        return "In Delivery"
    return "Open"


def _latest_order(customer_id: str) -> dict | None:
    """Return a summary of the customer's most recent SAP order, or None.

    Queries GSI1 (CUSTOMER#<num>, projects ALL) so a single call returns every
    record for the customer; groups by order and picks the highest order number
    (VBELN is zero-padded and monotonically increasing, so lexical max ==
    most recent). Best-effort: any failure returns None and the agent falls
    back to calling the SAP tools live.
    """
    table_name = os.environ.get("SAP_ORDERS_TABLE", "")
    if not table_name or not customer_id:
        return None
    try:
        resp = dynamodb.Table(table_name).query(
            IndexName="GSI1",
            KeyConditionExpression=Key("GSI1PK").eq(f"CUSTOMER#{customer_id}"),
        )
    except Exception as e:  # noqa: BLE001 — never hard-fail the call over pre-population
        logger.warning("SAP orders query failed: %s", type(e).__name__)
        return None

    by_order: dict[str, list[dict]] = {}
    for item in resp.get("Items", []):
        pk = item.get("PK", "")
        if pk.startswith("ORDER#"):
            by_order.setdefault(pk[len("ORDER#"):], []).append(item)
    if not by_order:
        logger.info("No SAP orders for customer %s", customer_id)
        return None

    order_number = max(by_order)  # lexical max of zero-padded VBELN == latest
    items = by_order[order_number]
    header = next((i for i in items if i.get("SK", "").startswith("HEADER")), {})
    return {
        "recentOrderId": header.get("VBELN", order_number),
        "orderStatus": _derive_order_status(items),
        "orderTotal": header.get("netValue", ""),
        "orderCurrency": header.get("currency", ""),
        "orderRequestedDelivery": header.get("requestedDeliveryDate", ""),
    }


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------

def handler(event: dict, context: Any) -> dict:
    """Lambda entry point.

    Resolves the caller's Customer Profile, maps identity fields into the
    Q Connect session ``Custom`` namespace, and returns.
    """
    contact_data = event.get("Details", {}).get("ContactData", {})
    parameters = event.get("Details", {}).get("Parameters", {})
    attributes = contact_data.get("Attributes", {})

    assistant_id = parameters.get("assistantId") or os.environ.get("ASSISTANT_ID")
    domain = parameters.get("profilesDomain") or os.environ.get("PROFILES_DOMAIN")
    contact_id = contact_data.get("ContactId")
    instance_arn = contact_data.get("InstanceARN")

    logger.info(
        "Received event: contactId=%s, assistantId=%s, domain=%s",
        contact_id, assistant_id, domain,
    )

    if not contact_id or not instance_arn or not domain:
        logger.error("Missing ContactId, InstanceARN, or domain")
        return {"statusCode": 400, "profileFound": "false"}

    # --- Resolve caller profile ---
    profile = _resolve_profile(domain, contact_data, attributes)
    if not profile:
        logger.info("No matching profile; proceeding without caller context")
        return {"statusCode": 200, "profileFound": "false"}

    # --- Map identity fields to session data ---
    attrs = profile.get("Attributes") or {}
    full_name = " ".join(
        p for p in [profile.get("FirstName"), profile.get("LastName")] if p
    )
    customer_id = attrs.get("customerNumber") or profile.get("AccountNumber", "")

    fields = {
        "customerName": full_name,
        "customerId": customer_id,
        "accountTier": attrs.get("accountTier", ""),
    }

    # Pre-populate the caller's most recent order so the agent can answer
    # "what's my latest order" from session context without a tool call. The
    # SAP tools remain available for order-specific detail / follow-ups. Uses
    # the resolved customer number as the DynamoDB GSI key (customer-scoped, so
    # a caller can only ever see their own order). Best-effort — skipped
    # silently if the table isn't configured, the customer has no orders, or
    # the query fails.
    if customer_id:
        order = _latest_order(customer_id)
        if order:
            fields.update(order)

    session_data = [
        {"key": k, "value": {"stringValue": v}} for k, v in fields.items() if v
    ]
    if not session_data:
        logger.info("Profile found but no mappable identity fields; nothing to inject")
        return {"statusCode": 200, "profileFound": "true", "dataCount": "0"}

    # --- Resolve Q Connect session and write ---
    try:
        instance_id = instance_arn.rsplit("/", 1)[-1]
        describe_resp = connect.describe_contact(
            InstanceId=instance_id, ContactId=contact_id
        )
        session_arn = (
            describe_resp.get("Contact", {}).get("WisdomInfo", {}).get("SessionArn")
        )
        session_id = session_arn.rsplit("/", 1)[-1] if session_arn else contact_id

        logger.info(
            "Injecting %d identity field(s) into session %s",
            len(session_data), session_id,
        )
        qconnect.update_session_data(
            assistantId=assistant_id,
            sessionId=session_id,
            namespace="Custom",
            data=session_data,
        )
    except Exception as e:  # noqa: BLE001
        logger.error(
            "Session data injection failed (resolve session / update_session_data): %s", e
        )
        return {"statusCode": 200, "profileFound": "true", "dataCount": "0"}

    return {
        "statusCode": 200,
        "profileFound": "true",
        "dataCount": str(len(session_data)),
    }
