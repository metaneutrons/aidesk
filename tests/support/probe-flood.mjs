// Answers with far more than a result may be.
const chunk = "x".repeat(1024 * 1024);
for (let index = 0; index < 64; index += 1) process.stdout.write(chunk);
