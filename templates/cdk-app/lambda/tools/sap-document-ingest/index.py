"""
SAP document ingestion — S3 -> Lambda -> SapOrdersTable.

Parses the SAP SD order-to-cash JSON format documented in
`sap-sd-order-sample.json` (repo root) — technical SAP table/field names
(VBAK/VBAP sales order, LIKP/LIPS delivery, VBRK/VBRP billing, VBFA document
flow) — and maps it onto the same PK/SK/GSI1PK/GSI1SK item shape sap-seed
writes, so ingested documents land in SapOrdersTable alongside seed data.

A document may carry the full order-to-cash bundle (salesOrder + delivery +
billing, as in the sample file) or just one stage (e.g. a delivery-only or
billing-only extract); resolve_order_number() below falls back to the LIPS
VGBEL / VBFA document-flow chain when salesOrder.header is absent.
"""

import json
import logging
import os
import time
import urllib.parse

import boto3

log_level = os.environ.get('LOG_LEVEL', 'ERROR')
logger = logging.getLogger()
logger.setLevel(getattr(logging, log_level, logging.ERROR))

TABLE_NAME = os.environ.get('TABLE_NAME', '')
TTL_SECONDS = 365 * 24 * 60 * 60  # 365 days

s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(TABLE_NAME)


def handler(event, context):
    """Entry point for S3 ObjectCreated notifications."""
    records = event.get('Records', [])
    logger.info(f"Processing {len(records)} S3 event record(s)")

    processed = 0
    failed = 0
    for record in records:
        try:
            bucket = record['s3']['bucket']['name']
            key = urllib.parse.unquote_plus(record['s3']['object']['key'])
            process_document(bucket, key)
            processed += 1
        except Exception as e:
            # Log only non-sensitive metadata (bucket/key), never document body.
            logger.error(f"Failed to process object: {e}", exc_info=True)
            failed += 1

    logger.info(f"Ingestion complete: processed={processed} failed={failed}")
    if failed and not processed:
        # Let Lambda report failure when nothing succeeded, so S3/Lambda retry
        # policies and any configured DLQ can react.
        raise RuntimeError(f"Failed to process {failed} document(s)")


def process_document(bucket, key):
    logger.info(f"Fetching s3://{bucket}/{key}")
    obj = s3.get_object(Bucket=bucket, Key=key)
    body = obj['Body'].read()

    try:
        document = json.loads(body)
    except (ValueError, TypeError) as e:
        raise ValueError(f"Unable to parse {key} as JSON: {e}")

    items = extract_items(document)
    if not items:
        logger.info(f"No extractable order data in {key}")
        return

    ttl_value = int(time.time()) + TTL_SECONDS
    with table.batch_writer() as batch:
        for item in items:
            item['ttl'] = ttl_value
            batch.put_item(Item=item)

    logger.info(f"Wrote {len(items)} item(s) from {key} into {TABLE_NAME}")


def normalize_order_number(raw):
    """Strip non-digits and zero-pad to 10 digits (SAP VBELN format).

    Must stay behaviourally identical to the copy in sap-order/index.py:
    ingest writes the DynamoDB keys and the tool queries them, so a divergence
    here would store data under a key the lookup can't find. >10 digits is
    rejected rather than truncated, same as the query side.
    """
    digits = ''.join(c for c in str(raw or '') if c.isdigit())
    if not digits or len(digits) > 10:
        return ''
    return digits.zfill(10)


def resolve_order_number(document):
    """Determine the sales order number (VBELN) a document belongs to.

    Prefers the direct salesOrder.header.VBELN. Falls back to a delivery
    item's VGBEL (LIPS-VGBEL — SAP populates this with the originating sales
    order number), then walks the VBFA document-flow chain backward
    (billing -> delivery -> order) when only a billing document is present.
    """
    sales_order = document.get('salesOrder') or {}
    vbeln = (sales_order.get('header') or {}).get('VBELN')
    if vbeln:
        return normalize_order_number(vbeln)

    delivery_items = (document.get('delivery') or {}).get('items') or []
    if delivery_items and delivery_items[0].get('VGBEL'):
        return normalize_order_number(delivery_items[0]['VGBEL'])

    billing_items = (document.get('billing') or {}).get('items') or []
    flow_links = (document.get('documentFlow') or {}).get('links') or []
    if billing_items and billing_items[0].get('VGBEL'):
        # VBRP-VGBEL on a billing item is the originating delivery number;
        # walk the VBFA link (predecessor VBELV -> successor VBELN) backward
        # from that delivery number to find the order that produced it.
        delivery_vbeln = billing_items[0]['VGBEL']
        for link in flow_links:
            if link.get('VBELN') == delivery_vbeln:
                return normalize_order_number(link.get('VBELV'))

    return ''


