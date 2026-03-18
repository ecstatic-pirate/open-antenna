'use strict';

/**
 * antenna run — main digest pipeline.
 *
 * Flow:
 *   1. Load config.yaml
 *   2. Run Python scanners (YouTube + HN) in parallel
 *   3. Invoke Claude Code CLI with antenna skill
 *   4. Write markdown digest to output dir
 *   5. Convert to PDF (if configured)
 *   6. Send notifications (if configured)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { loadConfig } = require('./config');

const PKG_ROOT = path.join(__dirname, '..');
const SCANNERS_DIR = path.join(PKG_ROOT, 'scanners');
const SKILLS_DIR = path.join(PKG_ROOT, 'skills');

/**
 * Ensure output directory exists.
 */
function ensureOutputDir(outputDir) {
  const resolved = path.resolve(outputDir);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

/**
 * Run a Python scanner. Returns a Promise that resolves to parsed JSON or null on failure.
 */
function runScanner(scriptName, configPath) {
  return new Promise((resolve) => {
    const scriptPath = path.join(SCANNERS_DIR, scriptName);
    const child = spawn('python3', [scriptPath, '--config', configPath], {
      encoding: 'utf8',
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      child.kill();
      console.warn(`[warn] Scanner ${scriptName} timed out after 120s`);
      resolve(null);
    }, 120_000);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.warn(`[warn] Scanner ${scriptName} failed:\n${stderr}`);
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        console.warn(`[warn] Scanner ${scriptName} returned invalid JSON: ${e.message}`);
        resolve(null);
      }
    });
  });
}

/**
 * Check that required external deps are available.
 */
function checkDeps() {
  const errors = [];

  // Claude Code CLI
  const claudeCheck = spawnSync('which', ['claude'], { encoding: 'utf8' });
  if (claudeCheck.status !== 0) {
    errors.push('Claude Code CLI not found. Install from https://claude.ai/code');
  }

  // Python 3
  const pyCheck = spawnSync('which', ['python3'], { encoding: 'utf8' });
  if (pyCheck.status !== 0) {
    errors.push('Python 3 not found. Install from https://python.org');
  }

  if (errors.length > 0) {
    throw new Error('Missing dependencies:\n' + errors.map((e) => `  - ${e}`).join('\n'));
  }
}

/**
 * Install Python scanner deps only if requirements.txt is newer than the sentinel file.
 */
function ensurePythonDeps() {
  const reqFile = path.join(SCANNERS_DIR, 'requirements.txt');
  const sentinel = path.join(SCANNERS_DIR, '.deps-installed');

  if (fs.existsSync(sentinel) && fs.existsSync(reqFile)) {
    const reqMtime = fs.statSync(reqFile).mtimeMs;
    const sentinelMtime = fs.statSync(sentinel).mtimeMs;
    if (sentinelMtime >= reqMtime) {
      return; // deps already up-to-date
    }
  }

  const result = spawnSync(
    'pip3',
    ['install', '-r', reqFile, '--quiet'],
    { encoding: 'utf8', timeout: 60_000 }
  );
  if (result.status !== 0) {
    console.warn('[warn] pip install failed. Scanners may not work:\n' + result.stderr);
  } else {
    // Write sentinel so we skip pip on next run
    fs.writeFileSync(sentinel, new Date().toISOString());
  }
}

/**
 * Get today's date string (YYYY-MM-DD).
 */
function todayString() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Build the claude invocation prompt for the antenna skill.
 * We pass scan results as JSON so Claude doesn't need to re-run scanners.
 */
function buildAntennaPrompt(config, scanResults, outputDir, configPath, today) {
  const profile = config.profile || {};
  const ytVideos = scanResults.youtube || [];
  const hnStories = scanResults.hn?.stories || [];

  return `Run the antenna skill to generate a daily intelligence briefing.

## Config

Output directory: ${outputDir}
Config path: ${configPath}
Scanners dir: ${SCANNERS_DIR}
Lib dir: ${path.join(PKG_ROOT, 'lib')}

## User Profile

Name: ${profile.name || 'User'}
Role: ${profile.role || 'Not specified'}
Topics: ${(profile.topics || []).join(', ') || 'Not specified'}

## YouTube Scan Results (${ytVideos.length} videos)

${JSON.stringify(ytVideos, null, 2)}

## Hacker News Scan Results (${hnStories.length} stories)

${JSON.stringify(hnStories, null, 2)}

## Instructions

1. Process each YouTube video using the read-podcast skill logic (transcript extraction + knowledge summary). Skip videos where transcripts are unavailable.
2. Evaluate each HN story for relevance to the user profile. Fetch and summarize relevant articles. Skip irrelevant ones silently.
3. Assemble the digest following the antenna skill format.
4. Write the digest to: ${outputDir}/${today}-digest.md

Skills available at: ${SKILLS_DIR}
Antenna skill: ${path.join(SKILLS_DIR, 'antenna', 'SKILL.md')}
Read-podcast skill: ${path.join(SKILLS_DIR, 'read-podcast', 'SKILL.md')}
Read-article skill: ${path.join(SKILLS_DIR, 'read-article', 'SKILL.md')}

Follow the skills exactly. Output only the digest file — no board updates, no git commits.`;
}

