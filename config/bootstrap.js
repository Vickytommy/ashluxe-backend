import { loadSecrets } from './secrets.js';
// import { connectDB } from './database.js';

let initialized = false;

async function bootstrap() {
  if (initialized) return;
  initialized = true;

  await loadSecrets();
//   await connectDB();

  console.log('✅ App bootstrapped');
}

export default bootstrap;
