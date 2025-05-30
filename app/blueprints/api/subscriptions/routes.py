from decimal import ROUND_HALF_UP, Decimal
from flask import jsonify, request
from flask_jwt_extended import jwt_required, current_user 
from app.blueprints.api.subscriptions.exchange_rates import exchange_rates
from app.blueprints.api.subscriptions.models import AnonPlan, Plan
from . import subscription_bp
from .plans import plans

@subscription_bp.route('/subscriptions', methods=['GET'])
def subscription_data():
    currency = request.args.get('currency', 'KES').upper()
    rate = exchange_rates.get(currency)
    
    if rate is None:
        currency = 'KES'
        rate = 1.0

    converted = {
        "currency": currency,
        "subscriptions": [
            {
                **plan,
                "price": round_price(plan["price"] * rate)
            }
            for plan in plans["subscriptions"]
        ]
    }
    return jsonify(converted), 200

def round_price(value):
    return float(Decimal(value).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))

@subscription_bp.route('/trial-plan', methods=['GET'])
@jwt_required()
def save_trial_plan():
    trial_plan = Plan(
        user_id=current_user.user_id, 
        duration=7,
        name="Free trial",
        period="weekly",
    )
    trial_plan.save()
    return jsonify({"message": "subscribed to trial plan"}), 200

@subscription_bp.route('/plan', methods=['GET'])
@jwt_required()
def get_subscription():
    if current_user.is_anonymous:
        subscription = AnonPlan.query.filter_by(user_id=current_user.user_id).order_by(AnonPlan.expiry_date.desc()).first()
        
        return jsonify({
            "plan_id": subscription.plan_id,
            "plan": subscription.name,
            "status": "active" if subscription.is_active() else "expired",
            "remaining_time": subscription.remaining_time(),
            "expiry_date": subscription.expiry_date.strftime("%Y-%m-%d %H:%M:%S")
        }), 200
    
    subscription = Plan.query.filter_by(user_id=current_user.user_id).order_by(Plan.expiry_date.desc()).first()
    
    if not subscription:
        return jsonify({"message": "User is not subscribed"}), 404
    
    return jsonify({
        "plan_id": subscription.plan_id,
        "plan": subscription.name,
        "status": "active" if subscription.is_active() else "expired",
        "period": subscription.period,
        "remaining_time": subscription.remaining_time(),
        "expiry_date": subscription.expiry_date.strftime("%Y-%m-%d %H:%M:%S")
    }), 200


@subscription_bp.route('/plan-status', methods=['GET'])
@jwt_required()
def get_plan_status():
    if current_user.is_anonymous:
        plan = AnonPlan.query.filter_by(user_id=current_user.user_id).order_by(AnonPlan.expiry_date.desc()).first()
        expiry = plan.expiry_date.strftime("%Y-%m-%d %H:%M:%S")
        return jsonify({"status": "active" if plan.is_active() else "expired", "expiry": expiry}), 200
    plan = Plan.query.filter_by(user_id=current_user.user_id).order_by(Plan.expiry_date.desc()).first()
    expiry = None
    if not plan:
        return jsonify({"status": "none", "expiry": ""}), 200
    else:
        expiry = plan.expiry_date.strftime("%Y-%m-%d %H:%M:%S")
    return jsonify({"status": "active" if plan.is_active() else "expired", "expiry": expiry}), 200