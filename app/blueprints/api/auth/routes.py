from flask import jsonify, request
from . import auth_bp
from flask_jwt_extended import (
    create_access_token, 
    create_refresh_token, 
    jwt_required, 
    get_jwt,
    get_jwt_identity, 
    current_user
    )
from .models import User, TokenBlocklist

@auth_bp.route('/register', methods=['POST'])
def register_user():
    data = request.get_json()
    print(f"Data from client: {data}")
    
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
    access_token = create_access_token(identity=user.username)
    refresh_token = create_refresh_token(identity=user.username)

    return jsonify(
        {
            "tokens":{
                "access":access_token,
                "refresh":refresh_token
            }
        }
    ), 200

@auth_bp.get('/user')
@jwt_required()
def get_user():
    print(f"Request from client: ")
    return jsonify(
        {
            "user": {
                "user_id":current_user.user_id, 
                "username":current_user.username, 
                "email":current_user.email
            }
        }
    ), 200

@auth_bp.get('/refresh')
@jwt_required(refresh=True)
def refresh_access():
    identity = get_jwt_identity()
    new_access_token = create_access_token(identity=identity)
    return jsonify({"access_token": new_access_token})

@auth_bp.get('/logout')
@jwt_required(verify_type=False)
def logout_user():
    jwt = get_jwt()
    jti = jwt['jti']
    token_type = jwt['type']
    token_b = TokenBlocklist(jti=jti)
    token_b.save()
    return jsonify({"message": f"{token_type} token revoked successfully"}), 200

