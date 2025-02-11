from flask import Flask, Blueprint
from .extensions import db, jwt, bcrypt, mail, migrate, login_manager
from .config import Config

# import blueprints
from .blueprints.web.index import index_bp
from .blueprints.web.auth import auth_view
from .blueprints.api.auth import auth_bp
from .blueprints.api.payments import mpesa_bp
from .blueprints.api.payments import card_bp
from .blueprints.api.subscriptions import subscription_bp
from .blueprints.utils.jwt import jwt_handler
from .blueprints.errors.errors import errors_bp

def create_app():
    app = Flask(__name__)
    app.config.from_object(Config)

    # initialize extensions
    db.init_app(app)
    migrate.init_app(app, db)
    bcrypt.init_app(app)
    jwt.init_app(app)
    mail.init_app(app)
    login_manager.init_app(app)

    # register blueprints
    app.register_blueprint(index_bp)
    app.register_blueprint(auth_view)
    app.register_blueprint(jwt_handler)
    app.register_blueprint(errors_bp)

    # Create a blueprint for the API prefix
    api = Blueprint('api', __name__, url_prefix='/api')

    # register blueprints
    api.register_blueprint(auth_bp)
    api.register_blueprint(mpesa_bp)
    api.register_blueprint(card_bp)
    api.register_blueprint(subscription_bp)

    # Register the API blueprint with the main app
    app.register_blueprint(api)

    return app
