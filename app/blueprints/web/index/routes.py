from flask import Blueprint, render_template

from . import index_bp

@index_bp.route('/')
def index():
    return render_template('index.html')




