'use strict';
// Captures microphone ("you") and system audio ("others") as 16 kHz mono and emits speech segments.
// When saveAudio is given, each stream is also recorded as compressed WebM/Opus and handed over every
// 30 seconds, so the meeting can be transcribed again later or recovered after a crash.
// saveAudio: { begin(source, t, mime) -> Promise<name|null>, append(name, ArrayBuffer) -> Promise }

const AUDIO_SLICE_MS = 30000;

// Records one stream. Chunks are written strictly in order, because each depends on the one before.
function createRecorder(stream, source, t, saveAudio, onWarning) {
  if (!saveAudio || typeof MediaRecorder === 'undefined') return null;
  const mime = ['audio/webm;codecs=opus', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) return null;
  let rec;
  try {
    rec = new MediaRecorder(new MediaStream(stream.getAudioTracks()), { mimeType: mime, audioBitsPerSecond: 32000 });
  } catch (_) {
    return null;
  }
  let warned = false;
  const warn = () => {
    if (!warned) { warned = true; onWarning('Saving the meeting audio failed. Transcription continues, but this recording may not be available to transcribe again later.'); }
  };
  let chain = Promise.resolve().then(() => saveAudio.begin(source, t, mime)).catch(() => { warn(); return null; });
  rec.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    const blob = e.data;
    chain = chain.then(async (name) => {
      if (!name) return name;
      try {
        await saveAudio.append(name, await blob.arrayBuffer());
      } catch (err) {
        warn();
        return null; // later chunks depend on this one; do not append them to a broken file
      }
      return name;
    });
  };
  const stopped = new Promise((resolve) => { rec.onstop = resolve; });
  rec.onerror = warn;
  rec.start(AUDIO_SLICE_MS);
  return {
    pause() { if (rec.state === 'recording') rec.pause(); },
    resume() { if (rec.state === 'paused') rec.resume(); },
    // Resolves once the last chunk is written.
    async stop() {
      if (rec.state !== 'inactive') rec.stop();
      await stopped;
      await chain;
    },
  };
}

async function startCapture({ getElapsed, onSegment, onWarning, onLevel, saveAudio }) {
  const ctx = new AudioContext({ sampleRate: 16000 });

  const streams = [];
  const segmenters = {};
  const nodes = [];
  const recorders = [];
  let paused = false;
  let stopped = false;
  const MIC_CONSTRAINTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } };

  async function cleanup() {
    stopped = true;
    paused = true;
    await Promise.all(recorders.map((r) => r.stop().catch(() => { /* already reported */ })));
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    nodes.forEach((n) => {
      if (n.port) n.port.onmessage = null;
      try { n.disconnect(); } catch (_) { /* already disconnected */ }
    });
    if (ctx.state !== 'closed') await ctx.close();
  }

  function attach(stream, source) {
    segmenters[source] = new Segmenter();
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pcm-collector');
    const mute = ctx.createGain();
    mute.gain.value = 0; // keep the graph running without playing audio back
    src.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
    node.port.onmessage = (e) => {
      if (onLevel) onLevel(source, paused ? 0 : Segmenter.rms(e.data));
      if (paused) return;
      const segs = segmenters[source].push(e.data, getElapsed());
      for (const s of segs) onSegment({ source, t: s.t, samples: s.samples });
    };
    nodes.push(node, src, mute);
    const rec = createRecorder(stream, source, getElapsed(), saveAudio, onWarning);
    if (rec) {
      if (paused) rec.pause();
      recorders.push(rec);
    }
    stream.getAudioTracks().forEach((track) => {
      track.onended = () => onTrackEnded(source);
    });
  }

  // A headset unplugged or a Bluetooth device switching ends the track silently.
  // Reconnect the microphone to the current default device instead of recording nothing.
  async function onTrackEnded(source) {
    if (stopped) return;
    const seg = segmenters[source] && segmenters[source].flush();
    if (seg) onSegment({ source, t: seg.t, samples: seg.samples });
    if (source !== 'you') {
      onWarning('System audio stopped. Other participants are no longer transcribed. Stop and start the meeting to reconnect.');
      return;
    }
    for (let attempt = 0; attempt < 5 && !stopped; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const mic = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
        if (stopped) { mic.getTracks().forEach((t) => t.stop()); return; }
        streams.push(mic);
        attach(mic, 'you');
        onWarning('Microphone changed. Recording continues with the current default microphone.');
        return;
      } catch (_) { /* try again */ }
    }
    if (!stopped) onWarning('Microphone disconnected. Your voice is not being transcribed. Check the microphone, then stop and start the meeting.');
  }

  function flushAll() {
    for (const source of Object.keys(segmenters)) {
      const seg = segmenters[source].flush();
      if (seg) onSegment({ source, t: seg.t, samples: seg.samples });
    }
  }

  try {
  await ctx.audioWorklet.addModule('pcm-worklet.js');
  await ctx.resume();
  // Microphone
  const mic = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
  streams.push(mic);
  attach(mic, 'you');

  // System audio through Windows loopback. A video track is required by the API and is discarded.
  let systemOk = false;
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    streams.push(display);
    display.getVideoTracks().forEach((t) => {
      t.stop();
      display.removeTrack(t);
    });
    if (display.getAudioTracks().length) {
      attach(display, 'others');
      systemOk = true;
    }
  } catch (err) {
    // handled below
  }
  if (!systemOk) onWarning('System audio is not available. Capturing the microphone only, so other participants will not be transcribed.');
  } catch (err) {
    await cleanup();
    throw err;
  }

  return {
    systemOk: Boolean(segmenters.others),
    setPaused(value) {
      if (value && !paused) flushAll(); // keep what was said before the pause
      paused = Boolean(value);
      recorders.forEach((r) => (paused ? r.pause() : r.resume()));
    },
    async stop() {
      flushAll();
      await cleanup();
    },
  };
}

window.startCapture = startCapture;
