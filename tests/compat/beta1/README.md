# Frozen v1.0.0-beta.1 update readers

Byte-for-byte copies of the update code in tag `v1.0.0-beta.1`: the web client (`src/client/update`), the desktop shell (`desktop/update-store.cjs`, `desktop/bridge-policy.cjs`) and the Android and iOS update policy and updaters. Those builds are installed on players' devices, so every later release must still work with exactly this code.

`tests/release-compat.test.ts` runs these copies against a release built by today's tools. Never edit them; the test checks they still match the tag. When another release becomes the oldest one that must keep updating, add its readers next to this folder (for example `tests/compat/beta2/`) instead of changing these.
