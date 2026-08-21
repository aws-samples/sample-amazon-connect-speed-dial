"""
SAP SD order lookup — order status, delivery tracking, invoice status.

Backs the AgentCore gateway's SapOrderLookup target. Dispatches on the tool
name (get_order_history / get_order_status / get_delivery_tracking /
get_invoice_status / get_active_promotions), enforces access control via the
customer number partition key, and reads from the SapOrdersTable DynamoDB
table. get_active_promotions is the exception: static public campaign data,
no customer_number and no table read.
"""

import json
import logging
import os
import re
from datetime import date

import boto3
from boto3.dynamodb.conditions import Key

log_level = os.environ.get('LOG_LEVEL', 'ERROR')
logger = logging.getLogger()
logger.setLevel(getattr(logging, log_level, logging.ERROR))

TABLE_NAME = os.environ.get('TABLE_NAME', '')
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(TABLE_NAME)


def lambda_handler(event, context):
    """Dispatch to the appropriate tool handler based on AgentCore tool name."""
    try:
        tool_name = ''
        if context.client_context and hasattr(context.client_context, 'custom'):
            extended = context.client_context.custom.get('bedrockAgentCoreToolName', '')
            tool_name = extended.split('___')[-1] if '___' in extended else extended

        logger.info(f"Tool dispatched: {tool_name}")

        args = tool_args(event)
        # Log the RAW argument values (pre-normalization) so a lookup miss can be
        # traced to what the model actually sent — a wrong digit count from
        # ASR/formatting looks identical to a real "no orders" once normalized.
        logger.info("Raw tool args: %s", json.dumps(args, default=str))

        if tool_name == 'get_order_history':
            return handle_get_order_history(args)
        elif tool_name == 'get_order_status':
            return handle_get_order_status(args)
        elif tool_name == 'get_delivery_tracking':
            return handle_get_delivery_tracking(args)
        elif tool_name == 'get_invoice_status':
            return handle_get_invoice_status(args)
        elif tool_name == 'get_active_promotions':
            return handle_get_active_promotions(args)
        else:
            return {'statusCode': 400, 'body': json.dumps({'error': f'Unknown tool: {tool_name}'})}

    except Exception as e:
        logger.error(f"Handler error: {e}", exc_info=True)
        return {'statusCode': 500, 'body': json.dumps({'error': 'Internal server error'})}


def tool_args(event):
    """Unwrap tool arguments from various AgentCore Gateway payload shapes."""
    if isinstance(event, dict):
        for k in ('arguments', 'input', 'parameters', 'toolInput', 'body'):
            v = event.get(k)
            if isinstance(v, str):
                try:
                    v = json.loads(v)
                except (ValueError, TypeError):
                    v = None
            if isinstance(v, dict):
                return v
        return event
    return {}


def normalize_order_number(raw):
    """Normalize a spoken/typed SAP number to the 10-digit zero-padded VBELN/KUNNR form.

    SAP order and customer numbers are <=10 digits, stored left-zero-padded to
    10 (e.g. customer 100042 -> 0000100042). Callers rarely say the padding, so
    we strip separators and left-pad. Grouping separators are common from a
    German-locale voice model (100.042, 100 042) and are handled — the dots and
    spaces are stripped and the six digits pad correctly.

    Limits of this function (NOT a full fix for a wrong digit COUNT): if the
    spoken/heard digits are themselves wrong — e.g. one extra zero, "1000042"
    instead of "100042" — that is an in-range 7-digit number and pads to a valid
    but different id (0001000042). No normalization can recover that; the digit
    sequence is genuinely ambiguous. Such cases must be fixed upstream (the
    profile lookup so the number is never dictated, or ASR/model behaviour), not
    here. What this DOES guard is the >10-digit overflow: reject rather than
    silently truncate to a valid-but-wrong id.
    """
    if not raw:
        return ''
    digits = re.sub(r'[^0-9]', '', str(raw))
    if not digits or len(digits) > 10:
        return ''
    return digits.zfill(10)


def derive_order_lifecycle(items):
    """Derive overall order lifecycle status from existing record types."""
    sk_prefixes = {item.get('SK', '') for item in items}
    has_invoice = any(sk.startswith('INVOICE#') for sk in sk_prefixes)
    has_delivery_gi = any(
        item.get('actualGoodsIssueDate') for item in items
        if item.get('SK', '').startswith('DELIVERY#')
    )
    has_delivery = any(sk.startswith('DELIVERY#') for sk in sk_prefixes)

    if has_invoice:
        return 'Invoiced'
    if has_delivery_gi:
        return 'Delivered'
    if has_delivery:
        return 'In Delivery'
    return 'Open'


