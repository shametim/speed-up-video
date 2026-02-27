import {
    Input,
    Output,
    Conversion,
    BlobSource,
    BufferTarget,
    Mp4OutputFormat,
    ALL_FORMATS,
    QUALITY_MEDIUM,
    AudioSample,
    VideoSample
} from 'mediabunny';

const fileInput = document.getElementById('fileInput');
const convertBtn = document.getElementById('convertBtn');
const log = document.getElementById('log');
const progressBar = document.getElementById('progressBar');
const progressContainer = document.getElementById('progressContainer');
const discardAudioCheckbox = document.getElementById('discardAudio');
const compressOutputCheckbox = document.getElementById('compressOutput');
const smoothModeCheckbox = document.getElementById('smoothMode');
const speedButtons = document.querySelectorAll('.speed-btn');
const speedEstimate = document.getElementById('speedEstimate');
const fileName = document.getElementById('fileName');
const downloadWrap = document.getElementById('downloadWrap');
const downloadFullBtn = document.getElementById('downloadFullBtn');
const shareWrap = document.getElementById('shareWrap');
const shareBtn = document.getElementById('shareBtn');
const fullPlayerWrap = document.getElementById('fullPlayerWrap');
const fullVideo = document.getElementById('fullVideo');

let selectedSpeed = 2;
let currentVideoDuration = null;
let fullObjectUrl = null;
let fullOutputFile = null;
let sourceDisplayWidth = null;
let sourceDisplayHeight = null;
let sourceMetadataRotation = null;
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

const getVideoMetadata = (file) => {
    return new Promise((resolve) => {
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.onloadedmetadata = () => {
            window.URL.revokeObjectURL(video.src);
            resolve({
                duration: video.duration,
                width: video.videoWidth,
                height: video.videoHeight
            });
        };
        video.onerror = () => {
            resolve(null);
        };
        video.src = URL.createObjectURL(file);
    });
};

const updateButtonText = (percent = null) => {
    if (conversionInProgress && Number.isFinite(percent)) {
        convertBtn.textContent = `Converting... ${Math.round(percent)}%`;
    } else {
        const modeSuffix = smoothModeCheckbox.checked ? ', Smooth' : '';
        convertBtn.textContent = `Speedup Video (${selectedSpeed}x${modeSuffix})`;
    }

    if (currentVideoDuration) {
        const originalFormatted = formatMinutes(currentVideoDuration / 60);
        const newFormatted = formatMinutes((currentVideoDuration / selectedSpeed) / 60);
        speedEstimate.textContent = `This ${originalFormatted} video becomes about ${newFormatted} at ${selectedSpeed}x speed.`;
    } else {
        speedEstimate.textContent = '';
    }
};

const setControlsLocked = (locked) => {
    fileInput.disabled = locked;
    discardAudioCheckbox.disabled = locked;
    compressOutputCheckbox.disabled = locked;
    smoothModeCheckbox.disabled = locked;
    speedButtons.forEach((button) => {
        button.disabled = locked;
    });
};

const readBoxType = (view, offset) => {
    return String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3)
    );
};

const getChildBoxes = (view, start, end) => {
    const boxes = [];
    let cursor = start;

    while (cursor + 8 <= end) {
        let size = view.getUint32(cursor);
        const type = readBoxType(view, cursor + 4);
        let headerSize = 8;

        if (size === 1) {
            if (cursor + 16 > end) break;
            const largeSize = view.getBigUint64(cursor + 8);
            size = Number(largeSize);
            headerSize = 16;
        } else if (size === 0) {
            size = end - cursor;
        }

        if (!Number.isFinite(size) || size < headerSize) break;
        const boxEnd = cursor + size;
        if (boxEnd > end) break;

        boxes.push({
            type,
            start: cursor,
            dataStart: cursor + headerSize,
            end: boxEnd
        });

        cursor = boxEnd;
    }

    return boxes;
};

const toUint8Array = (bufferLike) => {
    if (bufferLike instanceof Uint8Array) return bufferLike;
    if (bufferLike instanceof ArrayBuffer) return new Uint8Array(bufferLike);
    if (ArrayBuffer.isView(bufferLike)) {
        return new Uint8Array(bufferLike.buffer, bufferLike.byteOffset, bufferLike.byteLength);
    }

    return new Uint8Array(bufferLike);
};

const normalizeQuarterTurn = (degrees) => {
    const mapped = ((degrees % 360) + 360) % 360;
    const snapped = Math.round(mapped / 90) * 90;
    return snapped === 360 ? 0 : snapped;
};

