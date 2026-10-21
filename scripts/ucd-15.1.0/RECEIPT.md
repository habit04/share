# UCD 15.1.0 — vendored input receipt

These files are the pinned Unicode Character Database inputs for
`scripts/generate-unicode-tables.mjs`, which emits
`src/core/unicode-tables.ts` (see `ENGINE-STEP2B-DESIGN.md` §5 in the
recon folder). They are vendored so table generation is reproducible
offline and the provenance is inspectable in review. Upstream headers
inside each file are preserved intact.

## Source

- Package: Debian `unicode-data` **15.1.0-1** (system copy at
  `/usr/share/unicode/`), copied verbatim on 2026-10-17.
- The files are the final UCD data files for **Unicode 15.1.0**
  (per `ReadMe.txt` in the source package: dated 2023-08-28).
- Re-pinning: fetch the same version from
  `https://www.unicode.org/Public/15.1.0/ucd/` (paths below are
  relative to that `ucd/` root) and replace the copies here; the
  SHA-256 table below must be updated in the same act, and the
  generated table regenerated and diff-reviewed.

## Files

| Path (relative to this directory / to `ucd/`) | Bytes | SHA-256 |
|---|---|---|
| `BidiBrackets.txt` | 8,879 | `2f0531dc6a2aafa7462c7f89008c2845ade52e51267ac5ba39339adeefb8fe53` |
| `DerivedCoreProperties.txt` | 1,072,686 | `f55d0db69123431a7317868725b1fcbf1eab6b265d756d1bd7f0f6d9f9ee108b` |
| `PropertyValueAliases.txt` | 78,546 | `4b7411fc592c4985e5f03643aa0bddfdfd45250ff1790d358926614d20e37652` |
| `ScriptExtensions.txt` | 22,174 | `fdfd54237a2c0452ba1060571fd1e58fd46aeecdfda7c5b5be1b716dad755cec` |
| `Scripts.txt` | 184,280 | `0eacb65169ae6eb1d399cd70826b3da15fff19f6f586eecf819b70c83b1d9b32` |
| `auxiliary/GraphemeBreakProperty.txt` | 96,863 | `a7e52eee647e52dc210b8719b4d7037276f4b353810293d69377fc46374cec3f` |
| `emoji/emoji-data.txt` | 111,505 | `d7aef489c8fe4c14f09ea5695200277c6b93ac82ac60845cdd2161b0d6835cc1` |
| `extracted/DerivedBidiClass.txt` | 166,678 | `b57884c59a3a5348d86faed39965bbddb4e4493d3c16c1ec378ec26bfb5821be` |

Only the Indic_Conjunct_Break section of `DerivedCoreProperties.txt`
and the `Extended_Pictographic` lines of `emoji/emoji-data.txt` are
consumed by the generator; the files are vendored whole to keep the
upstream artifacts intact.

## Licensing

Unicode data files are used under the Unicode License v3 /
Unicode-DFS terms (see https://www.unicode.org/terms_of_use.html and
the copyright notice carried in each file's header, which the
generator also carries forward into the generated module).

## Addition (step 2B, pipeline landing)

- `auxiliary/GraphemeBreakTest.txt` — the official UAX #29 conformance file at the same pinned 15.1.0, vendored so the repo test suite can run the full grapheme gate (1,187 cases) without a system package. Source: same Debian unicode-data 15.1.0-1 package (`/usr/share/unicode/auxiliary/GraphemeBreakTest.txt`); byte size and SHA-256 recorded in the generator run log for this landing. BidiCharacterTest.txt (91,707 cases, ~3.5 MB) is NOT vendored: its full run is a dev-side gate (validation-12.5-engine/conformance-2b-final.log), and the repo carries a curated subset in tests/text-bidi.test.ts.