def format_order_response(items, order_number):
    """Format DynamoDB items into a structured order response."""
    header = None
    line_items = []
    for item in items:
        sk = item.get('SK', '')
        if sk.startswith('HEADER'):
            header = {
                'orderNumber': item.get('VBELN', order_number),
                'customerNumber': item.get('customerNumber', ''),
                'orderType': item.get('orderType', ''),
                'netValue': item.get('netValue', ''),
                'currency': item.get('currency', ''),
                'requestedDeliveryDate': item.get('requestedDeliveryDate', ''),
                'salesOrg': item.get('salesOrg', ''),
            }
        elif sk.startswith('ITEM#'):
            line_items.append({
                'itemNumber': item.get('itemNumber', ''),
                'materialNumber': item.get('materialNumber', ''),
                'description': item.get('description', ''),
                'quantity': item.get('quantity', ''),
                'unit': item.get('unit', ''),
                'netPrice': item.get('netPrice', ''),
            })

    status = derive_order_lifecycle(items)
    return {
        'order': header or {'orderNumber': order_number},
        'items': line_items,
        'status': status,
    }


def verify_order_ownership(order_number, customer_number):
    """Verify that the order belongs to the customer using the GSI.

    Returns True if ownership is confirmed, False otherwise. This is the
    hard access-control gate — even if the model sends a wrong customer
    number, data for another customer is never returned.
    """
    if not customer_number:
        return False
    gsi_resp = table.query(
        IndexName='GSI1',
        KeyConditionExpression=(
            Key('GSI1PK').eq(f'CUSTOMER#{customer_number}')
            & Key('GSI1SK').eq(f'ORDER#{order_number}')
        ),
    )
    return len(gsi_resp.get('Items', [])) > 0


def handle_get_order_history(args):
    """List all SAP sales orders for a customer, most recent first.

    Customer-scoped: the only input is customer_number, which is also the
    access-control key — the GSI query is partitioned by CUSTOMER#<num>, so a
    customer can only ever see their own orders. Returns one summary row per
    order (number, type, value, requested delivery date, derived lifecycle
    status) so the agent can answer 'what orders do I have' and then drill into
    a specific one via get_order_status.
    """
    customer_number = normalize_order_number(args.get('customer_number', ''))

    logger.info(f"get_order_history: customer={customer_number}")

    # Access control: customer_number is mandatory (it IS the partition key).
    if not customer_number:
        return {'statusCode': 403, 'body': json.dumps({'error': 'customer_number is required for access control'})}

    # GSI1 projects ALL, so this single query returns every record for the
    # customer (headers, items, deliveries, invoices) without per-order queries.
    gsi_resp = table.query(
        IndexName='GSI1',
        KeyConditionExpression=Key('GSI1PK').eq(f'CUSTOMER#{customer_number}'),
    )
    records = gsi_resp.get('Items', [])
    if not records:
        return {'statusCode': 200, 'body': json.dumps({'customerNumber': customer_number, 'orders': [], 'message': 'No orders found for this customer'})}

    # Group all records by order number, then summarize each order.
    by_order = {}
    for item in records:
        pk = item.get('PK', '')
        if not pk.startswith('ORDER#'):
            continue
        by_order.setdefault(pk[len('ORDER#'):], []).append(item)

    orders = []
    for order_number, items in by_order.items():
        header = next((i for i in items if i.get('SK', '').startswith('HEADER')), None)
        orders.append({
            'orderNumber': (header or {}).get('VBELN', order_number),
            'orderType': (header or {}).get('orderType', ''),
            'netValue': (header or {}).get('netValue', ''),
            'currency': (header or {}).get('currency', ''),
            'requestedDeliveryDate': (header or {}).get('requestedDeliveryDate', ''),
            'status': derive_order_lifecycle(items),
        })

    # Most recent first — VBELN is a zero-padded, monotonically increasing SAP
    # order number, so lexical sort on it matches chronological order.
    orders.sort(key=lambda o: o['orderNumber'], reverse=True)

    result = {'customerNumber': customer_number, 'orderCount': len(orders), 'orders': orders}
    return {'statusCode': 200, 'body': json.dumps(result, default=str)}


