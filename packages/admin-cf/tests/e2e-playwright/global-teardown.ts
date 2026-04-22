import * as fs from 'node:fs';
import { TOKEN_FILE } from './global-setup.js';

async function globalTeardown() {
  // Clean up the auth token file
  if (fs.existsSync(TOKEN_FILE)) {
    fs.unlinkSync(TOKEN_FILE);
  }
}

export default globalTeardown;
