const { readFile } = require('node:fs/promises');
(async () => {
  const profile = JSON.parse(await readFile('.data/performance-cpu.cpuprofile', 'utf8'));
  if (!Array.isArray(profile.nodes) || !Array.isArray(profile.samples) || !profile.samples.length) throw new Error('profile has no samples');
  const counts = new Map();
  for (const id of profile.samples) counts.set(id, (counts.get(id) || 0) + 1);
  const top = profile.nodes.map(node => ({ function: node.callFrame.functionName || '(anonymous)', samples: counts.get(node.id) || 0 }))
    .sort((a, b) => b.samples - a.samples).slice(0, 10);
  console.log(JSON.stringify({ totalSamples: profile.samples.length, top, interpretation: 'self sample counts, including idle; not wall-clock latency or inclusive call-tree cost' }, null, 2));
})().catch(() => { console.error('CPU_PROFILE_SUMMARY_FAILED: run npm run profile:cpu first'); process.exitCode = 1; });
