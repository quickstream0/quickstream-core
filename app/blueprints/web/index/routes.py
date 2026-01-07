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


# @index_bp.route('/static/files/app/v1/update.json')
# def update_json():
#     # Your JSON data
#     data = {
#         "update": {
#             "version": "1.0.18",
#             "build": 19,
#             "mandatory": true,
#             "notify_only": false,
#             "min_sdk": 24,
#             "release_date": "2026-01-07",
#             "apk": {
#                 "url": "https://github.com/quickstream0/app-release/releases/download/v1.0.18/quickstream-v1.0.18.apk",
#                 "size_mb": 79.6,
#                 "checksum_sha256": "A72FB8A0CFCCA1F1883F03494D3B6471CB2764B71313EAE6C298566AA7009C17"
#             },
#             "changelog": {
#                 "default": [
#                     "Add russian provider"
#                 ],
#                 "localized": {
#                     "ar": [
#                         "إضافة مزود الروسي"
#                     ],
#                     "de": [
#                         "Fügen Sie einen russischen Anbieter hinzu"
#                     ],
#                     "es": [
#                         "Agregar proveedor ruso"
#                     ],
#                     "fa": [
#                         "ارائه دهنده روسی را اضافه کنید"
#                     ],
#                     "fr": [
#                         "Ajouter un fournisseur russe"
#                     ],
#                     "hi": [
#                         "रूसी प्रदाता जोड़ें"
#                     ],
#                     "id": [
#                         "Tambahkan penyedia Rusia"
#                     ],
#                     "it": [
#                         "Aggiungi fornitore russo"
#                     ],
#                     "ja": [
#                         "ロシアのプロバイダーを追加"
#                     ],
#                     "ko": [
#                         "러시아 공급자 추가"
#                     ],
#                     "nl": [
#                         "Russische provider toevoegen"
#                     ],
#                     "pl": [
#                         "Dodaj rosyjskiego dostawcę"
#                     ],
#                     "pt": [
#                         "Adicionar provedor russo"
#                     ],
#                     "ru": [
#                         "Добавить российского провайдера"
#                     ],
#                     "sw": [
#                         "Ongeza mtoaji wa Kirusi"
#                     ],
#                     "th": [
#                         "เพิ่มผู้ให้บริการชาวรัสเซีย"
#                     ],
#                     "tr": [
#                         "Rus sağlayıcı ekle"
#                     ],
#                     "uk": [
#                         "Додати російського провайдера"
#                     ],
#                     "vi": [
#                         "Thêm nhà cung cấp Nga"
#                     ],
#                     "zh": [
#                         "添加俄罗斯提供商"
#                     ]
#                 }
#             }
#         }
#     }
    
#     # Return as text/plain with explicit Content-Type
#     return Response(
#         json.dumps(data),
#         mimetype='text/plain',
#         headers={
#             'Content-Type': 'text/plain; charset=utf-8'
#         }
#     )

