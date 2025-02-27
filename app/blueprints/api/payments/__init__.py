from flask import Blueprint

mpesa_bp = Blueprint('mpesa', __name__, url_prefix='/mpesa')
pesapal_bp = Blueprint('pesapal', __name__, url_prefix='/pesapal')

from . import mpesa
from . import pesapal