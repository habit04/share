#!/usr/bin/env python3
"""Independent verifier for JCad restricted-PDF output (milestone 12.4).

This verifier trusts nothing the writer or the transform claims: it parses
the encrypted file with pypdf (an independent implementation) and with raw
byte scans, and compares it against the EXACT plaintext it was made from,
matching objects by reachable graph ROLE (page contents, font programs,
ToUnicode maps, metadata), never by object numbers or global hash
multisets. Security fields are asserted individually, password behavior is
exercised with fresh readers (empty user password must authenticate as the
user password; the owner password, when known, as the owner password; any
other password must fail), and every stream's declared /Length — including
indirect lengths — is checked against the bytes actually present.

Usage:
  verify.py PLAINTEXT ENCRYPTED [--owner-password PW] [--receipt OUT.json]

Requires: pypdf + cryptography (pip install pypdf cryptography).
Exit code 0 only when every assertion passes; a JSON receipt is printed.
"""
import hashlib
import json
import re
import sys

from pypdf import PdfReader
from pypdf.generic import DictionaryObject, IndirectObject, NameObject, StreamObject

CHECKS = []


def check(name, ok, detail=""):
    CHECKS.append({"name": name, "ok": bool(ok), "detail": str(detail)})
    return ok


def stream_raw_bytes(obj):
    """Stored (still filter-encoded, but decrypted by pypdf) stream bytes."""
    data = getattr(obj, "_data", None)
    return bytes(data) if data is not None else obj.get_data()


def pdf_bool(value):
    """The ACTUAL boolean a PDF value carries, or None when it is not a
    boolean at all. pypdf wraps file booleans in BooleanObject, whose
    truthiness is plain object truthiness — both `bool(x)` and the identity
    test `x is not False` lie for BooleanObject(False). Its `.value`
    attribute carries the real boolean. A native bool passes through."""
    if isinstance(value, bool):
        return value
    raw = getattr(value, "value", None)
    return raw if isinstance(raw, bool) else None


def canon(value, depth=0, active=frozenset()):
    """Canonical structural form of a PDF object graph fragment.

    Indirect references are RESOLVED (object numbers differ between the
    plaintext and the transform's renumbered output, so comparing reference
    identities would be meaningless) with a cycle guard on the current
    path. Streams canonicalize to their dictionary (minus /Length, whose
    representation varies and which the length audit checks separately)
    plus the SHA-256 of their stored bytes. Scalars keep their type, so a
    name can never silently equal a string or a number.
    """
    if depth > 8:
        return ("deep",)
    if isinstance(value, IndirectObject):
        key = (value.idnum, value.generation)
        if key in active:
            return ("cycle",)
        try:
            target = value.get_object()
        except Exception as error:  # broken reference: a distinct shape
            return ("unresolvable", type(error).__name__)
        return canon(target, depth + 1, active | {key})
    if isinstance(value, StreamObject):
        items = tuple(sorted(
            (str(k), canon(v, depth + 1, active)) for k, v in value.items() if k != "/Length"))
        return ("stream", items, hashlib.sha256(stream_raw_bytes(value)).hexdigest())
    if isinstance(value, DictionaryObject):
        return ("dict", tuple(sorted(
            (str(k), canon(v, depth + 1, active)) for k, v in value.items())))
    if isinstance(value, (list, tuple)):
        return ("array", tuple(canon(v, depth + 1, active) for v in value))
    if isinstance(value, NameObject):
        return ("name", str(value))
    resolved_bool = pdf_bool(value)
    if resolved_bool is not None:
        return ("bool", resolved_bool)
    if isinstance(value, bool):
        return ("bool", value)
    if isinstance(value, (int, float)):
        return ("num", float(value))
    if isinstance(value, str):
        return ("str", value)
    if isinstance(value, (bytes, bytearray)):
        return ("bytes", bytes(value).hex())
    if value is None or type(value).__name__ == "NullObject":
        return ("null",)
    return ("other", type(value).__name__, str(value)[:64])


