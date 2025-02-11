from uuid import uuid4
from datetime import datetime, timedelta
from app import db

class Subscription(db.Model):
    __tablename__ = 'subscription'
    id = db.Column(db.Integer(), primary_key=True, autoincrement=True)
    subscription_id = db.Column(db.String(64), unique=True, default=str(uuid4()))
    expiry_date = db.Column(db.DateTime(), default=datetime.now())
    duration = db.Column(db.Integer())
    type = db.Column(db.String(64))
    transaction_id = db.Column(db.String(64), db.ForeignKey('transaction.transaction_id'))
    user_id = db.Column(db.String(64), db.ForeignKey('user.user_id'))
    created_at = db.Column(db.DateTime(), default=datetime.now())