import { 
    Input, 
    Output, 
    Conversion, 
    BlobSource, 
    BufferTarget, 
    Mp4OutputFormat, 
    ALL_FORMATS,
    QUALITY_MEDIUM
} from 'mediabunny';

const fileInput = document.getElementById('fileInput');
const convertBtn = document.getElementById('convertBtn');
const previewBtn = document.getElementById('previewBtn');
const log = document.getElementById('log');
const progressBar = document.getElementById('progressBar');
const progressContainer = document.getElementById('progressContainer');
const discardAudioCheckbox = document.getElementById('discardAudio');
const compressOutputCheckbox = document.getElementById('compressOutput');
const speedButtons = document.querySelectorAll('.speed-btn');
const speedEstimate = document.getElementById('speedEstimate');
const fileName = document.getElementById('fileName');
const previewPlayerWrap = document.getElementById('previewPlayerWrap');
const previewVideo = document.getElementById('previewVideo');
const downloadWrap = document.getElementById('downloadWrap');
const downloadFullBtn = document.getElementById('downloadFullBtn');

let selectedSpeed = 5;
const PREVIEW_SECONDS = 60;
let previewObjectUrl = null;
let fullObjectUrl = null;
let conversionInProgress = false;

const handleBeforeUnload = (event) => {
    if (!conversionInProgress) return;
    event.preventDefault();
    event.returnValue = 'A conversion is in progress. Are you sure you want to close this tab?';
};

window.addEventListener('beforeunload', handleBeforeUnload);

const formatMinutes = (minutes) => {
    const totalSeconds = Math.max(1, Math.round(minutes * 60));
    const mm = String(Math.floor(totalSeconds / 60));
    const ss = String(totalSeconds % 60).padStart(2, '0');
    return `${mm}:${ss}`;
};

const updateButtonText = () => {
    convertBtn.textContent = `Convert Full Video (${selectedSpeed}x)`;
    previewBtn.textContent = `Create 1-Min Preview (${selectedSpeed}x)`;
    speedEstimate.textContent = `Example: a 5:00 video becomes about ${formatMinutes(5 / selectedSpeed)} at ${selectedSpeed}x speed.`;
};

updateButtonText();

const resetFullDownload = () => {
    if (fullObjectUrl) {
        URL.revokeObjectURL(fullObjectUrl);
        fullObjectUrl = null;
    }
    downloadWrap.style.display = 'none';
    downloadFullBtn.removeAttribute('href');
    downloadFullBtn.removeAttribute('download');
};

speedButtons.forEach((button) => {
    button.addEventListener('click', () => {
        selectedSpeed = Number(button.dataset.speed);
        speedButtons.forEach((btn) => btn.classList.remove('active'));
        button.classList.add('active');
        updateButtonText();
    });
});

fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
        convertBtn.disabled = false;
        previewBtn.disabled = false;
        fileName.textContent = `Selected: ${fileInput.files[0].name}`;
        log.textContent = `Selected: ${fileInput.files[0].name}`;
        resetFullDownload();
    }
});

const runConversion = async (previewOnly) => {
    const file = fileInput.files[0];
    if (!file) return;
    const SPEED_FACTOR = selectedSpeed;
    updateButtonText();

    if (!previewOnly) {
        resetFullDownload();
    }

    try {
        conversionInProgress = true;
        convertBtn.disabled = true;
        previewBtn.disabled = true;
        progressContainer.style.display = 'block';
        log.textContent = previewOnly
            ? `Initializing 1-minute preview at ${SPEED_FACTOR}x...`
            : `Initializing full conversion at ${SPEED_FACTOR}x...`;

        // 1. Setup Input
        const input = new Input({
            source: new BlobSource(file),
            formats: ALL_FORMATS, // Detects MP4, MOV, WebM, etc.
        });

        // 2. Setup Output (MP4)
        const output = new Output({
            format: new Mp4OutputFormat(),
            target: new BufferTarget(), // Keeps file in memory. Use StreamTarget for huge files.
        });

        // 3. Configure Conversion
        const conversion = await Conversion.init({
            input,
            output,
            trim: previewOnly ? { start: 0, end: PREVIEW_SECONDS } : undefined,
            
            // VIDEO PROCESSING
            video: async (track) => {
                let sourceFrameRate = track.timeResolution || 30;
                try {
                    const stats = await track.computePacketStats(120);
                    if (Number.isFinite(stats.averagePacketRate) && stats.averagePacketRate > 0) {
                        sourceFrameRate = stats.averagePacketRate;
                    }
                } catch {
                    // Fall back to track time resolution if packet stats cannot be computed
                }

                // Keep output FPS in a widely-compatible range by downsampling first,
                // then retime timestamps to get the requested speedup.
                const conversionFrameRate = Math.max(1, sourceFrameRate / SPEED_FACTOR);

                return {
                    width: compressOutputCheckbox.checked ? 1920 : undefined,
                    bitrate: compressOutputCheckbox.checked ? QUALITY_MEDIUM : undefined,
                    frameRate: conversionFrameRate,
                    process: (sample) => {
                        sample.setTimestamp(sample.timestamp / SPEED_FACTOR);
                        sample.setDuration(sample.duration / SPEED_FACTOR);
                        return sample;
                    }
                };
            },

            // AUDIO PROCESSING
            audio: (track) => {
                // Audio at high speed is usually undesirable, so we discard it by default
                if (discardAudioCheckbox.checked) {
                    return { discard: true };
                }
                
                // If user wants to keep it, we still need to speed timestamps.
                // This may sound distorted without pitch-correction/time-stretching.
                return {
                    process: (sample) => {
                        sample.setTimestamp(sample.timestamp / SPEED_FACTOR);
                        return sample;
                    }
                };
            }
        });

        // Check compatibility
        if (!conversion.isValid) {
            throw new Error("Conversion not possible. " + 
                JSON.stringify(conversion.discardedTracks.map(t => t.reason)));
        }

        // Monitor Progress
        conversion.onProgress = (val) => {
            progressBar.value = val * 100;
            const percent = Math.round(val * 100);
            log.textContent = `Converting... ${percent}%`;
        };

        // 4. EXECUTE
        await conversion.execute();

        log.textContent = previewOnly
            ? "Preview complete! Playing now."
            : "Conversion complete! Ready to download.";

        // 5. Download the result
        const buffer = output.target.buffer;
        const blob = new Blob([buffer], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        
        if (previewOnly) {
            if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
            previewObjectUrl = url;
            previewVideo.src = previewObjectUrl;
            previewPlayerWrap.style.display = 'flex';
            previewVideo.currentTime = 0;
            previewVideo.play().catch(() => {});
        } else {
            fullObjectUrl = url;
            const suffix = `full_${selectedSpeed}x`;
            downloadFullBtn.href = fullObjectUrl;
            downloadFullBtn.download = `${suffix}_${file.name}.mp4`;
            downloadWrap.style.display = 'block';
        }

    } catch (err) {
        console.error(err);
        log.textContent = "Error: " + err.message;
    } finally {
        conversionInProgress = false;
        convertBtn.disabled = false;
        previewBtn.disabled = false;
    }
};

previewBtn.addEventListener('click', async () => {
    await runConversion(true);
});

convertBtn.addEventListener('click', async () => {
    await runConversion(false);
});
