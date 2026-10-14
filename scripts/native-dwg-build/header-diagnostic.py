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

ARCHIVE_SHA = "96d407e96047237200360b1669768f80aaffbb003c34c6fe57228fc4cd345d5a"
DECODE_SHA = "be1fa5ba174fee1a513de35c7a32a2344a009e00a45c39a7480fb444cf10829a"
AUX_SPEC_SHA = "80fd1928f65b68d69fba973448320a7d268df2272de8d80602905bac8b48f5dd"
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
    "offsetof(Dwg_AuxHeader, TDUPDATE)", "offsetof(Dwg_AuxHeader, zero_18)"]
LAYOUT_NAMES = ["rsBytes", "rlBytes", "rllBytes", "timeBytes", "daysOffset", "msOffset",
    "valueOffset", "drawingBytes", "auxOffset", "auxBytes", "maintenanceOffset",
    "maintenance1Offset", "maintenance2Offset", "creationOffset", "updateOffset", "tailOffset"]
FIELD_ROLES = [("maint_version", 16, 1), ("maint_version_1", 16, 1),
               ("maint_version_2", 16, 1), ("TDCREATE", 64, 2),
               ("TDUPDATE", 64, 2), ("zero_18", 48, 3)]
MAX_RAW_AUX = 256
DECLARATIONS = (
    b"/* Development-only observation; authenticated copy, no decode changes. */\n"
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
        elif count == 2:
            anchor = f"  FIELD_TIMERLL ({name}, 0);"
            values = [f"_obj->{name}.days", f"_obj->{name}.ms", "0"]
        else:
            anchor = "    FIELD_VECTOR_INL (zero_18, RS, 3, 0);"
            values = [f"_obj->{name}[{index}]" for index in range(3)]
        indent = anchor[:len(anchor) - len(anchor.lstrip())]
        before = f'#ifdef IS_DECODER\n{indent}jcad_header_diagnostic_aux_field ("{name}", 0, (unsigned long long)dat->byte, dat->bit, 0, 0, 0, {count});\n#endif\n'
        after = f'\n#ifdef IS_DECODER\n{indent}jcad_header_diagnostic_aux_field ("{name}", 1, (unsigned long long)dat->byte, dat->bit, ' + ", ".join("(unsigned long long)" + value for value in values) + f", {count});\n#endif"
        replacements.append((anchor.encode(), (before + anchor + after).encode()))
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
        "decodeObservedSha256": sha(decode.read_bytes()), "observerOnly": True,
        "auxSpecBeforeSha256": sha(aux_before), "auxSpecObservedSha256": sha(aux_spec.read_bytes()),
        "ignoredToolSymlinks": ignored, "sourceHashes": source_hashes(directory / "source"),
        "fixtures": fixtures, "driverSha256": sha(checked_file(workspace /
            "scripts/native-dwg-build/header-diagnostic.c", 64 * 1024))}
    (directory / "prepared.json").write_text(json.dumps(proof, indent=2) + "\n")
    print(json.dumps({"diagnosticPrepared": True, "revision": revision,
        "archiveSha256": ARCHIVE_SHA, "decodeObservedSha256": proof["decodeObservedSha256"],
        "auxSpecObservedSha256": proof["auxSpecObservedSha256"],
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
    if not isinstance(result, dict) or set(result) != {"schemaVersion", "inputBytes", "nativeError", "nativeVersion", "auxSection", "auxRead", "aux", "mainUtc", "hostDerivedLocal", "elapsed", "unverifiedObservations", "nativeFreed", "rawAuxCertified"}:
        raise ValueError("Invalid diagnostic JSON schema")
    for field in ("schemaVersion", "inputBytes", "nativeError", "nativeVersion"):
        if type(result[field]) is not int:
            raise ValueError("Invalid diagnostic integer storage")
    if returncode != 0 or result.get("schemaVersion") != 1 or result.get("nativeError") != 0 or result["nativeVersion"] != NATIVE_R2018:
        raise ValueError("Native diagnostic read failed")
    if result.get("inputBytes") != input_bytes or result.get("nativeFreed") is not True or result.get("rawAuxCertified") is not True:
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
    if any(value[key] != NATIVE_R2018 for key in ("decodedVersion", "decodedFromVersion", "parsedVersion", "parsedFromVersion")):
        raise ValueError("Aux source cursor version changed")
    if not 0 <= value["finalBit"] <= 7 or not 0 <= value["finalByte"] <= decoded_size or value["finalByte"] * 8 + value["finalBit"] > decoded_size * 8:
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
        maximum = 0xffff if count in (1, 3) else 0xffffffff
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
    driver = workspace / "scripts/native-dwg-build/header-diagnostic.c"
    if sha(checked_file(driver, 64 * 1024)) != prepared["driverSha256"]:
        raise ValueError("Diagnostic driver changed during compilation")
    binary = directory / "diagnostic"
    binary_sha = sha(checked_file(binary, 64 * 1024 * 1024))
    compiled = json.loads(checked_file(directory / "compiled.json", 64 * 1024))
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
        zones = {}
        for zone, label in (("UTC", "utc"), ("America/Chicago", "chicago")):
            zones[zone] = run_checked_original(fixture, original, copy, binary,
                                              directory / f"{stem}-{label}", zone)
        for field in ("aux", "mainUtc"):
            if zones["UTC"][field] != zones["America/Chicago"][field]:
                raise ValueError("Raw stored header evidence changed with host timezone")
        case = {**fixture, "zones": zones, "originalAndCopyUnchanged": True}
        cases.append(case)
        print(json.dumps({"rawHeaderEvidence": case}, separators=(",", ":")))
    proof = {"schemaVersion": 1, "revision": revision, "archiveSha256": ARCHIVE_SHA,
        "source": prepared["source"], "decodeBeforeSha256": prepared["decodeBeforeSha256"],
        "decodeObservedSha256": prepared["decodeObservedSha256"], "driverSha256": prepared["driverSha256"],
        "auxSpecBeforeSha256": prepared["auxSpecBeforeSha256"],
        "auxSpecObservedSha256": prepared["auxSpecObservedSha256"],
        "binarySha256": binary_sha, "cases": cases, "observerOnly": True,
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
