import os
from flask import render_template, current_app, Response

from . import index_bp

@index_bp.route('/')
def index():
    return render_template('index.html')

@index_bp.route('/pricing')
def pricing():
    return render_template('pricing.html')

@index_bp.route('/contact')
def contact():
    return render_template('contact.html')

@index_bp.route('/faq')
def faq():
    return render_template('faq.html')


@index_bp.route('/static/files/app/v2/update.json')
def custom_update_json():
    # Read the actual static file
    static_file_path = os.path.join(current_app.static_folder, 'files', 'app', 'v1', 'update.json')
    
    # Read with explicit UTF-8 encoding
    with open(static_file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Return as text/plain
    return Response(content, content_type='text/plain')
