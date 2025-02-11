from flask import jsonify
from . import subscription_bp
from .data import data

@subscription_bp.route('/subscriptions', methods=['GET'])
def subscription_data():
    return jsonify({"subscriptions": data}), 200