def handle_get_order_status(args):
    """Look up SAP order status by order number with ownership verification."""
    order_number = normalize_order_number(args.get('order_number', ''))
    customer_number = normalize_order_number(args.get('customer_number', ''))

    logger.info(f"get_order_status: order={order_number} customer={customer_number}")

    # Access control: customer_number is mandatory
    if not customer_number:
        return {'statusCode': 403, 'body': json.dumps({'error': 'customer_number is required for access control'})}

    if not order_number:
        # Customer-only lookup: list orders for this customer via GSI
        gsi_resp = table.query(
            IndexName='GSI1',
            KeyConditionExpression=Key('GSI1PK').eq(f'CUSTOMER#{customer_number}'),
        )
        orders = [item.get('GSI1SK', '').replace('ORDER#', '') for item in gsi_resp.get('Items', [])]
        if not orders:
            return {'statusCode': 200, 'body': json.dumps({'message': 'No orders found for this customer'})}
        # Return first order found
        order_number = orders[0]

    # Ownership check via GSI — reject if order does not belong to this customer
    if not verify_order_ownership(order_number, customer_number):
        return {'statusCode': 200, 'body': json.dumps({'message': f'Order {order_number} not found'})}

    pk = f'ORDER#{order_number}'

    # Query header + items
    header_resp = table.query(
        KeyConditionExpression=Key('PK').eq(pk) & Key('SK').begins_with('HEADER'),
    )
    items_resp = table.query(
        KeyConditionExpression=Key('PK').eq(pk) & Key('SK').begins_with('ITEM#'),
    )

    # Also check for delivery/invoice existence to derive status
    delivery_resp = table.query(
        KeyConditionExpression=Key('PK').eq(pk) & Key('SK').begins_with('DELIVERY#'),
    )
    invoice_resp = table.query(
        KeyConditionExpression=Key('PK').eq(pk) & Key('SK').begins_with('INVOICE#'),
    )

    all_items = (
        header_resp.get('Items', [])
        + items_resp.get('Items', [])
        + delivery_resp.get('Items', [])
        + invoice_resp.get('Items', [])
    )

    if not header_resp.get('Items'):
        return {'statusCode': 200, 'body': json.dumps({'message': f'Order {order_number} not found'})}

    result = format_order_response(all_items, order_number)
    return {'statusCode': 200, 'body': json.dumps(result, default=str)}


def handle_get_delivery_tracking(args):
    """Track delivery status for a SAP sales order with ownership verification."""
    order_number = normalize_order_number(args.get('order_number', ''))
    customer_number = normalize_order_number(args.get('customer_number', ''))
    delivery_number = normalize_order_number(args.get('delivery_number', ''))

    logger.info(f"get_delivery_tracking: order={order_number} customer={customer_number} delivery={delivery_number}")

    # Access control: customer_number is mandatory
    if not customer_number:
        return {'statusCode': 403, 'body': json.dumps({'error': 'customer_number is required for access control'})}

    if not order_number:
        return {'statusCode': 400, 'body': json.dumps({'error': 'order_number is required'})}

    # Ownership check via GSI — reject if order does not belong to this customer
    if not verify_order_ownership(order_number, customer_number):
        return {'statusCode': 200, 'body': json.dumps({'message': f'No deliveries found for order {order_number}'})}

    pk = f'ORDER#{order_number}'

    # Query deliveries
    if delivery_number:
        sk_condition = Key('SK').eq(f'DELIVERY#{delivery_number}')
    else:
        sk_condition = Key('SK').begins_with('DELIVERY#')

    delivery_resp = table.query(
        KeyConditionExpression=Key('PK').eq(pk) & sk_condition,
    )

    # Query delivery items
    delivery_items_resp = table.query(
        KeyConditionExpression=Key('PK').eq(pk) & Key('SK').begins_with('DELIVERY_ITEM#'),
    )

    deliveries = delivery_resp.get('Items', [])
    delivery_items = delivery_items_resp.get('Items', [])

    if not deliveries:
        return {'statusCode': 200, 'body': json.dumps({'message': f'No deliveries found for order {order_number}'})}

    # Format delivery response
    formatted_deliveries = []
    for d in deliveries:
        actual_gi = d.get('actualGoodsIssueDate', '')
        planned_gi = d.get('goodsIssueDate', '')
        today_str = date.today().isoformat()

        if actual_gi:
            status = 'Delivered' if actual_gi <= today_str else 'In Transit'
        elif planned_gi:
            status = 'Goods Issued'
        else:
            status = 'Planned'

        formatted_deliveries.append({
            'deliveryNumber': d.get('VBELN', ''),
            'status': status,
            'plannedGoodsIssueDate': planned_gi,
            'actualGoodsIssueDate': actual_gi,
            'route': d.get('route', ''),
            'shippingCondition': d.get('shippingCondition', ''),
            'totalWeight': d.get('totalWeight', ''),
            'weightUnit': d.get('weightUnit', ''),
            'estimatedArrival': d.get('estimatedArrival', planned_gi),
        })

    formatted_items = []
    for item in delivery_items:
        formatted_items.append({
            'itemNumber': item.get('itemNumber', ''),
            'materialNumber': item.get('materialNumber', ''),
            'description': item.get('description', ''),
            'quantity': item.get('quantity', ''),
            'unit': item.get('unit', ''),
        })

    result = {
        'orderNumber': order_number,
        'deliveries': formatted_deliveries,
        'deliveryItems': formatted_items,
    }
    return {'statusCode': 200, 'body': json.dumps(result, default=str)}


