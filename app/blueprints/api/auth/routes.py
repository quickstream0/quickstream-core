from datetime import datetime, timedelta
from flask import jsonify, request

from app.blueprints.api.subscriptions.models import AnonPlan, Plan
from . import auth_bp
from flask_jwt_extended import (
    create_access_token, 
    create_refresh_token, 
    jwt_required, 
    get_jwt,
    get_jwt_identity, 
    current_user
    )
from .models import AnonUser, User, TokenBlocklist
from app import db

@auth_bp.route('/register', methods=['POST'])
def register_user():
    data = request.get_json()
    # print(f"Data from client: {data}")
    
    # Explicit checks for required fields
    if 'name' not in data:
        return jsonify({"message": "Name field is required"}), 400
    if 'username' not in data:
        return jsonify({"message": "Username field is required"}), 400
    if 'email' not in data:
        return jsonify({"message": "Email field is required"}), 400
    if 'password' not in data:
        return jsonify({"message": "Password field is required"}), 400

    # Check if username exists
    user = User.get_username(username=data.get('username'))
    if user:
        return jsonify({"message": "Username is taken. Please choose a different username"}), 409 

    # Check if email exists
    email = User.get_email(email=data.get('email'))
    if email:
        return jsonify({"message": "Email already exists"}), 409

    # Proceed with user creation
    new_user = User(
        name=data.get('name'),
        username=data.get('username'),
        email=data.get('email')
    )
    
    # Set hashed password
    new_user.set_password(password=data.get('password'))

    # Save new user to the database
    new_user.save()

    return jsonify({"message": "User registered successfully!"}), 201

@auth_bp.route('/anonymous-register', methods=['POST'])
def register_anon_user():
    data = request.get_json()
    print(f"Data from client: {data}")

    if 'device_id' not in data:
        return jsonify({"message": "device_id field is required"}), 400

    device_id = data.get('device_id')
    user = AnonUser.get_device_id(device_id=device_id)
    if user:
        return generate_anon_token(user.device_id)
    else:
        new_anon_user = AnonUser(device_id=device_id)
        new_anon_user.save()
        trial_plan = AnonPlan(device_id=device_id, duration=3)
        trial_plan.save()
        return generate_anon_token(device_id)

@auth_bp.route('/login', methods=['POST'])
def login_user():
    data = request.get_json()
    print(f"Data from client: {data}")

    if 'password' not in data:
        return jsonify({"message": "Password field is required"}), 400
    
    if 'username' in data:
        user = User.get_username(username=data.get('username'))

        if user and (user.check_password(password=data.get('password'))):
            return generate_token(user)
    elif 'email' in data:
        user = User.get_email(email=data.get('email'))
        if user and (user.check_password(password=data.get('password'))):
            return generate_token(user)
    else:
        return jsonify({"message": "username or email required"}), 400
        
    return jsonify({"message": "Invalid credentials"}), 401

def generate_token(user):
    access_token_expires = timedelta(days=7)
    refresh_token_expires = timedelta(days=14)
    access_token = create_access_token(identity=user.username, additional_claims={"user_id": user.user_id}, expires_delta=access_token_expires)
    refresh_token = create_refresh_token(identity=user.username, additional_claims={"user_id": user.user_id}, expires_delta=refresh_token_expires)

    return jsonify(
        {
            "tokens":{
                "access":access_token,
                "refresh":refresh_token
            }
        }
    ), 200

def generate_anon_token(device_id):
    access_token_expires = timedelta(days=7)
    refresh_token_expires = timedelta(days=14)
    access_token = create_access_token(identity='anonymous', additional_claims={"device_id": device_id}, expires_delta=access_token_expires)
    refresh_token = create_refresh_token(identity='anonymous', additional_claims={"device_id": device_id}, expires_delta=refresh_token_expires)

    return jsonify(
        {
            "tokens":{
                "access":access_token,
                "refresh":refresh_token
            }
        }
    ), 200

@auth_bp.route('/user-information', methods=['GET'])
@jwt_required()
def get_user():
    print(f"Request from client: ")
    formatted_date = current_user.created_at.strftime('%Y-%m-%d %H:%M:%S')
    if current_user.is_anonymous:
        user = {
            "device_id":current_user.device_id, 
            "is_anonymous":current_user.is_anonymous,
        }
        subscription = AnonPlan.query.filter_by(device_id=current_user.device_id).order_by(AnonPlan.expiry_date.desc()).first()
        if not subscription:
            subscription_data = {"plan": "none", "status": "none"}
        subscription_data = {
            "plan_id": subscription.plan_id,
            "plan": "free trial",
            "status": "active" if subscription.is_active() else "expired",
            "remaining_time": subscription.remaining_time(),
            "expiry_time": subscription.expiry_date.strftime("%Y-%m-%d %H:%M:%S")
        }
        return jsonify({"user": user, "subscription": subscription_data}), 200
    
    user = {
        "user_id":current_user.user_id, 
        "name":current_user.name,
        "username":current_user.username, 
        "email":current_user.email,
        "created_at":formatted_date,
        "profile_id":current_user.profile,
        "is_anonymous":current_user.is_anonymous,
        "verified":current_user.verified
    }
    subscription = Plan.query.filter_by(user_id=current_user.user_id).order_by(Plan.expiry_date.desc()).first()
    print(subscription)
    if not subscription:
        subscription_data = {"plan": "none", "status": "none"}
    else:
        subscription_data = {
            "plan_id": subscription.plan_id,
            "plan": subscription.name,
            "status": "active" if subscription.is_active() else "expired",
            "period": subscription.period,
            "remaining_time": subscription.remaining_time(),
            "expiry_time": subscription.expiry_date.strftime("%Y-%m-%d %H:%M:%S")
        }
    return jsonify({"user": user, "subscription": subscription_data}), 200


@auth_bp.route('/refresh', methods=['GET'])
@jwt_required(refresh=True)
def refresh_access():
    identity = get_jwt_identity()
    new_access_token = create_access_token(identity=identity)
    return jsonify({"access_token": new_access_token})


@auth_bp.route('/logout', methods=['GET'])
@jwt_required(verify_type=False)
def logout_user():
    jwt = get_jwt()
    logout(jwt)
    token_type = jwt['type']
    return jsonify({"message": f"{token_type} token revoked successfully"}), 200


def logout(jwt):
    jti = jwt['jti']
    token_b = TokenBlocklist(jti=jti)
    token_b.save() 


@auth_bp.route('/update-account', methods=['POST'])
@jwt_required()
def update_account():
    data = request.get_json()
    print(f"Data from client: {data}")

    user = current_user
    user.name = data.get('name'),
    user.username = data.get('username'),
    user.email = data.get('email'),
    db.session.commit()

    return jsonify({"message": "Account updated successfully!"}), 200

@auth_bp.route('/delete-account', methods=['GET'])
@jwt_required()
def delete_account():
    jwt = get_jwt()
    logout(jwt)
    User.query.filter_by(user_id=current_user.user_id).delete()
    db.session.commit()

    return jsonify({"message": "Account deleted successfully!"}), 200