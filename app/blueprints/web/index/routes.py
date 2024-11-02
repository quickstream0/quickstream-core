import requests
from flask import render_template, Response

from . import index_bp

@index_bp.route('/')
def index():
    return render_template('index.html')

@index_bp.route('/pricing')
def pricing():
    return render_template('pricing.html')

@index_bp.route('/download')
def download():
    url = "https://github.com/quickstream0/quickstream-core/releases/download/v1.0.0/quickstream-v1.0.0.apk"

    # Send request to GitHub to fetch the file
    response = requests.get(url, stream=True)
    
    if response.status_code == 200:
        # Send the file to the client
        return Response(
            response.iter_content(chunk_size=8192),
            headers={
                'Content-Disposition': 'attachment; filename="quickstream-v1.0.0.apk"',
                'Content-Type': 'application/octet-stream'
            }
        )
    else:
        return "Failed to download file", response.status_code
