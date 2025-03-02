from uuid import uuid4
from datetime import datetime, timedelta
from app import db

class Transaction(db.Model):
    __tablename__ = 'transaction'
    id = db.Column(db.Integer(), primary_key=True, autoincrement=True)
    transaction_id = db.Column(db.String(64), unique=True, default=lambda: str(uuid4()))
    card_number = db.Column(db.String(64))
    phone_number = db.Column(db.String(64))
    payment_method = db.Column(db.String(64))
    payment_account = db.Column(db.String(64))
    amount = db.Column(db.Integer(), nullable=False)
    currency = db.Column(db.String(10), default='KES')
    tracking_id = db.Column(db.String(64))
    merchant_reference = db.Column(db.String(64))
    payment_status = db.Column(db.String(64))
    status = db.Column(db.String(64), default='pending')
    user_id = db.Column(db.String(64), db.ForeignKey('user.user_id'))
    created_at = db.Column(db.DateTime(), default=db.func.now())

    def save(self):
        db.session.add(self)
        db.session.commit()

    def delete(self):
        db.session.delete(self)
        db.session.commit()
