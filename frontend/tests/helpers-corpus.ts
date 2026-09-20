// Pure test fixtures for the tax-law corpus (no database). Not a test file.
import { GOVERNING_ACT_1961, normalizeSourceText, sha256Text } from "../lib/rag/corpus";

export const FIXTURE_TEXT = [
  "# Fixture Source",
  "",
  "## Zorblax rules",
  "Quindle flumbrick text about zorblax. It has two sentences.",
  "",
  "## Second heading",
  "A second passage about flumbrick and quindle.",
  "",
].join("\n");

type FixtureOptions = {
  version?: string;
  sourceKey?: string;
  text?: string;
  file?: string;
  assessmentYear?: string;
  governingAct?: string;
  sections?: unknown[];
  extraSources?: unknown[];
  manifestOverrides?: Record<string, unknown>;
  sourceOverrides?: Record<string, unknown>;
};

/** A valid manifest plus a reader for its files. Every option can be broken on purpose. */
export function fixtureCorpusInput(options: FixtureOptions = {}) {
  const file = options.file ?? "sources/fixture-source.txt";
  const text = options.text ?? FIXTURE_TEXT;
  const files: Record<string, string> = { [file]: text };
  const source = {
    sourceKey: options.sourceKey ?? "fixture-source-zorblax",
    title: "Fixture source",
    publisher: "Fixture Department",
    url: "https://fixture.gov.in/zorblax",
    authorityTier: "official_guidance",
    sourceDate: "2026-01-01",
    effectiveFrom: null,
    effectiveTo: null,
    retrievedAt: "2026-09-19T00:00:00Z",
    status: "active",
    file,
    sha256: sha256Text(normalizeSourceText(text)),
    notes: null,
    sections: options.sections ?? [
      { heading: "Zorblax rules", sectionRef: "99Z", regime: "both", topics: ["fixture"], verificationStatus: "primary_verified" },
    ],
    ...options.sourceOverrides,
  };
  const manifest = {
    corpusVersion: options.version ?? "fixture-corpus-v1",
    governingAct: options.governingAct ?? GOVERNING_ACT_1961,
    assessmentYear: options.assessmentYear ?? "2026-27",
    description: "A fixture corpus for tests.",
    knownGaps: [],
    sources: [source, ...(options.extraSources ?? [])],
    ...options.manifestOverrides,
  };
  return {
    manifest,
    files,
    read: (name: string): string => {
      if (!(name in files)) throw new Error(`no such fixture file: ${name}`);
      return files[name];
    },
  };
}

