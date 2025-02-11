from flask import Blueprint

mpesa_bp = Blueprint('mpesa', __name__, url_prefix='/mpesa')
card_bp = Blueprint('card', __name__, url_prefix='/card')

from . import mpesa
from . import card