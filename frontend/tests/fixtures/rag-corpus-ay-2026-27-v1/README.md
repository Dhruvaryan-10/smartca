# Corpus v1 fixture

An exact copy of the shipped tax-law corpus `ay-2026-27-v1` (`rag-corpus/ay-2026-27/` before corpus v2), kept so the
section-reference tests (`tests/rag-section-refs.test.ts`) keep testing the mechanism they were written for: a section named
inside a passage filed under another section is reported as cited, not indexed. Corpus v2 gives several of those sections
their own passages, so the shipped corpus no longer exercises that path. Never edit these files.
