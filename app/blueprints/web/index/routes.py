from flask import render_template

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