const extractRotationFromTrackMatrix = (view, tkhdDataStart) => {
    const version = view.getUint8(tkhdDataStart);
    const matrixOffset = version === 1 ? tkhdDataStart + 52 : tkhdDataStart + 40;

    const m11 = view.getInt32(matrixOffset) / 65536;
    const m21 = view.getInt32(matrixOffset + 12) / 65536;
    const scaleX = Math.hypot(m11, m21);

    if (!Number.isFinite(scaleX) || scaleX === 0) return 0;

    const cosTheta = m11 / scaleX;
    const sinTheta = m21 / scaleX;
    const rotation = -Math.atan2(sinTheta, cosTheta) * (180 / Math.PI);
    return normalizeQuarterTurn(rotation);
};

const getSourceRotationFromFileMetadata = async (file) => {
    if (!file || file.size <= 0 || file.size > 512 * 1024 * 1024) {
        return null;
    }

    try {
        const buffer = await file.arrayBuffer();
        const view = new DataView(buffer);
        const topLevel = getChildBoxes(view, 0, view.byteLength);
        const moov = topLevel.find((box) => box.type === 'moov');
        if (!moov) return null;

        const traks = getChildBoxes(view, moov.dataStart, moov.end)
            .filter((box) => box.type === 'trak');

        for (const trak of traks) {
            const trakChildren = getChildBoxes(view, trak.dataStart, trak.end);
            const tkhd = trakChildren.find((box) => box.type === 'tkhd');
            const mdia = trakChildren.find((box) => box.type === 'mdia');
            if (!tkhd || !mdia) continue;

            const mdiaChildren = getChildBoxes(view, mdia.dataStart, mdia.end);
            const hdlr = mdiaChildren.find((box) => box.type === 'hdlr');
            if (!hdlr || hdlr.dataStart + 12 > hdlr.end) continue;

            const handlerType = readBoxType(view, hdlr.dataStart + 8);
            if (handlerType !== 'vide') continue;

            return extractRotationFromTrackMatrix(view, tkhd.dataStart);
        }
    } catch {
        return null;
    }

    return null;
};

const stripMp4RotationMatrices = (bufferLike) => {
    const bytes = toUint8Array(bufferLike);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const topLevel = getChildBoxes(view, 0, view.byteLength);

    for (const moov of topLevel.filter((box) => box.type === 'moov')) {
        const traks = getChildBoxes(view, moov.dataStart, moov.end).filter((box) => box.type === 'trak');

        for (const trak of traks) {
            const trakChildren = getChildBoxes(view, trak.dataStart, trak.end);
            const tkhd = trakChildren.find((box) => box.type === 'tkhd');
            const mdia = trakChildren.find((box) => box.type === 'mdia');
            if (!tkhd || !mdia) continue;

            const mdiaChildren = getChildBoxes(view, mdia.dataStart, mdia.end);
            const hdlr = mdiaChildren.find((box) => box.type === 'hdlr');
            if (!hdlr || hdlr.dataStart + 12 > hdlr.end) continue;

            const handlerType = readBoxType(view, hdlr.dataStart + 8);
            if (handlerType !== 'vide') continue;

            const version = view.getUint8(tkhd.dataStart);
            const matrixOffset = version === 1 ? tkhd.dataStart + 52 : tkhd.dataStart + 40;
            if (matrixOffset + 36 > tkhd.end) continue;

            view.setInt32(matrixOffset, 0x00010000);
            view.setInt32(matrixOffset + 4, 0);
            view.setInt32(matrixOffset + 8, 0);
            view.setInt32(matrixOffset + 12, 0);
            view.setInt32(matrixOffset + 16, 0x00010000);
            view.setInt32(matrixOffset + 20, 0);
            view.setInt32(matrixOffset + 24, 0);
            view.setInt32(matrixOffset + 28, 0);
            view.setInt32(matrixOffset + 32, 0x40000000);
        }
    }

    return bytes;
};

const clearFullOutput = () => {
    if (fullObjectUrl) {
        URL.revokeObjectURL(fullObjectUrl);
        fullObjectUrl = null;
    }
    fullOutputFile = null;

    fullVideo.pause();
    fullVideo.removeAttribute('src');
    fullVideo.load();
    fullPlayerWrap.style.display = 'none';

    downloadWrap.style.display = 'none';
    downloadFullBtn.removeAttribute('href');
    downloadFullBtn.removeAttribute('download');

    shareWrap.style.display = 'none';
    shareBtn.disabled = false;
};

