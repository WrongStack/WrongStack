const fs = require('fs');
const lines = fs.readFileSync('scratch/leaks2.txt', 'utf-8').split('\n').filter(l => l.trim().length > 0);
const byFile = {};
lines.forEach(line => {
  const parts = line.split(':');
  if (parts.length >= 3) {
    const file = parts[0] + ':' + parts[1];
    const lineNum = parseInt(parts[2], 10);
    const content = parts.slice(3).join(':');
    if (!byFile[file]) byFile[file] = [];
    byFile[file].push({ lineNum, content });
  }
});
for (const file of Object.keys(byFile)) {
  const content = fs.readFileSync(file, 'utf-8');
  if (content.includes('setInterval') && !content.includes('clearInterval')) console.log('LEAK: setInterval', file);
  if (content.includes('.on(') && !content.includes('.off(') && !content.includes('removeListener') && !content.includes('removeAllListeners')) console.log('LEAK: event_listener', file);
  if (content.includes('setTimeout') && !content.includes('clearTimeout')) console.log('LEAK: setTimeout', file);
  
  const flines = content.split('\n');
  flines.forEach((l, i) => {
    if (l.match(/(const|let|private|public|protected|readonly)\s+\w+\s*=\s*new (Map|Set)\b/)) {
        if (!l.includes('<string, string>') && !l.includes('Set<string>')) {
           console.log('LEAK: map_set', file, i+1, l.trim());
        }
    }
    if (l.includes('[]') && l.match(/(const|let|private|public|protected|readonly)\s+\w+\s*=\s*\[\]/)) {
        console.log('LEAK: array', file, i+1, l.trim());
    }
  });
}
