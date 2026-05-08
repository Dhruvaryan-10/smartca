import mongoose from "mongoose";

const TransactionSchema = new mongoose.Schema({
  type: { type: String, enum: ["income", "expense"], required: true },
  amount: { type: Number, required: true },
  category: { type: String },
  date: { type: Date, required: true },
});

export default mongoose.models.Transaction ||
  mongoose.model("Transaction", TransactionSchema);