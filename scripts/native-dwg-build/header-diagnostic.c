/* Development-only typed header evidence; never linked into JCad's reader. */
#include <inttypes.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include "dwg.h"
#include "dwg_api.h"

static unsigned attempts, parses;
static int decompression_error = -1, parse_error = -1, chain_present;
static unsigned long long decoded_size, final_byte;
static unsigned final_bit;
static int decoded_version, decoded_from_version, parsed_version, parsed_from_version;
#define RAW_AUX_LIMIT 256
#define LAYOUT_COUNT 19
#define FIELD_COUNT 6
static unsigned char decoded_bytes[RAW_AUX_LIMIT];
static unsigned captured_bytes, layout_calls, observation_error;
static unsigned long long library_layout[LAYOUT_COUNT];
static const char *layout_names[LAYOUT_COUNT] = {
  "rsBytes", "rlBytes", "rllBytes", "timeBytes", "daysOffset", "msOffset",
  "valueOffset", "drawingBytes", "auxOffset", "auxBytes", "maintenanceOffset",
  "maintenance1Offset", "maintenance2Offset", "creationOffset", "updateOffset", "tailOffset",
  "maintenanceBytes", "maintenance1Bytes", "maintenance2Bytes"
};
static const char *field_names[FIELD_COUNT] = {
  "maint_version", "maint_version_1", "maint_version_2", "TDCREATE", "TDUPDATE", "zero_18"
};
static const unsigned field_counts[FIELD_COUNT] = {1, 1, 1, 2, 2, 0};
static const unsigned field_widths[FIELD_COUNT] = {32, 32, 32, 64, 64, 0};
static struct field_observation {
  unsigned before_calls, after_calls;
  unsigned long long before_bits, after_bits, values[3];
} fields[FIELD_COUNT];

/* Observation hooks are injected only into the authenticated runner-temp copy. */
void jcad_header_diagnostic_aux_decompressed(int error, int present,
                                            unsigned long long size,
                                            const unsigned char *raw,
                                            int version, int from_version)
{
  attempts++;
  decompression_error = error;
  chain_present = present;
  decoded_size = size;
  decoded_version = version;
  decoded_from_version = from_version;
  if (present && raw && size <= 4 * 1024 * 1024)
    {
      captured_bytes = size < RAW_AUX_LIMIT ? (unsigned)size : RAW_AUX_LIMIT;
      memcpy(decoded_bytes, raw, captured_bytes);
    }
}

void jcad_header_diagnostic_aux_parsed(int error, unsigned long long byte,
                                     unsigned bit, int version, int from_version)
{
  parses++;
  parse_error = error;
  final_byte = byte;
  final_bit = bit;
  parsed_version = version;
  parsed_from_version = from_version;
}

void jcad_header_diagnostic_aux_layout(const unsigned long long *facts, unsigned count)
{
  layout_calls++;
  if (!facts || count != LAYOUT_COUNT)
    { observation_error = 1; return; }
  memcpy(library_layout, facts, sizeof library_layout);
}

void jcad_header_diagnostic_aux_field(const char *name, int phase,
                                    unsigned long long byte, unsigned bit,
                                    unsigned long long a, unsigned long long b,
                                    unsigned long long c, unsigned count)
{
  unsigned index;
  if (!name || bit > 7 || byte > 4 * 1024 * 1024)
    { observation_error = 1; return; }
  for (index = 0; index < FIELD_COUNT; index++)
    if (!strcmp(name, field_names[index]))
      break;
  if (index == FIELD_COUNT || count != field_counts[index])
    { observation_error = 1; return; }
  if (phase == 0)
    {
      fields[index].before_calls++;
      fields[index].before_bits = byte * 8 + bit;
    }
  else if (phase == 1)
    {
      fields[index].after_calls++;
      fields[index].after_bits = byte * 8 + bit;
      fields[index].values[0] = a;
      fields[index].values[1] = b;
      fields[index].values[2] = c;
    }
  else
    observation_error = 1;
}

