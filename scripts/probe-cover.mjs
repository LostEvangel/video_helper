import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');
const generatedRoot = path.join(repoRoot, 'tests', 'generated', 'cover-probe');
const shellScript = path.join(repoRoot, 'scripts', 'read-shell-thumbnail.ps1');

function run(command, args, { binaryStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.on('error', (error) => reject(new Error(`Could not start ${command}: ${error.message}`)));
    child.on('close', (code, signal) => {
      const stdoutBuffer = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      if (code !== 0) {
        reject(new Error(`${command} exited ${code ?? `after signal ${signal}`}: ${stderr || '<no stderr>'}`));
        return;
      }
      resolve({ stdout: binaryStdout ? stdoutBuffer : stdoutBuffer.toString('utf8'), stderr });
    });
  });
}

async function runFfmpeg(args, options) {
  return run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], options);
}

async function probe(filePath) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath,
  ]);
  return JSON.parse(stdout);
}

function requireStream(streams, predicate, errorCode) {
  const stream = streams.find(predicate);
  if (!stream) throw new Error(errorCode);
  return stream;
}

function mediaFields(stream) {
  return {
    index: stream.index,
    codec_type: stream.codec_type,
    codec_name: stream.codec_name,
    width: stream.width,
    height: stream.height,
    sample_rate: stream.sample_rate,
    channels: stream.channels,
    duration: stream.duration,
    disposition: stream.disposition,
  };
}

