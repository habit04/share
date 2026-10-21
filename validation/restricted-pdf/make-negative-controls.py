#!/usr/bin/env python3
"""Build the verifier's negative controls (milestone 12.4, corrections round).

Each control corrupts ONE thing the verifier is required to catch, in a way
the pre-correction verifier demonstrably missed (BaseFont-collapsed font
comparison, an /EncryptMetadata identity test). The first three mutate the
committed plaintext fixture with LENGTH-PRESERVING edits, so no length or
offset check can catch them — only the by-role structural comparison can.
The fourth re-issues the encrypted fixture's /Encrypt object in an
incremental update with /EncryptMetadata false, leaving every byte of the
original revision (and the decryption keys) untouched.

Usage: make-negative-controls.py [OUT_DIR]   (default: ./negative-controls)
Inputs are read from this script's fixtures/ directory. Every anchor is
asserted to occur exactly once; a fixture change that invalidates an
anchor fails the generator loudly instead of emitting a wrong control.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")


def replace_once(data, old, new, label):
    assert len(old) == len(new), f"{label}: mutation must preserve length"
    assert data.count(old) == 1, f"{label}: anchor {old!r} found {data.count(old)} times"
    return data.replace(old, new)


def wrong_width(plain):
    # /W [1 [650 650]] -> /W [1 [750 750]]: same length, same structure,
    # wrong widths. The pre-correction verifier never compared /W at all.
    return replace_once(plain, b"/W [1 [650 650]]", b"/W [1 [750 750]]", "wrong-width")


def corrupt_mapping(plain):
    # The CIDToGIDMap (object 9) is six raw bytes: CID 1 -> GID 2, CID 2 ->
    # GID 3. Change GID 2 to GID 7 inside the stream, length preserved.
    head = re.search(rb"9 0 obj\s*<<[^>]*>>\s*stream\r?\n", plain)
    assert head, "corrupt-mapping: CIDToGIDMap stream anchor not found"
    start = head.end()
    assert plain[start:start + 6] == b"\x00\x00\x00\x02\x00\x03", \
        f"corrupt-mapping: unexpected CIDToGIDMap bytes {plain[start:start + 6]!r}"
    out = bytearray(plain)
    out[start + 3] = 0x07
    return bytes(out)


def broken_reference(plain):
    # The page's font resource points at object 0, which does not exist.
    return replace_once(plain, b"/JCF1 5 0 R", b"/JCF1 0 0 R", "broken-reference")


def false_metadata(enc):
    trailer_at = enc.rfind(b"trailer")
    trailer = enc[trailer_at:enc.find(b"startxref", trailer_at)]
    enc_ref = re.search(rb"/Encrypt\s+(\d+)\s+(\d+)\s+R", trailer)
    num, gen = int(enc_ref.group(1)), int(enc_ref.group(2))
    size = int(re.search(rb"/Size\s+(\d+)", trailer).group(1))
    root = re.search(rb"/Root\s+(\d+)\s+(\d+)\s+R", trailer)
    info = re.search(rb"/Info\s+(\d+)\s+(\d+)\s+R", trailer)
    idm = re.search(rb"/ID\s*\[\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\]", trailer)
    prev = int(re.search(rb"startxref\s*(\d+)", enc[enc.rfind(b"startxref"):]).group(1))
    obj_head = re.search(rb"(?m)^%d %d obj\r?$" % (num, gen), enc)
    obj_end = enc.find(b"endobj", obj_head.end())
    body = enc[obj_head.end():obj_end]
    close = body.rfind(b">>")
    new_body = body[:close] + b"/EncryptMetadata false " + body[close:]
    new_obj = b"%d %d obj" % (num, gen) + new_body + b"endobj\n"
    out = bytearray(enc)
    if not out.endswith(b"\n"):
        out += b"\n"
    xref_at = len(out)
    out += new_obj
    xref_entry_at = len(out)
    out += b"xref\n%d 1\n%010d 00000 n \n" % (num, xref_at)
    out += (b"trailer\n<< /Size %d /Root %s %s R /Encrypt %d %d R /Info %s %s R "
            b"/ID [<%s><%s>] /Prev %d >>\nstartxref\n%d\n%%%%EOF\n"
            % (size, root.group(1), root.group(2), num, gen,
               info.group(1), info.group(2), idm.group(1), idm.group(2), prev, xref_entry_at))
    return bytes(out)


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "negative-controls")
    os.makedirs(out_dir, exist_ok=True)
    plain = open(os.path.join(FIXTURES, "plaintext.pdf"), "rb").read()
    enc = open(os.path.join(FIXTURES, "restricted.enc-known.pdf"), "rb").read()
    controls = {
        "negative-wrong-width.pdf": wrong_width(plain),
        "negative-corrupt-mapping.pdf": corrupt_mapping(plain),
        "negative-broken-reference.pdf": broken_reference(plain),
        "negative-false-metadata.pdf": false_metadata(enc),
    }
    for name, data in controls.items():
        path = os.path.join(out_dir, name)
        open(path, "wb").write(data)
        print(f"{name}: {len(data)} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
