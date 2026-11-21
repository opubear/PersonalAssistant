// Example fixed command adapter. It receives one JSON envelope via stdin.
let text = '';
for await (const chunk of process.stdin) {
  text += chunk;
  if (Buffer.byteLength(text) > 65536) throw new Error('Input too large');
}
const { jobId, input } = JSON.parse(text);
if (typeof input.text !== 'string') throw new Error('input.text must be a string');
process.stdout.write(JSON.stringify({ jobId, characters: input.text.length }) + '\n');
