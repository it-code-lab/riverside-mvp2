const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');

const roomId = process.argv[2]; // e.g. node mergeRecordings.js room-abc123
if (!roomId) {
  console.error("❌ Please provide a room ID. Example:\n    node mergeRecordings.js room-abc123");
  process.exit(1);
}

// FIX: Correcting the UPLOADS_DIR path
// __dirname is the directory where the current script (mergeRecordings.js) resides.
// If mergeRecordings.js is in 'riverside-mvp', then 'uploads' is directly inside it.
// So, we just need to join __dirname with 'uploads'.
const UPLOADS_DIR = path.join(__dirname, 'uploads'); 

const roomPath = path.join(UPLOADS_DIR, roomId);
const outputDir = path.join(roomPath, 'merged');

// Ensure base uploads dir, room dir, and merged output dir exist
try {
  fs.ensureDirSync(UPLOADS_DIR); // Ensure the top-level uploads directory
  fs.ensureDirSync(roomPath); // Ensure the specific room directory itself exists
  fs.ensureDirSync(outputDir); // Ensure the merged output directory exists
} catch (err) {
  console.error(`❌ Error ensuring directories exist for room ${roomId}:`, err.message);
  process.exit(1);
}

console.log(`\n📂 Starting merge process for room: ${roomId}`);
console.log(`   Full Room Path: ${roomPath}`);
console.log(`   Output Directory: ${outputDir}`);

// Find user directories within the room, excluding the 'merged' folder
const userDirs = fs.readdirSync(roomPath)
  .filter(d => {
    const fullPath = path.join(roomPath, d);
    try {
      // Check if it's a directory and not the 'merged' folder
      return fs.statSync(fullPath).isDirectory() && d !== 'merged';
    } catch (e) {
      // Log if a directory can't be accessed (e.g., permission issues, symlink errors)
      console.warn(`⚠️ Could not stat directory '${fullPath}': ${e.message}. Skipping.`);
      return false; 
    }
  });

console.log(`\n🔎 Found ${userDirs.length} potential user directories: ${userDirs.length > 0 ? userDirs.join(', ') : 'None'}`);

const userOutputFiles = []; // This array will store paths to successfully concatenated user audio files

for (const userId of userDirs) {
  const userDir = path.join(roomPath, userId);
  console.log(`\n--- Processing user: ${userId} (Directory: ${userDir}) ---`);

  let files = [];
  try {
    // Read files in the user's directory, filter for .webm, and sort chronologically
    files = fs.readdirSync(userDir)
      .filter(f => f.endsWith('.webm'))
      .sort(); 
  } catch (e) {
    console.error(`❌ Error reading files in user directory '${userDir}': ${e.message}. Skipping this user.`);
    continue; // Skip to the next user if we can't read their directory
  }

  console.log(`🎧 Found ${files.length} .webm files for user '${userId}':`);
  if (files.length > 0) {
    // Log each file found with its size for verification
    files.forEach(f => {
      const fullFilePath = path.join(userDir, f);
      try {
        const stats = fs.statSync(fullFilePath);
        console.log(`   - ${f} (Size: ${stats.size} bytes)`);
      } catch (e) {
        console.warn(`   - ${f} (WARNING: Could not stat file: ${e.message}). This file might be problematic.`);
      }
    });
  } else {
    console.warn(`   ⚠️ No .webm audio files found for user '${userId}'. Skipping concatenation for this user.`);
    continue; // Skip concatenation if no valid files are found for this user
  }

  // Create a list file for ffmpeg concatenation
  const listFilePath = path.join(userDir, 'files.txt');
  // Use forward slashes in the list file and absolute paths for safety with ffmpeg's 'concat' demuxer
  const concatList = files.map(f => `file '${path.join(userDir, f).replace(/\\/g, '/')}'`).join('\n');
  fs.writeFileSync(listFilePath, concatList);
  console.log(`   List file created at: ${listFilePath}`);

  const outputFile = path.join(outputDir, `full-${userId}.webm`);
  try {
    console.log(`\n🔄 Concatenating ${files.length} chunks for user: '${userId}' into '${outputFile}'`);
    const ffmpegConcatCommand = `ffmpeg -y -f concat -safe 0 -i "${listFilePath}" -c copy "${outputFile}"`;
    console.log(`   Executing FFMPEG: ${ffmpegConcatCommand}`);
    // Execute ffmpeg command, inherit stdio for ffmpeg's own output/errors
    execSync(ffmpegConcatCommand, { stdio: 'inherit' });
    userOutputFiles.push(outputFile); // Add successfully concatenated file to the list for final merge
    console.log(`✅ Concatenation successful for user: '${userId}'`);
  } catch (err) {
    console.error(`❌ FFMPEG concatenation failed for user '${userId}':`, err.message);
    // Continue loop, this user's file won't be part of the final merge
  }
}

console.log(`\n--- Final Merge Preparation ---`);
console.log(`Total users with successfully concatenated audio files: ${userOutputFiles.length}`);

// Merge into final meeting file if at least two users have concatenated audio
if (userOutputFiles.length < 2) {
  console.warn("⚠️ Need at least two users with valid concatenated audio to mix. Skipping final merge.");
  process.exit(0);
}

const inputs = userOutputFiles.map(f => `-i "${f}"`).join(' ');
const finalFile = path.join(outputDir, `final-meeting.mp3`);

try {
  console.log(`\n🎧 Merging all users into: ${finalFile}`);
  // amix filter mixes multiple audio streams
  const ffmpegAmixCommand = `ffmpeg ${inputs} -filter_complex "amix=inputs=${userOutputFiles.length}:duration=longest" -y "${finalFile}"`;
  console.log(`   Executing FFMPEG: ${ffmpegAmixCommand}`);
  execSync(ffmpegAmixCommand, { stdio: 'inherit' });
  console.log("✅ Final meeting audio created:", finalFile);
} catch (err) {
  console.error("❌ Final merge failed:", err.message);
  process.exit(1);
}