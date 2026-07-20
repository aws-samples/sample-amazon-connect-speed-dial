"""
Customer Profile Lookup Lambda

Compliance note: this function reads Amazon Connect Customer Profiles data, which
is PII (phone numbers, account ids, names, custom attributes). Customers are
responsible for ensuring their use of Customer Profiles complies with applicable
data-protection regulations (e.g. GDPR for EU callers, CCPA for California
residents) — including consent, data minimization, retention, and access
controls — under the AWS shared responsibility model. Logs here deliberately
avoid recording profile values (see the SearchProfiles logging below).

Invoked from an Amazon Connect contact flow (the customerProfilesEnabled
capability) to look up the caller in Amazon Connect Customer Profiles and push
the resulting profile into the Q Connect session, so the Nova Sonic orchestration
agent can read it via the `{{$.Custom.<key>}}` prompt syntax.

Lookup key resolution (first match wins):
  1. The caller's phone number (voice contacts with an ANI).
  2. An `email` or `emailAddress` contact attribute (web-call / chat widgets
     pass the authenticated user's email) → searched as the `_email` key.
  3. A `customerId` contact attribute (set by the web-call widget JWT — surfaces
     as $.Attributes.customerId) → searched as the `_account` key.
  4. A static demo phone (DEMO_PROFILE_PHONE env) → resolves the seeded demo
     profile on web-call / fresh-DID contacts with no real match.

Bridge: Customer Profiles results live in the contact-attribute namespace
(`$.Customer.*`), which is NOT what the agent prompt reads. The agent reads the
Q Connect session `Custom` namespace, populated only via qconnect
UpdateSessionData(namespace="Custom"). This Lambda performs that bridge.

On no match (or any error resolving a profile) it writes nothing and returns
gracefully — the prompt's `{{$.Custom.*}}` variables interpolate to empty
strings, so the agent simply proceeds without profile context.

Environment variables:
    ASSISTANT_ID        – Q Connect assistant id (fallback when not passed as a param).
    PROFILES_DOMAIN     – Customer Profiles domain name to search.
    DEMO_PROFILE_PHONE  – static fallback phone lookup key (the seeded demo profile).
    LOG_LEVEL           – logging level (default INFO).
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
profiles = boto3.client("customer-profiles")


def _search(domain: str, key_name: str, value: str) -> dict | None:
    """Return the first matching profile, or None."""
    if not value:
        return None
    try:
        resp = profiles.search_profiles(
            DomainName=domain, KeyName=key_name, Values=[value]
        )
    except Exception as e:  # noqa: BLE001 — lookups must never hard-fail the call
        # the search value (a phone number via _phone or account id via _account).
        # Include the AWS error code (e.g. AccessDeniedException — the KMS-CMK
        # permission failure mode) so the failure class is self-evident in logs.
        # Still never the exception MESSAGE: it can echo the searched value (PII).
        code = getattr(e, "response", {}).get("Error", {}).get("Code", "") if hasattr(e, "response") else ""
        logger.warning("SearchProfiles failed (key=%s): %s %s", key_name, type(e).__name__, code)
        return None
    items = resp.get("Items", [])
    # Log the key name and match count only — never the search value, which can
    # be a phone number (_phone) or customer account id (_account).
    logger.info("SearchProfiles key=%s -> %d match(es)", key_name, len(items))
    return items[0] if items else None


def _resolve_profile(domain: str, contact_data: dict, attributes: dict) -> dict | None:
    """Resolve the caller's profile via phone, email, customerId, then demo fallback.

    Lookup key resolution (first match wins):
      1. Caller phone number (voice ANI) → _phone search.
      2. Email attribute (web-call / chat widget passes email as a contact
         attribute) → _email search.
      3. customerId attribute from the web-call widget JWT → _account search.
      4. Static demo phone fallback (DEMO_PROFILE_PHONE env).
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
    profile = _search(domain, "_account", customer_id)
    if profile:
        return profile

    # 4. Static demo fallback so the demo profile resolves with no real key.
    demo_phone = os.environ.get("DEMO_PROFILE_PHONE", "")
    return _search(domain, "_phone", demo_phone)


