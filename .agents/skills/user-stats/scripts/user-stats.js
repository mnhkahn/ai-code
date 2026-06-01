const fs = require('fs');
const os = require('os');
const path = require('path');
const {execSync} = require('child_process');

// Auto-detect session directories based on runtime environment
function detectSessionDirs() {
  const home = os.homedir();
  const dirs = [];

  // 1. CLI argument: --dir <path>
  const dirArgIdx = process.argv.indexOf('--dir');
  if (dirArgIdx !== -1 && process.argv[dirArgIdx + 1]) {
    dirs.push(process.argv[dirArgIdx + 1]);
    return dirs;
  }

  // 2. Both Claude Code and Trae store sessions under ~/.claude/projects/
  //    Trae does not have a separate projects directory.
  dirs.push(path.join(home, '.claude', 'projects'));

  // Filter to only existing directories
  return dirs.filter(d => { try { return fs.statSync(d).isDirectory(); } catch(e) { return false; } });
}

const sessionDirs = detectSessionDirs();

if (sessionDirs.length === 0) {
  console.log('No session data found. Checked:');
  console.log('  ~/.claude/projects');
  console.log('  ~/.trae/projects');
  process.exit(0);
}

const findCmd = sessionDirs.map(d => `find ${d} -name "*.jsonl" -type f`).join(' && ');
const jsonlFiles = execSync(
  findCmd + ' 2>/dev/null',
  {maxBuffer: 10 * 1024 * 1024, encoding: 'utf8'}
).trim().split('\n').filter(Boolean);

if (jsonlFiles.length === 0 || (jsonlFiles.length === 1 && !jsonlFiles[0])) {
  console.log('No session data found in:', sessionDirs.join(', '));
  process.exit(0);
}

const models = {};
const tools = {};
const toolIdMap = {};

function normalizeToolName(name) {
  if (!name) return 'Unknown';
  if (name.includes('\n') || name.length > 30) return 'Agent';
  return name;
}

for (const file of jsonlFiles) {
  let content;
  try { content = fs.readFileSync(file, 'utf8'); } catch(e) { continue; }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch(e) { continue; }

    if (obj.type === 'assistant' && obj.message) {
      const msg = obj.message;
      const model = msg.model || 'unknown';
      if (!models[model]) models[model] = {calls:0, failures:0, input:0, output:0, cacheRead:0, cacheWrite:0};
      const m = models[model];
      m.calls++;
      if (msg.stop_reason === 'error') m.failures++;
      const u = msg.usage || {};
      m.input += u.input_tokens || 0;
      m.output += u.output_tokens || 0;
      m.cacheRead += u.cache_read_input_tokens || 0;
      m.cacheWrite += u.cache_creation_input_tokens || 0;

      const c = msg.content;
      if (Array.isArray(c)) {
        for (const block of c) {
          if (block.type === 'tool_use') {
            const tname = normalizeToolName(block.name);
            if (!tools[tname]) tools[tname] = {calls:0, errors:0};
            tools[tname].calls++;
            if (block.id) toolIdMap[block.id] = tname;
          }
        }
      }
    }

    if (obj.type === 'user' && obj.message) {
      const c = obj.message.content;
      if (Array.isArray(c)) {
        for (const block of c) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const tname = toolIdMap[block.tool_use_id];
            if (tname && tools[tname]) {
              if (block.is_error) tools[tname].errors++;
            }
          }
        }
      }
    }
  }
}

function fmtTokens(n) {
  if (n === 0) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function fmtRate(calls, failures) {
  if (calls === 0) return '0%';
  return ((calls - failures) / calls * 100).toFixed(1) + '%';
}

const sortedModels = Object.entries(models).sort((a,b) => b[1].calls - a[1].calls);
const sortedTools = Object.entries(tools).sort((a,b) => b[1].calls - a[1].calls);

let output = 'Usage by model:';
for (const [name, m] of sortedModels) {
  const label = name + ':';
  output += '\n' + label.padStart(21) + '  ' +
    m.calls + ' calls, ' + fmtRate(m.calls, m.failures) + ' success, ' +
    fmtTokens(m.input) + ' input, ' + fmtTokens(m.output) + ' output, ' +
    fmtTokens(m.cacheRead) + ' cache read, ' + fmtTokens(m.cacheWrite) + ' cache write';
}

output += '\nTool calls:';
for (const [name, t] of sortedTools) {
  const label = name + ':';
  output += '\n' + label.padStart(21) + '  ' +
    t.calls + ' calls, ' + t.errors + ' errors, ' + fmtRate(t.calls, t.errors) + ' success';
}

console.log(output);
