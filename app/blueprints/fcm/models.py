from app import db

class DeviceToken(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.String(50), nullable=False)
    token = db.Column(db.String(255), unique=True, nullable=False)
    platform = db.Column(db.String(20))  # e.g., android, ios, web
