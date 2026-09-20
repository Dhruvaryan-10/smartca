// Reads a RAG evaluation dataset from the repository (rag-evals/<name>/: meta.json, gold-evidence.json, cases.json).
// The only place the evaluation dataset touches the file system. It reads local, committed files and fetches nothing.
import fs from "node:fs";
import path from "node:path";
import { EvalDatasetError, parseEvalDataset, verifyTestFreeze } from "./dataset";
import type { EvalDataset, RawEvalDataset } from "./dataset";

export const DEFAULT_EVAL_DIR = path.resolve(__dirname, "..", "..", "rag-evals", "ay-2026-27-v1");

const readJson = (directory: string, file: string): unknown => JSON.parse(fs.readFileSync(path.join(directory, file), "utf8").replace(/^﻿/, ""));

export function loadRawEvalDataset(directory: string = DEFAULT_EVAL_DIR): RawEvalDataset {
  return {
    meta: readJson(directory, "meta.json") as RawEvalDataset["meta"],
    goldEvidence: readJson(directory, "gold-evidence.json") as RawEvalDataset["goldEvidence"],
    cases: readJson(directory, "cases.json") as RawEvalDataset["cases"],
  };
}

/**
 * The validated dataset. Refuses (with the reason) a dataset whose frozen test set was edited, so no run, and no
 * report, can be produced from test labels that changed after they were frozen.
 */
export function loadEvalDataset(directory: string = DEFAULT_EVAL_DIR): EvalDataset {
  const raw = loadRawEvalDataset(directory);
  const dataset = parseEvalDataset(raw);
  const frozen = verifyTestFreeze(raw);
  if (frozen !== null) throw new EvalDatasetError([frozen]);
  return dataset;
}
