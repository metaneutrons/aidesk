// Fills the heap of the process, which ends it with an abort.
const hold = [];
for (;;) hold.push({ text: "heap".repeat(1000), more: [1, 2, 3] });
