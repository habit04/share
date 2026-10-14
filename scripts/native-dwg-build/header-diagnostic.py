"""Isolated development-only preparation and bounded raw-header evidence."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import subprocess
import tarfile
from decimal import Decimal, InvalidOperation, ROUND_FLOOR, ROUND_HALF_UP

ARCHIVE_SHA = "96d407e96047237200360b1669768f80aaffbb003c34c6fe57228fc4cd345d5a"
DECODE_SHA = "be1fa5ba174fee1a513de35c7a32a2344a009e00a45c39a7480fb444cf10829a"
AUX_SPEC_SHA = "80fd1928f65b68d69fba973448320a7d268df2272de8d80602905bac8b48f5dd"
HEADER_SHA = "f5335fd2c5f42f9978cd1820e09e1e47f5a776911b4cd32d466a1476e9bff665"
SOURCE_VARIANT = "candidate-exact-r2018-maintenance-rl-no-wire-zero18-v1"
BASELINE_REFERENCE = {"head": "6bce502385d410a10fe15aadd55346e4686b4b6d",
    "observationSha256": "c6e676ec01d90989477d01085d520ca0cc2a07a9e0c76c0e6f5f6a0c9fde9e63",
    "rawAuxSha256": "3291cedb37c7e73e92ff498dd9baed2b6bd13e85832a47d4e54c3e4e993c3e53",
    "outcome": "compiled ABI matched; original grammar refused invalid Aux dates"}
# Authenticated include/dwg.h DWG_VERSION_TYPE: R_12 aliases R_11; R_2018 is 40.
NATIVE_R2018 = 40
LIBRARY_CFLAGS = "-O2 -DNDEBUG"
CONFIGURE_ARGS = ["--enable-release", "--enable-debug", "--disable-werror", "--disable-docs",
                  "--disable-write", "--disable-json", "--disable-python", "--disable-bindings",
                  "--disable-shared", "--enable-static"]
CONFIG_FEATURES = {"DEBUG_CLASSES": "1", "HAVE_WERROR": None, "USE_WRITE": None,
                   "USE_TRACING": None, "DISABLE_JSON": "1", "DISABLE_DXF": None,
                   "DEBUG": None, "ENABLE_MIMALLOC": None}
FIXTURES = {
    "r2018-minsert": "74cafbe617e7a885d622a8a0270b60f64cc285801be42ea8829cc9e9472616d5",
    "r2018-views-fields": "5f5a9bd4a0ffd2e545f6f5404bed9edb27f2c41411c3b26a264f0696a649f105",
    "r2018-unicode-metadata": "cf75bd2670ad88b29694fa4f96db4309fc2f8689f7bfa63cf9d0906447cb54f6",
    "r2018-field-object-reference": "78f2e61f66e84f2e24d589071faf0afe3a68d0127405e7a53fbd5ebc020749c6",
}
FIXTURE_BYTES = {"r2018-minsert": 18644, "r2018-views-fields": 19501,
                 "r2018-unicode-metadata": 20049, "r2018-field-object-reference": 20019}
DXF_REFERENCE_SHA = {
    "r2018-minsert": "d0539d4040a7c59264de839864bfacfa2728b820e527c84df4c157397cb52a96",
    "r2018-views-fields": "2630c55169a36ed81951e132b3a946feb57426197e64d4e5747c3bde6821dcad",
    "r2018-unicode-metadata": "b3ad96ebc4a0ae041d63fdb171430216f037a892718002399008cbdd024b50f1",
    "r2018-field-object-reference": "b6f356c4333ea9e3daf57c605ecbdbce636363b6486632cf55082e96e6583ed8"}
IGNORED_LINKS = {
    "m4/ltoptions.m4", "m4/ltversion.m4", "m4/ltsugar.m4", "m4/lt~obsolete.m4",
    "m4/libtool.m4", "INSTALL", "build-aux/depcomp", "build-aux/compile",
    "build-aux/mdate-sh", "build-aux/install-sh", "build-aux/missing",
    "build-aux/config.sub", "build-aux/py-compile", "build-aux/texinfo.tex",
    "build-aux/config.guess", "build-aux/ltmain.sh",
}
MAX_INPUT = 4 * 1024 * 1024
MAX_OUTPUT = 64 * 1024
DECOMPRESSED_CALL = b"  error = read_2004_compressed_section (dat, dwg, &sec_dat, SECTION_AUXHEADER);"
PARSED_CALL = b"  error = auxheader_private (dat, dwg);"
LAYOUT_ANCHOR = (b"auxheader_private (Bit_Chain *restrict dat, Dwg_Data *restrict dwg)\n"
                b"{\n  Bit_Chain *str_dat = dat;\n  Dwg_AuxHeader *_obj = &dwg->auxheader;")
LAYOUT_EXPRESSIONS = ["sizeof(BITCODE_RS)", "sizeof(BITCODE_RL)", "sizeof(BITCODE_RLL)",
    "sizeof(BITCODE_TIMEBLL)", "offsetof(Dwg_Bitcode_TimeBLL, days)",
    "offsetof(Dwg_Bitcode_TimeBLL, ms)", "offsetof(Dwg_Bitcode_TimeBLL, value)",
    "sizeof(Dwg_Data)", "offsetof(Dwg_Data, auxheader)", "sizeof(Dwg_AuxHeader)",
    "offsetof(Dwg_AuxHeader, maint_version)", "offsetof(Dwg_AuxHeader, maint_version_1)",
    "offsetof(Dwg_AuxHeader, maint_version_2)", "offsetof(Dwg_AuxHeader, TDCREATE)",
    "offsetof(Dwg_AuxHeader, TDUPDATE)", "offsetof(Dwg_AuxHeader, zero_18)",
    "sizeof(((Dwg_AuxHeader *)0)->maint_version)",
    "sizeof(((Dwg_AuxHeader *)0)->maint_version_1)",
    "sizeof(((Dwg_AuxHeader *)0)->maint_version_2)"]
LAYOUT_NAMES = ["rsBytes", "rlBytes", "rllBytes", "timeBytes", "daysOffset", "msOffset",
    "valueOffset", "drawingBytes", "auxOffset", "auxBytes", "maintenanceOffset",
    "maintenance1Offset", "maintenance2Offset", "creationOffset", "updateOffset", "tailOffset",
    "maintenanceBytes", "maintenance1Bytes", "maintenance2Bytes"]
FIELD_ROLES = [("maint_version", 32, 1), ("maint_version_1", 32, 1),
               ("maint_version_2", 32, 1), ("TDCREATE", 64, 2),
               ("TDUPDATE", 64, 2), ("zero_18", 0, 0)]
# Complete named sequence from authenticated AC1032 Aux writer, not guessed offsets.
AUX_FIELDS = [("aux_intro", 8, 3), ("dwg_version", 16, 1), ("maint_version", 32, 1),
    ("numsaves", 32, 1), ("minus_1", 32, 1), ("numsaves_1", 16, 1), ("numsaves_2", 16, 1),
    ("zero", 32, 1), ("dwg_version_1", 16, 1), ("maint_version_1", 32, 1),
    ("dwg_version_2", 16, 1), ("maint_version_2", 32, 1), ("unknown_6rs", 16, 6),
    ("unknown_5rl", 32, 5), ("TDCREATE", 32, 2), ("TDUPDATE", 32, 2),
    ("HANDSEED", 32, 1), ("plot_stamp", 32, 1), ("zero_1", 16, 1), ("numsaves_3", 16, 1),
    ("zero_2", 32, 1), ("zero_3", 32, 1), ("zero_4", 32, 1), ("numsaves_4", 32, 1),
    ("zero_5", 32, 1), ("zero_6", 32, 1), ("zero_7", 32, 1), ("zero_8", 32, 1)]
MAX_RAW_AUX = 256
DECLARATIONS = (
    b"/* Development-only candidate observations; authenticated private copy. */\n"
    b"#include <stddef.h>\n"
    b"extern void jcad_header_diagnostic_aux_decompressed (int, int, unsigned long long, const unsigned char *, int, int);\n"
    b"extern void jcad_header_diagnostic_aux_parsed (int, unsigned long long, unsigned, int, int);\n"
    b"extern void jcad_header_diagnostic_aux_layout (const unsigned long long *, unsigned);\n"
    b"extern void jcad_header_diagnostic_aux_field (const char *, int, unsigned long long, unsigned, unsigned long long, unsigned long long, unsigned long long, unsigned);\n"
)
DECODE_REPLACEMENTS = [(DECOMPRESSED_CALL, DECOMPRESSED_CALL +
    b"\n  jcad_header_diagnostic_aux_decompressed (error, sec_dat.chain != NULL, (unsigned long long)sec_dat.size, sec_dat.chain, (int)sec_dat.version, (int)sec_dat.from_version);"),
    (PARSED_CALL, PARSED_CALL +
    b"\n  jcad_header_diagnostic_aux_parsed (error, (unsigned long long)dat->byte, dat->bit, (int)dat->version, (int)dat->from_version);"),
    (LAYOUT_ANCHOR, LAYOUT_ANCHOR + b"\n  { const unsigned long long facts[] = { " +
     ", ".join("(unsigned long long)" + value for value in LAYOUT_EXPRESSIONS).encode() +
     b" }; jcad_header_diagnostic_aux_layout (facts, sizeof facts / sizeof facts[0]); }")]


def aux_observation_replacements():
    replacements = []
    for name, _, count in FIELD_ROLES:
        if count == 1:
            anchor = f"  FIELD_RSx ({name}, 0);"
            values = [f"_obj->{name}", "0", "0"]
            candidate = (f'#ifdef IS_DECODER\n  if (dat->from_version == R_2018)\n'
                f'    {{ FIELD_RL ({name}, 0); }}\n  else\n#endif\n'
                f'    {{ FIELD_RSx ({name}, 0); }}')
        elif count == 2:
            anchor = f"  FIELD_TIMERLL ({name}, 0);"
            values = [f"_obj->{name}.days", f"_obj->{name}.ms", "0"]
            candidate = anchor
        else:
            anchor = "    FIELD_VECTOR_INL (zero_18, RS, 3, 0);"
            values = ["0", "0", "0"]
            candidate = ('#ifdef IS_DECODER\n    if (dat->from_version != R_2018)\n#endif\n'
                         '      { FIELD_VECTOR_INL (zero_18, RS, 3, 0); }')
        indent = anchor[:len(anchor) - len(anchor.lstrip())]
        before = f'#ifdef IS_DECODER\n{indent}jcad_header_diagnostic_aux_field ("{name}", 0, (unsigned long long)dat->byte, dat->bit, 0, 0, 0, {count});\n#endif\n'
        after = f'\n#ifdef IS_DECODER\n{indent}jcad_header_diagnostic_aux_field ("{name}", 1, (unsigned long long)dat->byte, dat->bit, ' + ", ".join("(unsigned long long)" + value for value in values) + f", {count});\n#endif"
        replacements.append((anchor.encode(), (before + candidate + after).encode()))
    return replacements


AUX_REPLACEMENTS = aux_observation_replacements()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def checked_file(path, limit):
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= limit:
        raise ValueError("Missing, linked or oversized evidence input")
    content = path.read_bytes()
    if not 0 < len(content) <= limit:
        raise ValueError("Changed evidence input size")
    return content


def patch_decoder(data):
    if sha(data) != DECODE_SHA:
        raise ValueError("Authenticated decode.c preimage changed")
    for call, _ in DECODE_REPLACEMENTS:
        if data.count(call) != 1:
            raise ValueError("Aux observation anchor is not unique")
    result = data
    for original, observed in DECODE_REPLACEMENTS:
        result = result.replace(original, observed, 1)
    return DECLARATIONS + result


def patch_aux_spec(data):
    if sha(data) != AUX_SPEC_SHA:
        raise ValueError("Authenticated auxheader.spec preimage changed")
    result = data
    for original, observed in AUX_REPLACEMENTS:
        if data.count(original) != 1:
            raise ValueError("Aux field observation anchor is not unique")
        result = result.replace(original, observed, 1)
    return result


def patch_header(data):
    if sha(data) != HEADER_SHA:
        raise ValueError("Authenticated dwg.h preimage changed")
    start = data.index(b"typedef struct _dwg_auxheader\n")
    end = data.index(b"} Dwg_AuxHeader;", start)
    body = data[start:end]
    for name in ("maint_version", "maint_version_1", "maint_version_2"):
        original = f"  BITCODE_RS {name};".encode()
        if body.count(original) != 1:
            raise ValueError("Aux maintenance storage anchor is not unique")
        body = body.replace(original, f"  BITCODE_RL {name};".encode(), 1)
    return data[:start] + body + data[end:]


def archive_name(name):
    if "\\" in name or "\0" in name or PurePosixPath(name).is_absolute():
        raise ValueError("Unsafe source archive path")
    parts = PurePosixPath(name).parts
    if ".." in parts:
        raise ValueError("Source archive path escapes its root")
    return "/".join(parts)


def extract_regular(archive_bytes, destination):
    """Never follow archived tool symlinks. CI regenerates these with Autotools."""
    names = set()
    total = 0
    ignored = []
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as source:
        members = source.getmembers()
        if len(members) > 4096:
            raise ValueError("Source archive entry budget exceeded")
        for member in members:
            name = archive_name(member.name)
            if not name:
                if not member.isdir():
                    raise ValueError("Invalid root archive entry")
                continue
            if name in names:
                raise ValueError("Duplicate source archive path")
            names.add(name)
            if member.issym() and name in IGNORED_LINKS:
                ignored.append({"path": name, "target": member.linkname})
                continue
            if not (member.isfile() or member.isdir()):
                raise ValueError("Unsupported source archive link/device")
            if member.size < 0 or member.size > 32 * 1024 * 1024:
                raise ValueError("Source archive member budget exceeded")
            total += member.size
            if total > 256 * 1024 * 1024:
                raise ValueError("Expanded source budget exceeded")
        destination.mkdir()
        for member in members:
            name = archive_name(member.name)
            if not name or member.issym():
                continue
            target = destination.joinpath(*PurePosixPath(name).parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as stream, target.open("xb") as output:
                copied = 0
                while True:
                    chunk = stream.read(256 * 1024)
                    if not chunk:
                        break
                    copied += len(chunk)
                    if copied > member.size:
                        raise ValueError("Source archive member grew")
                    output.write(chunk)
            if copied != member.size:
                raise ValueError("Source archive member was truncated")
            target.chmod(0o755 if member.mode & 0o111 else 0o644)
    return ignored


def source_hashes(source):
    return {str(path.relative_to(source)).replace("\\", "/"): sha(path.read_bytes())
            for path in sorted(source.rglob("*"))
            if path.is_file() and not path.is_symlink()
            and path.suffix in (".c", ".h", ".spec", ".inc")}


def checked_context(workspace, directory, revision):
    workspace = Path(workspace).resolve(strict=True)
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Expected exact checkout revision")
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=workspace, text=True).strip()
    if actual != revision:
        raise ValueError("Diagnostic checkout revision changed")
    temporary = Path(os.environ.get("RUNNER_TEMP", workspace / ".codex-local/header-creation-audit")).resolve(strict=True)
    directory = Path(directory).resolve()
    if directory == temporary or not directory.is_relative_to(temporary):
        raise ValueError("Diagnostic directory must stay in its private temporary root")
    return workspace, directory


def prepare(workspace, directory, revision):
    workspace, directory = checked_context(workspace, directory, revision)
    if directory.exists():
        raise ValueError("Refuse an existing diagnostic build directory")
    vendor = workspace / "vendor/libredwg-web-bg"
    archive = vendor / "modified-source.tar.gz"
    archive_bytes = checked_file(archive, 128 * 1024 * 1024)
    if sha(archive_bytes) != ARCHIVE_SHA:
        raise ValueError("Authenticated corresponding-source archive changed")
    provenance = json.loads(checked_file(vendor / "provenance.json", 512 * 1024))
    if provenance["source"]["commit"] != "1dd682f46339f37b67c5ff1085d10d04a8c16d7e":
        raise ValueError("Native source provenance changed")
    directory.mkdir()
    ignored = extract_regular(archive_bytes, directory / "source")
    decode = directory / "source/src/decode.c"
    before = decode.read_bytes()
    decode.write_bytes(patch_decoder(before))
    aux_spec = directory / "source/src/auxheader.spec"
    aux_before = aux_spec.read_bytes()
    aux_spec.write_bytes(patch_aux_spec(aux_before))
    header = directory / "source/include/dwg.h"
    header_before = header.read_bytes()
    header.write_bytes(patch_header(header_before))
    inputs = directory / "inputs"
    inputs.mkdir()
    fixtures = []
    for stem, expected in FIXTURES.items():
        original = workspace / f"tests/fixtures/interchange/{stem}.dwg"
        data = checked_file(original, MAX_INPUT)
        if sha(data) != expected or len(data) != FIXTURE_BYTES[stem] or data[:6] != b"AC1032":
            raise ValueError("Original DWG hash/version changed")
        copy = inputs / f"{stem}.dwg"
        with copy.open("xb") as output:
            output.write(data)
        copy.chmod(0o444)
        if sha(checked_file(copy, MAX_INPUT)) != expected:
            raise ValueError("Private original copy changed")
        fixtures.append({"stem": stem, "sha256": expected, "bytes": len(data)})
    proof = {"schemaVersion": 1, "revision": revision, "source": provenance["source"],
        "archiveSha256": ARCHIVE_SHA, "decodeBeforeSha256": sha(before),
        "decodeObservedSha256": sha(decode.read_bytes()), "observerOnly": False,
        "candidateSchemaExperiment": True,
        "auxSpecBeforeSha256": sha(aux_before), "auxSpecObservedSha256": sha(aux_spec.read_bytes()),
        "headerBeforeSha256": sha(header_before), "headerCandidateSha256": sha(header.read_bytes()),
        "sourceVariant": SOURCE_VARIANT, "baselineReference": BASELINE_REFERENCE,
        "dxfReferences": {stem: read_dxf_reference(workspace, stem) for stem in FIXTURES},
        "ignoredToolSymlinks": ignored, "sourceHashes": source_hashes(directory / "source"),
        "fixtures": fixtures, "driverSha256": sha(checked_file(workspace /
            "scripts/native-dwg-build/header-diagnostic.c", 64 * 1024))}
    (directory / "prepared.json").write_text(json.dumps(proof, indent=2) + "\n")
    print(json.dumps({"diagnosticPrepared": True, "revision": revision,
        "archiveSha256": ARCHIVE_SHA, "decodeObservedSha256": proof["decodeObservedSha256"],
        "auxSpecObservedSha256": proof["auxSpecObservedSha256"],
        "sourceVariant": SOURCE_VARIANT, "headerCandidateSha256": proof["headerCandidateSha256"],
        "originals": fixtures, "sourceFileCount": len(proof["sourceHashes"])}))


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate diagnostic JSON property")
        result[key] = value
    return result


def validated_fixture_manifest(values):
    if not isinstance(values, list) or len(values) != len(FIXTURES):
        raise ValueError("Expected exactly four original fixtures")
    for value, (stem, expected) in zip(values, FIXTURES.items()):
        if not isinstance(value, dict) or set(value) != {"stem", "sha256", "bytes"} or value["stem"] != stem or value["sha256"] != expected or type(value["bytes"]) is not int or value["bytes"] != FIXTURE_BYTES[stem]:
            raise ValueError("Original fixture registry changed")
    return values


def validated_result(data, returncode, input_bytes):
    if len(data) > MAX_OUTPUT:
        raise ValueError("Diagnostic output budget exceeded")
    result = json.loads(data, object_pairs_hook=unique_object,
                        parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Non-finite JSON")))
    if not isinstance(result, dict) or set(result) != {"schemaVersion", "sourceVariant", "inputBytes", "nativeError", "nativeVersion", "auxSection", "auxRead", "aux", "auxFields", "mainUtc", "hostDerivedLocal", "elapsed", "unverifiedObservations", "nativeFreed", "rawAuxCertified", "candidateDecoded"}:
        raise ValueError("Invalid diagnostic JSON schema")
    for field in ("schemaVersion", "inputBytes", "nativeError", "nativeVersion"):
        if type(result[field]) is not int:
            raise ValueError("Invalid diagnostic integer storage")
    if returncode != 0 or result.get("schemaVersion") != 1 or result.get("nativeError") != 0 or result["nativeVersion"] != NATIVE_R2018:
        raise ValueError("Native diagnostic read failed")
    if result.get("sourceVariant") != SOURCE_VARIANT or result.get("inputBytes") != input_bytes or result.get("nativeFreed") is not True or result.get("rawAuxCertified") is not False or result.get("candidateDecoded") is not True:
        raise ValueError("Uncertified diagnostic lifetime/input")
    section, observed, aux = result["auxSection"], result["auxRead"], result["aux"]
    for group, fields in ((section, ("count", "size", "pages")),
                          (observed, ("attempts", "parses", "decompressionError", "parseError", "decodedSize")),
                          (aux, ("version", "maintenance"))):
        if not isinstance(group, dict) or any(type(group.get(field)) is not int for field in fields):
            raise ValueError("Invalid native observation integer storage")
    if section["count"] != 1 or section["nameValid"] is not True or not 0 < section["size"] <= MAX_INPUT or section["pages"] < 1:
        raise ValueError("Auxiliary section identity is not unique")
    if observed["attempts"] != 1 or observed["parses"] != 1 or observed["decompressionError"] != 0 or observed["parseError"] != 0 or observed["chainPresent"] is not True or not 0 < observed["decodedSize"] <= MAX_INPUT:
        raise ValueError("Auxiliary section was not successfully decoded")
    if aux["magic"] != [255, 119, 1] or aux["version"] != 33:
        raise ValueError("Auxiliary header magic/version changed")
    validated_observations(result["unverifiedObservations"], observed["decodedSize"], aux)
    validated_aux_fields(result)
    for group in ("aux", "mainUtc", "hostDerivedLocal", "elapsed"):
        for name in (("drawing", "user") if group == "elapsed" else ("creation", "update")):
            date = result[group][name]
            if type(date["days"]) is not int or type(date["ms"]) is not int or not 0 <= date["days"] <= 0x7fffffff or not 0 <= date["ms"] < 86400000:
                raise ValueError("Invalid raw native date tuple")
    return result


def validated_observations(value, decoded_size, aux):
    required = {"observationError", "layoutCalls", "layoutMatches", "driverLayout", "libraryLayout",
        "decodedVersion", "decodedFromVersion", "parsedVersion", "parsedFromVersion",
        "finalByte", "finalBit", "capturedBytes", "rawComplete", "rawHex", "fields"}
    if not isinstance(value, dict) or set(value) != required:
        raise ValueError("Invalid source observation schema")
    integer_fields = ["observationError", "layoutCalls", "decodedVersion", "decodedFromVersion",
                      "parsedVersion", "parsedFromVersion", "finalByte", "finalBit", "capturedBytes"]
    if any(type(value[key]) is not int for key in integer_fields):
        raise ValueError("Invalid source observation integer storage")
    if value["observationError"] != 0 or value["layoutCalls"] != 1 or value["layoutMatches"] is not True:
        raise ValueError("Library and driver layout evidence disagrees")
    for layout in (value["driverLayout"], value["libraryLayout"]):
        if not isinstance(layout, dict) or set(layout) != set(LAYOUT_NAMES) or any(type(number) is not int or not 0 <= number <= 1024 * 1024 for number in layout.values()):
            raise ValueError("Invalid bounded library layout evidence")
    if value["driverLayout"] != value["libraryLayout"]:
        raise ValueError("Library and driver layouts differ")
    layout = value["driverLayout"]
    if (layout["rsBytes"], layout["rlBytes"], layout["rllBytes"], layout["timeBytes"], layout["daysOffset"], layout["msOffset"], layout["valueOffset"]) != (2, 4, 8, 16, 0, 4, 8):
        raise ValueError("Unexpected fixed-width date layout")
    if any(layout[key] != 4 for key in ("maintenanceBytes", "maintenance1Bytes", "maintenance2Bytes")):
        raise ValueError("Candidate maintenance storage is not full 32-bit")
    if any(value[key] != NATIVE_R2018 for key in ("decodedVersion", "decodedFromVersion", "parsedVersion", "parsedFromVersion")):
        raise ValueError("Aux source cursor version changed")
    if decoded_size != 129 or value["finalBit"] != 0 or value["finalByte"] != decoded_size:
        raise ValueError("Aux source cursor exceeds its decoded section")
    if value["rawComplete"] is not True or value["capturedBytes"] != decoded_size or not 0 < value["capturedBytes"] <= MAX_RAW_AUX or not isinstance(value["rawHex"], str) or not re.fullmatch(r"[0-9a-f]{" + str(value["capturedBytes"] * 2) + r"}", value["rawHex"]):
        raise ValueError("Incomplete or oversized raw Aux observation")
    fields = value["fields"]
    if not isinstance(fields, list) or len(fields) != len(FIELD_ROLES):
        raise ValueError("Missing source-defined Aux field observations")
    previous_end = 0
    for field, (name, width, count) in zip(fields, FIELD_ROLES):
        if not isinstance(field, dict) or set(field) != {"name", "beforeCalls", "afterCalls", "beforeBits", "afterBits", "values"} or field["name"] != name:
            raise ValueError("Aux field role/order changed")
        if any(type(field[key]) is not int for key in ("beforeCalls", "afterCalls", "beforeBits", "afterBits")) or field["beforeCalls"] != 1 or field["afterCalls"] != 1 or not previous_end <= field["beforeBits"] <= field["afterBits"] <= decoded_size * 8 or field["afterBits"] - field["beforeBits"] != width:
            raise ValueError("Invalid source-defined Aux field span")
        values = field["values"]
        maximum = 0xffffffff
        if not isinstance(values, list) or len(values) != count or any(type(number) is not int or not 0 <= number <= maximum for number in values):
            raise ValueError("Invalid observed Aux field value")
        if name in ("TDCREATE", "TDUPDATE"):
            date = aux["creation" if name == "TDCREATE" else "update"]
            if values != [date["days"], date["ms"]]:
                raise ValueError("Library observed date differs from driver date")
        elif name == "maint_version" and values != [aux["maintenance"]]:
            raise ValueError("Library observed maintenance differs from driver value")
        previous_end = field["afterBits"]
    if previous_end > value["finalByte"] * 8 + value["finalBit"]:
        raise ValueError("Final Aux cursor precedes a source field read")


def validated_aux_fields(result):
    """Compare every actual typed value with the complete authenticated candidate sequence."""
    fields = result["auxFields"]
    if not isinstance(fields, dict) or list(fields) != [name for name, _, _ in AUX_FIELDS]:
        raise ValueError("Candidate named Aux field sequence changed")
    raw = bytes.fromhex(result["unverifiedObservations"]["rawHex"])
    cursor = 0
    positions = {}
    for name, width, count in AUX_FIELDS:
        size = width // 8
        values = fields[name]
        if not isinstance(values, list) or len(values) != count or any(type(value) is not int or not 0 <= value < 2 ** width for value in values):
            raise ValueError("Candidate Aux field storage changed: " + name)
        end = cursor + size * count
        actual = [int.from_bytes(raw[cursor + index * size:cursor + (index + 1) * size], "little") for index in range(count)]
        if end > len(raw) or actual != values:
            raise ValueError("Candidate typed/raw Aux field disagrees: " + name)
        positions[name] = (cursor * 8, end * 8)
        cursor = end
    if cursor != len(raw) or cursor != 129:
        raise ValueError("Candidate Aux sequence did not consume the exact section")
    for observed in result["unverifiedObservations"]["fields"]:
        name = observed["name"]
        expected = positions.get(name, (cursor * 8, cursor * 8))
        values = fields.get(name, [])
        if (observed["beforeBits"], observed["afterBits"]) != expected or observed["values"] != values:
            raise ValueError("Candidate named read span disagrees: " + name)


def dxf_reference_values(data):
    """Independently read only the fixed original DXF's four HEADER date scalars."""
    lines = data.decode("utf-8").splitlines()
    if len(lines) % 2:
        raise ValueError("Odd original DXF reference pair count")
    pairs = [(int(lines[index].strip()), lines[index + 1].strip()) for index in range(0, len(lines), 2)]
    if pairs[:2] != [(0, "SECTION"), (2, "HEADER")]:
        raise ValueError("Original date reference has no leading HEADER")
    wanted = {"$TDCREATE", "$TDUPDATE", "$TDUCREATE", "$TDUUPDATE"}
    dates = {}
    for index, (code, name) in enumerate(pairs[2:], 2):
        if code == 0:
            break
        if code == 9 and name in wanted:
            if name in dates or index + 1 >= len(pairs) or pairs[index + 1][0] != 40:
                raise ValueError("Ambiguous original date reference")
            source = pairs[index + 1][1]
            try:
                value = Decimal(source)
            except InvalidOperation as error:
                raise ValueError("Malformed original date reference") from error
            if not value.is_finite() or value < 0 or value >= 0x80000000:
                raise ValueError("Invalid original date reference")
            day = int(value.to_integral_value(rounding=ROUND_FLOOR))
            ms = int(((value - day) * 86400000).to_integral_value(rounding=ROUND_HALF_UP))
            if ms == 86400000:
                day += 1; ms = 0
            if day > 0x7fffffff:
                raise ValueError("Original date reference rounded outside its storage")
            dates[name] = {"sourceDecimal": source, "tuple": {"days": day, "ms": ms}}
    if set(dates) != wanted:
        raise ValueError("Missing original DXF date reference")
    return dates


