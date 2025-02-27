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

class Plan(db.Model):
    __tablename__ = 'pricing_plan'
    id = db.Column(db.Integer(), primary_key=True, autoincrement=True)
    name = db.Column(db.String(64))
    duration = db.Column(db.Integer())
    price = db.Column(db.String(64))
    updated_at = db.Column(db.DateTime(), default=datetime.now())

    def save(self):
        db.session.add(self)
        db.session.commit()

    def delete(self):
        db.session.delete(self)
        db.session.commit()