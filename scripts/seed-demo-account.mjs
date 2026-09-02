import {
  SqliteAuthUserLookup,
  parseDemoSeedArgs,
  readDemoSeedEnvironment,
  seedDemoAccount,
} from "../src/sharednet/demo-seed.ts";

let lookup;
let result;
let failed = false;

try {
  const { email } = parseDemoSeedArgs(process.argv.slice(2));
  const { apiUrl, consoleToken, databasePath } =
    readDemoSeedEnvironment(process.env);
  lookup = new SqliteAuthUserLookup(databasePath);
  result = await seedDemoAccount({
    apiUrl,
    consoleToken,
    email,
    fetch,
    lookup,
  });
} catch {
  failed = true;
} finally {
  if (lookup) {
    try {
      lookup.close();
    } catch {
      failed = true;
    }
  }
}

if (failed || !result) {
  console.error("Demo seed failed.");
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(result));
}
