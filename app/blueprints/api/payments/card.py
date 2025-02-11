from flask import jsonify, request
from flask_jwt_extended import jwt_required, current_user
import stripe
from app import db
from app.blueprints.api.payments.models import Transaction
from . import card_bp


# @card_bp.route('/payment', methods=['POST'])
# @jwt_required()
# def create_payment_intent():
#     try:
#         # Get payment data from your app
#         data = request.json
#         amount = data.get('amount')  # Amount in cents
#         currency = data.get('currency', 'usd')

#         # Create a PaymentIntent
#         intent = stripe.PaymentIntent.create(
#             amount=amount,
#             currency=currency,
#             payment_method_types=["card"],
#         )

#         return jsonify({
#             'clientSecret': intent['client_secret'],
#         }), 200
#     except Exception as e:
#         return jsonify({'error': str(e)}), 400

# Create the PaymentIntent
@card_bp.route('/create-payment-intent', methods=['POST'])
@jwt_required()
def create_payment_intent():
    try:
        data = request.json
        amount = data['amount']
        user_id = current_user.user_id

        # Create a PaymentIntent
        intent = stripe.PaymentIntent.create(
            amount=amount,
            currency='usd',
            payment_method_types=['card'],
        )

        # Save the transaction (initial status: pending)
        transaction = Transaction(
            user_id=user_id,
            amount=amount,
        )
        transaction.save()

        return jsonify({
            'clientSecret': intent['client_secret'],
            'transactionId': transaction.id,
        }), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 400

# Webhook to handle payment status updates
@card_bp.route('/webhook', methods=['POST'])
def stripe_webhook():
    payload = request.get_data(as_text=True)
    sig_header = request.headers.get('Stripe-Signature')
    endpoint_secret = 'your_webhook_secret'

    try:
        event = stripe.Webhook.construct_event(payload, sig_header, endpoint_secret)
    except stripe.error.SignatureVerificationError as e:
        return jsonify({'error': 'Webhook signature verification failed'}), 400

    # Handle the event
    if event['type'] == 'payment_intent.succeeded':
        payment_intent = event['data']['object']
        transaction = Transaction.query.filter_by(id=payment_intent.metadata['transactionId']).first()
        if transaction:
            transaction.status = 'succeeded'
            db.session.commit()
    elif event['type'] == 'payment_intent.payment_failed':
        payment_intent = event['data']['object']
        transaction = Transaction.query.filter_by(id=payment_intent.metadata['transactionId']).first()
        if transaction:
            transaction.status = 'failed'
            db.session.commit()

    return jsonify({'status': 'success'}), 200