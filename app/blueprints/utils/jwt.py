from flask import Blueprint, jsonify
from app import jwt, db
from app.blueprints.api.auth.models import AnonUser, User, TokenBlocklist

jwt_handler = Blueprint('jwt_handler', __name__)

# load user

@jwt.user_lookup_loader
def user_lookup_callback(jwt_header, jwt_data):
    identity = jwt_data['sub']
    if identity == 'anonymous':
        return AnonUser.query.filter_by(user_id=jwt_data['user_id']).one_or_none()
    
    return User.query.filter_by(username=identity).one_or_none()

@jwt.additional_claims_loader
def make_additional_claims(identity):
    if identity == 'anonymous':
        return {"is_anonymous": True}
    return {"is_anonymous": False}


# error handlers

@jwt.expired_token_loader
def expired_token_callback(jwt_header, jwt_data):
    return jsonify(
        {
            "message": "Token has expired", 
            "error": "token_expired"
        }
    ), 401

@jwt.invalid_token_loader
def invalid_token_callback(error):
    return jsonify(
        {
            "message": "Signature verification failed", 
            "error": "invalid_token"
        }
    ), 401

@jwt.unauthorized_loader
def missing_token_callback(error):
    return jsonify(
        {
            "message": "Request doesnt contain valid token", 
            "error": "authorization_header"
        }
    ), 401

@jwt.token_in_blocklist_loader
def token_in_blocklist_callback(jwt_header, jwt_data):
    jti = jwt_data['jti']

    token = db.session.query(TokenBlocklist).filter(TokenBlocklist.jti==jti).scalar()

    return token