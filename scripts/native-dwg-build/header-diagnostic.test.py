"""Tooling regressions; authored JSON/tars do not certify native date semantics."""
import hashlib
import importlib.util
import io
import json
import os
import re
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve()
WORKSPACE = SCRIPT.parents[2]
spec = importlib.util.spec_from_file_location("header_diagnostic", SCRIPT.with_name("header-diagnostic.py"))
diagnostic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostic)


def authored_result():
    date = {"days": 2461325, "ms": 70498000}
    return {"schemaVersion": 1, "inputBytes": 18644, "nativeError": 0, "nativeVersion": 40,
        "auxSection": {"count": 1, "nameValid": True, "size": 129, "pages": 1},
        "auxRead": {"attempts": 1, "parses": 1, "decompressionError": 0, "parseError": 0,
                    "chainPresent": True, "decodedSize": 129},
        "aux": {"magic": [255, 119, 1], "version": 33, "maintenance": 4,
                "creation": date.copy(), "update": date.copy()},
        "mainUtc": {"creation": {"days": 2461326, "ms": 2098000}, "update": {"days": 2461326, "ms": 2098000}},
        "hostDerivedLocal": {"creation": date.copy(), "update": date.copy()},
        "elapsed": {"drawing": {"days": 0, "ms": 1000}, "user": {"days": 0, "ms": 1000}},
        "nativeFreed": True, "rawAuxCertified": True}


class DiagnosticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        archive = WORKSPACE / "vendor/libredwg-web-bg/modified-source.tar.gz"
        assert hashlib.sha256(archive.read_bytes()).hexdigest() == diagnostic.ARCHIVE_SHA
        with tarfile.open(archive, "r:gz") as source:
            cls.original = source.extractfile("./src/decode.c").read()
            cls.header = source.extractfile("./include/dwg.h").read().decode()
            cls.makefile = source.extractfile("./src/Makefile.in").read().decode()
            cls.configure = source.extractfile("./configure.ac").read().decode()
            cls.dwg2 = source.extractfile("./src/dwg2.spec").read().decode()
            cls.print_source = source.extractfile("./src/print.c").read().decode()
        root = Path(os.environ.get("RUNNER_TEMP", WORKSPACE / ".codex-local/header-creation-audit")).resolve()
        root.mkdir(parents=True, exist_ok=True)
        cls.private = tempfile.TemporaryDirectory(prefix="header-diagnostic-tests-", dir=root)
        cls.root = Path(cls.private.name).resolve()
        assert cls.root.is_relative_to(root) and cls.root != root

    @classmethod
    def tearDownClass(cls):
        cls.private.cleanup()

    def tar(self, entries):
        path = self.root / f"case-{len(list(self.root.iterdir()))}.tar.gz"
        with tarfile.open(path, "w:gz") as archive:
            for name, kind, value in entries:
                info = tarfile.TarInfo(name)
                if kind == "file":
                    data = value.encode(); info.size = len(data)
                    archive.addfile(info, io.BytesIO(data))
                else:
                    info.type = tarfile.SYMTYPE if kind == "symlink" else tarfile.LNKTYPE
                    info.linkname = value
                    archive.addfile(info)
        return path

    def test_observation_only_exact_authenticated_source_replay(self):
        observed = diagnostic.patch_decoder(self.original)
        self.assertEqual(observed.count(b"jcad_header_diagnostic_aux_decompressed (error"), 1)
        self.assertEqual(observed.count(b"jcad_header_diagnostic_aux_parsed (error"), 1)
        restored = observed.removeprefix(diagnostic.DECLARATIONS)
        restored = restored.replace(diagnostic.DECOMPRESSED_CALL + b"\n  jcad_header_diagnostic_aux_decompressed (error, sec_dat.chain != NULL, (unsigned long long)sec_dat.size);", diagnostic.DECOMPRESSED_CALL)
        restored = restored.replace(diagnostic.PARSED_CALL + b"\n  jcad_header_diagnostic_aux_parsed (error);", diagnostic.PARSED_CALL)
        self.assertEqual(restored, self.original)

    def test_source_drift_and_reapplication_refuse(self):
        for changed in (self.original + b"\n", diagnostic.patch_decoder(self.original),
                        self.original.replace(diagnostic.PARSED_CALL, b"  error = 0;", 1)):
            with self.subTest(sha=diagnostic.sha(changed)), self.assertRaises(ValueError):
                diagnostic.patch_decoder(changed)

    def test_r2018_matches_authenticated_c_enum_not_aux_wire_version(self):
        text = re.sub(r'/\*.*?\*/|//[^\n]*', '', self.header, flags=re.S)
        body = re.search(r'typedef enum DWG_VERSION_TYPE\s*\{([^}]+)\}', text).group(1)
        values = {}; previous = -1
        for declaration in body.split(','):
            if not declaration.strip():
                continue
            parts = declaration.strip().split('=')
            value = values[parts[1].strip()] if len(parts) == 2 else previous + 1
            values[parts[0].strip()] = value; previous = value
        self.assertEqual(values['R_2018'], diagnostic.NATIVE_R2018)
        for version in (27, 33, 39, True):
            result = authored_result(); result['nativeVersion'] = version
            with self.subTest(version=version), self.assertRaises(ValueError):
                diagnostic.validated_result(json.dumps(result).encode(), 0, 18644)

    def test_factory_class_configuration_and_foreign_warnings_driver_remains_strict(self):
        workflow = (WORKSPACE / '.github/workflows/dwg-header-diagnostic.yml').read_text()
        flags = re.search(r"CC=gcc CFLAGS='([^']+)'", workflow).group(1)
        self.assertEqual(flags, diagnostic.LIBRARY_CFLAGS)
        self.assertEqual(flags.split(), ['-O2', '-DNDEBUG'])
        self.assertIn('$(AM_CFLAGS) $(CFLAGS)', self.makefile)
        arguments = re.search(r'"\$source_dir/configure" ([^\n)]+)', workflow).group(1).split()
        self.assertEqual(arguments, diagnostic.CONFIGURE_ARGS)
        for required in ('--enable-release', '--enable-debug', '--disable-werror', '--disable-write', '--disable-json'):
            self.assertIn(required, arguments)
        self.assertNotIn('--enable-trace', arguments)
        self.assertNotIn('-Wno-error', workflow)
        self.assertIn('AC_DEFINE([DEBUG_CLASSES],1', self.configure)
        self.assertIn('AC_ARG_ENABLE([werror]', self.configure)
        guarded_region = self.dwg2[self.dwg2.index('// AutoCAD Mechanical'):self.dwg2.index('#endif /* DEBUG_CLASSES || IS_FREE */', self.dwg2.index('// AutoCAD Mechanical'))]
        self.assertIn('DWG_ENTITY (ARCALIGNEDTEXT)', guarded_region)
        self.assertIn('#define IS_PRINT', self.print_source)
        self.assertLess(self.print_source.index('#include "dwg2.spec"'), self.print_source.index('#include "classes.inc"'))
        driver = next(line for line in workflow.splitlines() if line.strip().startswith('gcc -std=c11'))
        self.assertIn('-Wall -Wextra -Werror ', driver)
        self.assertNotIn('-Wno-error', driver)

    def test_effective_native_configuration_records_gnu_debug_flags(self):
        make = b'CC = gcc\nCFLAGS =  -DNDEBUG -fno-omit-frame-pointer\n'
        config = b'#define DEBUG_CLASSES 1\n#define DISABLE_JSON 1\n/* #undef HAVE_WERROR */\n'
        actual = diagnostic.validated_build_config(make, config)
        self.assertEqual(actual['effectiveCflags'], ' -DNDEBUG -fno-omit-frame-pointer')
        self.assertEqual(actual['features'], diagnostic.CONFIG_FEATURES)
        self.assertNotEqual(actual['effectiveCflags'], diagnostic.LIBRARY_CFLAGS)

    def test_wrong_effective_features_compiler_and_missing_flags_refuse(self):
        make = b'CC = gcc\nCFLAGS = -DNDEBUG -fno-omit-frame-pointer\n'
        config = b'#define DEBUG_CLASSES 1\n#define DISABLE_JSON 1\n'
        for wrong in (config.replace(b'#define DEBUG_CLASSES 1', b''),
                      config + b'#define HAVE_WERROR 1\n', config + b'#define USE_WRITE 1\n',
                      config + b'#define USE_TRACING 1\n', config + b'#define DEBUG 1\n',
                      config + b'#define DISABLE_DXF 1\n', config + b'#define DEBUG_CLASSES 1\n'):
            with self.subTest(config=wrong), self.assertRaises(ValueError):
                diagnostic.validated_build_config(make, wrong)
        for wrong in (make.replace(b'gcc', b'clang'), make.replace(b'-DNDEBUG', b''), make + b'CFLAGS = -DNDEBUG\n'):
            with self.subTest(make=wrong), self.assertRaises(ValueError):
                diagnostic.validated_build_config(wrong, config)

    def test_parent_and_windows_archive_escape_refuse_before_output(self):
        for name in ("../outside", "/outside", "src\\outside", "src/../outside"):
            with self.subTest(name=name):
                source = self.tar([(name, "file", "bad")]); destination = self.root / "not-created"
                with self.assertRaises(ValueError):
                    diagnostic.extract_regular(source.read_bytes(), destination)
                self.assertFalse(destination.exists())

    def test_archive_links_and_duplicate_entries_refuse(self):
        for entries in ([('src/leak', 'symlink', '/outside')], [('src/leak', 'hardlink', 'src/real')],
                        [('src/a', 'file', 'first'), ('src/a', 'file', 'second')]):
            with self.subTest(entries=entries):
                with self.assertRaises(ValueError):
                    diagnostic.extract_regular(self.tar(entries).read_bytes(), self.root / "not-created")
                self.assertFalse((self.root / "not-created").exists())

    def test_known_archived_tool_link_is_omitted_not_followed(self):
        destination = self.root / "extracted"
        ignored = diagnostic.extract_regular(self.tar([
            ('src/a.c', 'file', 'source'), ('m4/libtool.m4', 'symlink', '/usr/share/libtool.m4')]).read_bytes(), destination)
        self.assertEqual((destination / 'src/a.c').read_text(), 'source')
        self.assertFalse((destination / 'm4/libtool.m4').exists())
        self.assertEqual(ignored, [{'path': 'm4/libtool.m4', 'target': '/usr/share/libtool.m4'}])

    def test_authored_output_has_raw_values_without_host_conversion(self):
        original = authored_result()
        self.assertEqual(diagnostic.validated_result(json.dumps(original).encode(), 0, 18644), original)
        self.assertNotEqual(original['aux']['creation'], original['mainUtc']['creation'])

    def test_failed_read_parse_free_and_section_evidence_refuse(self):
        mutations = [('nativeError', 1), ('nativeFreed', False), ('rawAuxCertified', False), ('inputBytes', 18645)]
        for key, value in mutations:
            result = authored_result(); result[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                diagnostic.validated_result(json.dumps(result).encode(), 0, 18644)
        for group, key, value in [('auxRead', 'attempts', 0), ('auxRead', 'parses', 0),
            ('auxRead', 'parseError', 1), ('auxRead', 'decompressionError', 1),
            ('auxRead', 'chainPresent', False), ('auxRead', 'decodedSize', 0),
            ('auxSection', 'count', 2), ('auxSection', 'nameValid', False),
            ('auxSection', 'size', 0), ('auxSection', 'pages', 0),
            ('aux', 'magic', [0, 0, 0]), ('aux', 'version', 32)]:
            result = authored_result(); result[group][key] = value
            with self.subTest(group=group, key=key), self.assertRaises(ValueError):
                diagnostic.validated_result(json.dumps(result).encode(), 0, 18644)

    def test_invalid_date_storage_each_stream_refuses(self):
        for group, name in [('aux', 'creation'), ('aux', 'update'), ('mainUtc', 'creation'),
                            ('mainUtc', 'update'), ('hostDerivedLocal', 'creation'), ('elapsed', 'drawing')]:
            for key, value in [('days', -1), ('days', 0x80000000), ('days', 1.5),
                               ('days', True), ('ms', -1), ('ms', 86400000), ('ms', 0.5)]:
                result = authored_result(); result[group][name][key] = value
                with self.subTest(group=group, key=key, value=value), self.assertRaises(ValueError):
                    diagnostic.validated_result(json.dumps(result).encode(), 0, 18644)

    def test_native_exit_output_limit_duplicate_and_nonfinite_refuse(self):
        content = json.dumps(authored_result()).encode()
        for data, code in [(content, 1), (b' ' * (diagnostic.MAX_OUTPUT + 1), 0),
                           (b'{"nativeError":0,"nativeError":0}', 0), (b'{"value":NaN}', 0)]:
            with self.subTest(code=code, length=len(data)), self.assertRaises(ValueError):
                diagnostic.validated_result(data, code, 18644)

    def test_exact_fixture_registry_refuses_empty_duplicates_extra_paths_and_counts(self):
        values = [{'stem': stem, 'sha256': value, 'bytes': diagnostic.FIXTURE_BYTES[stem]}
                  for stem, value in diagnostic.FIXTURES.items()]
        self.assertEqual(diagnostic.validated_fixture_manifest(values), values)
        cases = [[], values[:-1], values + [values[0]], [values[0]] * 4]
        for key, value in [('stem', '../outside'), ('sha256', '0' * 64), ('bytes', 1), ('bytes', True)]:
            changed = [dict(record) for record in values]; changed[0][key] = value; cases.append(changed)
        for changed in cases:
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                diagnostic.validated_fixture_manifest(changed)

    def test_boolean_count_and_integer_roles_cannot_certify_native_evidence(self):
        for group, key in [(None, 'schemaVersion'), (None, 'nativeError'), ('auxRead', 'attempts'),
                            ('auxSection', 'count'), ('aux', 'version')]:
            result = authored_result(); target = result if group is None else result[group]
            target[key] = True
            with self.subTest(group=group, key=key), self.assertRaises(ValueError):
                diagnostic.validated_result(json.dumps(result).encode(), 0, 18644)

    def test_declared_copy_length_is_checked_before_native_invocation(self):
        original = self.root / 'authored-original'; original.write_bytes(b'AC1032test')
        copied = self.root / 'authored-copy'; copied.write_bytes(original.read_bytes())
        fixture = {'sha256': diagnostic.sha(original.read_bytes()), 'bytes': original.stat().st_size}
        diagnostic.checked_original_pair(fixture, original, copied)
        for count in (1, True):
            changed = {**fixture, 'bytes': count}
            with self.subTest(count=count), self.assertRaises(ValueError):
                diagnostic.checked_original_pair(changed, original, copied)
        copied.write_bytes(b'AC1032edit')
        with self.assertRaises(ValueError):
            diagnostic.checked_original_pair(fixture, original, copied)

    def test_wrong_revision_and_private_directory_escape_refuse(self):
        with patch.object(diagnostic.subprocess, 'check_output', return_value='a' * 40):
            with self.assertRaises(ValueError):
                diagnostic.checked_context(WORKSPACE, WORKSPACE / 'outside', 'b' * 40)
            with self.assertRaises(ValueError):
                diagnostic.checked_context(WORKSPACE, WORKSPACE / 'outside', 'a' * 40)


if __name__ == '__main__':
    unittest.main()
