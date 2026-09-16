"""
Custom Resource handler: seed the SAP orders table with sample data.

Populates two complete SAP SD order cycles on stack creation using the same
PK/SK/GSI1PK/GSI1SK item shape the runtime tool Lambda (sap-order) reads.
Update and Delete request types are no-ops.
"""

import json
import logging
import time
import urllib.request

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

TTL_SECONDS = 365 * 24 * 60 * 60  # 365 days


def handler(event, context):
    logger.info(
        "SeedData: RequestType=%s PhysicalResourceId=%s",
        event.get('RequestType'),
        event.get('PhysicalResourceId', '-'),
    )
    try:
        if event['RequestType'] == 'Create':
            seed_data(event['ResourceProperties']['TABLE_NAME'])
        # Update and Delete are no-ops
        send(event, context, 'SUCCESS')
    except Exception as e:
        logger.error(f"Seed error: {e}", exc_info=True)
        send(event, context, 'FAILED', reason=str(e))


def seed_data(table_name):
    """Populate 2 complete SAP SD order cycles as sample data."""
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(table_name)

    items = [
        # --- Order 12345: Fully completed cycle ---
        # Order header
        {
            'PK': 'ORDER#0000012345',
            'SK': 'HEADER',
            'VBELN': '0000012345',
            'customerNumber': '0000100042',
            'orderType': 'ZOR',
            'netValue': '15250.00',
            'currency': 'EUR',
            'requestedDeliveryDate': '2025-03-22',
            'salesOrg': '1000',
            'distributionChannel': '10',
            'division': '00',
        },
        # Order items
        {
            'PK': 'ORDER#0000012345',
            'SK': 'ITEM#000010',
            'itemNumber': '000010',
            'materialNumber': 'MAT-A100',
            'description': 'Premium Widget Assembly',
            'quantity': '100',
            'unit': 'EA',
            'netPrice': '12500.00',
            'currency': 'EUR',
        },
        {
            'PK': 'ORDER#0000012345',
            'SK': 'ITEM#000020',
            'itemNumber': '000020',
            'materialNumber': 'MAT-B200',
            'description': 'Standard Connector Kit',
            'quantity': '50',
            'unit': 'EA',
            'netPrice': '2750.00',
            'currency': 'EUR',
        },
        # Delivery (completed)
        {
            'PK': 'ORDER#0000012345',
            'SK': 'DELIVERY#0080012001',
            'VBELN': '0080012001',
            'goodsIssueDate': '2025-03-22',
            'actualGoodsIssueDate': '2025-03-22',
            'route': 'R00001',
            'shippingCondition': 'DDP',
            'shippingPoint': 'Hamburg',
            'totalWeight': '250',
            'weightUnit': 'KG',
        },
        # Delivery items
        {
            'PK': 'ORDER#0000012345',
            'SK': 'DELIVERY_ITEM#0080012001#000010',
            'deliveryNumber': '0080012001',
            'itemNumber': '000010',
            'materialNumber': 'MAT-A100',
            'description': 'Premium Widget Assembly',
            'quantity': '100',
            'unit': 'EA',
        },
        {
            'PK': 'ORDER#0000012345',
            'SK': 'DELIVERY_ITEM#0080012001#000020',
            'deliveryNumber': '0080012001',
            'itemNumber': '000020',
            'materialNumber': 'MAT-B200',
            'description': 'Standard Connector Kit',
            'quantity': '50',
            'unit': 'EA',
        },
        # Invoice (billed)
        {
            'PK': 'ORDER#0000012345',
            'SK': 'INVOICE#0090015001',
            'VBELN': '0090015001',
            'billingDate': '2025-03-23',
            'netValue': '15250.00',
            'taxAmount': '2897.50',
            'currency': 'EUR',
            'paymentTerms': 'Z030',
            'paymentTermsDescription': '30 days net',
            'dueDate': '2025-04-22',
        },
        # Invoice items
        {
            'PK': 'ORDER#0000012345',
            'SK': 'INVOICE_ITEM#0090015001#000010',
            'invoiceNumber': '0090015001',
            'itemNumber': '000010',
            'materialNumber': 'MAT-A100',
            'description': 'Premium Widget Assembly',
            'quantity': '100',
            'netPrice': '12500.00',
            'taxAmount': '2375.00',
        },
        {
            'PK': 'ORDER#0000012345',
            'SK': 'INVOICE_ITEM#0090015001#000020',
            'invoiceNumber': '0090015001',
            'itemNumber': '000020',
            'materialNumber': 'MAT-B200',
            'description': 'Standard Connector Kit',
            'quantity': '50',
            'netPrice': '2750.00',
            'taxAmount': '522.50',
        },
        # Customer index record
        {
            'PK': 'ORDER#0000012345',
            'SK': 'CUSTOMER_IDX',
            'GSI1PK': 'CUSTOMER#0000100042',
            'GSI1SK': 'ORDER#0000012345',
        },

        # --- Order 12346: In transit, no invoice ---
        # Order header
        {
            'PK': 'ORDER#0000012346',
            'SK': 'HEADER',
            'VBELN': '0000012346',
            'customerNumber': '0000100042',
            'orderType': 'ZOR',
            'netValue': '8500.00',
            'currency': 'EUR',
            'requestedDeliveryDate': '2025-03-28',
            'salesOrg': '1000',
            'distributionChannel': '10',
            'division': '00',
        },
        # Order item
        {
            'PK': 'ORDER#0000012346',
            'SK': 'ITEM#000010',
            'itemNumber': '000010',
            'materialNumber': 'MAT-C300',
            'description': 'Industrial Sensor Pack',
            'quantity': '25',
            'unit': 'EA',
            'netPrice': '8500.00',
            'currency': 'EUR',
        },
        # Delivery (in transit — no actual GI date)
        {
            'PK': 'ORDER#0000012346',
            'SK': 'DELIVERY#0080012002',
            'VBELN': '0080012002',
            'goodsIssueDate': '2025-03-26',
            'route': 'R00002',
            'shippingCondition': 'DDP',
            'shippingPoint': 'Munich',
            'totalWeight': '75',
            'weightUnit': 'KG',
        },
        # Delivery item
        {
            'PK': 'ORDER#0000012346',
            'SK': 'DELIVERY_ITEM#0080012002#000010',
            'deliveryNumber': '0080012002',
            'itemNumber': '000010',
            'materialNumber': 'MAT-C300',
            'description': 'Industrial Sensor Pack',
            'quantity': '25',
            'unit': 'EA',
        },
        # Customer index record
        {
            'PK': 'ORDER#0000012346',
            'SK': 'CUSTOMER_IDX',
            'GSI1PK': 'CUSTOMER#0000100042',
            'GSI1SK': 'ORDER#0000012346',
        },
    ]

    ttl_value = int(time.time()) + TTL_SECONDS

    with table.batch_writer() as batch:
        for item in items:
            item['ttl'] = ttl_value
            batch.put_item(Item=item)

    logger.info(f"Seeded {len(items)} items into {table_name}")


def send(event, context, status, reason=None):
    """Send CloudFormation custom resource response."""
    body = {
        'Status': status,
        'Reason': reason or f"See CloudWatch: {context.log_stream_name}",
        'PhysicalResourceId': event.get('PhysicalResourceId', context.log_stream_name),
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
    }
    req = urllib.request.Request(
        event['ResponseURL'],
        data=json.dumps(body).encode(),
        headers={'Content-Type': ''},
        method='PUT',
    )
    urllib.request.urlopen(req)