def extract_items(document):
    """Map an SAP SD order-to-cash JSON document onto SapOrdersTable's
    PK/SK item shape (same shape sap-seed writes — see sap-sd-order-sample.json
    for the source field names: VBAK/VBAP, LIKP/LIPS, VBRK/VBRP).
    """
    order_number = resolve_order_number(document)
    if not order_number:
        raise ValueError(
            'unable to resolve order number: document has no salesOrder.header.VBELN, '
            'delivery item VGBEL, or resolvable VBFA document flow'
        )

    pk = f'ORDER#{order_number}'
    items = []

    sales_order = document.get('salesOrder') or {}
    header = sales_order.get('header') or {}
    if header:
        items.append({
            'PK': pk,
            'SK': 'HEADER',
            'VBELN': order_number,
            'customerNumber': normalize_order_number(header.get('KUNNR')),
            'orderType': header.get('AUART', ''),
            'netValue': str(header.get('NETWR', '')),
            'currency': header.get('WAERK', ''),
            'requestedDeliveryDate': header.get('VDATU', ''),
            'salesOrg': header.get('VKORG', ''),
            'distributionChannel': header.get('VTWEG', ''),
            'division': header.get('SPART', ''),
        })

    for line in sales_order.get('items', []):
        item_number = str(line.get('POSNR', ''))
        items.append({
            'PK': pk,
            'SK': f'ITEM#{item_number}',
            'itemNumber': item_number,
            'materialNumber': line.get('MATNR', ''),
            'description': line.get('ARKTX', ''),
            'quantity': str(line.get('KWMENG', '')),
            'unit': line.get('VRKME', ''),
            'netPrice': str(line.get('NETWR', '')),
            'currency': line.get('WAERK', header.get('WAERK', '')),
        })

    delivery = document.get('delivery') or {}
    delivery_header = delivery.get('header') or {}
    if delivery_header:
        delivery_number = normalize_order_number(delivery_header.get('VBELN'))
        items.append({
            'PK': pk,
            'SK': f'DELIVERY#{delivery_number}',
            'VBELN': delivery_number,
            'goodsIssueDate': delivery_header.get('WADAT', ''),
            'actualGoodsIssueDate': delivery_header.get('WADAT_IST', ''),
            'route': delivery_header.get('ROUTE', ''),
            'shippingCondition': delivery_header.get('INCO1', ''),
            'shippingPoint': delivery_header.get('INCO2', ''),
            'totalWeight': str(delivery_header.get('BTGEW', '')),
            'weightUnit': delivery_header.get('GEWEI', ''),
        })
        for line in delivery.get('items', []):
            item_number = str(line.get('POSNR', ''))
            items.append({
                'PK': pk,
                'SK': f'DELIVERY_ITEM#{delivery_number}#{item_number}',
                'deliveryNumber': delivery_number,
                'itemNumber': item_number,
                'materialNumber': line.get('MATNR', ''),
                'description': line.get('ARKTX', ''),
                'quantity': str(line.get('LFIMG', '')),
                'unit': line.get('VRKME', ''),
            })

    billing = document.get('billing') or {}
    billing_header = billing.get('header') or {}
    if billing_header:
        invoice_number = normalize_order_number(billing_header.get('VBELN'))
        billing_line_items = billing.get('items', [])
        # VBRK (billing header) carries no tax total in this source format;
        # derive it from the sum of VBRP (line item) MWSBP, matching how the
        # seed fixture's header taxAmount equals the sum of its line items.
        tax_total = sum(float(li.get('MWSBP', 0) or 0) for li in billing_line_items)
        items.append({
            'PK': pk,
            'SK': f'INVOICE#{invoice_number}',
            'VBELN': invoice_number,
            'billingDate': billing_header.get('FKDAT', ''),
            'netValue': str(billing_header.get('NETWR', '')),
            'taxAmount': f'{tax_total:.2f}' if billing_line_items else '',
            'currency': billing_header.get('WAERK', ''),
            'paymentTerms': billing_header.get('ZTERM', ''),
            # Not present in this source document (VBRK carries the payment
            # terms code but not a human-readable description or computed due
            # date — that requires joining table T052) — left blank rather
            # than guessed.
            'paymentTermsDescription': '',
            'dueDate': '',
        })
        for line in billing_line_items:
            item_number = str(line.get('POSNR', ''))
            items.append({
                'PK': pk,
                'SK': f'INVOICE_ITEM#{invoice_number}#{item_number}',
                'invoiceNumber': invoice_number,
                'itemNumber': item_number,
                'materialNumber': line.get('MATNR', ''),
                'description': line.get('ARKTX', ''),
                'quantity': str(line.get('FKIMG', '')),
                'netPrice': str(line.get('NETWR', '')),
                'taxAmount': str(line.get('MWSBP', '')),
            })

    customer_number = normalize_order_number(header.get('KUNNR')) if header else ''
    if customer_number:
        items.append({
            'PK': pk,
            'SK': 'CUSTOMER_IDX',
            'GSI1PK': f'CUSTOMER#{customer_number}',
            'GSI1SK': f'ORDER#{order_number}',
        })

    return items
