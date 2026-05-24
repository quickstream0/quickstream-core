from flask import Blueprint, request, jsonify
from services.token_service import save_token

tokens_bp = Blueprint("tokens", __name__)

@tokens_bp.route("/register_token", methods=["POST"])
def register_token():
    data = request.json
    save_token(data["user_id"], data["token"], data.get("platform", "unknown"))
    return jsonify({"status": "success"})
