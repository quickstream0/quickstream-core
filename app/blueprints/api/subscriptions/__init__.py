from flask import Blueprint

subscription_bp = Blueprint('subscription', __name__)

from . import routes
