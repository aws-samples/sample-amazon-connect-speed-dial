"""
Custom Resource handler: seed prompt-texts data table.

Calls the Connect BatchCreateDataTableValue API directly via SigV4-signed
HTTP requests — avoids dependency on a specific boto3 version.

Each record has 'language' as the primary key and prompt IDs as attribute columns.

On Delete, calls BatchDeleteDataTableValue to remove them.
On Update, deletes old records then creates new ones (full replacement).

Environment variables:
  LOG_LEVEL — Python log level (default: ERROR).
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.request
from typing import Any

from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.session import Session as BotocoreSession

LOG_LEVEL = os.environ.get("LOG_LEVEL", "ERROR").upper()
logger = logging.getLogger(__name__)
logger.setLevel(getattr(logging, LOG_LEVEL, logging.ERROR))

REGION = os.environ.get("AWS_REGION", "eu-central-1")


def _send_response(event: dict, context: Any, status: str, data: dict, reason: str = "") -> None:
    """Send response to CloudFormation via the pre-signed S3 URL."""
    body = json.dumps({
        "Status": status,
        "Reason": reason or f"See CloudWatch Log Stream: {context.log_stream_name}",
        "PhysicalResourceId": event.get("PhysicalResourceId", context.log_stream_name),
        "StackId": event["StackId"],
        "RequestId": event["RequestId"],
        "LogicalResourceId": event["LogicalResourceId"],
        "Data": data,
    }).encode("utf-8")

    req = urllib.request.Request(
        event["ResponseURL"],
        data=body,
        headers={"Content-Type": "application/json", "Content-Length": str(len(body))},
        method="PUT",
    )
    urllib.request.urlopen(req)


def _signed_request(method: str, url: str, body: dict | None = None) -> dict:
    """Make a SigV4-signed request to the Connect API."""
    session = BotocoreSession()
    credentials = session.get_credentials().get_frozen_credentials()

    data = json.dumps(body).encode("utf-8") if body else None
    headers = {"Content-Type": "application/json"}

    aws_request = AWSRequest(method=method, url=url, data=data, headers=headers)
    SigV4Auth(credentials, "connect", REGION).add_auth(aws_request)

    req = urllib.request.Request(
        aws_request.url,
        data=data,
        headers=dict(aws_request.headers),
        method=method,
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8") if e.fp else ""
        logger.error("API error %d: %s", e.code, error_body)
        raise RuntimeError(f"Connect API {e.code}: {error_body}") from e


def _parse_instance_id(instance_arn_or_id: str) -> str:
    """Extract instance ID from ARN or return as-is."""
    if "/" in instance_arn_or_id:
        return instance_arn_or_id.rsplit("/", 1)[-1]
    return instance_arn_or_id


def _parse_table_id(data_table_arn: str) -> str:
    """Extract the table ID from the ARN."""
    return data_table_arn.rsplit("/", 1)[-1]


def _build_values(records: list[dict], primary_key: str = "language") -> list[dict]:
    """Build the Values list for BatchCreateDataTableValue.

    Each record: {<primary_key>: "value", "attr": "val", ...}
    The primary_key field is the PK; all other keys are attribute values.
    """
    values = []
    for rec in records:
        pk_value = rec[primary_key]
        primary_values = [{"AttributeName": primary_key, "Value": pk_value}]
        for attr_name, attr_value in rec.items():
            if attr_name == primary_key:
                continue
            values.append({
                "PrimaryValues": primary_values,
                "AttributeName": attr_name,
                "Value": attr_value,
            })
    return values


def _build_default_values(records: list[dict], default_language: str, primary_key: str = "language") -> list[dict]:
    """Build Values entries for the system Default row (no PrimaryValues).

    Finds the record matching `default_language` and emits entries without
    PrimaryValues — this tells the Connect API to write to the built-in
    Default row (yellow badge) rather than creating a normal keyed record.
    """
    # Find the record whose primary key matches the default language.
    default_rec = None
    for rec in records:
        if rec.get(primary_key) == default_language:
            default_rec = rec
            break

    if not default_rec:
        logger.warning(
            "No record found for default_language=%s; falling back to first record.",
            default_language,
        )
        default_rec = records[0] if records else None

    if not default_rec:
        return []

    values = []
    for attr_name, attr_value in default_rec.items():
        if attr_name == primary_key:
            continue
        values.append({
            "PrimaryValues": [],
            "AttributeName": attr_name,
            "Value": attr_value,
        })
    return values


def _create_records(instance_id: str, data_table_arn: str, records: list[dict], primary_key: str = "language", default_language: str = "") -> dict:
    """Create records via BatchCreateDataTableValue with retry.

    If `default_language` is provided, also populates the system Default row
    (no PrimaryValues) with values from the matching language record.
    """
    table_id = _parse_table_id(data_table_arn)
    values = _build_values(records, primary_key)

    # Append entries for the system Default row if a default language is specified.
    if default_language:
        default_values = _build_default_values(records, default_language, primary_key)
        values.extend(default_values)

    url = f"https://connect.{REGION}.amazonaws.com/data-tables/{instance_id}/{table_id}/values/create"

    last_error = None
    for attempt in range(3):
        try:
            resp = _signed_request("POST", url, {"Values": values})
            failed = resp.get("Failed", [])
            if failed:
                logger.error("Partial failure: %s", json.dumps(failed))
            return {"failed": str(len(failed)), "successful": str(len(resp.get("Successful", [])))}
        except Exception as e:
            last_error = e
            logger.warning("Attempt %d failed: %s", attempt + 1, str(e))
            time.sleep(5)

    raise last_error  # type: ignore[misc]


def _delete_records(instance_id: str, data_table_arn: str, records: list[dict], primary_key: str = "language", default_language: str = "") -> None:
    """Delete records via BatchDeleteDataTableValue."""
    table_id = _parse_table_id(data_table_arn)
    values = []
    for rec in records:
        pk_value = rec[primary_key]
        primary_values = [{"AttributeName": primary_key, "Value": pk_value}]
        for attr_name in rec:
            if attr_name == primary_key:
                continue
            values.append({
                "PrimaryValues": primary_values,
                "AttributeName": attr_name,
            })

    # Also delete system Default row values if default_language was set.
    if default_language:
        default_rec = None
        for rec in records:
            if rec.get(primary_key) == default_language:
                default_rec = rec
                break
        if default_rec:
            for attr_name in default_rec:
                if attr_name == primary_key:
                    continue
                values.append({
                    "PrimaryValues": [],
                    "AttributeName": attr_name,
                })

    url = f"https://connect.{REGION}.amazonaws.com/data-tables/{instance_id}/{table_id}/values/delete"
    try:
        _signed_request("POST", url, {"Values": values})
    except Exception as e:
        logger.warning("BatchDeleteDataTableValue error (non-fatal): %s", str(e))


def handler(event: dict, context: Any) -> None:
    """CloudFormation custom resource handler."""
    request_type = event.get("RequestType", "")
    props = event.get("ResourceProperties", {})
    old_props = event.get("OldResourceProperties", {})

    instance_id = _parse_instance_id(props.get("InstanceId", ""))
    data_table_arn = props.get("DataTableArn", "")
    records = json.loads(props.get("Records", "[]"))
    primary_key = props.get("PrimaryKeyName", "language")
    default_language = props.get("DefaultLanguage", "")

    logger.info(
        "RequestType=%s, InstanceId=%s, DataTableArn=%s, RecordCount=%d, PrimaryKey=%s, DefaultLanguage=%s",
        request_type, instance_id, data_table_arn, len(records), primary_key, default_language,
    )

    try:
        if request_type == "Create":
            result = _create_records(instance_id, data_table_arn, records, primary_key, default_language)
            _send_response(event, context, "SUCCESS", result)

        elif request_type == "Update":
            old_records = json.loads(old_props.get("Records", "[]"))
            old_instance_id = _parse_instance_id(old_props.get("InstanceId", instance_id))
            old_data_table_arn = old_props.get("DataTableArn", data_table_arn)
            old_primary_key = old_props.get("PrimaryKeyName", "language")
            old_default_language = old_props.get("DefaultLanguage", "")
            _delete_records(old_instance_id, old_data_table_arn, old_records, old_primary_key, old_default_language)
            result = _create_records(instance_id, data_table_arn, records, primary_key, default_language)
            _send_response(event, context, "SUCCESS", result)

        elif request_type == "Delete":
            _delete_records(instance_id, data_table_arn, records, primary_key, default_language)
            _send_response(event, context, "SUCCESS", {})

        else:
            _send_response(event, context, "FAILED", {}, f"Unknown RequestType: {request_type}")

    except Exception as e:
        logger.error("Handler failed: %s", str(e))
        _send_response(event, context, "FAILED", {}, str(e))