async function sampleRgb(filePath) {
  const { stdout } = await runFfmpeg([
    '-i', filePath,
    '-vf', 'scale=1:1:flags=area',
    '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { binaryStdout: true });
  if (stdout.length < 3) throw new Error(`Could not read RGB pixels from ${filePath}`);
  const [red, green, blue] = stdout;
  let color = 'mixed';
  if (red > green * 1.45 && red > blue * 1.45) color = 'red';
  else if (green > red * 1.45 && green > blue * 1.45) color = 'green';
  else if (blue > red * 1.45 && blue > green * 1.45) color = 'blue';
  return { rgb: [red, green, blue], dominantColor: color };
}

async function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function mp4Boxes(buffer) {
  const containers = new Set([
    'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'meta', 'ilst',
    'mvex', 'moof', 'traf', 'mfra', 'tref', 'sinf', 'schi', 'wave', 'ipro', 'sbgp', 'covr',
    'sgpd', 'grpl', 'meco', 'mere',
  ]);
  const boxes = [];

  function visit(start, end, parentPath = '') {
    let offset = start;
    while (offset + 8 <= end) {
      const size32 = buffer.readUInt32BE(offset);
      const type = buffer.toString('ascii', offset + 4, offset + 8);
      let boxSize = size32;
      let headerSize = 8;
      if (size32 === 1) {
        if (offset + 16 > end) break;
        const size64 = buffer.readBigUInt64BE(offset + 8);
        if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) break;
        boxSize = Number(size64);
        headerSize = 16;
      } else if (size32 === 0) {
        boxSize = end - offset;
      }
      if (boxSize < headerSize || offset + boxSize > end) break;

      const boxPath = parentPath ? `${parentPath}/${type}` : type;
      const box = { type, path: boxPath, offset, size: boxSize, headerSize };
      boxes.push(box);

      let childStart = offset + headerSize;
      if (type === 'meta') childStart += 4; // FullBox version and flags.
      if (containers.has(type) && childStart <= offset + boxSize) {
        visit(childStart, offset + boxSize, boxPath);
      }
      offset += boxSize;
    }
  }

  visit(0, buffer.length);
  return boxes;
}

function inspectMp4(boxes, buffer) {
  const handlerBoxes = boxes.filter((box) => box.type === 'hdlr' && box.path.endsWith('/mdia/hdlr'));
  const handlers = handlerBoxes.map((box) => ({
    path: box.path,
    offset: box.offset,
    size: box.size,
    handlerType: box.offset + box.headerSize + 12 <= box.offset + box.size
      ? buffer.toString('ascii', box.offset + box.headerSize + 8, box.offset + box.headerSize + 12)
      : null,
  }));
  const covrData = boxes.filter((box) => box.type === 'data' && box.path.includes('/covr/data')).map((box) => {
    const metadataStart = box.offset + box.headerSize;
    const imagePayloadOffset = metadataStart + 8; // data type indicator + locale occupy eight bytes.
    const imagePayloadSize = box.size - box.headerSize - 8;
    const payload = buffer.subarray(imagePayloadOffset, imagePayloadOffset + imagePayloadSize);
    return {
      path: box.path,
      atomOffset: box.offset,
      atomSize: box.size,
      imagePayloadOffset,
      imagePayloadSize,
      dataTypeIndicator: box.size >= box.headerSize + 4 ? buffer.readUInt32BE(metadataStart) : null,
      locale: box.size >= box.headerSize + 8 ? buffer.readUInt32BE(metadataStart + 4) : null,
      startsWithJpegSignature: payload.length >= 2 && payload[0] === 0xff && payload[1] === 0xd8,
      imagePayloadSha256: createHash('sha256').update(payload).digest('hex'),
    };
  });
  return {
    covrAtoms: boxes.filter((box) => box.type === 'covr').map(({ path, offset, size }) => ({ path, offset, size })),
    covrData,
    pictureHandlers: handlers.filter((handler) => handler.handlerType === 'pict'),
    handlers,
    mediaDataAtoms: boxes.filter((box) => box.type === 'mdat').map(({ path, offset, size, headerSize }) => ({
      path,
      offset,
      size,
      payloadOffset: offset + headerSize,
      payloadSize: size - headerSize,
    })),
    sampleTableAtoms: boxes.filter((box) => ['stco', 'co64', 'stsz', 'stsc', 'stsd'].includes(box.type))
      .map(({ type, path, offset, size }) => ({ type, path, offset, size })),
  };
}

async function getUniqueRunDirectory() {
  await mkdir(generatedRoot, { recursive: true });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
    const candidate = path.join(generatedRoot, `run-${stamp}-${randomUUID()}`);
    try {
      await mkdir(candidate, { recursive: false });
      return candidate;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Could not allocate a unique probe output directory.');
}

async function getShellThumbnail(videoPath, outputPath) {
  const { stdout } = await run('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', shellScript,
    '-VideoPath', videoPath,
    '-OutputPath', outputPath,
  ]);
  const jsonLine = stdout.trim().split(/\r?\n/).at(-1);
  let result;
  try {
    result = JSON.parse(jsonLine);
  } catch {
    throw new Error(`Shell thumbnail helper returned unexpected output: ${stdout.trim() || '<empty>'}`);
  }
  return result;
}

async function assertDecode(filePath, videoStream, audioStream) {
  await runFfmpeg([
    '-i', filePath,
    '-map', `0:${videoStream.index}`,
    '-map', `0:${audioStream.index}`,
    '-f', 'null', '-',
  ]);
  return { status: 'passed', decodedVideoStream: videoStream.index, decodedAudioStream: audioStream.index };
}

async function main() {
  const runDirectory = await getUniqueRunDirectory();
  const copiedDirectory = path.join(runDirectory, 'copied');
  await mkdir(copiedDirectory);

  const files = {
    plain: path.join(runDirectory, 'plain-blue.mp4'),
    coverRed: path.join(runDirectory, 'cover-red.jpg'),
    embeddedRed: path.join(runDirectory, 'embedded-red.mp4'),
    extractedRed: path.join(runDirectory, 'embedded-cover-red.jpg'),
    mainBlue: path.join(runDirectory, 'main-video-first-frame-blue.jpg'),
    shellRed: path.join(runDirectory, 'shell-thumbnail-red-sample.png'),
    copiedRed: path.join(copiedDirectory, 'embedded-red-copy.mp4'),
    shellCopiedRed: path.join(runDirectory, 'shell-thumbnail-copied-file.png'),
    coverGreen: path.join(runDirectory, 'cover-green-replacement.jpg'),
    embeddedGreen: path.join(runDirectory, 'embedded-green-new-path.mp4'),
    shellGreen: path.join(runDirectory, 'shell-thumbnail-green-sample.png'),
    comparison: path.join(runDirectory, 'thumbnail-comparison.png'),
  };

  const [ffmpegVersionOutput, ffprobeVersionOutput] = await Promise.all([
    run('ffmpeg', ['-version']),
    run('ffprobe', ['-version']),
  ]);

  const makeVideo = [
    '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=25:d=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:v', 'libx264', '-c:a', 'aac', '-shortest', files.plain,
  ];
  const makeRedCover = ['-f', 'lavfi', '-i', 'color=c=red:s=640x360', '-frames:v', '1', files.coverRed];
  const embedRed = [
    '-i', files.plain, '-i', files.coverRed,
    '-map', '0:v:0', '-map', '0:a?', '-map', '1:v:0',
    '-c', 'copy', '-c:v:1', 'mjpeg', '-disposition:v:1', 'attached_pic', files.embeddedRed,
  ];

  await runFfmpeg(makeVideo);
  await runFfmpeg(makeRedCover);
  await runFfmpeg(embedRed);

  const plainProbe = await probe(files.plain);
  const redProbe = await probe(files.embeddedRed);
  const redStreams = redProbe.streams;
  const attachedRed = requireStream(redStreams, (s) => s.disposition?.attached_pic === 1, 'COVER_NOT_EMBEDDED');
  const mainRed = requireStream(redStreams, (s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1, 'MAIN_VIDEO_MISSING');
  const audioRed = requireStream(redStreams, (s) => s.codec_type === 'audio', 'ORIGINAL_AUDIO_MISSING');
  const plainVideo = requireStream(plainProbe.streams, (s) => s.codec_type === 'video', 'PLAIN_VIDEO_MISSING');
  const plainAudio = requireStream(plainProbe.streams, (s) => s.codec_type === 'audio', 'PLAIN_AUDIO_MISSING');

  await runFfmpeg(['-i', files.embeddedRed, '-map', `0:${attachedRed.index}`, '-frames:v', '1', '-q:v', '2', files.extractedRed]);
  await runFfmpeg(['-i', files.embeddedRed, '-map', `0:${mainRed.index}`, '-frames:v', '1', '-q:v', '2', files.mainBlue]);
  const extractedCoverColor = await sampleRgb(files.extractedRed);
  const firstVideoFrameColor = await sampleRgb(files.mainBlue);
  const expectedCoverColor = await sampleRgb(files.coverRed);
  if (extractedCoverColor.dominantColor !== 'red') throw new Error('EXTRACTED_COVER_NOT_RED');
  if (firstVideoFrameColor.dominantColor !== 'blue') throw new Error('MAIN_VIDEO_FRAME_NOT_BLUE');

  const shellRedResult = await getShellThumbnail(files.embeddedRed, files.shellRed);
  const shellRedColor = await sampleRgb(files.shellRed);

  await copyFile(files.embeddedRed, files.copiedRed);
  const originalHash = await sha256(files.embeddedRed);
  const copiedHash = await sha256(files.copiedRed);
  if (originalHash !== copiedHash) throw new Error('COPIED_FILE_HASH_MISMATCH');
  const shellCopiedResult = await getShellThumbnail(files.copiedRed, files.shellCopiedRed);
  const shellCopiedColor = await sampleRgb(files.shellCopiedRed);

  const makeGreenCover = ['-f', 'lavfi', '-i', 'color=c=green:s=640x360', '-frames:v', '1', files.coverGreen];
  const embedGreen = [
    '-i', files.plain, '-i', files.coverGreen,
    '-map', '0:v:0', '-map', '0:a?', '-map', '1:v:0',
    '-c', 'copy', '-c:v:1', 'mjpeg', '-disposition:v:1', 'attached_pic', files.embeddedGreen,
  ];
  await runFfmpeg(makeGreenCover);
  await runFfmpeg(embedGreen);

  const greenProbe = await probe(files.embeddedGreen);
  const attachedGreen = requireStream(greenProbe.streams, (s) => s.disposition?.attached_pic === 1, 'GREEN_COVER_NOT_EMBEDDED');
  const shellGreenResult = await getShellThumbnail(files.embeddedGreen, files.shellGreen);
  const shellGreenColor = await sampleRgb(files.shellGreen);
  const greenCoverColor = await sampleRgb(files.coverGreen);

  await runFfmpeg([
    '-i', files.extractedRed, '-i', files.mainBlue, '-i', files.shellRed, '-i', files.shellGreen,
    '-filter_complex',
    '[0:v]scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2[a];' +
      '[1:v]scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2[b];' +
      '[2:v]scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2[c];' +
      '[3:v]scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2[d];' +
      '[a][b][c][d]xstack=inputs=4:layout=0_0|320_0|640_0|960_0:fill=black[out]',
    '-map', '[out]', '-frames:v', '1', files.comparison,
  ]);

  const embeddedBuffer = await readFile(files.embeddedRed);
  const embeddedBoxes = mp4Boxes(embeddedBuffer);
  const mp4Layout = inspectMp4(embeddedBoxes, embeddedBuffer);
  if (mp4Layout.covrAtoms.length !== 1 || mp4Layout.covrData.length !== 1 || !mp4Layout.covrData[0].startsWithJpegSignature) {
    throw new Error('MP4_COVR_JPEG_PAYLOAD_NOT_LOCATED');
  }

  const decodeRed = await assertDecode(files.embeddedRed, mainRed, audioRed);
  const decodeCopy = await assertDecode(files.copiedRed, mainRed, audioRed);
  const greenMain = requireStream(greenProbe.streams, (s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1, 'GREEN_MAIN_VIDEO_MISSING');
  const greenAudio = requireStream(greenProbe.streams, (s) => s.codec_type === 'audio', 'GREEN_ORIGINAL_AUDIO_MISSING');
  const decodeGreen = await assertDecode(files.embeddedGreen, greenMain, greenAudio);

  const compareFields = (left, right) => {
    const keys = left.codec_type === 'audio'
      ? ['codec_name', 'sample_rate', 'channels']
      : ['codec_name', 'width', 'height'];
    return keys.every((key) => left[key] === right[key]);
  };
  const unchangedOriginalStreams = compareFields(plainVideo, mainRed) && compareFields(plainAudio, audioRed);
  if (!unchangedOriginalStreams) throw new Error('ORIGINAL_STREAM_PARAMETERS_CHANGED');

  const fileStats = {};
  for (const [key, value] of Object.entries(files)) {
    if (key === 'comparison' || key.startsWith('shell')) {
      const info = await stat(value);
      fileStats[key] = { path: value, bytes: info.size };
    }
  }
  const result = {
    status: 'completed',
    generatedAt: new Date().toISOString(),
    runDirectory,
    environment: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      powershell: 'Windows PowerShell Shell API helper',
    },
    tools: {
      ffmpegVersion: ffmpegVersionOutput.stdout.split(/\r?\n/, 1)[0],
      ffprobeVersion: ffprobeVersionOutput.stdout.split(/\r?\n/, 1)[0],
    },
    files: Object.fromEntries(Object.entries(files).map(([key, value]) => [key, path.resolve(value)])),
    streams: {
      plain: [mediaFields(plainVideo), mediaFields(plainAudio)],
      redEmbedded: redStreams.map(mediaFields),
      greenEmbedded: greenProbe.streams.map(mediaFields),
      unchangedOriginalVideoAndAudioParameters: unchangedOriginalStreams,
    },
    colorChecks: {
      redJpegCover: expectedCoverColor,
      extractedEmbeddedCover: extractedCoverColor,
      firstFrameOfMainVideo: firstVideoFrameColor,
      generatedGreenCover: greenCoverColor,
      shellThumbnailForRedEmbeddedFile: shellRedColor,
      shellThumbnailForCopiedFile: shellCopiedColor,
      shellThumbnailForGreenEmbeddedFile: shellGreenColor,
    },
    shellApi: {
      redEmbedded: shellRedResult,
      copiedFile: shellCopiedResult,
      greenEmbedded: shellGreenResult,
    },
    copyCheck: {
      byteIdentical: originalHash === copiedHash,
      sha256: originalHash,
      path: files.copiedRed,
    },
    decodeChecks: { redEmbedded: decodeRed, copiedRed: decodeCopy, greenEmbedded: decodeGreen },
    mp4Layout,
    fileStats,
  };

  const resultPath = path.join(runDirectory, 'probe-results.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