/**
 * Run Claude Code CLI with the antenna prompt.
 * Uses --print flag (non-interactive, returns output and exits).
 */
function runClaude(prompt, skillsDir) {
  const claudeArgs = [
    '--print',
    '--allowedTools', 'Read,Write,Bash,WebFetch',
    '--add-dir', skillsDir,
    '-p', prompt,
  ];

  console.log('[antenna] Invoking Claude — this takes 3-10 minutes...');

  const result = spawnSync('claude', claudeArgs, {
    encoding: 'utf8',
    timeout: 900_000, // 15 minutes max
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(`Claude invocation failed (exit ${result.status}):\n${result.stderr}`);
  }

  return result.stdout;
}

/**
 * Main pipeline entry point.
 */
async function run(options = {}) {
  const configPath = path.resolve(options.config || './config.yaml');

  console.log('[antenna] Loading config:', configPath);
  const config = loadConfig(configPath);

  const outputDir = ensureOutputDir(config.output?.dir ?? './output');
  console.log('[antenna] Output dir:', outputDir);

  // Dependency checks
  checkDeps();
  ensurePythonDeps();

  // Capture today once — avoids midnight skew if pipeline spans midnight
  const today = todayString();

  // Run scanners truly in parallel
  console.log('[antenna] Scanning sources...');
  const [ytResult, hnResult] = await Promise.all([
    runScanner('youtube_scanner.py', configPath),
    runScanner('hn_scanner.py', configPath),
  ]);

  const ytVideos = Array.isArray(ytResult) ? ytResult : [];
  const hnData = hnResult?.stories ? hnResult : { stories: [] };

  console.log(`[antenna] YouTube: ${ytVideos.length} videos | HN: ${hnData.stories.length} stories`);

  if (ytVideos.length === 0 && hnData.stories.length === 0) {
    console.warn('[antenna] Both scanners returned no results. Check your config and network.');
  }

  const scanResults = {
    youtube: ytVideos,
    hn: hnData,
  };

  const prompt = buildAntennaPrompt(config, scanResults, outputDir, configPath, today);
  const claudeOutput = runClaude(prompt, SKILLS_DIR);

  console.log('[antenna] Claude finished.');
  if (claudeOutput) {
    console.log('[antenna] Claude output:\n' + claudeOutput.slice(0, 500) + (claudeOutput.length > 500 ? '...' : ''));
  }

  // Check for digest file
  const digestPath = path.join(outputDir, `${today}-digest.md`);
  if (!fs.existsSync(digestPath)) {
    console.warn(`[antenna] Digest file not found at expected path: ${digestPath}`);
    console.warn('[antenna] Check Claude output above for errors.');
    return;
  }

  console.log(`[antenna] Digest written: ${digestPath}`);

  // PDF conversion
  const wantPdf = options.pdf !== false && config.output?.format === 'pdf';
  if (wantPdf) {
    const pdf = require('./pdf');
    const pdfPath = await pdf.convert(digestPath);
    console.log(`[antenna] PDF written: ${pdfPath}`);
  }

  // Notifications — run in parallel
  const wantNotify = options.notify !== false;
  if (wantNotify) {
    const notify = config.notifications || {};
    const notifyTasks = [];

    if (notify.whatsapp?.enabled) {
      const notifyWa = require('./notify-whatsapp');
      notifyTasks.push(notifyWa.send(config, digestPath));
    }

    if (notify.email?.enabled) {
      const notifyEmail = require('./notify-email');
      notifyTasks.push(notifyEmail.send(config, digestPath));
    }

    if (notifyTasks.length > 0) {
      const results = await Promise.allSettled(notifyTasks);
      for (const result of results) {
        if (result.status === 'rejected') {
          console.error('[antenna] Notification error:', result.reason?.message ?? result.reason);
        }
      }
    }
  }

  console.log('[antenna] Done.');
}

module.exports = run;