def font_roles(reader):
    """Font resources keyed by ROLE — (page index, resource name) — never
    collapsed by BaseFont: two distinct resources that happen to share a
    BaseFont are compared separately, each against its own counterpart.

    Each role carries a canonical STRUCTURE of the whole font subtree
    (Encoding, ToUnicode, the descendant CIDFont with its CIDSystemInfo,
    /DW default width and /W width array, the CIDToGIDMap, and the font
    descriptor's fields plus which FontFile slot it uses and the embedded
    program's digest) and the raw font-program / ToUnicode bytes for the
    per-font byte checks. A role that cannot be extracted (broken
    reference, wrong object type) records an error structure, which fails
    the comparisons cleanly instead of crashing the verifier.
    """
    roles = {}
    for page_index, page in enumerate(reader.pages):
        try:
            fonts = (page.get("/Resources") or {}).get("/Font") or {}
        except Exception:
            continue
        for name, ref in fonts.items():
            key = f"page{page_index}:{name}"
            entry = {"structure": ("error", "NotExtracted", ""), "basefont": "<error>",
                     "fontfile": None, "tounicode": None}
            try:
                font = ref.get_object()
            except Exception as error:
                entry["structure"] = ("error", type(error).__name__, str(error)[:80])
                roles[key] = entry
                continue
            # Byte extraction and structure canonicalization are independent
            # on purpose: a failure in one must never mask the other, and an
            # error structure on the trusted plaintext side fails the census
            # check below rather than comparing vacuously equal.
            try:
                entry["basefont"] = str(font.get("/BaseFont"))
                if font.get("/ToUnicode") is not None:
                    entry["tounicode"] = stream_raw_bytes(font["/ToUnicode"].get_object())
                descendant = (font.get("/DescendantFonts") or [None])[0]
                target = descendant.get_object() if descendant is not None else font
                descriptor = target.get("/FontDescriptor")
                if descriptor is not None:
                    descriptor = descriptor.get_object()
                    for slot in ("/FontFile2", "/FontFile3", "/FontFile"):
                        if descriptor.get(slot) is not None:
                            entry["fontfile"] = stream_raw_bytes(descriptor[slot].get_object())
            except Exception as error:
                entry["basefont"] = "<error>"
                entry["structure"] = ("error", type(error).__name__, str(error)[:80])
            try:
                entry["structure"] = canon(font)
            except Exception as error:
                entry["structure"] = ("error", type(error).__name__, str(error)[:80])
            roles[key] = entry
    return roles


def role_census(reader):
    """Counts of reachable objects by graph role, for shape comparison —
    including EVERY stream object in the file (the earlier census's
    other-streams bucket was never incremented and is replaced by an exact
    total)."""
    census = {"pages": 0, "content_streams": 0, "fonts": 0, "font_files": 0,
              "tounicode": 0, "total_streams": 0}
    for page in reader.pages:
        census["pages"] += 1
        if page.get("/Contents") is not None:
            census["content_streams"] += 1
        fonts = (page.get("/Resources") or {}).get("/Font") or {}
        for ref in fonts.values():
            census["fonts"] += 1
            try:
                font = ref.get_object()
                if font is None:
                    continue
                if font.get("/ToUnicode") is not None:
                    census["tounicode"] += 1
                descendant = (font.get("/DescendantFonts") or [None])[0]
                target = descendant.get_object() if descendant is not None else font
                descriptor = target.get("/FontDescriptor")
                if descriptor is not None:
                    descriptor = descriptor.get_object()
                    if descriptor.get("/FontFile2") is not None or descriptor.get("/FontFile3") is not None:
                        census["font_files"] += 1
            except Exception:
                continue
    for generation, objects in reader.xref.items():
        for num in objects:
            try:
                obj = reader.get_object(IndirectObject(num, generation, reader))
            except Exception:
                continue
            if isinstance(obj, StreamObject):
                census["total_streams"] += 1
    return census


def page_content_bytes(reader):
    result = []
    for page in reader.pages:
        contents = page.get("/Contents")
        if contents is None:
            result.append(b"")
        elif isinstance(contents, IndirectObject):
            result.append(stream_raw_bytes(contents.get_object()))
        else:  # array of streams
            result.append(b"".join(stream_raw_bytes(c.get_object()) for c in contents))
    return result


def stream_length_audit(path):
    """Every stream's declared /Length (resolving indirect refs) must equal
    the raw bytes between the stream EOL and the endstream keyword."""
    raw = open(path, "rb").read()
    reader = PdfReader(path)
    if reader.is_encrypted:
        reader.decrypt("")
    problems = []
    audited = 0
    offsets = {}
    for generation, objects in reader.xref.items():
        for num, offset in objects.items():
            offsets[(num, generation)] = offset
    for (num, generation), offset in sorted(offsets.items()):
        if not isinstance(offset, int) or offset <= 0:
            continue
        head = raw[offset:offset + 8192]
        m = re.search(rb"stream(\r\n|\n|\r)", head)
        if not m:
            continue
        # The declared /Length is read from the RAW object header: pypdf
        # drops the key from decoded stream dictionaries, so the parsed
        # object cannot be trusted for this. An indirect length is resolved
        # through the reader. (/Length1 must not match the pattern.)
        dict_text = head[:m.start()]
        lm = re.search(rb"/Length(?![0-9A-Za-z])\s+(\d+)(?:\s+(\d+)\s+R)?", dict_text)
        if not lm:
            problems.append(f"object {num}: stream without /Length")
            continue
        if lm.group(2) is not None:
            try:
                length = int(reader.get_object(IndirectObject(int(lm.group(1)), int(lm.group(2)), reader)))
            except Exception as error:
                problems.append(f"object {num}: indirect /Length unresolvable ({error})")
                continue
        else:
            length = int(lm.group(1))
        start = offset + m.end()
        # The stream data is encrypted in the file but its byte count is not.
        end = raw.find(b"endstream", start)
        if end < 0:
            problems.append(f"object {num}: no endstream")
            continue
        measured = end - start
        if raw[end - 1:end] in (b"\n", b"\r"):
            measured -= 1
            if raw[end - 2:end - 1] == b"\r" and raw[end - 1:end] == b"\n":
                measured -= 1
        audited += 1
        if length != measured:
            problems.append(f"object {num}: /Length {length} != measured {measured}")
    return audited, problems


