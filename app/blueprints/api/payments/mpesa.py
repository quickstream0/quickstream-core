import base64
from flask_jwt_extended import jwt_required, current_user
import requests
from datetime import datetime
from requests.auth import HTTPBasicAuth
from app.config import get_env
from flask import jsonify, request
from . import mpesa_bp

# transaction_type = 'CustomerPayBillOnline'
transaction_type = 'CustomerBuyGoodsOnline'
passkey='bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919'
callback = 'https://quickstream.vercel.app/mpesa/callback'
user_id = None

# MPESA API URLs
CONSUMER_KEY = get_env("MPESA_CONSUMER_KEY")
CONSUMER_SECRET = get_env("MPESA_CONSUMER_SECRET")
STK_PUSH_URL = get_env("MPESA_STK_PUSH_URL")
AUTH_URL = get_env("MPESA_AUTH_URL")

@mpesa_bp.route('/payment', methods=['POST'])
@jwt_required()
def mpesa_express():
    data = request.get_json()
    amount = data.get('amount')
    phone = data.get('phone')
    user_id = current_user.user_id

    endpoint = STK_PUSH_URL
    access_token = get_access_token()
    headers = { "Authorization": "Bearer %s" % access_token }
    timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
    shortcode = '174379'#get_env('MPESA_BUSINESS_STORE_NUMBER')
    password = shortcode + passkey + timestamp
    password = base64.b64encode(password.encode('utf-8')).decode('utf-8')

    data = {
        "BusinessShortCode": shortcode,    
        "Password": password,    
        "Timestamp":timestamp,    
        "TransactionType": transaction_type,    
        "Amount": amount,    
        "PartyA": phone,    
        "PartyB": shortcode,    
        "PhoneNumber": phone,    
        "CallBackURL": callback,    
        "AccountReference": "Test",    
        "TransactionDesc": "Test Payment"
    }

    res = requests.post(endpoint, json=data, headers=headers)
    print(f"User ID REQ: {user_id}")
    return res.json()

@mpesa_bp.route('/callback', methods=['POST'])
def incoming():
    data = request.get_json()
    if data:
        # Process the callback data
        print(f"User ID RES: {user_id}")
        print(f"Received callback data: {data}, User ID {user_id}")
        return jsonify({"status": "success"}), 200
    else:
        return jsonify({"error": "No data received"}), 400

def get_access_token():
    consumer_key = CONSUMER_KEY
    consumer_secret = CONSUMER_SECRET
    endpoint = AUTH_URL

    r = requests.get(endpoint, auth=HTTPBasicAuth(consumer_key, consumer_secret))
    data = r.json()
    return data['access_token']