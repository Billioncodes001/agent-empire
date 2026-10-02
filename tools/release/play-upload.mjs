// Uploads the signed Android App Bundle to a Google Play track through the Play Developer Publishing API (v3),
// with a service account; no third-party action ever sees the credentials.
//
//   PLAY_SERVICE_ACCOUNT_JSON="$(cat sa.json)" node tools/release/play-upload.mjs --aab <file.aab> \
//     [--package com.agentempire.mobile] [--track internal] [--status completed|draft] [--name <release name>]
//
// Use --status draft until the app's first release has been rolled out from the Play Console (Play refuses
// "completed" releases for an app that has never been published).
import { sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const API = 'https://androidpublisher.googleapis.com';
const b64url = data => Buffer.from(data).toString('base64url');

/** A signed RS256 JWT assertion for the OAuth 2.0 service-account flow. */
export function serviceAccountAssertion(account, now = Math.floor(Date.now() / 1000)) {
  if (!account?.client_email || !account?.private_key) throw new Error('PLAY_SERVICE_ACCOUNT_JSON must be a service account key (client_email, private_key)');
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: account.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), account.private_key);
  return `${header}.${claims}.${b64url(signature)}`;
}

async function call(fetchImpl, url, init, what) {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${what} failed: HTTP ${response.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

/** Creates an edit, uploads the bundle, assigns it to `track` and commits. Returns the uploaded versionCode. */
export async function uploadBundle({ account, packageName, aab, track = 'internal', status = 'completed', name, fetchImpl = fetch }) {
  if (!['completed', 'draft'].includes(status)) throw new Error(`status must be completed or draft, got ${status}`);
  const token = await call(fetchImpl, account.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serviceAccountAssertion(account) }).toString(),
  }, 'OAuth token');
  const auth = { authorization: `Bearer ${token.access_token}` };
  const app = `applications/${encodeURIComponent(packageName)}`;
  const edit = await call(fetchImpl, `${API}/androidpublisher/v3/${app}/edits`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}' }, 'Create edit');
  const bundle = await call(fetchImpl, `${API}/upload/androidpublisher/v3/${app}/edits/${edit.id}/bundles?uploadType=media`,
    { method: 'POST', headers: { ...auth, 'content-type': 'application/octet-stream' }, body: aab }, 'Upload bundle');
  if (!bundle.versionCode) throw new Error('Play did not return a versionCode for the bundle');
  await call(fetchImpl, `${API}/androidpublisher/v3/${app}/edits/${edit.id}/tracks/${encodeURIComponent(track)}`, {
    method: 'PUT', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ track, releases: [{ name, versionCodes: [String(bundle.versionCode)], status }] }),
  }, `Assign ${track} track`);
  await call(fetchImpl, `${API}/androidpublisher/v3/${app}/edits/${edit.id}:commit`, { method: 'POST', headers: auth }, 'Commit edit');
  return bundle.versionCode;
}

function option(args, flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    const aabPath = option(args, '--aab');
    if (!aabPath) throw new Error('usage: play-upload.mjs --aab <file> [--package <id>] [--track internal] [--status completed|draft] [--name <name>]');
    const raw = process.env.PLAY_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('PLAY_SERVICE_ACCOUNT_JSON is not set');
    const code = await uploadBundle({
      account: JSON.parse(raw), aab: readFileSync(aabPath),
      packageName: option(args, '--package', 'com.agentempire.mobile'), track: option(args, '--track', 'internal'),
      status: option(args, '--status', 'completed'), name: option(args, '--name', path.basename(aabPath)),
    });
    console.log(`uploaded versionCode ${code} to the Play track`);
  } catch (error) { console.error(`error: ${error.message}`); process.exit(1); }
}
