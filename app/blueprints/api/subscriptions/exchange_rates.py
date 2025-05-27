from apscheduler.schedulers.background import BackgroundScheduler
import requests
import json

exchange_rates = {"KES": 1.0}  # default to base
EXCHANGE_URL = "https://open.er-api.com/v6/latest/KES"

def fetch_exchange_rates():
    try:
        res = requests.get(EXCHANGE_URL, timeout=5)
        data = res.json()
        if data["result"] == "success":
            # Save locally in memory or file/db
            global exchange_rates
            exchange_rates = data["rates"]
            with open("exchange_rates.json", "w") as f:
                json.dump(exchange_rates, f)
    except Exception as e:
        print("Failed to update exchange rates:", e)

# Scheduler to run daily
scheduler = BackgroundScheduler()
scheduler.add_job(fetch_exchange_rates, 'interval', hours=24)
scheduler.start()

# On startup: load last saved rates if exist
try:
    with open("exchange_rates.json") as f:
        exchange_rates = json.load(f)
except FileNotFoundError:
    fetch_exchange_rates()
