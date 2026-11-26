// Helpers for the local Firebase emulator (auth on 9099, Firestore on 8080).
import { readFile } from 'node:fs/promises';

const PROJECT = 'demo-mc';
const AUTH = 'http://127.0.0.1:9099';
const FS = 'http://127.0.0.1:8080';

export async function createUser(email, password) {
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const j = await r.json();
  if (!j.localId) throw new Error('createUser failed: ' + JSON.stringify(j));
  return j.localId;
}

export async function loadRules(ownerUid) {
  const src = await readFile(new URL('../firebase/firestore.rules', import.meta.url), 'utf8');
  const r = await fetch(`${FS}/emulator/v1/projects/${PROJECT}:securityRules`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: src.replace('PASTE-YOUR-UID-HERE', ownerUid) }] } })
  });
  if (!r.ok) throw new Error('loadRules failed: ' + (await r.text()));
}

export async function reset() {
  await fetch(`${FS}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
}

// Read all docs of a collection, bypassing rules (emulator owner token).
export async function adminList(col) {
  const r = await fetch(`${FS}/v1/projects/${PROJECT}/databases/(default)/documents/${col}?pageSize=300`, { headers: { authorization: 'Bearer owner' } });
  const j = await r.json();
  return j.documents || [];
}
