# Frozen v0.5.0 recovery-storage producer

These four unmodified JCad modules are the complete dependency closure needed
to write the synthetic version-1 recovery fixture with the production storage
code from released v0.5.0, commit
`a580c9c6e27952c2b15e0a75b940facd3ec4f1fc`.

Every file must match the original SHA-256 pins in
`WINDOWS_UPGRADE_RECOVERY_INPUTS` in `scripts/windows-upgrade-smoke.mjs` before
any of this code executes. The copied LF bytes also match those preserved in
the later pristine `512e0b1c1ca8f870904876f7745153261b09508c` source snapshot.
Do not update these files or their historical pins when candidate storage
changes. They remain subject to the repository's existing license.

Unit tests use this frozen producer and then exercise the current production
store against its index and drawing, including a write/reopen and rejection of
unrecognized path/proof fields. Candidate source hashes are recorded separately;
they need not equal the old release. This checks format compatibility rather
than requiring production implementation bytes to remain unchanged forever.

The hosted Windows installer sequence continues to extract and pin-check the
producer from the actual authenticated v0.5.0 application ASAR. It does not use
this fallback. That sequence retains the original installer, signature, old/new
application, profile-inventory and recovery-file preservation checks. Neither
seeding path claims a dirty autosave created by the old shipping process;
recovery-manager UI remains a separate gate.
