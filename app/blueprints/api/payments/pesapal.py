import requests
from datetime import datetime, timedelta
from flask import jsonify, render_template, request
from flask_jwt_extended import jwt_required, current_user
from app import db
from app.blueprints.api.payments.models import Transaction
from app.blueprints.api.subscriptions.models import PendingPlan, Plan
from app.blueprints.utils.random import Generate
from . import pesapal_bp


# Global variables (initialized in `init_pesapal()`)
BASE_URL = None
CONSUMER_KEY = None
CONSUMER_SECRET = None
CALLBACK_URL = None
IPN_URL = None

def init_pesapal(app):
    """Initialize Pesapal config once, inside app context."""
    global BASE_URL, CONSUMER_KEY, CONSUMER_SECRET, CALLBACK_URL, IPN_URL
    BASE_URL = app.config["PESAPAL_BASE_URL"]
    CONSUMER_KEY = app.config["PESAPAL_CONSUMER_KEY"]
    CONSUMER_SECRET = app.config["PESAPAL_CONSUMER_SECRET"]
    CALLBACK_URL = f"{app.config['BASE_URL']}api/pesapal/callback"
    IPN_URL = f"{app.config['BASE_URL']}api/pesapal/ipn"

@pesapal_bp.route('/payment', methods=['POST'])
@jwt_required()
def payment_request():
    id = Generate.random_string(20)
    names = current_user.name.split(' ')
    client_data = request.get_json()
    amount = client_data.get('amount')
    days = client_data.get('days')
    currency = client_data.get('currency')
    period = client_data.get('period')
    name = client_data.get('name')
    description = client_data.get('description')
    notification_id = register_ipn()
    billing_address = {
        "email_address": current_user.email
    }

    # Handle names correctly
    if len(names) == 2:
        billing_address["first_name"] = names[0]
        billing_address["last_name"] = names[1]
    elif len(names) == 3:
        billing_address["first_name"] = names[0]
        billing_address["middle_name"] = names[1]
        billing_address["last_name"] = names[2]
    else:
        # If only one name is found, duplicate it as last_name
        billing_address["first_name"] = names[0]
        billing_address["last_name"] = names[0]

    payment_data = {
        "id": id,
        "amount": amount,
        "currency": currency,
        "description": description,
        "callback_url": CALLBACK_URL,
        "notification_id": notification_id,
        "billing_address": billing_address
    }

    response = create_payment_request(payment_data)
    if response.status_code == 200:
        data = response.json()
        tracking_id = data.get('order_tracking_id')
        merchant_reference = data.get('merchant_reference')
        # redirect_url = data.get('redirect_url')

        transaction = Transaction(
            transaction_id = id,
            amount = amount,
            tracking_id = tracking_id,
            merchant_reference = merchant_reference,
            user_id = current_user.user_id
        )
        transaction.save()
        plan = PendingPlan(
            user_id=current_user.user_id, 
            duration=days,
            period=period,
            name=name,
            transaction_id=id
        )
        plan.save()

        return data, 200
    else:
        raise Exception(f"Failed to process payment: {response.text}")


# Store token in memory to avoid unnecessary requests
access_token = None
token_expiry = None

def get_access_token():
    global access_token, token_expiry
    
    # Check if token is still valid
    if access_token and token_expiry and datetime.now() < token_expiry:
        return access_token
    
    url = f"{BASE_URL}api/Auth/RequestToken"
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    payload = {
        "consumer_key": CONSUMER_KEY,
        "consumer_secret": CONSUMER_SECRET
    }
    
    response = requests.post(url, json=payload, headers=headers)
    if response.status_code == 200:
        data = response.json()
        access_token = data.get("token")
        expires_in = data.get("expires_in", 3600)  # Default to 1 hour
        token_expiry = datetime.now() + timedelta(seconds=expires_in - 60)  # Renew 1 min before expiry
        return access_token
    else:
        raise Exception(f"Failed to get access token: {response.text}")


def register_ipn():
    token = get_access_token()
    url = f"{BASE_URL}api/URLSetup/RegisterIPN"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json", 
        "Accept": "application/json"
    }
    payload = {"url": IPN_URL, "ipn_notification_type": "GET"}
    response = requests.post(url, json=payload, headers=headers)
    if response.status_code == 200:
       return response.json().get("ipn_id")
    else:
        raise Exception(f"Failed to register ipn: {response.text}")


def create_payment_request(transaction_data):
    token = get_access_token()
    url = f"{BASE_URL}api/Transactions/SubmitOrderRequest"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json", 
        "Accept": "application/json"
    }
    response = requests.post(url, json=transaction_data, headers=headers)
    return response


def check_transaction_status(order_tracking_id):
    token = get_access_token()
    url = f"{BASE_URL}api/Transactions/GetTransactionStatus?orderTrackingId={order_tracking_id}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json", 
        "Accept": "application/json"
    }
    response = requests.get(url, headers=headers)
    return response


@pesapal_bp.route('/ipn', methods=['GET', 'POST'])
def ipn_notification():
    # data = request.get_json()
    # notification_type = data.get('OrderNotificationType')
    # tracking_id = data.get('OrderTrackingId')
    # merchant_reference = data.get('OrderMerchantReference')

    notification_type = request.args.get('OrderNotificationType')
    tracking_id = request.args.get('OrderTrackingId')
    merchant_reference = request.args.get('OrderMerchantReference')

    status = check_transaction_status(tracking_id)
    if status.status_code == 200:
        transaction_status = status.json()
        payment_status_description = transaction_status.get('payment_status_description')
        transaction = Transaction.query.filter_by(tracking_id=tracking_id).first()
        if transaction:
            transaction.status = payment_status_description.lower()
            transaction.payment_method = transaction_status.get('payment_method')
            transaction.payment_account = transaction_status.get('payment_account')
            db.session.commit()
        else:
            return jsonify({"error": "Transaction not found"}), 404

        pending_plan = PendingPlan.query.filter_by(transaction_id=transaction.transaction_id).first()
        if payment_status_description.lower() == 'completed':
            plan = Plan(
                user_id=pending_plan.user_id, 
                duration=pending_plan.duration,
                period=pending_plan.period,
                name=pending_plan.name,
                transaction_id=transaction.transaction_id,
                transaction_status='completed',
                status='active'
            )
            plan.save()
            db.session.commit()

        return jsonify(
            {
                "OrderNotificationType": notification_type,
                "OrderTrackingId": tracking_id,
                "OrderMerchantReference": merchant_reference,
                "status": 200
            }
        ), 200
    else:
        raise Exception(f"Failed to check transaction status: {status.text}")


@pesapal_bp.route('/callback', methods=['GET'])
def callback():
    status = None
    tracking_id = request.args.get('OrderTrackingId')
    transaction = Transaction.query.filter_by(tracking_id=tracking_id).first()
    if transaction:
        status = transaction.status
    return render_template('payment.html', status=status)