static int valid_date(BITCODE_TIMEBLL date)
{
  return date.days <= INT32_MAX && date.ms < 86400000;
}

static void date(const char *name, BITCODE_TIMEBLL value)
{
  printf("\"%s\":{\"days\":%" PRIu32 ",\"ms\":%" PRIu32 "}",
         name, (uint32_t)value.days, (uint32_t)value.ms);
}

static void aux_fields(const Dwg_AuxHeader *aux)
{
  const char *separator = "";
#define AUX_FIELD(name, ...) do { \
  const unsigned long long values[] = {__VA_ARGS__}; \
  printf("%s\"" #name "\":[", separator); \
  for (unsigned i = 0; i < sizeof values / sizeof values[0]; i++) \
    printf("%s%llu", i ? "," : "", values[i]); \
  printf("]"); separator = ","; \
} while (0)
  AUX_FIELD(aux_intro, aux->aux_intro[0], aux->aux_intro[1], aux->aux_intro[2]);
  AUX_FIELD(dwg_version, aux->dwg_version);
  AUX_FIELD(maint_version, aux->maint_version);
  AUX_FIELD(numsaves, aux->numsaves);
  AUX_FIELD(minus_1, aux->minus_1);
  AUX_FIELD(numsaves_1, aux->numsaves_1);
  AUX_FIELD(numsaves_2, aux->numsaves_2);
  AUX_FIELD(zero, aux->zero);
  AUX_FIELD(dwg_version_1, aux->dwg_version_1);
  AUX_FIELD(maint_version_1, aux->maint_version_1);
  AUX_FIELD(dwg_version_2, aux->dwg_version_2);
  AUX_FIELD(maint_version_2, aux->maint_version_2);
  AUX_FIELD(unknown_6rs, aux->unknown_6rs[0], aux->unknown_6rs[1], aux->unknown_6rs[2],
            aux->unknown_6rs[3], aux->unknown_6rs[4], aux->unknown_6rs[5]);
  AUX_FIELD(unknown_5rl, aux->unknown_5rl[0], aux->unknown_5rl[1], aux->unknown_5rl[2],
            aux->unknown_5rl[3], aux->unknown_5rl[4]);
  AUX_FIELD(TDCREATE, aux->TDCREATE.days, aux->TDCREATE.ms);
  AUX_FIELD(TDUPDATE, aux->TDUPDATE.days, aux->TDUPDATE.ms);
  AUX_FIELD(HANDSEED, aux->HANDSEED);
  AUX_FIELD(plot_stamp, aux->plot_stamp);
  AUX_FIELD(zero_1, aux->zero_1);
  AUX_FIELD(numsaves_3, aux->numsaves_3);
  AUX_FIELD(zero_2, aux->zero_2);
  AUX_FIELD(zero_3, aux->zero_3);
  AUX_FIELD(zero_4, aux->zero_4);
  AUX_FIELD(numsaves_4, aux->numsaves_4);
  AUX_FIELD(zero_5, aux->zero_5);
  AUX_FIELD(zero_6, aux->zero_6);
  AUX_FIELD(zero_7, aux->zero_7);
  AUX_FIELD(zero_8, aux->zero_8);
#undef AUX_FIELD
}

