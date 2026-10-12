# Code signing and notarization

New JCad Electrical desktop releases are **Windows x64 only**. The release workflow requires
Windows publisher credentials for publication and verifies the installer and application
signatures against the exact updater publisher. Empty-tag build-only rehearsals may run
unsigned; `require_signing` makes those runs fail closed too. Aggregate provenance independently
requires `authenticode-verified` evidence before publication. No signing secret is stored in
the repository.

macOS and Linux desktop updates are paused at [v0.4.5](https://github.com/habit04/share/releases/tag/v0.4.5).
Their existing downloads, portable code and historical signing tools remain available. Apple
secrets are retained but the current workflow does not read them, create keychains or submit
notarization requests. The Apple instructions below document the existing distribution and
a future return; they are not a prerequisite for new Windows releases. Linux packages in
historical releases are unsigned; Mac releases from v0.4.2 through v0.4.5 are Developer ID
signed and notarized, and versions through v0.4.1 are ad-hoc signed.

Each new release must verify its own source SHA, shipping fuses and artifact bytes. The
**Verified build** list follows actual verified provenance. GitHub/Sigstore attestation proves
workflow origin and bytes, and does not replace the Windows Authenticode signature.

| Platform | Current distribution | Signing inputs |
| --- | --- | --- |
| Windows | New x64 NSIS releases | Seven `AZURE_*` GitHub Actions secrets, checked by `scripts/azure-signing.mjs` |
| macOS | Paused at v0.4.5 | Existing Apple secrets retained; unused by current release workflow |
| Linux | Paused at v0.4.5 | Historical packages unsigned |

Secrets are not passed to workflows triggered from forks, so those checks cannot publish a
signed Windows installer.

## Windows: Azure Artifact Signing

Microsoft's managed signing service (launched as *Trusted Signing*, renamed
*Artifact Signing*). Microsoft holds the keys in its HSMs and issues short-lived
certificates chained to a Microsoft-trusted root, so there is no `.pfx` to
protect and no USB token, and SmartScreen reputation builds on the verified
publisher identity rather than on one certificate.

### Prerequisites

1. An Azure subscription (pay-as-you-go is enough) and permission to create
   resources and app registrations in its Microsoft Entra ID tenant.
2. Eligibility for **public trust** identity validation: organizations in the
   supported countries (USA, Canada, EU, UK at the time of writing) with a
   verifiable legal identity and business history, or individual developers
   where Microsoft offers individual validation. Check the current eligibility
   page before paying for anything.
3. The resource provider `Microsoft.CodeSigning` registered on the subscription.

### One-time setup in Azure

1. **Create the signing account**: Azure portal → *Artifact Signing
   Accounts* (or *Trusted Signing Accounts*) → Create. Pick a region and the
   Basic SKU. Note the account **name** and the region's **endpoint**, e.g.
   `https://eus.codesigning.azure.net/` (East US) or
   `https://weu.codesigning.azure.net/` (West Europe).
2. **Identity validation**: in the account, *Identity validations* → New →
   *Public*. Microsoft verifies the organization (or individual) and the
   verified name becomes the certificate subject. This is the step that takes
   days, not minutes.
3. **Certificate profile**: *Certificate profiles* → Create → *Public Trust*,
   linked to the completed validation. Note the profile **name**. The profile's
   subject's common name (the validated publisher name, e.g. `Example Controls LLC`, without
   the `CN=` prefix or other subject fields) must match `AZURE_PUBLISHER_NAME` exactly: the
   workflow compares it with the signer's common name, and the updater with the installer's.
4. **Service principal**: Microsoft Entra ID → App registrations → New
   registration (e.g. `jcad-release-signing`). Under *Certificates & secrets*
   create a client secret. Note the **Directory (tenant) ID**, the
   **Application (client) ID** and the secret **value**.
5. **Role assignment**: on the signing account (not the subscription), *Access
   control (IAM)* → Add role assignment → **Artifact Signing Certificate Profile
   Signer** (formerly *Trusted Signing Certificate Profile Signer*) → the app
   registration from step 4.

### GitHub secrets

| Secret | Value | Used as |
| --- | --- | --- |
| `AZURE_TENANT_ID` | Directory (tenant) ID | Azure login (EnvironmentCredential) |
| `AZURE_CLIENT_ID` | Application (client) ID | Azure login |
| `AZURE_CLIENT_SECRET` | client secret value | Azure login |
| `AZURE_SIGNING_ENDPOINT` | region endpoint, e.g. `https://eus.codesigning.azure.net/` | `win.azureSignOptions.endpoint` |
| `AZURE_SIGNING_ACCOUNT` | signing account name | `win.azureSignOptions.codeSigningAccountName` |
| `AZURE_CERT_PROFILE` | certificate profile name | `win.azureSignOptions.certificateProfileName` |
| `AZURE_PUBLISHER_NAME` | the profile subject's common name / validated publisher | `win.azureSignOptions.publisherName`; builder derives the updater's publisher list |

