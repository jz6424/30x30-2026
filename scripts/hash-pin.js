// npm run hash-pin -- 482913
// Prints the value to paste into a PIN_HASH_<ID> env var (e.g. PIN_HASH_TINA in Render).
import { hashPin } from '../lib/auth.js';

const pin = process.argv[2];
if (!/^\d{4,6}$/.test(pin || '')) {
  console.error('Usage: npm run hash-pin -- <4 to 6 digit PIN>');
  process.exit(1);
}
console.log(hashPin(pin));
