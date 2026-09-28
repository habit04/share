# Catalog packs: selling manufacturer data for a free (GPL) app

JCad Electrical is free software. What you sell is **data**: manufacturer catalogs
(part numbers, descriptions, ratings, panel footprints; later symbol packs) under your
own licence. A pack is one signed JSON file, `<id>.jcadpack.json`, issued to one buyer.
The app checks the signature with your public key, shows "Licensed to <buyer>" and
refuses files that were edited or that it does not know the key for.

This document is the publisher's manual: the business flow, what the check does and does
not protect, key rotation, and a pricing / update model that fits the mechanism.

## Be honest about what a signature check is

The app is GPL. Anyone may rebuild it, and a rebuilt app can skip the check or accept
a different key. **Nothing here stops a determined person from using a pack they did not
pay for.** Do not sell this as copy protection; it is not.

What it does do:

- **One file, no activation.** The buyer installs a file; nothing phones home, no accounts,
  works offline forever. Honest use is easier than piracy.
- **The buyer's name is in every copy.** `license.licensee` is inside the signed document.
  Passing the file around means passing your customer's name around, and editing the name
  breaks the signature. That makes casual sharing unattractive.
- **Corruption and tampering are caught.** A truncated download, an edited part number, a
  hand-made file: all refused with a clear message.
- **Expiry is visible.** An expired pack still works (see below) but every screen says so,
  which is the nudge to renew.

Anything more (server checks, hardware locks) would fight the GPL, annoy paying customers
and still be removable from the source. Price the data fairly and make renewing easy instead.

## Pack file format (`jcad-pack/1`)

```json
{
  "format": "jcad-pack/1",
  "id": "acme-rockwell-2026",
  "name": "Rockwell control parts",
  "publisher": "Justin Rodriguez",
  "version": "2026.1",
  "kind": "catalog",
  "description": "optional free text",
  "license": { "licensee": "Acme Controls <shop@acme.example>", "issued": "2026-09-28", "expires": "2027-09-28", "seats": 1 },
  "catalog": [ { "family": "PB", "mfg": "...", "cat": "...", "desc": "...", "rating": "...", "type": "NO", "assycode": "", "footprint": "WD_FP_PB" } ],
  "signature": { "alg": "ed25519", "keyId": "pub-2026", "value": "<base64>" }
}
```

- `id`: letters, digits, `.`, `_`, `-` (up to 64). Installing a pack with the same id replaces
  the older copy, so keep the id stable across a product's versions (`acme-rockwell`) or put the
  year in it if you want yearly packs to coexist.
- `license.expires`: last valid day (`YYYY-MM-DD`) or `null` for a perpetual licence.
  `seats` is informational.
- `catalog`: the same rows a user catalog uses (`family, mfg, cat, desc, rating?, type?,
  assycode?, footprint?`). The app upper-cases them.
- `signature.value` is Ed25519 over the **canonical JSON** of the document without the
  `signature` member: keys sorted at every level, no whitespace, `undefined` dropped. Unknown
  members are kept and are part of what is signed.
- Files are installed under `userData/packs/<id>.jcadpack.json` (Windows:
  `%APPDATA%\jcad-electrical\packs`, macOS: `~/Library/Application Support/jcad-electrical/packs`,
  Linux: `~/.config/jcad-electrical/packs`; the Packs dialog shows the exact path). In a browser
  build they live in localStorage under `jcad.packs.v1`. They are stored byte-for-byte as received
  and verified again on every start.

## The business flow, step by step

All commands are `node scripts/pack-sign.mjs <command>` from a checkout of the repository
(Node 22, no extra packages).

### 1. Build the catalog from a spreadsheet

Keep the master data in a spreadsheet with the header row
`family,mfg,cat,desc,rating,type,assycode,footprint` (`family`, `mfg`, `cat`, `desc` are
required; `type` is `NO` / `NC` for contacts; `footprint` is the `WD_FP_<family>` block to use on
panel layouts). Export as CSV and convert:

```
node scripts/pack-sign.mjs csv2catalog rockwell.csv rockwell.json
```

`fixtures/packs/sample-catalog.csv` is a small example. You can also hand the CSV straight to
`sign --in rockwell.csv`.

### 2. Generate your signing key (once)

```
node scripts/pack-sign.mjs keygen --out keys/ --key-id pub-2026
```

This writes `keys/pack-private.pem` (mode 600) and prints the base64 public key. **The private key
is the business.** Keep it off the repository (`keys/` and `*.pem` are git-ignored), back it up
somewhere offline (password manager, encrypted USB), and never send it to anyone.

Put the public key into `src/electrical/pack-keys.json`:

```json
{ "pub-2026": "<base64 from keygen>" }
```

and rebuild / release the app. Only builds that carry the key accept your packs, so ship the
key in a release **before** you sell the first pack.

> The key currently in `pack-keys.json` is a **sample** that was used to sign the fixtures in
> `fixtures/packs/`. Its private half was deleted right after signing them and is not stored
> anywhere. Replace the sample with your own key before selling anything (you may keep both
> entries while the fixtures are still used by the tests).

### 3. Sign a pack for each buyer

```
node scripts/pack-sign.mjs sign \
  --key keys/pack-private.pem --key-id pub-2026 \
  --in rockwell.json \
  --id acme-rockwell --name "Rockwell control parts" --version 2026.1 \
  --publisher "Justin Rodriguez" \
  --licensee "Acme Controls <shop@acme.example>" --expires 2027-09-28 \
  --out acme-rockwell.jcadpack.json
```

- `--licensee`: the shop name and an e-mail, so the buyer recognises it and a stranger who
  gets the file sees whose it is.
- `--expires`: one year from the sale is the model below; `--expires never` for a perpetual
  licence.
- `--in` accepts a JSON array, `{"items": [...]}`, a CSV, or an **existing pack** (to renew: pass
  last year's pack and new `--expires` / `--version`; the licensee and id are kept unless
  overridden).
- Check it before sending: `node scripts/pack-sign.mjs verify acme-rockwell.jcadpack.json`
  prints licensee, expiry and `RESULT: valid` (exit code 0).

Keep a simple ledger (spreadsheet): date, licensee, e-mail, pack id/version, expiry, price.
You will need it for renewals and for re-issuing a lost file.

### 4. Deliver

E-mail the `.jcadpack.json` file (a few hundred KB even for large catalogs) or provide a
download link. No activation codes. Tell the buyer:

> Open JCad Electrical, Schematic > Catalog Browser > **Packs...** (or type `AEPACKS`), click
> **Install...** and pick the file. The dialog shows the pack, "Licensed to <you>" and the
> expiry. Parts appear in the Catalog Browser with the pack name in the Source column.

### 5. What the buyer sees

- **Catalog Browser**: status line `N part(s) - built-in + user catalog (n) + 1 pack(s) (m parts)`;
  the Source column names the pack; expired packs are listed in the status line.
- **Packs dialog** (`AEPACKS`): name, version, publisher, licensed to, expires, parts, status
  (`valid until ...`, `valid (perpetual)`, `expired on ...`), Install..., Remove, and the folder path.
- **Command window** on start-up: one line per installed pack, a warning per expired pack, and the
  reason for any file that was refused.
- Commands: `AEPACKS` (dialog), `AEPACKINSTALL` (file picker), `AEPACKLIST` (text listing).

Lookup order everywhere (Catalog Browser, Catalog Lookup in the component dialog): **user catalog
file > packs in install order > built-in generic parts.** A pack part with the same manufacturer
and number as a built-in part wins; the user's own catalog file wins over both.

## Refused, expired: the rules

| Situation | Behaviour |
| --- | --- |
| No `signature` member | Refused: "Unsigned pack: only packs signed by the publisher can be installed" |
| Edited after signing (any field, including the licensee or a part number) | Refused: "The signature does not match the pack contents..." |
| Signed with a key this build does not know | Refused, names the key id and suggests updating the app |
| Not `kind: "catalog"` | Refused (symbol packs will arrive with a later format/kind) |
| Larger than 20 MB | Refused (main process and renderer both check) |
| **Expired** | **Installed and used**; status shows `expired on <date>`, start-up logs a warning |