def read_dxf_reference(workspace, stem):
    data = checked_file(workspace / f"tests/fixtures/interchange/{stem}.dxf", MAX_INPUT)
    canonical_sha = sha(data.replace(b"\r\n", b"\n"))
    if canonical_sha != DXF_REFERENCE_SHA[stem]:
        raise ValueError("Original DXF reference changed")
    return {"rawSha256": sha(data), "canonicalLfSha256": canonical_sha,
            "bytes": len(data), "dates": dxf_reference_values(data)}


def compare_date_reference(result, reference):
    comparisons = {}
    for name, local, universal in (("creation", "$TDCREATE", "$TDUCREATE"),
                                    ("update", "$TDUPDATE", "$TDUUPDATE")):
        if result["mainUtc"][name] != reference["dates"][universal]["tuple"]:
            raise ValueError("Native mainUTC differs from exact original DXF reference")
        comparisons[name] = {"mainUtcMatchesSourceUniversal": True,
            "candidateAuxMatchesSourceLocal": result["aux"][name] == reference["dates"][local]["tuple"],
            "candidateAuxMatchesSourceUniversal": result["aux"][name] == reference["dates"][universal]["tuple"]}
    return comparisons


def validated_build_config(make_bytes, config_bytes):
    make = make_bytes.decode("utf-8")
    config = config_bytes.decode("utf-8")
    cflags = re.findall(r"^CFLAGS = ([^\r\n]*)$", make, flags=re.M)
    compiler = re.findall(r"^CC = ([^\r\n]*)$", make, flags=re.M)
    if len(cflags) != 1 or len(compiler) != 1 or compiler[0].strip() != "gcc" or "-DNDEBUG" not in cflags[0].split():
        raise ValueError("Unexpected effective compiler/flags")
    features = {}
    for name, expected in CONFIG_FEATURES.items():
        definitions = re.findall(r"^#define " + re.escape(name) + r"\s+([^\r\n]+)$", config, flags=re.M)
        if len(definitions) > 1:
            raise ValueError("Duplicate build configuration macro")
        actual = definitions[0].strip() if definitions else None
        if actual != expected:
            raise ValueError("Unexpected build configuration feature: " + name)
        features[name] = actual
    return {"effectiveCflags": cflags[0], "effectiveCompiler": compiler[0].strip(), "features": features}


