// Asks for more memory than the process may have.
const hold = [];
for (;;) hold.push(Buffer.alloc(50 * 1024 * 1024, 1));
