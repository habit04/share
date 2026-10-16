# Independent verification — restricted PDF output (milestone 12.4)

Tooling: `verify.py` in this directory (pypdf 6.20.1 + cryptography, an
implementation independent of the writer and of qpdf), plus a qpdf decrypt
round-trip. Verified 2026-10-15 on the Linux sandbox; the same scripts run
unchanged on Windows (Codex's acceptance pass).

## Fixtures (committed, authored/synthetic only)

| file | what it is |
| --- | --- |
| `fixtures/plaintext.pdf` | Exact writer output of a real restricted plot: a drawing whose only font is an authored preview/print fixture face (fsType 4), embedded via the restricted captured lookup. PDF 1.4, FontFile2 + ToUnicode present. SHA-256 `64b3e646…` — regenerate before comparing; see below. |
| `fixtures/restricted.enc.pdf` | The plaintext transformed by the **production** one-shot child (owner password generated in the child and discarded, exactly as the app runs it). |
| `fixtures/restricted.enc-known.pdf` | The plaintext transformed by the same pinned engine + production argv with a known fixture owner password (`jcad-124-fixture-owner`, fixture-only), so owner authentication can be asserted. |
| `fixtures/verify-receipt-known.json` | Raw verifier receipt for the known-password pair: **33/33 checks pass**. |
| `fixtures/verify-receipt-production.json` | Raw verifier receipt for the production-child pair: **32/32 checks pass** (one fewer: no known owner password exists to check, by design). |

Regeneration: `JCAD_DUMP_RESTRICTED_FIXTURES=1 npx vitest run
tests/restricted-fixture-dump.test.ts` (the generator test is skipped
otherwise). Encryption is randomized (owner password, salts, /ID), so the
encrypted fixtures' hashes change on every regeneration; the plaintext is
deterministic.

## What the verifier asserts (all as hard checks)

- Password behavior with fresh readers: empty password authenticates as
  the **user** password; the owner password authenticates as the **owner**
  password; a wrong password is refused.
- Header exactly `%PDF-1.7`; catalog `/Extensions /ADBE /BaseVersion /1.7
  /ExtensionLevel 8` — asserted, not sampled.
- Encrypt dictionary: `/V 5`, `/R 6`, `/P` exactly **−1324** (the P2
  profile), `/Filter /Standard`, `/Length 256`, StdCF `/CFM /AESV3`,
  `/AuthEvent /DocOpen`, `/StmF` and `/StrF` both `/StdCF`,
  `/EncryptMetadata` resolved to the **actual PDF boolean** (it must be
  true; an absent key is the PDF default, also true — but a present
  `BooleanObject(False)`, or any non-boolean value, FAILS; the original
  identity test `is not False` could not see pypdf's wrapped boolean), and
  the R6 field sizes (`/O` 48, `/U` 48, `/OE` 32, `/UE` 32, `/Perms` 16
  bytes).
- Content equivalence **by reachable graph role**, not object numbers or
  hash multisets: page count; per-page stored content-stream bytes;
  extracted text; document Info metadata; a role census of the graph that
  counts **every** stream object (the original census's other-streams
  bucket was never incremented). Font resources are keyed by **role**
  (page + resource name), never collapsed by BaseFont, and each role's
  whole subtree is compared as a canonical structure — Encoding,
  CIDToGIDMap, the /W width array **and** /DW default width, descriptor
  fields and FontFile slot, the embedded program's digest and the
  ToUnicode digest — in addition to the per-font program and ToUnicode
  byte checks.
- Every stream's declared `/Length` — including indirect lengths,
  resolved — equals the bytes actually stored.
- `/ID` is checked structurally (a well-formed pair; an existing `/ID[0]`
  would be preserved). qpdf derives `/ID` from an MD5 of time, output
  path and Info entries and preserves an existing first element; that is
  document bookkeeping, **not** the R6 key-derivation path, and is not
  treated as a freshness proof in either direction.

## Negative controls (corrections round)

`make-negative-controls.py` builds four controls from the committed
fixtures; every one must make the verifier exit 1:

| control | corruption | check that must fail |
| --- | --- | --- |
| `negative-wrong-width.pdf` | plaintext /W widths 650 → 750 (length-preserving) | role census / font structure |
| `negative-corrupt-mapping.pdf` | one byte flipped inside the CIDToGIDMap stream (length-preserving) | role census / font structure |
| `negative-broken-reference.pdf` | the page's font resource points at nonexistent object 0 | BaseFont-by-role + role census |
| `negative-false-metadata.pdf` | the encrypted fixture's /Encrypt object re-issued with `/EncryptMetadata false` via incremental update | /EncryptMetadata resolution |

The pre-correction verifier ACCEPTED the wrong-width and false-metadata
controls (33/33, exit 0): it never compared widths or mappings, and its
`/EncryptMetadata` test was an object-identity check that pypdf's
`BooleanObject(False)` slips past. Failing-before / passing-after receipts
for the corrected verifier are kept with the corrections validation
bundle.

## Round-trip (decrypt) finding — stated precisely

`qpdf --decrypt --stream-data=preserve` of either encrypted fixture
succeeds with both the empty user password and the owner password. The
decrypted file is **not** byte-identical to the plaintext container:
qpdf normalizes what it writes (header version follows the encrypted
file at 1.7, an /ID pair is present, objects are renumbered and the xref
rebuilt). What does hold, and what the verifier asserts on the encrypted
side, is stream-level fidelity: every stored stream (page contents, font
program, ToUnicode, CIDToGIDMap) is byte-identical between plaintext and
decrypted-encrypted apart from the single EOL separator before
`endstream`, and all decoded content, text and metadata match exactly.
Whole-file byte identity after a decrypt pass is a property only of
inputs already in qpdf's canonical form; claiming it for arbitrary
writer output would be wrong, so the milestone does not claim it.
