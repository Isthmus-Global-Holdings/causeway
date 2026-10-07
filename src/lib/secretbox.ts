// AES-GCM for the one secret the app stores in D1: the Google refresh token.
// It can't be a Worker secret because it's obtained at runtime, when the rep
// signs in with Google. The key (TOKEN_ENCRYPTION_KEY) is a Worker secret, so
// a copy of the database alone doesn't expose the Gmail account.

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = fromBase64(base64Key);
  if (raw.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// Output: base64(iv) + "." + base64(ciphertext)
export async function encrypt(plaintext: string, base64Key: string): Promise<string> {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return `${toBase64(iv)}.${toBase64(new Uint8Array(cipher))}`;
}

export async function decrypt(sealed: string, base64Key: string): Promise<string> {
  const [iv, cipher] = sealed.split('.');
  if (!iv || !cipher) throw new Error('Malformed encrypted value');
  const key = await importKey(base64Key);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, key, fromBase64(cipher));
  return new TextDecoder().decode(plain);
}