def record_build(workspace, directory, revision):
    workspace, directory = checked_context(workspace, directory, revision)
    prepared = json.loads(checked_file(directory / "prepared.json", 512 * 1024))
    validated_fixture_manifest(prepared["fixtures"])
    if prepared["revision"] != revision or source_hashes(directory / "source") != prepared["sourceHashes"]:
        raise ValueError("Authenticated source changed during compilation")
    driver = workspace / "scripts/native-dwg-build/header-diagnostic.c"
    if sha(checked_file(driver, 64 * 1024)) != prepared["driverSha256"]:
        raise ValueError("Diagnostic driver changed during compilation")
    compiler = subprocess.check_output(["gcc", "--version"], text=True, timeout=5)
    if len(compiler) > 4096 or "gcc" not in compiler.lower():
        raise ValueError("Invalid observed compiler identity")
    make_bytes = checked_file(directory / "build/src/Makefile", 512 * 1024)
    config_bytes = checked_file(directory / "build/src/config.h", 512 * 1024)
    configured = validated_build_config(make_bytes, config_bytes)
    # These commands are the explicit GCC step in the hash-bound development workflow.
    workflow = workspace / ".github/workflows/dwg-header-diagnostic.yml"
    manifest = {"revision": revision, "compilerKind": "native-gcc-development-only",
        "sourceVariant": SOURCE_VARIANT, "baselineReference": BASELINE_REFERENCE,
        "compilerVersion": compiler, "requestedCflags": LIBRARY_CFLAGS, **configured,
        "configuredMakefileSha256": sha(make_bytes), "configuredHeaderSha256": sha(config_bytes),
        "configureArgs": CONFIGURE_ARGS,
        "libraryTarget": ["make", "-C", "build/src", "-j2", "libredwg.la"],
        "linkFlags": ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-lm", "-lz"],
        "workflowSha256": sha(checked_file(workflow, 64 * 1024)),
        "driverSha256": prepared["driverSha256"],
        "librarySha256": sha(checked_file(directory / "build/src/.libs/libredwg.a", 64 * 1024 * 1024)),
        "binarySha256": sha(checked_file(directory / "diagnostic", 64 * 1024 * 1024))}
    (directory / "compiled.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"diagnosticBuild": manifest}, separators=(",", ":")))


def run_one(binary, copy, output, zone):
    import resource
    def limits():
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OUTPUT, MAX_OUTPUT))
        resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
    environment = {**os.environ, "TZ": zone}
    environment.pop("LIBREDWG_TRACE", None)
    with output.with_suffix(".stdout").open("xb") as stdout, output.with_suffix(".stderr").open("xb") as stderr:
        process = subprocess.Popen([str(binary), str(copy)], stdout=stdout, stderr=stderr, cwd=output.parent,
                                   env=environment, start_new_session=True, preexec_fn=limits)
        try:
            process.wait(timeout=20)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    data = output.with_suffix(".stdout").read_bytes()
    error = output.with_suffix(".stderr").read_bytes()
    if error:
        print(json.dumps({"diagnosticStderr": error[:4096].decode("utf-8", "replace")}))
    try:
        return validated_result(data, process.returncode, copy.stat().st_size)
    except (ValueError, KeyError, TypeError):
        print(json.dumps({"unverifiedDiagnosticExit": process.returncode,
                          "unverifiedDiagnosticStdout": data[:MAX_OUTPUT].decode("utf-8", "replace")}))
        raise


