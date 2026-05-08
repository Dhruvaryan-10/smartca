from flask import Flask, jsonify, request
from flask_cors import CORS
from pymongo import MongoClient
from dotenv import load_dotenv
from datetime import datetime, timedelta, timezone
import jwt
import os
import random
import certifi

# ==============================
# Load Environment Variables
# ==============================
load_dotenv()

app = Flask(__name__)
CORS(app)

SECRET_KEY = os.getenv("SECRET_KEY", "supersecret")

# ==============================
# MongoDB Connection
# ==============================

MONGO_URI = os.getenv(
    "MONGO_URI",
    "mongodb+srv://smartca:Smartca123@cluster0.ecup91v.mongodb.net/smartca?retryWrites=true&w=majority"
)

client = MongoClient(
    MONGO_URI,
    tls=True,
    tlsCAFile=certifi.where(),
    serverSelectionTimeoutMS=5000
)

db = client.smartca

# ==============================
# JWT Helper
# ==============================

def get_current_user():
    auth_header = request.headers.get("Authorization")

    if not auth_header:
        return None, "Token required"

    try:
        token = auth_header.split(" ")[1]
        decoded = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
        return decoded["phone"], None

    except jwt.ExpiredSignatureError:
        return None, "Token expired"

    except Exception:
        return None, "Invalid token"


# ==============================
# Helper: Fix MongoDB datetime
# ==============================

def get_expiry_time(record):
    expiry = record["expires_at"]

    # MongoDB returns naive datetime sometimes
    if expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=timezone.utc)

    return expiry


# ==============================
# Home Route
# ==============================

@app.route("/")
def home():
    return jsonify({"message": "SmartCA Backend Running"})


# ==============================
# SEND OTP
# ==============================

@app.route("/send-otp", methods=["POST"])
def send_otp():
    try:
        data = request.get_json()
        phone = data.get("phone")

        if not phone:
            return jsonify({"error": "Phone number required"}), 400

        otp = str(random.randint(100000, 999999))

        db.otp.update_one(
            {"phone": phone},
            {
                "$set": {
                    "otp": otp,
                    "expires_at": datetime.now(timezone.utc) + timedelta(minutes=5)
                }
            },
            upsert=True
        )

        print(f"OTP for {phone}: {otp}")

        return jsonify({"message": "OTP sent"}), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ==============================
# VERIFY LOGIN OTP
# ==============================