const resetProgress = () => {
    progressBar.value = 0;
    progressContainer.style.display = 'none';
};

const toMp4Filename = (name) => {
    return name.toLowerCase().endsWith('.mp4') ? name : `${name}.mp4`;
};

const canShareFileNatively = (file) => {
    if (!file || typeof navigator.share !== 'function') return false;

    if (typeof navigator.canShare === 'function') {
        try {
            return navigator.canShare({ files: [file] });
        } catch {
            return false;
        }
    }

    return true;
};

const createProcessingCanvas = (width, height) => {
    if (typeof OffscreenCanvas !== 'undefined') {
        return new OffscreenCanvas(width, height);
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
};

const get2DContext = (canvas) => {
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('Could not initialize smooth-mode canvas rendering.');
    }
    return context;
};

const drawSampleToCanvas = (sample, context, width, height) => {
    context.clearRect(0, 0, width, height);
    sample.draw(context, 0, 0, width, height);
};

const createSpedUpAudioSample = (sample, speedFactor, timestamp) => {
    const sourceData = new Float32Array(sample.allocationSize({ planeIndex: 0, format: 'f32' }) / 4);
    sample.copyTo(sourceData, { planeIndex: 0, format: 'f32' });

    const channels = sample.numberOfChannels;
    const sourceFrames = sample.numberOfFrames;
    const targetFrames = Math.max(1, Math.floor(sourceFrames / speedFactor));
    const targetData = new Float32Array(targetFrames * channels);

    for (let outFrame = 0; outFrame < targetFrames; outFrame++) {
        const inFrame = Math.min(sourceFrames - 1, Math.floor(outFrame * speedFactor));
        const inOffset = inFrame * channels;
        const outOffset = outFrame * channels;

        for (let channel = 0; channel < channels; channel++) {
            targetData[outOffset + channel] = sourceData[inOffset + channel];
        }
    }

    return new AudioSample({
        format: 'f32',
        sampleRate: sample.sampleRate,
        numberOfChannels: channels,
        timestamp,
        data: targetData
    });
};

updateButtonText();

speedButtons.forEach((button) => {
    button.addEventListener('click', () => {
        if (conversionInProgress) return;

        selectedSpeed = Number(button.dataset.speed);
        speedButtons.forEach((btn) => btn.classList.remove('active'));
        button.classList.add('active');
        updateButtonText();
    });
});

smoothModeCheckbox.addEventListener('change', () => {
    if (conversionInProgress) return;
    updateButtonText();
});

fileInput.addEventListener('change', async () => {
    if (fileInput.files.length === 0) {
        currentVideoDuration = null;
        sourceDisplayWidth = null;
        sourceDisplayHeight = null;
        sourceMetadataRotation = null;
        convertBtn.disabled = true;
        fileName.textContent = 'No file selected';
        log.textContent = 'Waiting for file...';
        updateButtonText();
        clearFullOutput();
        resetProgress();
        return;
    }

    const file = fileInput.files[0];

    clearFullOutput();
    resetProgress();

    convertBtn.disabled = false;
    fileName.textContent = `Selected: ${file.name}`;
    log.textContent = `Selected: ${file.name}`;

    const [metadata, parsedRotation] = await Promise.all([
        getVideoMetadata(file),
        getSourceRotationFromFileMetadata(file)
    ]);
    currentVideoDuration = metadata?.duration ?? null;
    sourceDisplayWidth = metadata?.width ?? null;
    sourceDisplayHeight = metadata?.height ?? null;
    sourceMetadataRotation = parsedRotation;

    if (currentVideoDuration) {
        const formatted = formatMinutes(currentVideoDuration / 60);
        fileName.textContent = `Selected: ${file.name} (${formatted})`;
        log.textContent = `Selected: ${file.name} (Length: ${formatted})`;
    }

    updateButtonText();
});

