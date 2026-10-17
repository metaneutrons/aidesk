import { existsSync } from "node:fs";
process.env.APP_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "local-test-auth-secret-that-is-not-a-credential";
process.env.ENCRYPTION_KEY ??= "ab".repeat(32);
process.env.S3_ENDPOINT ??= "http://127.0.0.1:9000";
process.env.S3_REGION ??= "us-east-1";
process.env.S3_BUCKET ??= "aidesk";
process.env.S3_ACCESS_KEY ??= "test-access";
process.env.S3_SECRET_KEY ??= "test-secret";
process.env.OWNER_CLAIM_TOKEN ??= "test-owner-claim-token-not-a-real-credential";
process.env.OWNER_RECOVERY_TOKEN ??= "test-owner-recovery-token-not-a-real-credential";
// The development database is private to the Compose network. Never guess a
// host database: an unrelated local PostgreSQL may listen on the default port.
const configured = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!configured)
  throw new Error(
    "Set DATABASE_URL, or run the tests in the development container: sh scripts/dev.sh exec -T app pnpm test",
  );
const testUrl = new URL(configured);
if (!testUrl.pathname.endsWith("_test")) {
  if (!existsSync(".env.development"))
    throw new Error("Use a dedicated database ending in _test for integration tests.");
  testUrl.pathname = "/aidesk_test";
}
process.env.DATABASE_URL = testUrl.href;
