import os
from flask import render_template, current_app, Response

from . import index_bp

@index_bp.route('/')
def index():
    return render_template('index.html')

@index_bp.route('/android')
def android():
    return render_template('android.html', title='Android')

@index_bp.route('/windows')
def windows():
    return render_template('windows.html', title='Windows')

@index_bp.route('/privacy')
def privacy():
    return render_template('privacy.html', title='Privacy Policy')

@index_bp.route('/terms')
def terms():
    return render_template('terms.html', title='Terms of Use')


# @index_bp.route('/static/files/app/v2/update.json')
# def custom_update_json():
#     # Read the actual static file (v2 uses same update.json as v1)
#     static_file_path = os.path.join(current_app.static_folder, 'files', 'app', 'v1', 'update.json')
    
#     # Read with explicit UTF-8 encoding
#     with open(static_file_path, 'r', encoding='utf-8') as f:
#         content = f.read()
    
#     # Return as text/plain
#     return Response(content, content_type='text/plain')

# @index_bp.route('/static/files/app/v2/update.json')
# def custom_update_json():
#     return redirect(url_for('static', filename='files/app/v1/update.json'))

@index_bp.route('/static/files/app/v2/update.json')
def custom_update_json():
    # Defines the directory where the file lives
    directory = os.path.join(current_app.static_folder, 'files', 'app', 'v1')
    
    return send_from_directory(directory, 'update.json')