int main(int argc, char **argv)
{
  struct stat info;
  char magic[6];
  FILE *input;
  Dwg_Data dwg = {0};
  unsigned section_count = 0;
  int64_t section_size = 0;
  unsigned section_pages = 0;
  int section_name_valid = 0, native_error, accepted;
  const unsigned long long driver_layout[LAYOUT_COUNT] = {
    sizeof(BITCODE_RS), sizeof(BITCODE_RL), sizeof(BITCODE_RLL), sizeof(BITCODE_TIMEBLL),
    offsetof(Dwg_Bitcode_TimeBLL, days), offsetof(Dwg_Bitcode_TimeBLL, ms),
    offsetof(Dwg_Bitcode_TimeBLL, value), sizeof(Dwg_Data), offsetof(Dwg_Data, auxheader),
    sizeof(Dwg_AuxHeader), offsetof(Dwg_AuxHeader, maint_version),
    offsetof(Dwg_AuxHeader, maint_version_1), offsetof(Dwg_AuxHeader, maint_version_2),
    offsetof(Dwg_AuxHeader, TDCREATE), offsetof(Dwg_AuxHeader, TDUPDATE),
    offsetof(Dwg_AuxHeader, zero_18), sizeof(((Dwg_AuxHeader *)0)->maint_version),
    sizeof(((Dwg_AuxHeader *)0)->maint_version_1), sizeof(((Dwg_AuxHeader *)0)->maint_version_2)
  };
  int layout_matches, fields_valid = 1;
  if (argc != 2 || strlen(argv[1]) > 4096 || stat(argv[1], &info)
      || !S_ISREG(info.st_mode) || info.st_size <= 0
      || info.st_size > 4 * 1024 * 1024)
    return 2;
  input = fopen(argv[1], "rb");
  if (!input)
    return 2;
  if (fread(magic, 1, sizeof magic, input) != sizeof magic
      || memcmp(magic, "AC1032", sizeof magic))
    { fclose(input); return 2; }
  if (fclose(input))
    return 2;

  native_error = dwg_read_file(argv[1], &dwg);
  if (dwg.header.section_infohdr.num_desc <= 4096
      && (!dwg.header.section_infohdr.num_desc || dwg.header.section_info))
    for (unsigned i = 0; i < dwg.header.section_infohdr.num_desc; i++)
      {
        const Dwg_Section_Info *section = &dwg.header.section_info[i];
        if (section->fixedtype == SECTION_AUXHEADER)
          {
            section_count++;
            section_size = section->size;
            section_pages = section->num_sections;
            section_name_valid = memchr(section->name, 0, sizeof section->name)
                                 && !strcmp(section->name, "AcDb:AuxHeader");
          }
      }
  layout_matches = layout_calls == 1 && !memcmp(driver_layout, library_layout, sizeof driver_layout);
  for (unsigned i = 0; i < FIELD_COUNT; i++)
    if (fields[i].before_calls != 1 || fields[i].after_calls != 1
        || fields[i].after_bits < fields[i].before_bits
        || fields[i].after_bits - fields[i].before_bits != field_widths[i]
        || fields[i].after_bits > decoded_size * 8
        || (i && fields[i].before_bits < fields[i - 1].after_bits))
      fields_valid = 0;
  accepted = native_error == 0 && dwg.header.version == R_2018
             && section_count == 1 && section_name_valid && section_size > 0
             && section_size <= 4 * 1024 * 1024 && section_pages > 0
             && attempts == 1 && parses == 1 && decompression_error == 0
             && parse_error == 0 && chain_present && decoded_size > 0
             && decoded_size <= 4 * 1024 * 1024
             && dwg.auxheader.aux_intro[0] == 0xff
             && dwg.auxheader.aux_intro[1] == 0x77
             && dwg.auxheader.aux_intro[2] == 0x01
             && dwg.auxheader.dwg_version == 33
             && valid_date(dwg.header_vars.TDUCREATE)
             && valid_date(dwg.header_vars.TDUUPDATE)
             && valid_date(dwg.auxheader.TDCREATE)
             && valid_date(dwg.auxheader.TDUPDATE)
             && !observation_error && layout_matches && fields_valid
             && driver_layout[16] == 4 && driver_layout[17] == 4 && driver_layout[18] == 4
             && decoded_version == R_2018 && decoded_from_version == R_2018
             && parsed_version == R_2018 && parsed_from_version == R_2018
             && decoded_size == 129 && captured_bytes == decoded_size
             && final_byte == decoded_size && final_bit == 0;
  printf("{\"schemaVersion\":1,\"sourceVariant\":\"candidate-exact-r2018-maintenance-rl-no-wire-zero18-v1\",\"inputBytes\":%" PRIu64
         ",\"nativeError\":%d,\"nativeVersion\":%d,\"auxSection\":{"
         "\"count\":%u,\"nameValid\":%s,\"size\":%" PRId64
         ",\"pages\":%u},\"auxRead\":{\"attempts\":%u,\"parses\":%u,"
         "\"decompressionError\":%d,\"parseError\":%d,\"chainPresent\":%s,"
         "\"decodedSize\":%llu},\"aux\":{\"magic\":[%u,%u,%u],"
         "\"version\":%u,\"maintenance\":%u,",
         (uint64_t)info.st_size, native_error, (int)dwg.header.version,
         section_count, section_name_valid ? "true" : "false", section_size,
         section_pages, attempts, parses, decompression_error, parse_error,
         chain_present ? "true" : "false", decoded_size,
         (unsigned)dwg.auxheader.aux_intro[0], (unsigned)dwg.auxheader.aux_intro[1],
         (unsigned)dwg.auxheader.aux_intro[2], (unsigned)dwg.auxheader.dwg_version,
         (unsigned)dwg.auxheader.maint_version);
  date("creation", dwg.auxheader.TDCREATE); printf(",");
  date("update", dwg.auxheader.TDUPDATE); printf("},\"auxFields\":{");
  aux_fields(&dwg.auxheader);
  printf("},\"mainUtc\":{");
  date("creation", dwg.header_vars.TDUCREATE); printf(",");
  date("update", dwg.header_vars.TDUUPDATE); printf("},\"hostDerivedLocal\":{");
  date("creation", dwg.header_vars.TDCREATE); printf(",");
  date("update", dwg.header_vars.TDUPDATE); printf("},\"elapsed\":{");
  date("drawing", dwg.header_vars.TDINDWG); printf(",");
  date("user", dwg.header_vars.TDUSRTIMER);
  printf("},\"unverifiedObservations\":{\"observationError\":%u,\"layoutCalls\":%u,"
         "\"layoutMatches\":%s,\"driverLayout\":{", observation_error, layout_calls,
         layout_matches ? "true" : "false");
  for (unsigned i = 0; i < LAYOUT_COUNT; i++)
    printf("%s\"%s\":%llu", i ? "," : "", layout_names[i], driver_layout[i]);
  printf("},\"libraryLayout\":{");
  for (unsigned i = 0; i < LAYOUT_COUNT; i++)
    printf("%s\"%s\":%llu", i ? "," : "", layout_names[i], library_layout[i]);
  printf("},\"decodedVersion\":%d,\"decodedFromVersion\":%d,\"parsedVersion\":%d,"
         "\"parsedFromVersion\":%d,\"finalByte\":%llu,\"finalBit\":%u,"
         "\"capturedBytes\":%u,\"rawComplete\":%s,\"rawHex\":\"", decoded_version,
         decoded_from_version, parsed_version, parsed_from_version, final_byte, final_bit,
         captured_bytes, captured_bytes == decoded_size ? "true" : "false");
  for (unsigned i = 0; i < captured_bytes; i++)
    printf("%02x", (unsigned)decoded_bytes[i]);
  printf("\",\"fields\":[");
  for (unsigned i = 0; i < FIELD_COUNT; i++)
    {
      printf("%s{\"name\":\"%s\",\"beforeCalls\":%u,\"afterCalls\":%u,"
             "\"beforeBits\":%llu,\"afterBits\":%llu,\"values\":[", i ? "," : "",
             field_names[i], fields[i].before_calls, fields[i].after_calls,
             fields[i].before_bits, fields[i].after_bits);
      for (unsigned j = 0; j < field_counts[i]; j++)
        printf("%s%llu", j ? "," : "", fields[i].values[j]);
      printf("]}");
    }
  printf("]}");
  dwg_free(&dwg);
  printf(",\"nativeFreed\":true,\"rawAuxCertified\":false,\"candidateDecoded\":%s}\n",
         accepted ? "true" : "false");
  return accepted ? 0 : 1;
}
