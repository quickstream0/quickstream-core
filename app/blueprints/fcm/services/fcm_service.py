from pyfcm import FCMNotification
from config import Config

push_service = FCMNotification(api_key=Config.FIREBASE_SERVER_KEY)

def send_to_token(token, title, body, data=None):
    return push_service.notify_single_device(
        registration_id=token,
        message_title=title,
        message_body=body,
        data_message=data or {}
    )

def send_to_multiple(tokens, title, body, data=None):
    return push_service.notify_multiple_devices(
        registration_ids=tokens,
        message_title=title,
        message_body=body,
        data_message=data or {}
    )