const runConversion = async () => {
    if (conversionInProgress) return;

    const file = fileInput.files[0];
    if (!file) return;

    const SPEED_FACTOR = selectedSpeed;
    const smoothModeEnabled = smoothModeCheckbox.checked;

    clearFullOutput();
    progressBar.value = 0;

    try {
        conversionInProgress = true;
        setControlsLocked(true);
        convertBtn.disabled = true;
        progressContainer.style.display = 'block';
        updateButtonText(0);
        log.textContent = `Initializing ${smoothModeEnabled ? 'smooth ' : ''}conversion at ${SPEED_FACTOR}x...`;

        const input = new Input({
            source: new BlobSource(file),
            formats: ALL_FORMATS,
        });

        const output = new Output({
            format: new Mp4OutputFormat(),
            target: new BufferTarget(),
        });

        const conversion = await Conversion.init({
            input,
            output,
            video: async (track) => {
                const browserHasDisplayOrientation = Number.isFinite(sourceDisplayWidth)
                    && Number.isFinite(sourceDisplayHeight)
                    && sourceDisplayWidth > 0
                    && sourceDisplayHeight > 0;
                const browserIsPortrait = browserHasDisplayOrientation
                    ? sourceDisplayHeight > sourceDisplayWidth
                    : null;
                const trackIsPortrait = track.displayHeight > track.displayWidth;
                const browserOrientationCorrection = browserIsPortrait !== null && browserIsPortrait !== trackIsPortrait
                    ? 90
                    : 0;
                const metadataRotationCorrection = Number.isFinite(sourceMetadataRotation)
                    ? normalizeQuarterTurn(sourceMetadataRotation - track.rotation)
                    : 0;
                const orientationCorrection = metadataRotationCorrection || browserOrientationCorrection;
                const generatedFramesPerGap = smoothModeEnabled
                    ? Math.max(1, Math.min(3, Math.round(SPEED_FACTOR / 3)))
                    : 0;

                let previousFrameCanvas = null;
                let currentFrameCanvas = null;
                let blendFrameCanvas = null;
                let previousFrameContext = null;
                let currentFrameContext = null;
                let blendFrameContext = null;
                let previousTimestamp = null;

                const ensureSmoothBuffers = (sample) => {
                    const frameWidth = sample.displayWidth;
                    const frameHeight = sample.displayHeight;

                    const needsReset = !previousFrameCanvas
                        || previousFrameCanvas.width !== frameWidth
                        || previousFrameCanvas.height !== frameHeight;

                    if (needsReset) {
                        previousFrameCanvas = createProcessingCanvas(frameWidth, frameHeight);
                        currentFrameCanvas = createProcessingCanvas(frameWidth, frameHeight);
                        blendFrameCanvas = createProcessingCanvas(frameWidth, frameHeight);
                        previousFrameContext = get2DContext(previousFrameCanvas);
                        currentFrameContext = get2DContext(currentFrameCanvas);
                        blendFrameContext = get2DContext(blendFrameCanvas);
                        previousTimestamp = null;
                    }

                    return { frameWidth, frameHeight };
                };

                return {
                    width: compressOutputCheckbox.checked ? 1920 : undefined,
                    bitrate: compressOutputCheckbox.checked ? QUALITY_MEDIUM : undefined,
                    rotate: orientationCorrection,
                    allowRotationMetadata: false,
                    process: (sample) => {
                        sample.setRotation(0);

                        if (!smoothModeEnabled) {
                            sample.setTimestamp(sample.timestamp / SPEED_FACTOR);
                            sample.setDuration(sample.duration / SPEED_FACTOR);
                            return sample;
                        }

                        const inputTimestamp = sample.timestamp;
                        const { frameWidth, frameHeight } = ensureSmoothBuffers(sample);
                        drawSampleToCanvas(sample, currentFrameContext, frameWidth, frameHeight);

                        if (!Number.isFinite(previousTimestamp)) {
                            previousFrameContext.clearRect(0, 0, frameWidth, frameHeight);
                            previousFrameContext.drawImage(currentFrameCanvas, 0, 0, frameWidth, frameHeight);
                            previousTimestamp = inputTimestamp;
                            sample.setTimestamp(inputTimestamp / SPEED_FACTOR);
                            sample.setDuration(sample.duration / SPEED_FACTOR);
                            return sample;
                        }

                        const delta = inputTimestamp - previousTimestamp;
                        const outputSamples = [];

                        if (delta > 0 && generatedFramesPerGap > 0) {
                            const generatedDuration = Math.max(1e-6, (delta / (generatedFramesPerGap + 1)) / SPEED_FACTOR);

                            for (let frameIndex = 1; frameIndex <= generatedFramesPerGap; frameIndex++) {
                                const mixAmount = frameIndex / (generatedFramesPerGap + 1);
                                const blendedTimestamp = previousTimestamp + (delta * mixAmount);

                                blendFrameContext.clearRect(0, 0, frameWidth, frameHeight);
                                blendFrameContext.globalAlpha = 1;
                                blendFrameContext.drawImage(previousFrameCanvas, 0, 0, frameWidth, frameHeight);
                                blendFrameContext.globalAlpha = mixAmount;
                                blendFrameContext.drawImage(currentFrameCanvas, 0, 0, frameWidth, frameHeight);
                                blendFrameContext.globalAlpha = 1;

                                outputSamples.push(new VideoSample(blendFrameCanvas, {
                                    timestamp: blendedTimestamp / SPEED_FACTOR,
                                    duration: generatedDuration
                                }));
                            }
                        }

                        sample.setTimestamp(inputTimestamp / SPEED_FACTOR);
                        sample.setDuration(sample.duration / SPEED_FACTOR);
                        outputSamples.push(sample);

                        previousFrameContext.clearRect(0, 0, frameWidth, frameHeight);
                        previousFrameContext.drawImage(currentFrameCanvas, 0, 0, frameWidth, frameHeight);
                        previousTimestamp = inputTimestamp;

                        return outputSamples;
                    }
                };
            },
            audio: () => {
                if (discardAudioCheckbox.checked) {
                    return { discard: true };
                }

                let nextOutputTimestamp = null;

                return {
                    process: (sample) => {
                        const mappedTimestamp = sample.timestamp / SPEED_FACTOR;
                        const outputTimestamp = nextOutputTimestamp === null
                            ? mappedTimestamp
                            : Math.max(mappedTimestamp, nextOutputTimestamp);

                        const spedUpSample = createSpedUpAudioSample(sample, SPEED_FACTOR, outputTimestamp);
                        nextOutputTimestamp = spedUpSample.timestamp + spedUpSample.duration;

                        return spedUpSample;
                    }
                };
            }
        });

        if (!conversion.isValid) {
            throw new Error(
                `Conversion not possible. ${JSON.stringify(conversion.discardedTracks.map((track) => track.reason))}`
            );
        }

        const hasVideoTrack = conversion.utilizedTracks.some((track) => track.type === 'video');
        if (!hasVideoTrack) {
            const videoDiscardReasons = conversion.discardedTracks
                .filter((track) => track.track.type === 'video')
                .map((track) => track.reason);

            throw new Error(
                `Video track could not be processed in this browser (${videoDiscardReasons.join(', ') || 'unknown reason'}). `
                + 'If this is an iPhone HEVC video, try Safari.'
            );
        }

        conversion.onProgress = (val) => {
            const percent = Math.round(Math.max(0, Math.min(100, val * 100)));
            progressBar.value = percent;
            updateButtonText(percent);
            log.textContent = `Converting... ${percent}%`;
        };

        await conversion.execute();

        const encodedBuffer = output.target.buffer;
        const normalizedBuffer = stripMp4RotationMatrices(encodedBuffer);
        const blob = new Blob([normalizedBuffer], { type: 'video/mp4' });
        fullObjectUrl = URL.createObjectURL(blob);

        const suffix = `full_${selectedSpeed}x`;
        const outputName = toMp4Filename(`${suffix}_${file.name}`);
        downloadFullBtn.href = fullObjectUrl;
        downloadFullBtn.download = outputName;
        downloadWrap.style.display = 'block';
        fullOutputFile = new File([blob], outputName, { type: 'video/mp4' });
        shareWrap.style.display = canShareFileNatively(fullOutputFile) ? 'block' : 'none';

        fullVideo.src = fullObjectUrl;
        fullPlayerWrap.style.display = 'flex';
        fullVideo.currentTime = 0;
        fullVideo.play().catch(() => {});

        progressBar.value = 100;
        updateButtonText(100);
        log.textContent = 'Conversion complete! Ready to download.';
    } catch (err) {
        console.error(err);
        const message = err instanceof Error ? err.message : String(err);
        log.textContent = `Error: ${message}`;
    } finally {
        conversionInProgress = false;
        setControlsLocked(false);
        convertBtn.disabled = fileInput.files.length === 0;
        updateButtonText();
    }
};

convertBtn.addEventListener('click', runConversion);

shareBtn.addEventListener('click', async () => {
    if (!fullOutputFile) return;

    if (!canShareFileNatively(fullOutputFile)) {
        log.textContent = 'Native file sharing is not supported in this browser.';
        return;
    }

    shareBtn.disabled = true;

    try {
        await navigator.share({
            files: [fullOutputFile],
            title: 'Sped up video',
            text: fullOutputFile.name
        });
        log.textContent = 'Share complete.';
    } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
            log.textContent = 'Share canceled.';
            return;
        }

        const message = err instanceof Error ? err.message : String(err);
        log.textContent = `Share failed: ${message}`;
    } finally {
        shareBtn.disabled = false;
    }
});
