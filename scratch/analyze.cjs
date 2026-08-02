const fs = require('fs');

const lines = fs.readFileSync('scratch/leaks2.txt', 'utf-8').split('\n').filter(l => l.trim().length > 0);
const byFile = {};
lines.forEach(line => {
  const parts = line.split(':');
  if (parts.length >= 3) {
    const file = parts[0] + ':' + parts[1]; // handle drive letter
    const lineNum = parseInt(parts[2], 10);
    const content = parts.slice(3).join(':');
    
    if (!byFile[file]) byFile[file] = [];
    byFile[file].push({ lineNum, content });
  }
});

for (const file of Object.keys(byFile)) {
  const content = fs.readFileSync(file, 'utf-8');
  let hasLeak = false;
  
  // Unbounded maps/sets: check if it's assigned to const at top level or a class property
  // We can just print files that have setInterval but no clearInterval
  const hasSetInterval = content.includes('setInterval');
  const hasClearInterval = content.includes('clearInterval');
  if (hasSetInterval && !hasClearInterval) {
    console.log('Uncleared setInterval:', file);
  }
  
  // Event emitters: .on but no .off or removeListener
  // Let's just output files that have .on( but not .off or remove
  const hasOn = content.includes('.on(');
  const hasOff = content.includes('.off(') || content.includes('removeListener') || content.includes('removeAllListeners');
  if (hasOn && !hasOff) {
    console.log('Unremoved event listener:', file);
  }

  // Maps / Sets in module scope or class scope
  // If we see private foo = new Map() or const foo = new Map() outside function
  const lines = content.split('\n');
  lines.forEach((l, i) => {
    if (l.match(/(const|let|private|public|protected|readonly)\s+\w+\s*=\s*new (Map|Set)\b/)) {
      if (!l.includes('Map<string, string>') && !l.includes('Map<string,number>') && !l.includes('Set<string>')) { // rudimentary ignore small bounds
          // console.log('Potential unbounded Map/Set:', file, i+1, l.trim());
      }
    }
  });
}
