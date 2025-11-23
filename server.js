const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');

const execPromise = promisify(require('child_process').exec);
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Store download progress in memory
const downloadProgress = new Map();

// Ensure temp directory exists
const TEMP_DIR = path.join(__dirname, 'temp');
fs.mkdir(TEMP_DIR, { recursive: true });

// Cleanup old files periodically
setInterval(async () => {
  try {
    const files = await fs.readdir(TEMP_DIR);
    const now = Date.now();
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      const stats = await fs.stat(filePath);
      if (now - stats.mtimeMs > 3600000) {
        await fs.unlink(filePath);
      }
    }
  } catch (err) {
    console.error('Cleanup error:', err);
  }
}, 600000);

function detectPlatform(url) {
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'YouTube';
  if (url.includes('instagram.com')) return 'Instagram';
  if (url.includes('tiktok.com')) return 'TikTok';
  if (url.includes('twitter.com') || url.includes('x.com')) return 'Twitter/X';
  if (url.includes('facebook.com')) return 'Facebook';
  if (url.includes('vimeo.com')) return 'Vimeo';
  if (url.includes('dailymotion.com')) return 'Dailymotion';
  return 'Unknown';
}

app.post('/api/video-info', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const platform = detectPlatform(url);
    
    const { stdout } = await execPromise(
      `yt-dlp --dump-json "${url}"`,
      { maxBuffer: 10 * 1024 * 1024 }
    );

    const videoInfo = JSON.parse(stdout);
    
    const formats = videoInfo.formats
      .filter(f => {
        return (f.vcodec !== 'none' || f.acodec !== 'none') && 
               f.format_id && 
               !f.format_note?.includes('storyboard');
      })
      .map(f => {
        const isVideo = f.vcodec && f.vcodec !== 'none';
        const hasAudio = f.acodec && f.acodec !== 'none';
        
        let quality = f.format_note || f.quality || 'Unknown';
        
        if (isVideo && f.height) {
          quality = `${f.height}p`;
          if (f.height >= 2160) quality = '2160p (4K)';
          else if (f.height >= 1440) quality = '1440p (2K)';
          else if (f.height >= 1080) quality = '1080p (FHD)';
          else if (f.height >= 720) quality = '720p (HD)';
        } else if (!isVideo && hasAudio) {
          quality = `Audio Only (${f.abr || f.asr || 'Unknown'} kbps)`;
        }

        return {
          id: f.format_id,
          quality,
          type: isVideo ? 'video' : 'audio',
          hasAudio,
          codec: isVideo ? f.vcodec : f.acodec,
          filesize: f.filesize || f.filesize_approx,
        };
      })
      .filter((f, i, arr) => 
        arr.findIndex(t => t.quality === f.quality && t.type === f.type) === i
      )
      .sort((a, b) => {
        if (a.type === 'video' && b.type === 'video') {
          const aHeight = parseInt(a.quality) || 0;
          const bHeight = parseInt(b.quality) || 0;
          return bHeight - aHeight;
        }
        if (a.type === 'audio' && b.type === 'video') return 1;
        if (a.type === 'video' && b.type === 'audio') return -1;
        return 0;
      });

    res.json({
      platform,
      title: videoInfo.title,
      formats: formats.slice(0, 15),
    });
  } catch (error) {
    console.error('Error fetching video info:', error);
    res.status(500).json({ 
      error: 'Failed to fetch video information. Make sure yt-dlp is installed and the URL is valid.' 
    });
  }
});

// Endpoint to check download progress
app.get('/api/download-progress/:downloadId', (req, res) => {
  const { downloadId } = req.params;
  const progress = downloadProgress.get(downloadId);
  
  if (!progress) {
    return res.json({ 
      status: 'not_found',
      percent: 0,
      speed: '0 KB/s',
      eta: 'Unknown'
    });
  }
  
  res.json(progress);
});

