# Adversarial fixture generator for the capped-qpdf bounds tests.
# Hand-rolled minimal PDFs with proper xref tables (no third-party code):
# object-rich files whose per-object engine overhead dwarfs their byte size,
# and a deeply nested dictionary. An earlier xref-less variant made the
# engine throw an uncaught C++ exception (a raw number across the JS glue);
# that finding is recorded in BOUNDS.md — production inputs from the JCad
# writer always carry startxref, and the worker treats ANY engine throw as
# fail-closed. Usage: gen_adversarial.py <outdir>
import os, sys

def write_pdf(path, objs):
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for n, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % n + body + b"\nendobj\n"
    xref_at = len(out)
    size = len(objs) + 1
    out += b"xref\n0 %d\n" % size + b"0000000000 65535 f \n"
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (size, xref_at)
    with open(path, "wb") as f:
        f.write(bytes(out))

def object_rich(path, count, pad):
    kids = b" ".join(b"%d 0 R" % i for i in range(3, count + 3))
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Count %d /Kids [" % count + kids + b"] >>"]
    for i in range(3, count + 3):
        objs.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Pad (%s) >>"
                    % (b"x" * pad))
    write_pdf(path, objs)

def nested(path, depth):
    inner = b"<< /Leaf 1 >>"
    for _ in range(depth):
        inner = b"<< /N [ " + inner + b" ] /K 1 >>"
    write_pdf(path, [
        b"<< /Type /Catalog /Pages 2 0 R /Deep " + inner + b" >>",
        b"<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    ])

outdir = sys.argv[1]
os.makedirs(outdir, exist_ok=True)
object_rich(os.path.join(outdir, "objrich-50k.pdf"), 50_000, 24)
object_rich(os.path.join(outdir, "objrich-200k.pdf"), 200_000, 24)
object_rich(os.path.join(outdir, "objrich-500k.pdf"), 500_000, 24)
nested(os.path.join(outdir, "nested-10000.pdf"), 10_000)
print("written")
