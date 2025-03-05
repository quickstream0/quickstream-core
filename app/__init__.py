import os
from flask import Flask, Blueprint
from .extensions import db, jwt, bcrypt, mail, migrate, login_manager
from .config import DevelopmentConfig, ProductionConfig

# import blueprints
from .blueprints.web.index import index_bp
from .blueprints.web.auth import auth_view
from .blueprints.api.auth import auth_bp
from .blueprints.api.payments import pesapal_bp, mpesa_bp
from .blueprints.api.subscriptions import subscription_bp
from .blueprints.utils.jwt import jwt_handler
from .blueprints.errors.errors import errors_bp

def create_app():
    app = Flask(__name__)

    # Determine environment and load the correct config
    env = os.getenv('FLASK_ENV', 'production').lower()
    if env == "development":
        app.config.from_object(DevelopmentConfig)
    else:
        app.config.from_object(ProductionConfig)

    # Import config
    from app.blueprints.api.payments.pesapal import init_pesapal

   # Initialize config 
    init_pesapal(app)

    # Initialize extensions
    db.init_app(app)
    migrate.init_app(app, db)
    bcrypt.init_app(app)
    jwt.init_app(app)
    mail.init_app(app)
    login_manager.init_app(app)

    # Register blueprints
    app.register_blueprint(index_bp)
    app.register_blueprint(auth_view)
    app.register_blueprint(jwt_handler)
    app.register_blueprint(errors_bp)

    # Create and register the API blueprint
    api = Blueprint('api', __name__, url_prefix='/api')
    api.register_blueprint(auth_bp)
    api.register_blueprint(pesapal_bp)
    api.register_blueprint(mpesa_bp)
    api.register_blueprint(subscription_bp)
    
    app.register_blueprint(api)

    return app