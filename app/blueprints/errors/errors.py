from flask import Blueprint, render_template

errors_bp = Blueprint('errors', __name__)

@errors_bp.app_errorhandler(404)
def error_404(error):
    return render_template('errors/404.html'), 404

@errors_bp.app_errorhandler(403)
def error_403(error):
    return render_template('errors/403.html'), 403

@errors_bp.app_errorhandler(500)
def error_500(error):
    return render_template('errors/500.html'), 500

@errors_bp.app_errorhandler(ConnectionError)
def error_connection(error):
    return render_template('errors/errors.html'), 'ConnectionError'