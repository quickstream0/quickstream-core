import os
from flask import render_template, redirect, url_for

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


@index_bp.route('/static/files/app/v2/update.json')
def custom_update_json():
    return redirect(url_for('static', filename='files/app/v1/update.json'))
