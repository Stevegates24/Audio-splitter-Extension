// Dual Audio Output + Mixer — content script v4
// Fix: AudioContext autoplay suspension solved by resuming on ANY page interaction
(function () {
  'use strict';

  if (!window.__dualAudioV4) {
    window.__dualAudioV4 = {
      hooked: new Map(),
      config: { enabled: false, sinks: [] }, // sinks: [{deviceId, volume, eq, effect}]
      patched: false,
      observer: null,
      allCtxs: [],   // track every AudioContext for bulk resume
    };
  }
  const G = window.__dualAudioV4;

  // ─── KEY FIX: Resume ALL contexts on any user interaction on the page ────────
  // Chrome suspends AudioContext until a user gesture occurs on that tab.
  // System volume change is a gesture; that's why it was "working" only then.
  // We listen for the first real interaction and resume everything.
  function installGestureResume() {
    if (G._gestureInstalled) return;
    G._gestureInstalled = true;
    const resume = () => {
      G.allCtxs.forEach(ctx => {
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      });
    };
    // Capture phase so we catch it before the page does
    ['click','keydown','touchstart','mousedown','pointerdown'].forEach(ev => {
      document.addEventListener(ev, resume, { capture: true, passive: true });
    });
  }

  // ─── Messages ────────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

    if (msg.type === 'ENUM_DEVICES') {
      (async () => {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true });
          s.getTracks().forEach(t => t.stop());
        } catch (_) {}
        try {
          const all = await navigator.mediaDevices.enumerateDevices();
          sendResponse({ devices: all.filter(d => d.kind === 'audiooutput').map(d => ({ id: d.deviceId, label: d.label || '' })) });
        } catch (e) { sendResponse({ error: e.message }); }
      })();
      return true;
    }

    if (msg.type === 'DUAL_AUDIO_CONFIG') {
      G.config = msg.config;
      installGestureResume();
      // Work with 0, 1, or many sinks — 0 selected = apply EQ/FX to default output only
      if (G.config.enabled) {
        if (!G.config.sinks || G.config.sinks.length === 0) {
          G.config.sinks = [{ deviceId: 'default', volume: 1, eq: { bass: 0, mid: 0, treble: 0 }, effect: 'none' }];
        }
        applyToPage().then(count => sendResponse({ ok: true, count }));
      } else {
        teardownAll().then(() => sendResponse({ ok: true, torn: true }));
      }
      return true;
    }

    // Live param update — no teardown, just update nodes
    if (msg.type === 'UPDATE_PARAMS') {
      G.config.sinks = msg.sinks;
      updateLiveParams();
      sendResponse({ ok: true });
      return true;
    }
  });

  // ─── Apply to page ────────────────────────────────────────────────────────────
  async function applyToPage() {
    await teardownAll();
    patchPlay();
    observeDOM();
    installGestureResume();

    const els = [...document.querySelectorAll('audio, video')];
    let count = 0;
    for (const el of els) {
      if (await routeElement(el)) count++;
    }
    return count;
  }

  // ─── Build audio graph for one media element ──────────────────────────────────
  async function routeElement(el) {
    if (G.hooked.has(el)) return false;
    G.hooked.set(el, 'pending');

    const sinks = G.config.sinks;

    // Build one AudioContext per unique sink
    const ctxEntries = [];
    const seenSinks  = new Set();

    for (const sink of sinks) {
      const targetId = sink.deviceId === 'default' ? '' : sink.deviceId;
      const ctx = new AudioContext({ latencyHint: 'playback', sampleRate: 48000 });

      if (typeof ctx.setSinkId === 'function') {
        try { await ctx.setSinkId(targetId); }
        catch (e) {
          console.warn('[DualAudio] setSinkId failed:', sink.deviceId, e.message);
          ctx.close().catch(() => {});
          continue;
        }
      }

      const resolvedId = typeof ctx.sinkId === 'string' ? ctx.sinkId : targetId;
      if (seenSinks.has(resolvedId)) {
        console.warn('[DualAudio] Duplicate sink skipped:', sink.deviceId, '→', resolvedId);
        ctx.close().catch(() => {});
        continue;
      }
      seenSinks.add(resolvedId);

      // Immediately try to resume — may succeed if user has interacted
      ctx.resume().catch(() => {});
      G.allCtxs.push(ctx);
      ctxEntries.push({ ctx, sink, targetId });
    }

    if (!ctxEntries.length) { G.hooked.delete(el); return false; }

    try {
      const primary = ctxEntries[0].ctx;

      // Capture the element — recover if already captured
      let source;
      try {
        source = primary.createMediaElementSource(el);
      } catch (e) {
        console.warn('[DualAudio] Re-capturing element after context close');
        const wasPlaying = !el.paused;
        const t = el.currentTime;
        el.load();
        if (wasPlaying) {
          el.currentTime = t;
          try { await el.play(); } catch {}
        }
        source = primary.createMediaElementSource(el);
      }

      // Build the DSP chain for the primary sink
      const primaryChain = buildChain(primary, ctxEntries[0].sink);
      source.connect(primaryChain.input);
      primaryChain.output.connect(primary.destination);

      // Fork to extra sinks via MediaStream bridge
      const forks = [];
      for (let i = 1; i < ctxEntries.length; i++) {
        const { ctx, sink } = ctxEntries[i];

        const streamOut = primary.createMediaStreamDestination();
        source.connect(streamOut);                          // raw tap from source

        const streamIn = ctx.createMediaStreamSource(streamOut.stream);
        const chain    = buildChain(ctx, sink);
        streamIn.connect(chain.input);
        chain.output.connect(ctx.destination);

        forks.push({ streamOut, streamIn, chain, ctx });
      }

      const state = { primary, source, primaryChain, forks, allCtxs: ctxEntries.map(e => e.ctx) };
      G.hooked.set(el, state);
      console.log('[DualAudio] Routed →', ctxEntries.map(e => e.targetId||'default').join(' + '));
      return true;

    } catch (e) {
      ctxEntries.forEach(({ ctx }) => ctx.close().catch(() => {}));
      G.hooked.delete(el);
      console.warn('[DualAudio] routeElement failed:', e.message);
      return false;
    }
  }

  // ─── Build DSP chain: EQ + Effect + Gain ─────────────────────────────────────
  // Returns { input: AudioNode, output: AudioNode, nodes: {...} }
  function buildChain(ctx, sink) {
    const { volume = 1, eq = {}, effect = 'none' } = sink;

    // ── EQ: Low shelf (bass), Peaking (mids), High shelf (treble) ──
    const bass = ctx.createBiquadFilter();
    bass.type      = 'lowshelf';
    bass.frequency.value = 200;
    bass.gain.value      = (eq.bass  ?? 0);

    const mid = ctx.createBiquadFilter();
    mid.type      = 'peaking';
    mid.frequency.value = 1000;
    mid.Q.value         = 1.0;
    mid.gain.value      = (eq.mid   ?? 0);

    const treble = ctx.createBiquadFilter();
    treble.type      = 'highshelf';
    treble.frequency.value = 8000;
    treble.gain.value      = (eq.treble ?? 0);

    // ── Master gain ──
    const gainNode = ctx.createGain();
    gainNode.gain.value = volume;

    // ── Effect chain (inserted between EQ and gain) ──
    const effectNodes = buildEffect(ctx, effect);

    // Wire: bass → mid → treble → [effect] → gain
    bass.connect(mid);
    mid.connect(treble);

    if (effectNodes.length > 0) {
      treble.connect(effectNodes[0]);
      for (let i = 0; i < effectNodes.length - 1; i++) effectNodes[i].connect(effectNodes[i+1]);
      effectNodes[effectNodes.length - 1].connect(gainNode);
    } else {
      treble.connect(gainNode);
    }

    return {
      input:  bass,
      output: gainNode,
      nodes:  { bass, mid, treble, gainNode, effectNodes }
    };
  }

  // ─── Effect DSP implementations ───────────────────────────────────────────────
  function buildEffect(ctx, effect) {
    switch (effect) {

      case '8d': {
        // Natural 8D: three overlapping sine LFOs at prime-ratio frequencies
        // plus a slow random-walk modulator — no two cycles sound the same.
        const panner = ctx.createStereoPanner();

        // Primary slow pan — slightly randomised start phase & freq
        const lfo1 = ctx.createOscillator();
        const g1   = ctx.createGain();
        lfo1.type = 'sine';
        lfo1.frequency.value = 0.11 + Math.random() * 0.06; // 0.11–0.17 Hz
        g1.gain.value = 0.55 + Math.random() * 0.15;         // dominant depth
        lfo1.connect(g1); g1.connect(panner.pan);

        // Secondary off-beat modulator at ~2.3× primary — creates irregular feel
        const lfo2 = ctx.createOscillator();
        const g2   = ctx.createGain();
        lfo2.type = 'sine';
        lfo2.frequency.value = lfo1.frequency.value * (2.27 + Math.random() * 0.18);
        g2.gain.value = 0.18 + Math.random() * 0.1;
        lfo2.connect(g2); g2.connect(panner.pan);

        // Tertiary micro-wobble at ~5.1× primary — adds subtle humanisation
        const lfo3 = ctx.createOscillator();
        const g3   = ctx.createGain();
        lfo3.type = 'sine';
        lfo3.frequency.value = lfo1.frequency.value * (5.13 + Math.random() * 0.4);
        g3.gain.value = 0.07 + Math.random() * 0.06;
        lfo3.connect(g3); g3.connect(panner.pan);

        // Slow random-drift via noise-shaped modulator:
        // We use a very-low-freq triangle wave to make the center of panning
        // drift left/right over ~30 s — so the "orbit" itself isn't fixed.
        const drift = ctx.createOscillator();
        const gd    = ctx.createGain();
        drift.type = 'triangle';
        drift.frequency.value = 0.012 + Math.random() * 0.008; // 0.012–0.02 Hz
        gd.gain.value = 0.22;
        drift.connect(gd); gd.connect(panner.pan);

        // Start all at random phase offsets (each starts slightly delayed)
        const t = ctx.currentTime;
        lfo1.start(t);
        lfo2.start(t + Math.random() * 2);
        lfo3.start(t + Math.random() * 1);
        drift.start(t + Math.random() * 5);

        // Schedule gentle frequency variations every 8–14 s to prevent predictability
        function scheduleVariation(osc, baseFreq, spread, minInterval, maxInterval) {
          const next = minInterval + Math.random() * (maxInterval - minInterval);
          const newFreq = baseFreq * (1 + (Math.random() - 0.5) * spread);
          try {
            osc.frequency.setTargetAtTime(newFreq, ctx.currentTime + next, 2.5);
            setTimeout(() => scheduleVariation(osc, newFreq, spread, minInterval, maxInterval),
              (next + 2.5) * 1000);
          } catch (_) {} // ctx may be closed
        }
        scheduleVariation(lfo1, lfo1.frequency.value, 0.4, 8, 14);
        scheduleVariation(lfo2, lfo2.frequency.value, 0.3, 6, 11);

        return [panner];
      }

      case 'concert': {
        // Concert hall: reverb via ConvolverNode with a synthetic IR
        const convolver = ctx.createConvolver();
        convolver.buffer = makeImpulseResponse(ctx, 3.5, 2.0, false);
        const preGain  = ctx.createGain(); preGain.gain.value  = 0.7;
        const wetGain  = ctx.createGain(); wetGain.gain.value  = 0.55;
        const dryGain  = ctx.createGain(); dryGain.gain.value  = 0.65;
        // Wet/dry parallel mix — we flatten to series for simple chain
        // (true parallel would need a splitter at the input of this sub-graph;
        //  for the chain API we just return [convolver] and let output = convolver)
        convolver.buffer = makeImpulseResponse(ctx, 3.5, 2.0, false);
        return [convolver];
      }

      case 'stadium': {
        const convolver = ctx.createConvolver();
        convolver.buffer = makeImpulseResponse(ctx, 6.0, 3.0, false);
        return [convolver];
      }

      case 'cave': {
        const convolver = ctx.createConvolver();
        convolver.buffer = makeImpulseResponse(ctx, 2.0, 1.5, true);
        return [convolver];
      }

      case 'bathroom': {
        const convolver = ctx.createConvolver();
        convolver.buffer = makeImpulseResponse(ctx, 0.6, 0.8, true);
        return [convolver];
      }

      case 'club': {
        const convolver = ctx.createConvolver();
        convolver.buffer = makeImpulseResponse(ctx, 1.2, 1.2, false);
        // Add sub-bass boost
        const sub = ctx.createBiquadFilter();
        sub.type = 'lowshelf'; sub.frequency.value = 80; sub.gain.value = 5;
        convolver.connect(sub);
        return [convolver, sub];
      }

      case 'telephone': {
        const lo  = ctx.createBiquadFilter(); lo.type = 'highpass';  lo.frequency.value = 800;
        const hi  = ctx.createBiquadFilter(); hi.type = 'lowpass';   hi.frequency.value = 3000;
        const dist = ctx.createWaveShaper(); dist.curve = makeDistortionCurve(20);
        lo.connect(hi); hi.connect(dist);
        return [lo, hi, dist];
      }

      case 'bassboost': {
        const f = ctx.createBiquadFilter();
        f.type = 'lowshelf'; f.frequency.value = 150; f.gain.value = 10;
        return [f];
      }

      case 'vaporwave': {
        // Pitch shift emulation: slow + reverb + chorus via 2 delayed signals
        const convolver = ctx.createConvolver();
        convolver.buffer = makeImpulseResponse(ctx, 2.5, 1.8, false);
        const delay1 = ctx.createDelay(0.05); delay1.delayTime.value = 0.02;
        const delay2 = ctx.createDelay(0.05); delay2.delayTime.value = 0.035;
        convolver.connect(delay1); delay1.connect(delay2);
        return [convolver, delay1, delay2];
      }

      case 'none':
      default:
        return [];
    }
  }

  // ─── Synthetic impulse response (reverb IR) ───────────────────────────────────
  function makeImpulseResponse(ctx, duration, decay, reverse) {
    const rate   = ctx.sampleRate;
    const length = Math.floor(rate * duration);
    const buf    = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const n = reverse ? length - i : i;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - n / length, decay);
      }
    }
    return buf;
  }

  function makeDistortionCurve(amount) {
    const n = 256, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  }

  // ─── Live parameter update (no teardown) ─────────────────────────────────────
  function updateLiveParams() {
    G.hooked.forEach((state) => {
      if (!state || typeof state === 'string') return;
      const sinks = G.config.sinks;

      // Update primary
      if (sinks[0]) updateChainParams(state.primaryChain, sinks[0]);

      // Update forks
      state.forks.forEach((fork, i) => {
        if (sinks[i + 1]) updateChainParams(fork.chain, sinks[i + 1]);
      });
    });
  }

  function updateChainParams(chain, sink) {
    const { nodes } = chain;
    const eq  = sink.eq  || {};
    const vol = sink.volume ?? 1;

    nodes.bass.gain.setTargetAtTime(eq.bass   ?? 0, nodes.bass.context.currentTime, 0.01);
    nodes.mid.gain.setTargetAtTime( eq.mid    ?? 0, nodes.mid.context.currentTime,  0.01);
    nodes.treble.gain.setTargetAtTime(eq.treble ?? 0, nodes.treble.context.currentTime, 0.01);
    nodes.gainNode.gain.setTargetAtTime(vol, nodes.gainNode.context.currentTime, 0.01);
  }

  // ─── Teardown ─────────────────────────────────────────────────────────────────
  async function teardownAll() {
    const entries = [...G.hooked.entries()];
    G.hooked.clear();
    G.allCtxs = [];

    for (const [, state] of entries) {
      if (!state || typeof state === 'string') continue;
      try { state.source.disconnect(); } catch {}
      state.forks.forEach(f => {
        try { f.streamOut.disconnect(); } catch {}
        try { f.streamIn.disconnect(); } catch {}
      });
      for (const ctx of state.allCtxs) {
        try { await ctx.close(); } catch {}
      }
    }
  }

  // ─── Patch play() ─────────────────────────────────────────────────────────────
  function patchPlay() {
    if (G.patched) return;
    G.patched = true;
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (G.config.enabled && !G.hooked.has(this)) {
        const el = this;
        setTimeout(() => {
          routeElement(el).then(() => {
            // Resume all contexts after element is hooked
            G.allCtxs.forEach(c => c.resume().catch(() => {}));
          });
        }, 80);
      }
      return orig.apply(this, arguments);
    };
  }

  // ─── DOM observer ─────────────────────────────────────────────────────────────
  function observeDOM() {
    if (G.observer) return;
    G.observer = new MutationObserver(muts => {
      if (!G.config.enabled) return;
      for (const m of muts) for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.('audio,video')) routeElement(node);
        node.querySelectorAll?.('audio,video').forEach(el => routeElement(el));
      }
    });
    G.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

})();
