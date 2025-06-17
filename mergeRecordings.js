const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');

const roomId = process.argv[2];
if (!roomId) {
  console.error("❌ Please provide a room ID. Example:\n    node mergeRecordings.js room-abc123");
  process.exit(1);
}

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const roomPath = path.join(UPLOADS_DIR, roomId);
const outputDir = path.join(roomPath, 'merged');

try {
  fs.ensureDirSync(UPLOADS_DIR);
  fs.ensureDirSync(roomPath);
  fs.ensureDirSync(outputDir);
} catch (err) {
  console.error(`❌ Error ensuring directories exist for room ${roomId}:`, err.message);
  process.exit(1);
}

console.log(`\n📂 Starting merge process for room: ${roomId}`);
console.log(`   Full Room Path: ${roomPath}`);
console.log(`   Output Directory: ${outputDir}`);

// Helper to check file validity
function isValidWebm(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 8000; // Skip 0-byte or tiny files
  } catch (e) {
    return false;
  }
}

const userDirs = fs.readdirSync(roomPath)
  .filter(d => {
    const fullPath = path.join(roomPath, d);
    try {
      return fs.statSync(fullPath).isDirectory() && d !== 'merged';
    } catch (e) {
      console.warn(`⚠️ Could not stat directory '${fullPath}': ${e.message}. Skipping.`);
      return false;
    }
  });

console.log(`\n🔎 Found ${userDirs.length} potential user directories: ${userDirs.length > 0 ? userDirs.join(', ') : 'None'}`);

const userOutputFiles = [];

for (const userId of userDirs) {
  const userDir = path.join(roomPath, userId);
  console.log(`\n--- Processing user: ${userId} (Directory: ${userDir}) ---`);

  let rawFiles = [];
  try {
    rawFiles = fs.readdirSync(userDir)
      .filter(f => f.endsWith('.webm'))
      .sort();
  } catch (e) {
    console.error(`❌ Error reading files in user directory '${userDir}': ${e.message}. Skipping this user.`);
    continue;
  }

  const validFiles = rawFiles.filter(f => isValidWebm(path.join(userDir, f)));

  console.log(`🎧 Found ${rawFiles.length} .webm files for user '${userId}'`);
  if (validFiles.length === 0) {
    console.warn(`   ⚠️ No valid audio files found (after filtering). Skipping user '${userId}'`);
    continue;
  }

  validFiles.forEach(f => {
    const fp = path.join(userDir, f);
    const stats = fs.statSync(fp);
    console.log(`   ✅ ${f} (${stats.size} bytes)`);
  });

  const listFilePath = path.join(userDir, 'files.txt');
  const concatList = validFiles.map(f => `file '${path.join(userDir, f).replace(/\\/g, '/')}'`).join('\n');
  fs.writeFileSync(listFilePath, concatList);
  console.log(`   List file created: ${listFilePath}`);

  const outputFile = path.join(outputDir, `full-${userId}.webm`);
  try {
    console.log(`\n🔄 Concatenating ${validFiles.length} chunks for user: '${userId}'`);
    const cmd = `ffmpeg -y -f concat -safe 0 -i "${listFilePath}" -c copy "${outputFile}"`;
    console.log(`   Executing: ${cmd}`);
    execSync(cmd, { stdio: 'inherit' });
    userOutputFiles.push(outputFile);
    console.log(`✅ Concatenation successful for user '${userId}'`);
  } catch (err) {
    console.error(`❌ FFMPEG failed for '${userId}': ${err.message}`);
  }
}

console.log(`\n--- Final Merge Preparation ---`);
console.log(`Total users with valid output files: ${userOutputFiles.length}`);

if (userOutputFiles.length < 2) {
  console.warn("⚠️ Need at least two users with valid audio to mix. Skipping final merge.");
  process.exit(0);
}

const inputs = userOutputFiles.map(f => `-i "${f}"`).join(' ');
const finalFile = path.join(outputDir, `final-meeting.mp3`);

try {
  console.log(`\n🎧 Merging users into final file: ${finalFile}`);
  const mixCmd = `ffmpeg ${inputs} -filter_complex "amix=inputs=${userOutputFiles.length}:duration=longest" -y "${finalFile}"`;
  console.log(`   Executing: ${mixCmd}`);
  execSync(mixCmd, { stdio: 'inherit' });
  console.log("✅ Final meeting audio created:", finalFile);
} catch (err) {
  console.error("❌ Final merge failed:", err.message);
  process.exit(1);
}
