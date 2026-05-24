from flask import Blueprint, request, jsonify
from services.fcm_service import send_to_token, send_to_multiple
from services.token_service import get_tokens_by_user

notifications_bp = Blueprint("notifications", __name__)

@notifications_bp.route("/send", methods=["POST"])
def send_notification():
    data = request.json
    user_id = data.get("user_id")
    tokens = get_tokens_by_user(user_id)
    if not tokens:
        return jsonify({"error": "No tokens found"}), 404
    
    result = send_to_multiple(tokens, data["title"], data["body"], data.get("data"))
    return jsonify(result)
