import { existsSync, readFileSync } from "node:fs";
if (!process.env.DATABASE_URL && existsSync(".env.development")) {
  const values = Object.fromEntries(
    readFileSync(".env.development", "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  process.env.DATABASE_URL = `postgresql://aidesk:${values.POSTGRES_PASSWORD ?? ""}@127.0.0.1:5432/aidesk`;
  for (const name of ["BETTER_AUTH_SECRET", "ENCRYPTION_KEY", "S3_ACCESS_KEY", "S3_SECRET_KEY"])
    process.env[name] = values[name];
}
process.env.APP_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "local-test-auth-secret-that-is-not-a-credential";
process.env.ENCRYPTION_KEY ??= "ab".repeat(32);
process.env.S3_ENDPOINT ??= "http://127.0.0.1:8333";
process.env.S3_REGION ??= "us-east-1";
process.env.S3_BUCKET ??= "aidesk";
process.env.S3_ACCESS_KEY ??= "test-access";
process.env.S3_SECRET_KEY ??= "test-secret";
const testUrl = new URL(
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://localhost/aidesk_test",
);
if (!testUrl.pathname.endsWith("_test")) {
  if (!existsSync(".env.development"))
    throw new Error("Use a dedicated database ending in _test for integration tests.");
  testUrl.pathname = "/aidesk_test";
}
process.env.DATABASE_URL = testUrl.href;
