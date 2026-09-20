// Reads the curated corpus from the repository (rag-corpus/<year>/manifest.json
// and its source files) and builds it. This is the only place the corpus
// touches the file system. It reads local, committed files; it never fetches
// anything, and it is used by the ingestion script and the tests only, never
// by a request handler.
import fs from "node:fs";
import path from "node:path";
import { buildCorpus } from "./corpus";
import type { Corpus } from "./corpus";

export const DEFAULT_CORPUS_DIR = path.resolve(__dirname, "..", "..", "rag-corpus", "ay-2026-27");

export function loadCorpusFromDisk(directory: string = DEFAULT_CORPUS_DIR): Corpus {
  const manifest: unknown = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  return buildCorpus(manifest, (file) => {
    // A manifest may only name files inside its own directory.
    const resolved = path.resolve(directory, file);
    if (!resolved.startsWith(path.resolve(directory) + path.sep)) throw new Error("source path escapes the corpus directory");
    return fs.readFileSync(resolved, "utf8");
  });
}
