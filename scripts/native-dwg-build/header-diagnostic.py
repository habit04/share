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
# Authenticated include/dwg.h DWG_VERSION_TYPE: R_12 aliases R_11; R_2018 is 40.
NATIVE_R2018 = 40
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
DECLARATIONS = (
    b"/* Development-only observation; authenticated copy, no decode changes. */\n"
    b"extern void jcad_header_diagnostic_aux_decompressed (int, int, unsigned long long);\n"
    b"extern void jcad_header_diagnostic_aux_parsed (int);\n"
)


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
    for call in (DECOMPRESSED_CALL, PARSED_CALL):
        if data.count(call) != 1:
            raise ValueError("Aux observation anchor is not unique")
    result = DECLARATIONS + data.replace(DECOMPRESSED_CALL, DECOMPRESSED_CALL +
        b"\n  jcad_header_diagnostic_aux_decompressed (error, sec_dat.chain != NULL, (unsigned long long)sec_dat.size);", 1)
    return result.replace(PARSED_CALL, PARSED_CALL +
        b"\n  jcad_header_diagnostic_aux_parsed (error);", 1)


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
        "ignoredToolSymlinks": ignored, "sourceHashes": source_hashes(directory / "source"),
        "fixtures": fixtures, "driverSha256": sha(checked_file(workspace /
            "scripts/native-dwg-build/header-diagnostic.c", 64 * 1024))}
    (directory / "prepared.json").write_text(json.dumps(proof, indent=2) + "\n")
    print(json.dumps({"diagnosticPrepared": True, "revision": revision,
        "archiveSha256": ARCHIVE_SHA, "decodeObservedSha256": proof["decodeObservedSha256"],
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
    if not isinstance(result, dict) or set(result) != {"schemaVersion", "inputBytes", "nativeError", "nativeVersion", "auxSection", "auxRead", "aux", "mainUtc", "hostDerivedLocal", "elapsed", "nativeFreed", "rawAuxCertified"}:
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
    for group in ("aux", "mainUtc", "hostDerivedLocal", "elapsed"):
        for name in (("drawing", "user") if group == "elapsed" else ("creation", "update")):
            date = result[group][name]
            if type(date["days"]) is not int or type(date["ms"]) is not int or not 0 <= date["days"] <= 0x7fffffff or not 0 <= date["ms"] < 86400000:
                raise ValueError("Invalid raw native date tuple")
    return result


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
    # These commands are the explicit GCC step in the hash-bound development workflow.
    workflow = workspace / ".github/workflows/dwg-header-diagnostic.yml"
    manifest = {"revision": revision, "compilerKind": "native-gcc-development-only",
        "compilerVersion": compiler, "cc": "gcc", "cflags": "-O2 -DNDEBUG",
        "configureArgs": ["--disable-docs", "--disable-write", "--disable-json", "--disable-python",
                          "--disable-bindings", "--disable-shared", "--enable-static"],
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
        process = subprocess.Popen([str(binary), str(copy)], stdout=stdout, stderr=stderr,
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


def checked_original_pair(fixture, original, copy):
    original_bytes = checked_file(original, MAX_INPUT)
    copied_bytes = checked_file(copy, MAX_INPUT)
    if type(fixture["bytes"]) is not int or len(original_bytes) != fixture["bytes"] or len(copied_bytes) != fixture["bytes"] or sha(original_bytes) != fixture["sha256"] or sha(copied_bytes) != fixture["sha256"]:
        raise ValueError("Original or private copy changed")


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
    cases = []
    for fixture in prepared["fixtures"]:
        stem, expected = fixture["stem"], fixture["sha256"]
        original = workspace / f"tests/fixtures/interchange/{stem}.dwg"
        copy = directory / f"inputs/{stem}.dwg"
        checked_original_pair(fixture, original, copy)
        zones = {}
        for zone, label in (("UTC", "utc"), ("America/Chicago", "chicago")):
            zones[zone] = run_one(binary, copy, directory / f"{stem}-{label}", zone)
            checked_original_pair(fixture, original, copy)
        for field in ("aux", "mainUtc"):
            if zones["UTC"][field] != zones["America/Chicago"][field]:
                raise ValueError("Raw stored header evidence changed with host timezone")
        case = {**fixture, "zones": zones, "originalAndCopyUnchanged": True}
        cases.append(case)
        print(json.dumps({"rawHeaderEvidence": case}, separators=(",", ":")))
    proof = {"schemaVersion": 1, "revision": revision, "archiveSha256": ARCHIVE_SHA,
        "source": prepared["source"], "decodeBeforeSha256": prepared["decodeBeforeSha256"],
        "decodeObservedSha256": prepared["decodeObservedSha256"], "driverSha256": prepared["driverSha256"],
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