Why lenient on expiry: the buyer paid for that data and it should keep working; what expires
is the entitlement to *updates*. Cutting off the parts they already designed with would punish
paying customers, would not stop anyone who rebuilds the app, and creates support calls at the
worst moment (a deadline). The visible "expired" flag is the renewal reminder.

The packs folder is never modified by the app except when the user installs or removes a
pack. A file that fails verification is skipped and reported, not deleted, so a later app
version with a newer key can still load it.

## Key rotation and loss

- **Adding a key**: run `keygen --out keys2026/ --key-id pub-2027`, add the new entry to
  `pack-keys.json` next to the old one, release the app, then sign new packs with the new key.
  Old packs keep verifying as long as the old public key stays in the file.
- **Retiring a key**: remove its entry from `pack-keys.json`. Every pack signed with it stops
  loading in new app versions, so first re-sign and re-send the packs of paying customers (the
  ledger tells you who).
- **Private key leaked**: someone can now sign packs with your name. Retire the key as above
  and re-issue. Because the check is advisory anyway, the damage is reputational, not financial;
  act calmly.
- **Private key lost**: you cannot sign renewals with it. Generate a new key, ship it in a
  release, and re-sign existing customers' packs from your ledger and master catalog. Nothing
  already installed breaks.

Use a key id that says when it was made (`pub-2026`) so a refusal message tells you which key a
customer's pack needs.

## Suggested pricing and update model

- **Yearly version, yearly expiry.** Sell `2026.1` with `expires` one year out. During the year,
  ship `2026.2`, `2026.3`... with new parts to every current licensee (re-sign with the same
  licensee and expiry; the app replaces the pack because the id is the same).
- **Renewal = re-sign.** At renewal, take the latest pack, `sign --in old.jcadpack.json
  --expires <+1 year> --version 2027.1`, send it. Same file name, same install steps.
- **Lapsed customers keep what they have** (expired but working) and see the flag. Offer the
  renewal at the same price; no penalty for lapsing, which keeps the relationship friendly.
- **Perpetual option** for shops that hate subscriptions: `--expires never` at a higher price;
  updates sold as new versions.
- **Seats**: `seats` is written into the pack for the record; do not try to enforce it. Price
  per shop, not per seat, and ask honestly.
- **Bundles**: one pack per manufacturer (ids `acme-rockwell`, `acme-siemens`...) so shops buy
  only what they use; a bundle is several files.
- Keep the free built-in catalog useful. It is the demo of what a pack does, and the reason
  people trust you enough to buy.

## For developers

- `src/electrical/packs.ts`: `canonicalJson`, `parsePack`, `verifyPack` (WebCrypto Ed25519),
  `PackRegistry` (install / remove / load, merge into the catalog via `setPackCatalog`), the
  bridge / localStorage / memory stores.
- `src/electrical/pack-keys.json`: trusted publisher keys (`keyId -> base64 raw 32-byte key`).
- `electron/main.cjs` (`packs-*`, `pick-pack-file`) and `electron/preload.cjs`: file storage in
  `userData/packs/` with name validation, a 20 MB limit and atomic writes; the main process never
  parses a pack.
- `scripts/pack-sign.mjs`: the CLI; its `canonicalJson` must stay identical to the library's
  (`tests/packs.test.ts` verifies the fixtures it produced against the library).
- `fixtures/packs/`: `sample-catalog.csv` / `.json`, `sample-signed` (valid until 2027-09-28),
  `sample-expired` (valid signature, expired 2025-01-15), `sample-tampered` (licensee edited after
  signing, refused).
- Symbol packs: reserve `kind: "symbols"` with a `symbols` array in the user-library format; the
  registry currently refuses any kind other than `catalog` so an old app never half-installs one.
