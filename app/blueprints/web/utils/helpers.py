from uuid import uuid4
import os
import secrets
from PIL import Image
from datetime import datetime, timedelta
from flask import Config, flash, url_for, current_app
from flask_login import current_user
from flask_mail import Message
from werkzeug.security import generate_password_hash
from itsdangerous import URLSafeTimedSerializer as Serializer, SignatureExpired, BadSignature

from app import db, mail
from app.blueprints.api.auth.models import User
from app.blueprints.utils.mail import Mail
from app.config import get_env


def register_user(form):
    try:
        hashed_password = generate_password_hash(form.password.data)
        user_id = str(uuid4())
        user = User(
            user_id=user_id,
            name=form.name.data, 
            username=form.username.data, 
            email=form.email.data, 
            password=hashed_password
        )
        db.session.add(user)
        db.session.commit()
        return True, user_id
    except Exception as e:
        db.session.rollback()
        return False, str(e)


def update_account(form):
    try:
        current_user.email = form['email']
        current_user.username = form['username']
        db.session.commit()
        return True, None
    except Exception as e:
        db.session.rollback()
        return False, str(e)

    
def reset_password(form, user):
    try:
        hashed_password = generate_password_hash(form.password.data)
        user.password = hashed_password
        db.session.commit()
        return True, None
    except Exception as e:
        db.session.rollback()
        return False, str(e)

def allowed_file(filename):
    ALLOWED_EXTENSIONS = {'jpg', 'jpeg', 'png'}
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def save_picture(form_picture, old_picture_filename):
    if not allowed_file(form_picture.filename):
        flash(f'Invalid file type. Please upload a JPG or PNG image!', 'error') 
        raise ValueError('Invalid file type. Please upload a JPG or PNG image.')
    
    random_hex = secrets.token_hex(8)
    _, f_ext = os.path.splitext(form_picture.filename)
    picture_fn = random_hex + f_ext
    picture_path = os.path.join(current_app.root_path, get_env('PROFILE_UPLOAD_FOLDER'), picture_fn)

    output_size = (200, 200) 
    i = Image.open(form_picture)
    i.thumbnail(output_size)
    i.save(picture_path)

    # Delete the old picture file if it's not the default
    if old_picture_filename != 'default.png':
        old_picture_path = os.path.join(current_app.root_path, get_env('PROFILE_UPLOAD_FOLDER'), old_picture_filename)
        if os.path.exists(old_picture_path):
            os.remove(old_picture_path)

    return picture_fn


def get_token(user_id):
    s = Serializer(current_app.config['SECRET_KEY'])
    expires = datetime.now() + timedelta(seconds=3600)
    expires_timestamp = int(expires.timestamp())
    token =  s.dumps({'user_id': user_id, 'exp': expires_timestamp})
    return token


def verify_token(token):
    s = Serializer(current_app.config['SECRET_KEY'])
    try:
        data = s.loads(token)
        user_id = data['user_id']
        current_timestamp = int(datetime.utcnow().timestamp())
        if 'exp' in data and data['exp'] < current_timestamp:
            print("Token has expired.")
            return None
    except SignatureExpired:
        print("Token has expired.")
        return None
    except BadSignature:
        print("Invalid token signature.")
        return None
    user = User.query.filter_by(user_id=user_id).first()
    return user


def send_reset_email(user):
    token = user.get_reset_token()
    reset_url = url_for("auth_view.reset_token", token=token, _external=True)
            
    mail = Mail(
        username=Config.MAIL_USERNAME,
        password=Config.MAIL_PASSWORD,
        host=Config.MAIL_SERVER,
        port=Config.MAIL_PORT
    )
    subject = "Password Reset Request"
    body = f'''<p>Password reset was requested for this email. Ignore this message if this was not you.</p>
                      <p>To reset your password, click <a href="{reset_url}"><strong>here</strong></a>.</p>'''
    mail.send_mail([user.email], subject, body, "QuckStream")

def send_verification_email(user_id, email):
    token = get_token(user_id)
    verify_url = url_for("auth_view.verify_email", token=token, _external=True)
    mail = Mail(
        username=Config.MAIL_USERNAME,
        password=Config.MAIL_PASSWORD,
        host=Config.MAIL_SERVER,
        port=Config.MAIL_PORT
    )
    subject = "Email Verification Request"
    body = f'''QuckStream account was registered with this email. Ignore this message if this was not you.
     

To verify your account visit: {verify_url}
'''
    mail.send_mail([email], subject, body, "QuckStream")
    
# def send_reset_email(user):
#     token = user.get_reset_token()
#     message = Message('Password Reset', recipients=[user.email]) 

#     reset_link = url_for('auth_view.reset_token', token=token, _external=True)

#     message.body = f'''Password reset was requested for this email. Ignore this message if this was not you.'''
    
#     message.html = f'''<p>Password reset was requested for this email. Ignore this message if this was not you.</p>
#                       <p>To reset your password, click <a href="{reset_link}"><strong>here</strong></a>.</p>'''

#     mail.send(message)


# def send_verification_email(user_id, email):
#     token = get_token(user_id)
#     verify_url = url_for("auth_view.verify_email", token=token, _external=True)
#     message = Message('Email Verification', recipients=[email])                  
#     message.body = f'''QuckStream account was registered with this email. Ignore this message if this was not you. 

# To verify your account visit: {verify_url}
# '''
#     mail.send(message)
