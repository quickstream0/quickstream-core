from models import db, DeviceToken

def save_token(user_id, token, platform):
    existing = DeviceToken.query.filter_by(token=token).first()
    if not existing:
        new_token = DeviceToken(user_id=user_id, token=token, platform=platform)
        db.session.add(new_token)
        db.session.commit()
    return True

def get_tokens_by_user(user_id):
    return [t.token for t in DeviceToken.query.filter_by(user_id=user_id).all()]