def original_pair_evidence(original, copy):
    original_bytes = checked_file(original, MAX_INPUT)
    copied_bytes = checked_file(copy, MAX_INPUT)
    return {"originalSha256": sha(original_bytes), "copySha256": sha(copied_bytes),
            "originalBytes": len(original_bytes), "copyBytes": len(copied_bytes)}


def pair_matches(fixture, evidence):
    return (type(fixture["bytes"]) is int and evidence["originalBytes"] == fixture["bytes"]
        and evidence["copyBytes"] == fixture["bytes"]
        and evidence["originalSha256"] == fixture["sha256"]
        and evidence["copySha256"] == fixture["sha256"])


def checked_original_pair(fixture, original, copy):
    evidence = original_pair_evidence(original, copy)
    if not pair_matches(fixture, evidence):
        raise ValueError("Original or private copy changed")
    return evidence


def run_checked_original(fixture, original, copy, binary, output, zone):
    checked_original_pair(fixture, original, copy)
    try:
        return run_one(binary, copy, output, zone)
    finally:
        # Even a refused read/timeout must leave explicit after-read input evidence.
        try:
            after = original_pair_evidence(original, copy)
        except (ValueError, OSError):
            print(json.dumps({"diagnosticAfterReadInputs": {"stem": fixture["stem"],
                "zone": zone, "unchanged": False}}))
            raise
        unchanged = pair_matches(fixture, after)
        print(json.dumps({"diagnosticAfterReadInputs": {"stem": fixture["stem"],
            "zone": zone, "unchanged": unchanged, **after}}))
        if not unchanged:
            raise ValueError("Original or private copy changed after native read")


