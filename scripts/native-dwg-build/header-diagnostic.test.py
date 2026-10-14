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
    layout = dict(zip(diagnostic.LAYOUT_NAMES, [2, 4, 8, 16, 0, 4, 8, 8192, 4096, 176,
                                               8, 28, 36, 72, 88, 148, 4, 4, 4]))
    typed = {name: [0] * count for name, _, count in diagnostic.AUX_FIELDS}
    typed.update(aux_intro=[255, 119, 1], dwg_version=[33], dwg_version_1=[33], dwg_version_2=[33],
                 maint_version=[4], maint_version_1=[4], maint_version_2=[4], numsaves=[1],
                 minus_1=[0xffffffff], numsaves_1=[1], numsaves_3=[1], numsaves_4=[1],
                 unknown_6rs=[0, 0, 0, 0, 0, 1], unknown_5rl=[0, 0, 0, 256, 65537],
                 TDCREATE=[date['days'], date['ms']], TDUPDATE=[date['days'], date['ms']], HANDSEED=[399])
    raw = bytearray(); positions = {}
    for name, width, count in diagnostic.AUX_FIELDS:
        positions[name] = len(raw) * 8
        for value in typed[name]:
            raw.extend(value.to_bytes(width // 8, 'little'))
    fields = [{'name': name, 'beforeCalls': 1, 'afterCalls': 1, 'beforeBits': before,
               'afterBits': before + width, 'values': actual}
              for name, width, count in diagnostic.FIELD_ROLES
              for before, actual in [(positions.get(name, len(raw) * 8), typed.get(name, []))]]
    return {"schemaVersion": 1, "sourceVariant": diagnostic.SOURCE_VARIANT,
        "inputBytes": 18644, "nativeError": 0, "nativeVersion": 40,
        "auxSection": {"count": 1, "nameValid": True, "size": 129, "pages": 1},
        "auxRead": {"attempts": 1, "parses": 1, "decompressionError": 0, "parseError": 0,
                    "chainPresent": True, "decodedSize": 129},
        "aux": {"magic": [255, 119, 1], "version": 33, "maintenance": 4,
                "creation": date.copy(), "update": date.copy()},
        "auxFields": typed,
        "mainUtc": {"creation": {"days": 2461326, "ms": 2098000}, "update": {"days": 2461326, "ms": 2098000}},
        "hostDerivedLocal": {"creation": date.copy(), "update": date.copy()},
        "elapsed": {"drawing": {"days": 0, "ms": 1000}, "user": {"days": 0, "ms": 1000}},
        "unverifiedObservations": {"observationError": 0, "layoutCalls": 1, "layoutMatches": True,
            "driverLayout": layout.copy(), "libraryLayout": layout.copy(),
            "decodedVersion": 40, "decodedFromVersion": 40, "parsedVersion": 40, "parsedFromVersion": 40,
            "finalByte": 129, "finalBit": 0, "capturedBytes": 129, "rawComplete": True,
            "rawHex": raw.hex(), "fields": fields},
        "nativeFreed": True, "rawAuxCertified": False, "candidateDecoded": True}


class DiagnosticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        archive = WORKSPACE / "vendor/libredwg-web-bg/modified-source.tar.gz"
        assert hashlib.sha256(archive.read_bytes()).hexdigest() == diagnostic.ARCHIVE_SHA
        with tarfile.open(archive, "r:gz") as source:
            cls.original = source.extractfile("./src/decode.c").read()
            cls.aux_original = source.extractfile("./src/auxheader.spec").read()
            cls.header_original = source.extractfile("./include/dwg.h").read()
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
        for original, replacement in diagnostic.DECODE_REPLACEMENTS:
            self.assertEqual(observed.count(replacement), 1)
            restored = restored.replace(replacement, original, 1)
        self.assertEqual(restored, self.original)

    def test_named_aux_observations_reverse_without_any_field_grammar_change(self):
        observed = diagnostic.patch_aux_spec(self.aux_original)
        restored = observed
        for original, replacement in diagnostic.AUX_REPLACEMENTS:
            self.assertEqual(observed.count(replacement), 1)
            restored = restored.replace(replacement, original, 1)
        self.assertEqual(restored, self.aux_original)
        # Six before/after pairs exist only in the decoder, never the shared free/print includes.
        self.assertEqual(observed.count(b'#ifdef IS_DECODER'), 16)
        for name, _, _ in diagnostic.FIELD_ROLES:
            self.assertEqual(observed.count(('aux_field ("' + name + '", 0').encode()), 1)
            self.assertEqual(observed.count(('aux_field ("' + name + '", 1').encode()), 1)
        self.assertEqual(observed.count(b'FIELD_RSx'), self.aux_original.count(b'FIELD_RSx'))
        self.assertIn(b'if (dat->from_version == R_2018)', observed)
        self.assertIn(b'if (dat->from_version != R_2018)', observed)
        for changed in (self.aux_original + b'\n', observed):
            with self.assertRaises(ValueError):
                diagnostic.patch_aux_spec(changed)

    def test_candidate_storage_is_three_full_raw_longs_only_in_aux_header(self):
        observed = diagnostic.patch_header(self.header_original)
        start = observed.index(b'typedef struct _dwg_auxheader\n')
        end = observed.index(b'} Dwg_AuxHeader;', start)
        restored = observed[start:end]
        for name in ('maint_version', 'maint_version_1', 'maint_version_2'):
            self.assertEqual(restored.count(f'  BITCODE_RL {name};'.encode()), 1)
            restored = restored.replace(f'  BITCODE_RL {name};'.encode(), f'  BITCODE_RS {name};'.encode(), 1)
        self.assertEqual(observed[:start] + restored + observed[end:], self.header_original)
        for changed in (self.header_original + b'\n', observed):
            with self.assertRaises(ValueError):
                diagnostic.patch_header(changed)

    def test_exact_version_schema_branches_keep_legacy_reads_and_no_auto_offsets(self):
        observed = diagnostic.patch_aux_spec(self.aux_original).decode()
        for name in ('maint_version', 'maint_version_1', 'maint_version_2'):
            expected = ('if (dat->from_version == R_2018)\n'
                        f'    {{ FIELD_RL ({name}, 0); }}\n  else\n#endif\n'
                        f'    {{ FIELD_RSx ({name}, 0); }}')
            self.assertIn(expected, observed)
        self.assertIn('SINCE (R_2018)', observed)
        self.assertIn('if (dat->from_version != R_2018)\n#endif\n      { FIELD_VECTOR_INL (zero_18, RS, 3, 0); }', observed)
        self.assertEqual(sum(width * count // 8 for _, width, count in diagnostic.AUX_FIELDS), 129)

    def test_abi_facts_are_actual_type_and_member_expressions_not_wire_offsets(self):
        observed = diagnostic.patch_decoder(self.original).decode()
        driver = (WORKSPACE / 'scripts/native-dwg-build/header-diagnostic.c').read_text()
        for expression in diagnostic.LAYOUT_EXPRESSIONS:
            self.assertIn(expression, observed)
            self.assertIn(expression, driver)
        self.assertIn('memcmp(driver_layout, library_layout, sizeof driver_layout)', driver)
        self.assertIn('#define RAW_AUX_LIMIT 256', driver)
        self.assertIn('memcpy(decoded_bytes, raw, captured_bytes)', driver)
        self.assertNotIn('config.h', driver)

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
        mutations = [('nativeError', 1), ('nativeFreed', False), ('rawAuxCertified', True), ('inputBytes', 18645), ('candidateDecoded', False), ('sourceVariant', 'baseline')]
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

    def test_mismatched_or_unbounded_layout_cannot_certify_dates(self):
        for key, value in [('layoutCalls', 0), ('layoutCalls', 2), ('layoutMatches', False),
                           ('observationError', 1), ('decodedVersion', 0), ('parsedFromVersion', True)]:
            result = authored_result(); result['unverifiedObservations'][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                diagnostic.validated_result(json.dumps(result).encode(), 0, 18644)
        for group, key, value in [('libraryLayout', 'auxOffset', 4097), ('driverLayout', 'rsBytes', 4),
                                   ('libraryLayout', 'drawingBytes', 1048577), ('libraryLayout', 'timeBytes', True)]:
            result = authored_result(); result['unverifiedObservations'][group][key] = value
            with self.subTest(group=group, key=key), self.assertRaises(ValueError):
                diagnostic.validated_result(json.dumps(result).encode(), 0, 18644)

    def test_raw_aux_bytes_cursor_and_field_roles_are_bounded_and_complete(self):
        for key, value in [('finalByte', 130), ('finalBit', 8), ('finalByte', 0), ('rawComplete', False),
                           ('capturedBytes', 257), ('rawHex', '00' * 128), ('rawHex', 'zz' * 129)]:
            result = authored_result(); result['unverifiedObservations'][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                diagnostic.validated_result(json.dumps(result).encode(), 0, 18644)
        for index, key, value in [(0, 'beforeCalls', 2), (1, 'afterCalls', 0), (2, 'beforeBits', True),
                                   (3, 'name', 'TDUPDATE'), (4, 'afterBits', 1040), (5, 'values', [0, 0]),
                                   (3, 'values', [2461326, 2098000]), (0, 'values', [0x100000000])]:
            result = authored_result(); result['unverifiedObservations']['fields'][index][key] = value
            with self.subTest(index=index, key=key), self.assertRaises(ValueError):
                diagnostic.validated_result(json.dumps(result).encode(), 0, 18644)
        result = authored_result(); result['unverifiedObservations']['fields'].reverse()
        with self.assertRaises(ValueError):
            diagnostic.validated_result(json.dumps(result).encode(), 0, 18644)

    def test_invalid_genuine_aux_tuple_stays_refused_despite_matching_abi(self):
        result = authored_result()
        result['aux']['creation'] = {'days': 65536, 'ms': 2391670785}
        result['unverifiedObservations']['fields'][3]['values'] = [65536, 2391670785]
        result['rawAuxCertified'] = False
        with self.assertRaises(ValueError):
            diagnostic.validated_result(json.dumps(result).encode(), 1, 18644)
        result['auxFields']['TDCREATE'] = [65536, 2391670785]
        raw = bytearray.fromhex(result['unverifiedObservations']['rawHex'])
        position = result['unverifiedObservations']['fields'][3]['beforeBits'] // 8
        raw[position:position + 8] = (65536).to_bytes(4, 'little') + (2391670785).to_bytes(4, 'little')
        result['unverifiedObservations']['rawHex'] = raw.hex()
        with self.assertRaisesRegex(ValueError, 'Invalid raw native date tuple'):
            diagnostic.validated_result(json.dumps(result).encode(), 0, 18644)

    def test_all_named_typed_fields_and_unknown_arrays_must_match_full_raw_sequence(self):
        for name, width, count in diagnostic.AUX_FIELDS:
            for index in range(count):
                result = authored_result()
                result['auxFields'][name][index] = (result['auxFields'][name][index] + 1) % 2 ** width
                with self.subTest(field=name, index=index), self.assertRaises(ValueError):
                    diagnostic.validated_result(json.dumps(result).encode(), 0, 18644)
        for name, wrong in [('unknown_6rs', [0] * 5), ('unknown_5rl', [0] * 6),
                             ('unknown_5rl', [0, 0, 0, True, 65537])]:
            result = authored_result(); result['auxFields'][name] = wrong
            with self.subTest(field=name), self.assertRaises(ValueError):
                diagnostic.validated_result(json.dumps(result).encode(), 0, 18644)
        result = authored_result(); result['auxFields'] = dict(reversed(list(result['auxFields'].items())))
        with self.assertRaises(ValueError):
            diagnostic.validated_result(json.dumps(result).encode(), 0, 18644)

    def test_full_32_bit_maintenance_is_retained_in_every_slot(self):
        result = authored_result()
        result['aux']['maintenance'] = 0xfedcba98
        raw = bytearray.fromhex(result['unverifiedObservations']['rawHex'])
        for field in result['unverifiedObservations']['fields'][:3]:
            result['auxFields'][field['name']] = field['values'] = [0xfedcba98]
            offset = field['beforeBits'] // 8
            raw[offset:offset + 4] = (0xfedcba98).to_bytes(4, 'little')
        result['unverifiedObservations']['rawHex'] = raw.hex()
        self.assertEqual(diagnostic.validated_result(json.dumps(result).encode(), 0, 18644), result)
        result['unverifiedObservations']['libraryLayout']['maintenance1Bytes'] = 2
        with self.assertRaises(ValueError):
            diagnostic.validated_result(json.dumps(result).encode(), 0, 18644)

    def test_four_actual_original_dxf_date_references_are_pinned_and_read_independently(self):
        for stem in diagnostic.FIXTURES:
            with self.subTest(stem=stem):
                reference = diagnostic.read_dxf_reference(WORKSPACE, stem)
                self.assertEqual(reference['canonicalLfSha256'], diagnostic.DXF_REFERENCE_SHA[stem])
                self.assertEqual(set(reference['dates']), {'$TDCREATE', '$TDUCREATE', '$TDUPDATE', '$TDUUPDATE'})
                source = (WORKSPACE / f'tests/fixtures/interchange/{stem}.dxf').read_bytes()
                self.assertEqual(diagnostic.dxf_reference_values(source.replace(b'\r\n', b'\n')), reference['dates'])
        reference = diagnostic.read_dxf_reference(WORKSPACE, 'r2018-minsert')
        self.assertEqual(reference['dates']['$TDUCREATE']['tuple'], {'days': 2461326, 'ms': 2098000})
        self.assertEqual(reference['dates']['$TDCREATE']['tuple'], {'days': 2461325, 'ms': 70498000})

    def test_reference_compares_main_exactly_and_reports_aux_without_date_policy(self):
        reference = diagnostic.read_dxf_reference(WORKSPACE, 'r2018-minsert')
        result = authored_result()
        comparisons = diagnostic.compare_date_reference(result, reference)
        self.assertTrue(comparisons['creation']['mainUtcMatchesSourceUniversal'])
        self.assertTrue(comparisons['creation']['candidateAuxMatchesSourceLocal'])
        self.assertFalse(comparisons['creation']['candidateAuxMatchesSourceUniversal'])
        result['aux']['creation'] = result['mainUtc']['creation'].copy()
        comparisons = diagnostic.compare_date_reference(result, reference)
        self.assertTrue(comparisons['creation']['candidateAuxMatchesSourceUniversal'])
        self.assertFalse(comparisons['creation']['candidateAuxMatchesSourceLocal'])
        result['mainUtc']['creation']['ms'] += 1
        with self.assertRaisesRegex(ValueError, 'exact qualified date reference'):
            diagnostic.compare_date_reference(result, reference)

    def test_original_dwg_bound_oracle_is_pinned_exact_ticks_not_stale_paired_dxf(self):
        wanted = {'r2018-views-fields': 81137000, 'r2018-unicode-metadata': 83615000,
                  'r2018-field-object-reference': 82676000}
        for stem, ms in wanted.items():
            primary = diagnostic.read_qualified_date_reference(WORKSPACE, stem)
            self.assertEqual(primary['sourceDwgSha256'], diagnostic.FIXTURES[stem])
            self.assertEqual(primary['kind'], 'original-dwg-bound-autocad-oracle')
            self.assertEqual(primary['dates']['$TDUUPDATE']['tuple'], {'days': 2461326, 'ms': ms})
            self.assertEqual(primary['dates']['$TDUCREATE']['tuple'], {'days': 2461326, 'ms': 4674000})
            for name, artifact in primary['oracleArtifacts'].items():
                self.assertEqual(artifact['canonicalLfSha256'], diagnostic.ORACLE_SHA[name])
        dxf = diagnostic.read_dxf_reference(WORKSPACE, 'r2018-unicode-metadata')
        primary = diagnostic.read_qualified_date_reference(WORKSPACE, 'r2018-unicode-metadata')
        self.assertEqual(primary['dates']['$TDUUPDATE']['tuple']['ms'] - dxf['dates']['$TDUUPDATE']['tuple']['ms'], 181000)
        self.assertEqual(diagnostic.read_qualified_date_reference(WORKSPACE, 'r2018-minsert')['kind'], 'pinned-minsert-dxf-control')

    def test_oracle_duplicate_cases_binding_flags_and_exact_ticks_iso_decimal_refuse(self):
        original = json.loads((WORKSPACE / 'tests/fixtures/interchange/native-dwg-date-oracle.json').read_bytes())
        cases = [dict(original, cases=original['cases'][:-1]), dict(original, cases=[original['cases'][0]] * 3)]
        for key, wrong in [('sourceDwgSha256', '0' * 64), ('readOnly', False), ('readOnly', 1),
                           ('sourceAndCopyUnchanged', False), ('stem', 'r2018-minsert')]:
            changed = json.loads(json.dumps(original)); changed['cases'][0][key] = wrong; cases.append(changed)
        for key, wrong in [('ticks', '639273646740000001'), ('ticks', True),
                           ('iso', '2026-10-12T01:17:55.0000000'), ('julian', '2461326.1')]:
            changed = json.loads(json.dumps(original)); changed['cases'][0]['values']['TDUCREATE'][key] = wrong; cases.append(changed)
        for changed in cases:
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                diagnostic.validated_native_date_oracle(json.dumps(changed).encode())
        with patch.object(diagnostic, 'checked_file', return_value=b'changed pinned oracle artifact'):
            with self.assertRaisesRegex(ValueError, 'artifact changed'):
                diagnostic.read_qualified_date_reference(WORKSPACE, 'r2018-unicode-metadata')

    def test_qualified_reference_mismatch_retains_exact_both_roles_actual_and_expected(self):
        reference = diagnostic.read_dxf_reference(WORKSPACE, 'r2018-unicode-metadata')
        primary = diagnostic.read_qualified_date_reference(WORKSPACE, 'r2018-unicode-metadata')
        result = authored_result()
        result['mainUtc'] = {name: primary['dates'][role]['tuple'].copy()
                             for name, role in [('creation', '$TDUCREATE'), ('update', '$TDUUPDATE')]}
        result['aux']['update'] = primary['dates']['$TDUUPDATE']['tuple'].copy()
        comparison = diagnostic.compare_date_reference(result, reference, primary)
        self.assertTrue(comparison['update']['mainUtcMatchesQualifiedPrimary'])
        self.assertTrue(comparison['update']['candidateAuxMatchesQualifiedPrimary'])
        self.assertFalse(comparison['update']['mainUtcMatchesSourceUniversal'])
        self.assertFalse(comparison['update']['candidateAuxMatchesSourceUniversal'])
        result['mainUtc']['creation']['ms'] += 1
        result['mainUtc']['update']['ms'] += 2
        with self.assertRaises(diagnostic.DateReferenceMismatch) as error:
            diagnostic.compare_date_reference(result, reference, primary)
        self.assertEqual([item['role'] for item in error.exception.mismatches], ['mainUtc.creation', 'mainUtc.update'])
        self.assertEqual(error.exception.mismatches[1]['actual']['ms'], 83615002)
        self.assertEqual(error.exception.mismatches[1]['expected']['ms'], 83615000)

    def test_mismatch_logs_third_and_fourth_native_cases_and_final_gate_still_fails(self):
        # Only native transport is mocked. Real private copies and pinned reference reads remain.
        directory = self.root / 'continue-cases'; (directory / 'inputs').mkdir(parents=True)
        fixtures = [{'stem': stem, 'sha256': expected, 'bytes': diagnostic.FIXTURE_BYTES[stem]}
                    for stem, expected in diagnostic.FIXTURES.items()]
        for fixture in fixtures:
            (directory / 'inputs' / (fixture['stem'] + '.dwg')).write_bytes(
                (WORKSPACE / 'tests/fixtures/interchange' / (fixture['stem'] + '.dwg')).read_bytes())
        prepared = {'fixtures': fixtures,
            'dxfReferences': {stem: diagnostic.read_dxf_reference(WORKSPACE, stem) for stem in diagnostic.FIXTURES},
            'qualifiedDateReferences': {stem: diagnostic.read_qualified_date_reference(WORKSPACE, stem) for stem in diagnostic.FIXTURES}}
        calls = []
        def native_transport(_binary, copy, _output, zone):
            calls.append((copy.stem, zone))
            result = authored_result(); result['inputBytes'] = copy.stat().st_size
            primary = prepared['qualifiedDateReferences'][copy.stem]
            result['mainUtc'] = {name: primary['dates'][role]['tuple'].copy()
                for name, role in [('creation', '$TDUCREATE'), ('update', '$TDUUPDATE')]}
            if copy.stem == 'r2018-unicode-metadata':
                result['mainUtc']['update']['ms'] += 1
            return diagnostic.validated_result(json.dumps(result).encode(), 0, copy.stat().st_size)
        with patch.object(diagnostic, 'run_one', side_effect=native_transport), patch('builtins.print') as emitted:
            cases, mismatches = diagnostic.collect_candidate_cases(WORKSPACE, directory, self.root / 'mock-transport', prepared)
            proof = {'revision': 'a' * 40, 'archiveSha256': diagnostic.ARCHIVE_SHA,
                     'binarySha256': 'b' * 64, 'candidateOnly': True, 'rawAuxCertified': False, 'cases': cases}
            with self.assertRaises(diagnostic.DateReferenceMismatch):
                diagnostic.finish_candidate_proof(directory, proof, mismatches)
            events = [json.loads(call.args[0]) for call in emitted.call_args_list]
        self.assertEqual(len(calls), 8)
        self.assertEqual(len(cases), 4)
        raw = [event['validatedRawCandidateObservation'] for event in events if 'validatedRawCandidateObservation' in event]
        self.assertEqual(len(raw), 8)
        self.assertEqual([item['stem'] for item in raw[-2:]], ['r2018-field-object-reference'] * 2)
        mismatch_index = next(index for index, event in enumerate(events) if 'dateReferenceMismatches' in event)
        third_raw = [index for index, event in enumerate(events)
                     if event.get('validatedRawCandidateObservation', {}).get('stem') == 'r2018-unicode-metadata']
        self.assertTrue(all(index < mismatch_index for index in third_raw))
        saved = json.loads((directory / 'raw-header-proof.json').read_bytes())
        self.assertFalse(saved['passed'])
        self.assertFalse(saved['rawAuxCertified'])
        self.assertTrue(saved['candidateOnly'])
        self.assertEqual(len(saved['cases']), 4)
        self.assertEqual(len(saved['dateReferenceMismatches']), 2)
        self.assertEqual(saved['dateReferenceMismatches'][0]['actual']['ms'], 83615001)
        self.assertEqual(saved['dateReferenceMismatches'][0]['expected']['ms'], 83615000)
        self.assertTrue(any('dxfAndOriginalDwgDateDisagreements' in event for event in events))

    def test_duplicate_missing_malformed_nonfinite_dxf_references_refuse(self):
        source = (WORKSPACE / 'tests/fixtures/interchange/r2018-minsert.dxf').read_bytes()
        lines = source.decode().splitlines()
        index = next(index for index in range(0, len(lines), 2) if lines[index].strip() == '9' and lines[index + 1].strip() == '$TDUCREATE')
        for value in ('NaN', 'Infinity', '-1', '2147483648', 'bogus'):
            changed = lines.copy(); changed[index + 3] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                diagnostic.dxf_reference_values(('\n'.join(changed) + '\n').encode())
        for changed in (lines[:index] + lines[index + 4:], lines[:index] + lines[index:index + 4] + lines[index:]):
            with self.assertRaises(ValueError):
                diagnostic.dxf_reference_values(('\n'.join(changed) + '\n').encode())

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

    def test_refused_or_timed_out_native_read_rehashes_original_and_copy_in_finally(self):
        original = self.root / 'failure-original'; original.write_bytes(b'AC1032test')
        copied = self.root / 'failure-copy'; copied.write_bytes(original.read_bytes())
        fixture = {'stem': 'authored-private', 'sha256': diagnostic.sha(original.read_bytes()), 'bytes': 10}
        for failure in (ValueError('refused native result'), diagnostic.subprocess.TimeoutExpired('diagnostic', 20)):
            with self.subTest(error=type(failure).__name__), patch.object(diagnostic, 'run_one', side_effect=failure), patch('builtins.print') as emitted:
                with self.assertRaises(type(failure)):
                    diagnostic.run_checked_original(fixture, original, copied, self.root / 'not-executed', self.root / 'out', 'UTC')
                evidence = json.loads(emitted.call_args[0][0])['diagnosticAfterReadInputs']
                self.assertTrue(evidence['unchanged'])
                self.assertEqual(evidence['originalSha256'], fixture['sha256'])
                self.assertEqual(evidence['copySha256'], fixture['sha256'])

    def test_refused_read_records_actual_changed_after_hash_and_never_certifies(self):
        original = self.root / 'changed-original'; original.write_bytes(b'AC1032test')
        copied = self.root / 'changed-copy'; copied.write_bytes(original.read_bytes())
        fixture = {'stem': 'authored-private', 'sha256': diagnostic.sha(original.read_bytes()), 'bytes': 10}
        def refuse_after_change(*_):
            copied.write_bytes(b'AC1032edit')
            raise ValueError('invalid native output')
        with patch.object(diagnostic, 'run_one', side_effect=refuse_after_change), patch('builtins.print') as emitted:
            with self.assertRaisesRegex(ValueError, 'changed after native read'):
                diagnostic.run_checked_original(fixture, original, copied, self.root / 'not-executed', self.root / 'out', 'UTC')
            evidence = json.loads(emitted.call_args[0][0])['diagnosticAfterReadInputs']
            self.assertFalse(evidence['unchanged'])
            self.assertEqual(evidence['originalSha256'], fixture['sha256'])
            self.assertEqual(evidence['copySha256'], diagnostic.sha(b'AC1032edit'))

    def test_wrong_revision_and_private_directory_escape_refuse(self):
        with patch.object(diagnostic.subprocess, 'check_output', return_value='a' * 40):
            with self.assertRaises(ValueError):
                diagnostic.checked_context(WORKSPACE, WORKSPACE / 'outside', 'b' * 40)
            with self.assertRaises(ValueError):
                diagnostic.checked_context(WORKSPACE, WORKSPACE / 'outside', 'a' * 40)


if __name__ == '__main__':
    unittest.main()
