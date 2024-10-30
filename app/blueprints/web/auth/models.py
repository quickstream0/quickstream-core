# from uuid import uuid4
# from datetime import datetime, timedelta
# from flask import current_app
# from werkzeug.security import generate_password_hash, check_password_hash
# from itsdangerous import URLSafeTimedSerializer as Serializer, SignatureExpired, BadSignature
# from flask_login import UserMixin
# from app import db, login_manager


# @login_manager.user_loader
# def load_user(user_id):
#     return User.query.get(user_id)

# class User(db.Model, UserMixin):
#     __tablename__ = 'user'
#     id = db.Column(db.Integer(), primary_key=True, autoincrement=True)
#     user_id = db.Column(db.String(64), unique=True, default=str(uuid4()))
#     email = db.Column(db.String(60), unique=True, nullable=False)
#     username = db.Column(db.String(20), unique=True, nullable=False)
#     password = db.Column(db.String(255), nullable=False)
#     name = db.Column(db.String(40))
#     profile = db.Column(db.String(64), default='default.png')
#     status = db.Column(db.DateTime(), default=datetime.now())
#     created_at = db.Column(db.DateTime(), default=datetime.now())
#     verified = db.Column(db.Boolean(), default=False)

#     def __repr__(self):
#         return f"<User {self.username}>"
    
#     def set_password(self, password):
#         self.password = generate_password_hash(password)

#     def check_password(self, password):
#         return check_password_hash(self.password, password)
    
#     @classmethod
#     def get_username(cls, username):
#         return cls.query.filter_by(username=username).first()
    
#     @classmethod
#     def get_email(cls, email):
#         return cls.query.filter_by(email=email).first()
    
#     def update_account(self, form):
#         try:
#             self.email = form.get('email')
#             self.username = form.get('username')
#             db.session.commit()
#             return True, None
#         except Exception as e:
#             db.session.rollback()
#             return False, str(e)
    
#     def save(self):
#         db.session.add(self)
#         db.session.commit()

#     def delete(self):
#         db.session.delete(self)
#         db.session.commit()

#     def get_reset_token(self, max_age=1800):
#         s = Serializer(current_app.config['SECRET_KEY'])
#         expires = datetime.utcnow() + timedelta(seconds=max_age)
#         expires_timestamp = int(expires.timestamp())
#         token =  s.dumps({'user_id': self.user_id, 'exp': expires_timestamp})
#         return token
    
#     @staticmethod
#     def verify_reset_token(token):
#         s = Serializer(current_app.config['SECRET_KEY'])
#         try:
#             data = s.loads(token)
#             user_id = data['user_id']
#             current_timestamp = int(datetime.utcnow().timestamp())
#             if 'exp' in data and data['exp'] < current_timestamp:
#                 print("Token has expired.")
#                 return None
#         except SignatureExpired:
#             print("Token has expired.")
#             return None
#         except BadSignature:
#             print("Invalid token signature.")
#             return None
#         user = User.query.filter_by(user_id=user_id).first()
#         return user

#     def reg_date(self):
#         return self.created_at.strftime('%Y-%m-%d')
    
# class TokenBlocklist(db.Model):
#     __tablename__ = 'token_blocklist'
#     id = db.Column(db.Integer(), primary_key=True)
#     jti = db.Column(db.String(255), nullable=True)
#     created_at = db.Column(db.DateTime(), default=datetime.now())

#     def __repr__(self):
#         return f"<Token {self.jti}>"
    
#     def save(self):
#         db.session.add(self)
#         db.session.commit()

#     def delete(self):
#         db.session.delete(self)
#         db.session.commit()