// Start download (non-blocking)
app.post('/api/start-download', async (req, res) => {
  const { url, formatId, isVideoOnly } = req.body;

  if (!url || !formatId) {
    return res.status(400).json({ error: 'URL and format ID are required' });
  }

  const downloadId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const outputFile = path.join(TEMP_DIR, `video_${downloadId}.mp4`);

  // Initialize progress
  downloadProgress.set(downloadId, {
    status: 'downloading',
    percent: 0,
    speed: '0 KB/s',
    eta: 'Calculating...',
    filePath: outputFile,
  });

  // Return download ID immediately
  res.json({ downloadId });

  // Start download in background
  (async () => {
    try {
      let args;
      
      if (isVideoOnly) {
        args = [
          '-f', `${formatId}+bestaudio[ext=m4a]/bestaudio`,
          '--merge-output-format', 'mp4',
          '--newline',
          '-o', outputFile,
          url
        ];
      } else {
        args = [
          '-f', formatId,
          '--newline',
          '-o', outputFile,
          url
        ];
      }

      console.log('Executing: yt-dlp', args.join(' '));

      const ytdlp = spawn('yt-dlp', args);

      ytdlp.stdout.on('data', (data) => {
        const output = data.toString();
        
        // Parse yt-dlp progress
        const percentMatch = output.match(/(\d+\.?\d*)%/);
        const speedMatch = output.match(/(\d+\.?\d*(?:K|M|G)?i?B\/s)/);
        const etaMatch = output.match(/ETA\s+(\d+:\d+)/);
        
        const currentProgress = downloadProgress.get(downloadId);
        if (currentProgress) {
          if (percentMatch) currentProgress.percent = parseFloat(percentMatch[1]);
          if (speedMatch) currentProgress.speed = speedMatch[1];
          if (etaMatch) currentProgress.eta = etaMatch[1];
          
          downloadProgress.set(downloadId, currentProgress);
          console.log(`Progress [${downloadId}]: ${currentProgress.percent}% | ${currentProgress.speed}`);
        }
      });

      ytdlp.stderr.on('data', (data) => {
        console.log('yt-dlp stderr:', data.toString());
      });

      await new Promise((resolve, reject) => {
        ytdlp.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Download failed with code ${code}`));
          }
        });

        ytdlp.on('error', reject);
      });

      // Mark as complete
      downloadProgress.set(downloadId, {
        status: 'complete',
        percent: 100,
        speed: '0 KB/s',
        eta: 'Done',
        filePath: outputFile,
      });

      console.log('Download complete:', downloadId);

    } catch (error) {
      console.error('Download error:', error);
      downloadProgress.set(downloadId, {
        status: 'error',
        percent: 0,
        speed: '0 KB/s',
        eta: 'Failed',
        error: error.message,
      });

      try {
        await fs.unlink(outputFile);
      } catch (err) {}
    }
  })();
});

// Get the downloaded file
app.get('/api/get-file/:downloadId', async (req, res) => {
  const { downloadId } = req.params;
  const progress = downloadProgress.get(downloadId);

  if (!progress || progress.status !== 'complete') {
    return res.status(404).json({ error: 'File not ready or not found' });
  }

  try {
    const filePath = progress.filePath;
    await fs.access(filePath);
    
    const stats = await fs.stat(filePath);
    
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Disposition', 'attachment; filename="video.mp4"');

    const fileStream = require('fs').createReadStream(filePath);
    fileStream.pipe(res);

    fileStream.on('end', async () => {
      try {
        await fs.unlink(filePath);
        downloadProgress.delete(downloadId);
        console.log('File deleted:', filePath);
      } catch (err) {
        console.error('Error deleting file:', err);
      }
    });

  } catch (error) {
    console.error('Error serving file:', error);
    res.status(500).json({ error: 'Failed to serve file' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Video downloader API is running' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Make sure yt-dlp and ffmpeg are installed on your system`);
});
