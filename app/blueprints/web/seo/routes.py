from flask import Response, send_from_directory, url_for

from . import seo


@seo.route('/google6b5dc6ebd71e7df6.html')
def google_verification():
    return send_from_directory('static/seo', 'google6b5dc6ebd71e7df6.html')

@seo.route('/robots.txt')
def robots_sitemap():
    return send_from_directory('static/seo', 'robots.txt')

@seo.route('/sitemap.xml')
def sitemap():
    pages = [
        url_for('index.index', _external=True),
        # url_for('auth_view.login', _external=True),
        # url_for('auth_view.register', _external=True),
        url_for('index.faq', _external=True),
    ]

    xml = ['<?xml version="1.0" encoding="UTF-8"?>']
    xml.append('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9 http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">')

    for page in pages:
        xml.append('  <url>')
        xml.append(f'    <loc>{page}</loc>')
        xml.append('    <lastmod>2025-01-11</lastmod>')
        xml.append('    <changefreq>monthly</changefreq>')
        xml.append('    <priority>0.9</priority>')
        xml.append('  </url>')

    xml.append('</urlset>')

    return Response('\n'.join(xml), mimetype='application/xml')
