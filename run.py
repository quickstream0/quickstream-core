import os
from app import create_app, db
from dotenv import load_dotenv

load_dotenv()

app = create_app()

# app.app_context().push()    
# db.drop_all()
# db.create_all()

if __name__ == "__main__":
    host = os.getenv('HOST', '0.0.0.0')
    port = os.getenv('PORT', '5000')
    print(" * Running server")
    app.run(debug=False, use_reloader=False, host=host, port=port)