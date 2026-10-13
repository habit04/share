/* Development-only typed header evidence; never linked into JCad's reader. */
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include "dwg.h"
#include "dwg_api.h"

static unsigned attempts, parses;
static int decompression_error = -1, parse_error = -1, chain_present;
static unsigned long long decoded_size;

/* Observation hooks are injected only into the authenticated runner-temp copy. */
void jcad_header_diagnostic_aux_decompressed(int error, int present,
                                            unsigned long long size)
{
  attempts++;
  decompression_error = error;
  chain_present = present;
  decoded_size = size;
}

void jcad_header_diagnostic_aux_parsed(int error)
{
  parses++;
  parse_error = error;
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
             && valid_date(dwg.auxheader.TDUPDATE);
  printf("{\"schemaVersion\":1,\"inputBytes\":%" PRIu64
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
  date("update", dwg.auxheader.TDUPDATE); printf("},\"mainUtc\":{");
  date("creation", dwg.header_vars.TDUCREATE); printf(",");
  date("update", dwg.header_vars.TDUUPDATE); printf("},\"hostDerivedLocal\":{");
  date("creation", dwg.header_vars.TDCREATE); printf(",");
  date("update", dwg.header_vars.TDUPDATE); printf("},\"elapsed\":{");
  date("drawing", dwg.header_vars.TDINDWG); printf(",");
  date("user", dwg.header_vars.TDUSRTIMER);
  dwg_free(&dwg);
  printf("},\"nativeFreed\":true,\"rawAuxCertified\":%s}\n",
         accepted ? "true" : "false");
  return accepted ? 0 : 1;
}
