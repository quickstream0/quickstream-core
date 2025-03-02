from uuid import uuid4
from datetime import datetime, timedelta
from sqlalchemy.orm import validates
from app import db


class AnonPlan(db.Model):
    __tablename__ = 'anon_plan'

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    plan_id = db.Column(db.String(64), unique=True, default=lambda: str(uuid4()))
    expiry_date = db.Column(db.DateTime, nullable=False)
    duration = db.Column(db.Integer, nullable=False)
    device_id = db.Column(db.String(64), db.ForeignKey('user.user_id'), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.now)
    status = db.Column(db.String(10), default="active")

    @validates('duration')
    def validate_duration(self, key, value):
        """Ensure duration is positive and set expiry_date automatically."""
        if value <= 0:
            raise ValueError("Duration must be a positive integer.")
        self.expiry_date = datetime.now() + timedelta(days=value)
        return value

    def is_active(self):
        """Check if subscription is still active."""
        return self.expiry_date > datetime.now()

    def remaining_time(self):
        """Return remaining time in days or hours."""
        remaining = self.expiry_date - datetime.now()
        if remaining.total_seconds() > 86400:  # More than a day
            return f"{remaining.days} days"
        elif remaining.total_seconds() > 0:  # Less than a day
            return f"{int(remaining.total_seconds() / 3600)} hours"
        else:
            return "Expired"

    def expire_subscription(self):
        """Mark subscription as expired if time has passed."""
        if not self.is_active():
            self.status = "expired"

class Plan(db.Model):
    __tablename__ = 'plan'

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    plan_id = db.Column(db.String(40), unique=True, default=lambda: str(uuid4()))
    expiry_date = db.Column(db.DateTime, nullable=False)
    duration = db.Column(db.Integer, nullable=False)  # Store duration in days
    name = db.Column(db.String(40), nullable=False)
    transaction_id = db.Column(db.String(40), db.ForeignKey('transaction.transaction_id'))
    transaction_status = db.Column(db.String(10), default="pending") 
    period = db.Column(db.String(10)) 
    user_id = db.Column(db.String(40), db.ForeignKey('user.user_id'), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.now)
    status = db.Column(db.String(10), default="pending_payment")  # active, expired

    @validates('duration')
    def validate_duration(self, key, value):
        """Ensure duration is positive and set expiry_date automatically."""
        if value <= 0:
            raise ValueError("Duration must be a positive integer.")
        self.expiry_date = datetime.now() + timedelta(days=value)
        return value

    def is_active(self):
        """Check if subscription is still active."""
        return self.expiry_date > datetime.now()

    def remaining_time(self):
        """Return remaining time in days or hours."""
        remaining = self.expiry_date - datetime.now()
        if remaining.total_seconds() > 86400:  # More than a day
            return f"{remaining.days} days"
        elif remaining.total_seconds() > 0:  # Less than a day
            return f"{int(remaining.total_seconds() / 3600)} hours"
        else:
            return "Expired"

    def expire_subscription(self):
        """Mark subscription as expired if time has passed."""
        if not self.is_active():
            self.status = "expired"

    def save(self):
        db.session.add(self)
        db.session.commit()

    def delete(self):
        db.session.delete(self)
        db.session.commit()


class PricingPlan(db.Model):
    __tablename__ = 'pricing_plan'
    id = db.Column(db.Integer(), primary_key=True, autoincrement=True)
    name = db.Column(db.String(64))
    duration = db.Column(db.String(64))
    price = db.Column(db.String(64))
    updated_at = db.Column(db.DateTime(), default=datetime.now())

    def save(self):
        db.session.add(self)
        db.session.commit()

    def delete(self):
        db.session.delete(self)
        db.session.commit()