def run(workspace, directory, revision):
    workspace, directory = checked_context(workspace, directory, revision)
    prepared = json.loads(checked_file(directory / "prepared.json", 512 * 1024))
    validated_fixture_manifest(prepared["fixtures"])
    if prepared["revision"] != revision or prepared["archiveSha256"] != ARCHIVE_SHA or source_hashes(directory / "source") != prepared["sourceHashes"]:
        raise ValueError("Source changed during diagnostic compilation")
    if prepared["sourceVariant"] != SOURCE_VARIANT or prepared["baselineReference"] != BASELINE_REFERENCE or prepared["headerBeforeSha256"] != HEADER_SHA:
        raise ValueError("Candidate source variant changed")
    driver = workspace / "scripts/native-dwg-build/header-diagnostic.c"
    if sha(checked_file(driver, 64 * 1024)) != prepared["driverSha256"]:
        raise ValueError("Diagnostic driver changed during compilation")
    binary = directory / "diagnostic"
    binary_sha = sha(checked_file(binary, 64 * 1024 * 1024))
    compiled = json.loads(checked_file(directory / "compiled.json", 64 * 1024))
    if compiled["sourceVariant"] != SOURCE_VARIANT or compiled["baselineReference"] != BASELINE_REFERENCE:
        raise ValueError("Compiled candidate variant changed")
    if compiled["revision"] != revision or compiled["driverSha256"] != prepared["driverSha256"] or compiled["binarySha256"] != binary_sha or compiled["workflowSha256"] != sha(checked_file(workspace / ".github/workflows/dwg-header-diagnostic.yml", 64 * 1024)) or compiled["librarySha256"] != sha(checked_file(directory / "build/src/.libs/libredwg.a", 64 * 1024 * 1024)):
        raise ValueError("Compiled diagnostic provenance changed")
    make_bytes = checked_file(directory / "build/src/Makefile", 512 * 1024)
    config_bytes = checked_file(directory / "build/src/config.h", 512 * 1024)
    if compiled["requestedCflags"] != LIBRARY_CFLAGS or compiled["configureArgs"] != CONFIGURE_ARGS or compiled["configuredMakefileSha256"] != sha(make_bytes) or compiled["configuredHeaderSha256"] != sha(config_bytes):
        raise ValueError("Configured diagnostic provenance changed")
    if any(compiled[key] != value for key, value in validated_build_config(make_bytes, config_bytes).items()):
        raise ValueError("Effective diagnostic configuration changed")
    cases = []
    for fixture in prepared["fixtures"]:
        stem, expected = fixture["stem"], fixture["sha256"]
        original = workspace / f"tests/fixtures/interchange/{stem}.dwg"
        copy = directory / f"inputs/{stem}.dwg"
        checked_original_pair(fixture, original, copy)
        reference = read_dxf_reference(workspace, stem)
        if reference != prepared["dxfReferences"].get(stem):
            raise ValueError("Original DXF reference changed after preparation")
        zones = {}
        for zone, label in (("UTC", "utc"), ("America/Chicago", "chicago")):
            zones[zone] = run_checked_original(fixture, original, copy, binary,
                                              directory / f"{stem}-{label}", zone)
        for field in ("aux", "auxFields", "mainUtc"):
            if zones["UTC"][field] != zones["America/Chicago"][field]:
                raise ValueError("Raw stored header evidence changed with host timezone")
        if read_dxf_reference(workspace, stem) != reference:
            raise ValueError("Original DXF reference changed during native read")
        comparisons = {zone: compare_date_reference(result, reference) for zone, result in zones.items()}
        case = {**fixture, "zones": zones, "originalAndCopyUnchanged": True,
            "dxfReference": reference, "dateComparisons": comparisons,
            "candidateRawSectionSha256": sha(bytes.fromhex(zones["UTC"]["unverifiedObservations"]["rawHex"]))}
        cases.append(case)
        print(json.dumps({"rawHeaderEvidence": case}, separators=(",", ":")))
    proof = {"schemaVersion": 1, "revision": revision, "archiveSha256": ARCHIVE_SHA,
        "source": prepared["source"], "decodeBeforeSha256": prepared["decodeBeforeSha256"],
        "decodeObservedSha256": prepared["decodeObservedSha256"], "driverSha256": prepared["driverSha256"],
        "auxSpecBeforeSha256": prepared["auxSpecBeforeSha256"],
        "auxSpecObservedSha256": prepared["auxSpecObservedSha256"],
        "headerBeforeSha256": prepared["headerBeforeSha256"], "headerCandidateSha256": prepared["headerCandidateSha256"],
        "sourceVariant": SOURCE_VARIANT, "baselineReference": BASELINE_REFERENCE,
        "rawAuxCertified": False, "candidateOnly": True,
        "binarySha256": binary_sha, "cases": cases, "observerOnly": False,
        "candidateSchemaExperiment": True,
        "build": compiled,
        "noProductionChanges": True, "ownedChildrenJoined": True, "passed": True}
    (directory / "raw-header-proof.json").write_text(json.dumps(proof, indent=2) + "\n")
    print(json.dumps({"rawHeaderDiagnosticPassed": True, "revision": revision,
        "cases": len(cases), "archiveSha256": ARCHIVE_SHA, "binarySha256": binary_sha}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("prepare", "record-build", "run"))
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--revision", required=True)
    args = parser.parse_args()
    {"prepare": prepare, "record-build": record_build, "run": run}[args.mode](args.workspace, args.directory, args.revision)