def handler(event: dict, context: Any) -> dict:
    contact_data = event.get("Details", {}).get("ContactData", {})
    parameters = event.get("Details", {}).get("Parameters", {})
    attributes = contact_data.get("Attributes", {})

    assistant_id = parameters.get("assistantId") or os.environ.get("ASSISTANT_ID")
    domain = parameters.get("profilesDomain") or os.environ.get("PROFILES_DOMAIN")
    contact_id = contact_data.get("ContactId")
    instance_arn = contact_data.get("InstanceARN")

    logger.info(
        "Received event: contactId=%s, assistantId=%s, domain=%s", contact_id, assistant_id, domain
    )
    if not contact_id or not instance_arn or not domain:
        logger.error("Missing ContactId/InstanceARN/domain")
        return {"statusCode": 400, "profileFound": "false"}

    profile = _resolve_profile(domain, contact_data, attributes)
    if not profile:
        logger.info("No matching profile; proceeding without profile context")
        return {"statusCode": 200, "profileFound": "false"}

    # Map profile fields to the {{$.Custom.*}} keys the orchestration prompt reads.
    # A profile carries a user's full injected context: identity (name / id /
    # tier) AND recent-activity attributes (recentOrderId / orderStatus /
    # openCaseCount), stored as Customer Profiles custom Attributes. This is what
    # makes "create a profile for a new user" the one place to define everything
    # the agent should know about them. Profile-lookup runs LAST in the precall
    # chain, so a real per-user profile overrides the static context-injection
    # demo baseline. Custom attributes live under profile['Attributes'].
    attrs = profile.get("Attributes") or {}
    full_name = " ".join(p for p in [profile.get("FirstName"), profile.get("LastName")] if p)
    # customerId resolution: prefer the explicit customerNumber attribute (set by
    # setup-test-users.sh / ingested SAP data) — this is the SAP KUNNR that the
    # tool Lambda uses for access control. Fall back to AccountNumber (Cognito sub
    # for web-call users, or the seeded demo value) only when customerNumber is
    # absent, preserving backward compat with the demo profile.
    customer_id = attrs.get("customerNumber") or profile.get("AccountNumber", "")
    fields = {
        "customerName": full_name,
        "customerId": customer_id,
        "accountTier": attrs.get("accountTier", ""),
        "recentOrderId": attrs.get("recentOrderId", ""),
        "orderStatus": attrs.get("orderStatus", ""),
        "openCaseCount": attrs.get("openCaseCount", ""),
    }
    session_data = [
        {"key": k, "value": {"stringValue": v}} for k, v in fields.items() if v
    ]
    if not session_data:
        logger.info("Profile found but no mappable fields; nothing to inject")
        return {"statusCode": 200, "profileFound": "true", "dataCount": "0"}

    # Resolve the Q Connect session id (bound to the contact by an upstream
    # CreateWisdomSession + UpdateContactData) and write to the Custom namespace.
    # Wrapped so that a transient resolve/bridge error degrades to "proceed
    # without context" rather than hard-failing the call into the error branch.
    try:
        instance_id = instance_arn.rsplit("/", 1)[-1]
        describe_resp = connect.describe_contact(InstanceId=instance_id, ContactId=contact_id)
        session_arn = describe_resp.get("Contact", {}).get("WisdomInfo", {}).get("SessionArn")
        session_id = session_arn.rsplit("/", 1)[-1] if session_arn else contact_id
        logger.info("Injecting %d profile field(s) into session %s", len(session_data), session_id)
        qconnect.update_session_data(
            assistantId=assistant_id,
            sessionId=session_id,
            namespace="Custom",
            data=session_data,
        )
    except Exception as e:  # noqa: BLE001
        logger.error("Profile bridge failed (resolve session / update_session_data): %s", e)
        return {"statusCode": 200, "profileFound": "true", "dataCount": "0"}

    return {"statusCode": 200, "profileFound": "true", "dataCount": str(len(session_data))}