### How the build uses them

`scripts/azure-signing.mjs` runs on the Windows runner. When all seven secrets
are present it adds `build.win.azureSignOptions` (endpoint, account, profile,
publisher) to the runner's copy of `package.json`; otherwise it leaves the file
alone and the build stays unsigned. The workflow passes the three login values
to electron-builder on Windows only, and when signing is on it fails the job if
any produced `.exe` is not validly signed by that exact publisher common name. electron-builder (26.x) signs the app
executable, the uninstaller and the NSIS installer through the Artifact Signing
client (it installs the `TrustedSigning` PowerShell module on demand). The
committed `package.json` never contains signing settings.

The script sets `build.win.azureSignOptions.publisherName`. Builder 26 derives the packaged
`app-update.yml` publisher list from that Azure setting; its Windows schema rejects the obsolete
top-level `build.win.publisherName`. Regression tests validate the installed builder's schema
and generated updater configuration without contacting the signing service. The packaged
`app-update.yml` must contain a trusted publisher before the application enables an in-place
Windows update. Unsigned Windows and all Linux builds offer manual downloads.

An equivalent alternative, if electron-builder's built-in support ever gets in
the way, is to build unsigned and sign the output with the
[`azure/trusted-signing-action`](https://github.com/Azure/trusted-signing-action)
step (inputs `endpoint`, `trusted-signing-account-name`,
`certificate-profile-name`, `files-folder`, plus the same three login values);
the NSIS installer then has to be rebuilt around the signed app, which is why
the in-builder route is used.

### Verifying

On any Windows machine: right-click the installer → Properties → *Digital
Signatures*, or `signtool verify /pa /v JCad-Electrical-*.exe`, or in
PowerShell `Get-AuthenticodeSignature .\JCad-Electrical-*.exe` (Status `Valid`,
signer = the validated publisher). SmartScreen may still warn for the first
downloads of a new publisher until reputation builds up.

## macOS: historical Developer ID signing and notarization

This section describes the release workflow through v0.4.5. New Mac releases are paused;
the current Windows-only workflow does not run these steps. The scripts and credentials
are retained for a future return and for verifying existing signed releases.

Gatekeeper only opens downloaded apps without a warning when they are signed
with a **Developer ID Application** certificate, built with the **hardened
runtime**, and **notarized** by Apple (with the ticket stapled).

### Prerequisites

1. Membership in the **Apple Developer Program** (individual or organization;
   organizations need a D-U-N-S number). Only the Account Holder can create
   Developer ID certificates.
2. A matching certificate/private-key pair exported as a password-protected `.p12`.
   Keychain Access on a Mac provides the usual creation/export flow below. A Windows-generated
   RSA CSR and compatible PKCS#12 export also work; keep the CSR's private key, include the
   Developer ID intermediate certificate, and verify the pair before uploading it. The CI Mac
   runner performs signing, notarization and final platform checks.

### One-time setup

1. **Certificate**: Keychain Access → Certificate Assistant → *Request a
   Certificate From a Certificate Authority* (save to disk). In the developer
   portal → Certificates → **+** → *Developer ID Application* → upload the
   request, download the certificate and double-click it to install. Apple's
   [Developer ID instructions](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
   and [CSR instructions](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request)
   describe these steps. A downloaded `.cer` alone does not include the private key: keep the
   key created with the CSR, and export the matching certificate/key pair in the next step.
2. **Export**: in Keychain Access, select the certificate *with its private
   key* → Export → `.p12` with a strong password. Base64-encode it:
   `base64 -i DeveloperID.p12 | pbcopy`.
3. **App-specific password**: <https://account.apple.com> → Sign-In and
   Security → App-Specific Passwords → generate one for "JCad notarization".
4. **Team ID**: developer portal → Membership details (10 characters).

### GitHub secrets

| Secret | Value |
| --- | --- |
| `CSC_LINK` | the base64 text of the `.p12` (an `https://` URL of the file also works) |
| `CSC_KEY_PASSWORD` | the `.p12` export password |
| `APPLE_ID` | the Apple Account e-mail used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password from step 3 |
| `APPLE_TEAM_ID` | the 10-character Team ID |

### How the build uses them

When `HAS_APPLE` is true the macOS job skips the unsigned step and runs
*Build, sign and notarize*:

1. It sets, **on the runner's copy of `package.json` only**, `build.mac`:
   `hardenedRuntime: true`, `gatekeeperAssess: false`,
   `entitlements` and `entitlementsInherit` = `build/entitlements.mac.plist`.
   `scripts/mac-signing-config.mjs` checks the required secret names before applying this
   configuration. The committed `package.json` keeps `hardenedRuntime: false`, which is what
   the ad-hoc signed build needs.
2. The step imports `CSC_LINK` into a temporary keychain belonging to this job, with Apple's
   Developer ID intermediate certificates, and fails unless it holds a valid
   *Developer ID Application* identity. Private-key partition permissions use the keychain's
   password; the PKCS#12 export password is used only to import the signing package.
   electron-builder then runs without `CSC_LINK` / `CSC_KEY_PASSWORD` (so it does
   not import the certificate a second time) and signs the `.app` (both arm64 and
   x64) with that identity (`CSC_KEYCHAIN`, `CSC_NAME` = its SHA-1; the ad-hoc
   `afterPack` hook steps aside because `CSC_NAME` is set), submits it to Apple's notary service with
   `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`
   (`@electron/notarize`, `notarytool`), waits, and staples the ticket before
   building the DMGs. The keychain is deleted when the step ends.
3. *Verify the macOS signature and notarization ticket* runs
   `codesign --verify --deep --strict`, checks for the Developer ID authority
   and configured Team ID, the `runtime` flag, `xcrun stapler validate` and `spctl --assess` on each
   `.app`. It also verifies each DMG's signature and Team ID, and fails the job on a mismatch.
4. The build records the signing status `developer-id-notarized` in
   `JCad-Electrical-macOS-provenance.json` (`ad-hoc` without the secrets); the
   release job writes the notes' macOS sentence and **Verified build** line from it.

`build/entitlements.mac.plist` grants only what Electron needs under the
hardened runtime: `allow-jit` and `allow-unsigned-executable-memory` (V8 and
the LibreDWG WebAssembly reader) and `disable-library-validation` (Electron's
own frameworks and helpers). It lives in `build/`, electron-builder's default
build-resources folder, and is not packaged into the app.

An App Store Connect API key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`,
`APPLE_API_ISSUER`) also works with electron-builder instead of the Apple ID
trio; the workflow uses the Apple ID variant because it needs no key file.

### Verifying a downloaded build

```sh
spctl --assess --type execute --verbose=4 "/Applications/JCad Electrical.app"   # accepted, source=Notarized Developer ID
codesign -dv --verbose=4 "/Applications/JCad Electrical.app"                     # Authority=Developer ID Application: …
xcrun stapler validate "/Applications/JCad Electrical.app"
```

The Electron fuses (package.json `build.electronFuses`, security review E-15) are flipped by
electron-builder after the `afterPack` hook's ad-hoc signature; `resetAdHocDarwinSignature: true`
seals the bundle ad hoc again, and a configured Developer ID signature runs after that. CI checks
the final ad-hoc seal on unsigned macOS builds, and Developer ID, hardened runtime, stapling and
Gatekeeper assessment on signed ones.

## Costs and timelines

Prices change; check the vendors' pages before budgeting. At the time of writing:

| Item | Cost | Lead time |
| --- | --- | --- |
| Azure Artifact Signing, Basic SKU | about USD 10 per month (includes 5,000 signatures; a release signs a handful of files) | account: minutes |
| Azure identity validation (public trust) | included | typically 1–7 business days, longer if documents are requested |
| Azure subscription / Entra app registration | free (pay-as-you-go, billed only for the signing account) | minutes |
| Apple Developer Program | USD 99 per year | individual: usually within a day or two; organization: D-U-N-S lookup (free, up to ~2 weeks) plus Apple's review |
| Developer ID certificate | included (valid 5 years) | minutes |
| Notarization | free | usually minutes per build, occasionally an hour or more |
| SmartScreen reputation (Windows) | — | builds with downloads over days to weeks; signed builds from a validated publisher start with far fewer warnings |

Rough plan: create the Azure account and start identity validation and the
Apple enrollment on day 1; add the GitHub secrets as each completes; the next
tagged release is signed on both platforms without further changes.

## Rotating or turning signing off

- Removing a required signing secret blocks publication. Empty-tag rehearsals without
  `require_signing` may still exercise the unsigned/ad-hoc build path.
- Azure: create a new client secret before the old one expires (Entra shows the
  expiry) and update `AZURE_CLIENT_SECRET`.
- Apple: Developer ID certificates last five years; export the new `.p12` and
  update `CSC_LINK` / `CSC_KEY_PASSWORD`. Revoking an app-specific password
  breaks notarization until `APPLE_APP_SPECIFIC_PASSWORD` is replaced.