def main():
    args = sys.argv[1:]
    owner_password = None
    receipt_path = None
    positional = []
    i = 0
    while i < len(args):
        if args[i] == "--owner-password":
            owner_password = args[i + 1]; i += 2
        elif args[i] == "--receipt":
            receipt_path = args[i + 1]; i += 2
        else:
            positional.append(args[i]); i += 1
    if len(positional) != 2:
        print(__doc__)
        return 2
    plain_path, enc_path = positional
    enc_raw = open(enc_path, "rb").read()
    plain_raw = open(plain_path, "rb").read()

    # ---- password behavior (fresh readers per attempt) ----
    r_user = PdfReader(enc_path)
    user_result = r_user.decrypt("")
    check("empty password authenticates as USER password", int(user_result) == 1, f"decrypt('') -> {user_result}")
    if owner_password is not None:
        r_owner = PdfReader(enc_path)
        owner_result = r_owner.decrypt(owner_password)
        check("owner password authenticates as OWNER password", int(owner_result) == 2, f"decrypt(owner) -> {owner_result}")
    r_wrong = PdfReader(enc_path)
    wrong_result = r_wrong.decrypt("definitely-not-the-password")
    check("wrong password is refused", int(wrong_result) == 0, f"decrypt(wrong) -> {wrong_result}")
    check("plaintext fixture is not itself encrypted", not PdfReader(plain_path).is_encrypted)

    enc = r_user  # decrypted with the empty user password
    plain = PdfReader(plain_path)

    # ---- file-level security structure (actual assertions, not samples) ----
    check("header is exactly %PDF-1.7", enc_raw[:8] == b"%PDF-1.7", enc_raw[:8])
    check("plaintext header is %PDF-1.4 (writer output unchanged)", plain_raw[:8] == b"%PDF-1.4", plain_raw[:8])
    ext = (enc.trailer["/Root"].get("/Extensions") or {}).get("/ADBE") or {}
    check("catalog declares ExtensionLevel 8", int(ext.get("/ExtensionLevel", -1)) == 8, dict(ext))
    check("catalog declares BaseVersion /1.7", str(ext.get("/BaseVersion")) == "/1.7", ext.get("/BaseVersion"))
    ed = enc.trailer["/Encrypt"]
    check("/V is 5", int(ed["/V"]) == 5, ed["/V"])
    check("/R is 6", int(ed["/R"]) == 6, ed["/R"])
    check("/P is exactly -1324 (P2 profile)", int(ed["/P"]) == -1324, ed["/P"])
    check("/Filter is /Standard", str(ed["/Filter"]) == "/Standard", ed["/Filter"])
    check("/Length is 256 bits", int(ed["/Length"]) == 256, ed["/Length"])
    cf = (ed.get("/CF") or {}).get("/StdCF") or {}
    check("StdCF /CFM is /AESV3", str(cf.get("/CFM")) == "/AESV3", cf.get("/CFM"))
    check("StdCF /AuthEvent is /DocOpen", str(cf.get("/AuthEvent")) == "/DocOpen", cf.get("/AuthEvent"))
    check("/StmF is /StdCF", str(ed.get("/StmF")) == "/StdCF", ed.get("/StmF"))
    check("/StrF is /StdCF", str(ed.get("/StrF")) == "/StdCF", ed.get("/StrF"))
    # /EncryptMetadata: resolve the ACTUAL PDF boolean. Absent means the
    # PDF default (true). A present value must resolve to boolean true —
    # BooleanObject(False), or any malformed non-boolean value, fails.
    em_raw = ed.get("/EncryptMetadata")
    if em_raw is None:
        check("/EncryptMetadata resolves to true (metadata encrypted)", True, "absent: PDF default is true")
    else:
        em_resolved = pdf_bool(em_raw)
        check("/EncryptMetadata resolves to true (metadata encrypted)", em_resolved is True,
              f"raw={em_raw!r} resolved={em_resolved}")
    # R6 sizes per ISO 32000-2 §7.6.4.3: /O and /U carry hash + validation
    # salt + key salt (48); /OE and /UE are the bare encrypted file key (32);
    # /Perms is one AES block (16).
    for field, want in (("/O", 48), ("/U", 48), ("/OE", 32), ("/UE", 32), ("/Perms", 16)):
        value = ed.get(field)
        raw = value.original_bytes if hasattr(value, "original_bytes") else bytes(value)
        check(f"{field} is {want} bytes", len(raw) == want, f"len={len(raw)}")
    # /ID: qpdf preserves an existing ID[0] and mints a fresh pair otherwise;
    # neither is the R6 key path, so the check is structural, not freshness.
    enc_id = enc.trailer.get("/ID")
    plain_id = plain.trailer.get("/ID")
    check("/ID is a well-formed pair of 16-byte strings",
          bool(enc_id) and len(enc_id) == 2 and all(len(x) == 16 for x in enc_id),
          f"len={[len(x) for x in enc_id] if enc_id else None}")
    if plain_id:
        check("existing /ID[0] is preserved", bytes(enc_id[0]) == bytes(plain_id[0]))

    # ---- content equivalence by graph role ----
    check("page counts match", len(enc.pages) == len(plain.pages), f"{len(enc.pages)} vs {len(plain.pages)}")
    enc_content, plain_content = page_content_bytes(enc), page_content_bytes(plain)
    for idx, (a, b) in enumerate(zip(enc_content, plain_content)):
        check(f"page {idx} content stream bytes identical (stored streams preserved)", a == b,
              f"len {len(a)} vs {len(b)}")
    check("extracted text identical", [p.extract_text() for p in enc.pages] == [p.extract_text() for p in plain.pages],
          repr(enc.pages[0].extract_text() if enc.pages else None))
    enc_roles, plain_roles = font_roles(enc), font_roles(plain)
    check("font BaseFont sets match by role",
          set(enc_roles) == set(plain_roles)
          and all(enc_roles[key]["basefont"] == plain_roles[key]["basefont"] for key in plain_roles),
          f"{sorted((k, v['basefont']) for k, v in enc_roles.items())} vs "
          f"{sorted((k, v['basefont']) for k, v in plain_roles.items())}")
    basefont_counts = {}
    for role in plain_roles.values():
        basefont_counts[role["basefont"]] = basefont_counts.get(role["basefont"], 0) + 1
    for key in sorted(plain_roles):
        role = plain_roles[key]
        base = role["basefont"] if basefont_counts[role["basefont"]] == 1 else f"{role['basefont']} ({key})"
        for kind in ("fontfile", "tounicode"):
            if role[kind] is not None:
                check(f"font {base} {kind} bytes identical",
                      enc_roles.get(key, {}).get(kind) == role[kind],
                      f"len {len(enc_roles.get(key, {}).get(kind) or b'')} vs {len(role[kind])}")
    enc_info = {k: str(v) for k, v in (enc.trailer["/Info"].get_object() if enc.trailer.get("/Info") else {}).items()}
    plain_info = {k: str(v) for k, v in (plain.trailer["/Info"].get_object() if plain.trailer.get("/Info") else {}).items()}
    check("document Info metadata identical", enc_info == plain_info, f"{enc_info} vs {plain_info}")
    # The census check is now a full role comparison: the counts AND every
    # role's canonical font structure (Encoding, CIDToGIDMap, /W widths and
    # /DW default, descriptor relationships, embedded program, ToUnicode).
    enc_census, plain_census = role_census(enc), role_census(plain)
    differing = [key for key in plain_roles
                 if key not in enc_roles or enc_roles[key]["structure"] != plain_roles[key]["structure"]]
    unextractable = [key for key, role in plain_roles.items() if role["structure"][0] == "error"]
    check("role census matches", enc_census == plain_census and not differing and not unextractable,
          f"census {enc_census} vs {plain_census}; differing roles: {differing}; "
          f"plaintext roles that failed extraction: {unextractable}")

    audited, problems = stream_length_audit(enc_path)
    check("all stream /Length values (incl. indirect) match the stored bytes", not problems and audited > 0,
          f"audited={audited} problems={problems[:4]}")

    receipt = {"plaintext": plain_path, "encrypted": enc_path,
               "owner_password_checked": owner_password is not None,
               "checks": CHECKS,
               "passed": sum(1 for c in CHECKS if c["ok"]), "total": len(CHECKS)}
    text = json.dumps(receipt, indent=1)
    if receipt_path:
        open(receipt_path, "w").write(text + "\n")
    print(text)
    return 0 if receipt["passed"] == receipt["total"] else 1


if __name__ == "__main__":
    sys.exit(main())