def handle_get_invoice_status(args):
    """Check invoice and billing status for a SAP sales order with ownership verification."""
    order_number = normalize_order_number(args.get('order_number', ''))
    customer_number = normalize_order_number(args.get('customer_number', ''))
    invoice_number = normalize_order_number(args.get('invoice_number', ''))

    logger.info(f"get_invoice_status: order={order_number} customer={customer_number} invoice={invoice_number}")

    # Access control: customer_number is mandatory
    if not customer_number:
        return {'statusCode': 403, 'body': json.dumps({'error': 'customer_number is required for access control'})}

    if not order_number:
        return {'statusCode': 400, 'body': json.dumps({'error': 'order_number is required'})}

    # Ownership check via GSI — reject if order does not belong to this customer
    if not verify_order_ownership(order_number, customer_number):
        return {'statusCode': 200, 'body': json.dumps({'message': f'No invoices found for order {order_number}'})}

    pk = f'ORDER#{order_number}'

    # Query invoices
    if invoice_number:
        sk_condition = Key('SK').eq(f'INVOICE#{invoice_number}')
    else:
        sk_condition = Key('SK').begins_with('INVOICE#')

    invoice_resp = table.query(
        KeyConditionExpression=Key('PK').eq(pk) & sk_condition,
    )

    # Query invoice items
    invoice_items_resp = table.query(
        KeyConditionExpression=Key('PK').eq(pk) & Key('SK').begins_with('INVOICE_ITEM#'),
    )

    invoices = invoice_resp.get('Items', [])
    invoice_items = invoice_items_resp.get('Items', [])

    if not invoices:
        return {'statusCode': 200, 'body': json.dumps({'message': f'No invoices found for order {order_number}', 'status': 'Not Invoiced'})}

    # Format invoice response
    formatted_invoices = []
    for inv in invoices:
        billing_date = inv.get('billingDate', '')
        status = 'Invoiced' if billing_date else 'Not Invoiced'

        formatted_invoices.append({
            'invoiceNumber': inv.get('VBELN', ''),
            'status': status,
            'billingDate': billing_date,
            'netValue': inv.get('netValue', ''),
            'taxAmount': inv.get('taxAmount', ''),
            'currency': inv.get('currency', ''),
            'paymentTerms': inv.get('paymentTerms', ''),
            'paymentTermsDescription': inv.get('paymentTermsDescription', ''),
            'dueDate': inv.get('dueDate', ''),
        })

    formatted_items = []
    for item in invoice_items:
        formatted_items.append({
            'itemNumber': item.get('itemNumber', ''),
            'materialNumber': item.get('materialNumber', ''),
            'description': item.get('description', ''),
            'quantity': item.get('quantity', ''),
            'netPrice': item.get('netPrice', ''),
            'taxAmount': item.get('taxAmount', ''),
        })

    overall_status = 'Invoiced' if any(inv.get('billingDate') for inv in invoices) else 'Not Invoiced'
    result = {
        'orderNumber': order_number,
        'status': overall_status,
        'invoices': formatted_invoices,
        'invoiceItems': formatted_items,
    }
    return {'statusCode': 200, 'body': json.dumps(result, default=str)}


# Current promotions. Static by design: promotions are campaign data, identical
# for every caller, so there is no per-customer row to look up and no
# customer_number required — this is the one tool an UNIDENTIFIED caller may
# use (the agent prompt says so explicitly). That also makes it the integration
# test's target: the promotion codes exist nowhere but here (not in the
# pre-loaded session context, not in the knowledge base), so their presence in
# an agent answer proves a live MCP tools/call round trip. Changing a code here
# means updating the test fixture that asserts it.
ACTIVE_PROMOTIONS = [
    {
        'promotionCode': 'WELCOME15',
        'title': 'Welcome discount',
        'description': '15 percent off the first order for new customers.',
        'discount': '15%',
        'validUntil': '2027-12-31',
    },
    {
        'promotionCode': 'FREESHIP100',
        'title': 'Free shipping',
        'description': 'Free standard shipping on orders above 100 EUR.',
        'discount': 'Free shipping',
        'validUntil': '2027-12-31',
    },
]


def handle_get_active_promotions(args):
    """List currently active promotions. No arguments, no access control —
    promotions are public campaign data, the same for every caller."""
    logger.info("get_active_promotions: %d promotion(s)", len(ACTIVE_PROMOTIONS))
    result = {'promotionCount': len(ACTIVE_PROMOTIONS), 'promotions': ACTIVE_PROMOTIONS}
    return {'statusCode': 200, 'body': json.dumps(result, default=str)}