@app.route("/verify-login-otp", methods=["POST"])
def verify_login_otp():

    try:

        data = request.get_json()

        phone = data.get("phone")
        otp = data.get("otp")

        record = db.otp.find_one({"phone": phone})

        if not record:
            return jsonify({"error": "OTP not found"}), 400

        expiry = get_expiry_time(record)

        if datetime.now(timezone.utc) > expiry:
            return jsonify({"error": "OTP expired"}), 400

        if record["otp"] != otp:
            return jsonify({"error": "Invalid OTP"}), 400

        user = db.users.find_one({"phone": phone})

        if not user:
            return jsonify({"error": "User not registered"}), 400

        token = jwt.encode(
            {
                "phone": phone,
                "exp": datetime.now(timezone.utc) + timedelta(days=1)
            },
            SECRET_KEY,
            algorithm="HS256"
        )

        return jsonify({
            "message": "Login successful",
            "token": token
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ==============================
# VERIFY SIGNUP OTP
# ==============================

@app.route("/verify-signup-otp", methods=["POST"])
def verify_signup_otp():

    try:

        data = request.get_json()

        phone = data.get("phone")
        otp = data.get("otp")
        name = data.get("name")

        record = db.otp.find_one({"phone": phone})

        if not record:
            return jsonify({"error": "OTP not found"}), 400

        expiry = get_expiry_time(record)

        if datetime.now(timezone.utc) > expiry:
            return jsonify({"error": "OTP expired"}), 400

        if record["otp"] != otp:
            return jsonify({"error": "Invalid OTP"}), 400

        existing_user = db.users.find_one({"phone": phone})

        if existing_user:
            return jsonify({"error": "User already exists"}), 400

        db.users.insert_one({
            "phone": phone,
            "name": name,
            "created_at": datetime.now(timezone.utc)
        })

        token = jwt.encode(
            {
                "phone": phone,
                "exp": datetime.now(timezone.utc) + timedelta(days=1)
            },
            SECRET_KEY,
            algorithm="HS256"
        )

        return jsonify({
            "message": "Signup successful",
            "token": token
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ==============================
# DASHBOARD SUMMARY
# ==============================

@app.route("/dashboard-summary")
def dashboard_summary():

    phone, error = get_current_user()

    if error:
        return jsonify({"error": error}), 401

    income_total = sum(
        item["amount"] for item in db.income.find({"phone": phone})
    )

    expense_total = sum(
        item["amount"] for item in db.expenses.find({"phone": phone})
    )

    return jsonify({
        "total_income": income_total,
        "total_expenses": expense_total,
        "savings": income_total - expense_total
    })


# ==============================
# GET INCOME
# ==============================

@app.route("/get-income")
def get_income():

    phone, error = get_current_user()

    if error:
        return jsonify({"error": error}), 401

    data = list(db.income.find({"phone": phone}, {"_id": 0}))

    return jsonify(data)


# ==============================
# GET EXPENSE
# ==============================

@app.route("/get-expense")
def get_expense():

    phone, error = get_current_user()

    if error:
        return jsonify({"error": error}), 401

    data = list(db.expenses.find({"phone": phone}, {"_id": 0}))

    return jsonify(data)


# ==============================
# ADD INCOME
# ==============================

@app.route("/add-income", methods=["POST"])
def add_income():

    phone, error = get_current_user()

    if error:
        return jsonify({"error": error}), 401

    data = request.get_json()

    db.income.insert_one({
        "phone": phone,
        "title": data.get("title"),
        "amount": float(data.get("amount")),
        "category": data.get("category"),
        "date": datetime.now(timezone.utc)
    })

    return jsonify({"message": "Income added"})


# ==============================
# ADD EXPENSE
# ==============================

@app.route("/add-expense", methods=["POST"])
def add_expense():

    phone, error = get_current_user()

    if error:
        return jsonify({"error": error}), 401

    data = request.get_json()

    db.expenses.insert_one({
        "phone": phone,
        "title": data.get("title"),
        "amount": float(data.get("amount")),
        "category": data.get("category"),
        "date": datetime.now(timezone.utc)
    })

    return jsonify({"message": "Expense added"})


# ==============================
# MONTHLY ANALYTICS
# ==============================

@app.route("/monthly-analytics")
def monthly_analytics():

    phone, error = get_current_user()

    if error:
        return jsonify({"error": error}), 401

    months = ["Jan","Feb","Mar","Apr","May","Jun",
              "Jul","Aug","Sep","Oct","Nov","Dec"]

    monthly_data = []

    for i in range(1, 13):

        income_sum = sum(
            item["amount"] for item in db.income.find({
                "phone": phone,
                "$expr": {"$eq": [{"$month": "$date"}, i]}
            })
        )

        expense_sum = sum(
            item["amount"] for item in db.expenses.find({
                "phone": phone,
                "$expr": {"$eq": [{"$month": "$date"}, i]}
            })
        )

        monthly_data.append({
            "name": months[i-1],
            "income": income_sum,
            "expense": expense_sum
        })

    return jsonify(monthly_data)


# ==============================
# CATEGORY ANALYTICS
# ==============================

@app.route("/category-analytics")
def category_analytics():

    phone, error = get_current_user()

    if error:
        return jsonify({"error": error}), 401

    pipeline = [
        {"$match": {"phone": phone}},
        {
            "$group": {
                "_id": "$category",
                "total": {"$sum": "$amount"}
            }
        }
    ]

    results = list(db.expenses.aggregate(pipeline))

    formatted = [
        {"name": item["_id"], "value": item["total"]}
        for item in results
    ]

    return jsonify(formatted)


# ==============================
# Run Server
# ==============================

if __name__ == "__main__":
    app.run(debug=True)