// Dual Audio Output + Mixer — content script v5
// Key fixes:
//   - Primary AudioContext is never closed (avoids el.load() buffer stall)
//   - Effects swap live by rewiring nodes in-place (no full teardown)
//   - Buffering on 3rd apply fixed by reusing the captured source node
(function () {
  'use strict';

  if (!window.__dualAudioV5) {
    window.__dualAudioV5 = {
      // el → { primaryCtx, source, primaryChain, forks, allCtxs }
      hooked:  new Map(),
      config:  { enabled: false, sinks: [] },
      patched: false,
      observer: null,
      allCtxs: [],
    };
  }
  const G = window.__dualAudioV5;

  // ── Gesture resume: Chrome suspends AudioContext until user interacts ──────────
  function installGestureResume() {
    if (G._gr) return; G._gr = true;
    const resume = () => G.allCtxs.forEach(c => { if (c.state === 'suspended') c.resume().catch(()=>{}); });
    ['click','keydown','touchstart','mousedown','pointerdown'].forEach(ev =>
      document.addEventListener(ev, resume, { capture: true, passive: true }));
  }

  // ── Messages ─────────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

    if (msg.type === 'ENUM_DEVICES') {
      (async () => {
        try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); } catch (_) {}
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
      if (G.config.enabled) {
        if (!G.config.sinks || !G.config.sinks.length)
          G.config.sinks = [{ deviceId: 'default', volume: 1, eq: { bass:0,mid:0,treble:0 }, effect: { id:'none', params:{} } }];
        applyToPage().then(count => sendResponse({ ok: true, count }));
      } else {
        softTeardown();
        sendResponse({ ok: true, torn: true });
      }
      return true;
    }

    // Live EQ/volume update — no graph rebuild
    if (msg.type === 'UPDATE_PARAMS') {
      G.config.sinks = msg.sinks;
      updateLiveParams();
      sendResponse({ ok: true });
      return true;
    }

    // Live effect swap — rewires only the effect sub-graph, no teardown
    if (msg.type === 'SWAP_EFFECT') {
      G.config.sinks = msg.sinks;
      swapEffects();
      sendResponse({ ok: true });
      return true;
    }
  });

  // ── Apply to page ─────────────────────────────────────────────────────────────
  async function applyToPage() {
    // Soft-teardown: disconnect nodes but KEEP primary contexts alive
    // so we can reuse the already-captured MediaElementSourceNode
    softTeardown();
    patchPlay();
    observeDOM();
    installGestureResume();

    let count = 0;
    for (const el of [...document.querySelectorAll('audio, video')]) {
      if (await routeElement(el)) count++;
    }
    return count;
  }

  // ── Soft teardown: disconnect nodes, preserve primary ctx + source ────────────
  // This is the key fix for the buffering bug. We NEVER close the primary context
  // or reload the element. We just unwire the DSP graph and rebuild it.
  function softTeardown() {
    G.hooked.forEach((state, el) => {
      if (!state || typeof state === 'string') return;
      try {
        // Disconnect source from its chains (but keep source alive)
        state.source.disconnect();
      } catch (_) {}
      // Disconnect and close fork contexts (secondary sinks only)
      state.forks.forEach(f => {
        try { f.streamOut.disconnect(); } catch (_) {}
        try { f.streamIn.disconnect(); } catch (_) {}
        try { f.ctx.close(); } catch (_) {}
      });
      // Mark as needing rewire but keep the primaryCtx+source reference
      G.hooked.set(el, { primaryCtx: state.primaryCtx, source: state.source, _keepAlive: true });
    });
    // Purge dead fork ctxs from allCtxs (keep primary ctxs)
    G.allCtxs = G.allCtxs.filter(c => c.state !== 'closed');
  }

  // ── Route one element ─────────────────────────────────────────────────────────
  async function routeElement(el) {
    const existing = G.hooked.get(el);
    // Already fully routed (not a keepAlive stub)
    if (existing && !existing._keepAlive) return false;

    const sinks = G.config.sinks;
    const ctxEntries = [];
    const seenSinks  = new Set();

    // Reuse existing primary context if we have one (avoids re-capture)
    let reuseCtx    = existing?._keepAlive ? existing.primaryCtx : null;
    let reuseSource = existing?._keepAlive ? existing.source     : null;

    for (let i = 0; i < sinks.length; i++) {
      const sink     = sinks[i];
      const targetId = sink.deviceId === 'default' ? '' : sink.deviceId;

      let ctx;
      if (i === 0 && reuseCtx && reuseCtx.state !== 'closed') {
        // Reuse the primary context — no new capture needed
        ctx = reuseCtx;
      } else {
        ctx = new AudioContext({ latencyHint: 'playback', sampleRate: 48000 });
        if (typeof ctx.setSinkId === 'function') {
          try { await ctx.setSinkId(targetId); }
          catch (e) {
            console.warn('[DualAudio] setSinkId failed:', sink.deviceId, e.message);
            ctx.close().catch(()=>{});
            continue;
          }
        }
      }

      const resolvedId = typeof ctx.sinkId === 'string' ? ctx.sinkId : targetId;
      if (seenSinks.has(resolvedId)) {
        console.warn('[DualAudio] Duplicate sink skipped:', sink.deviceId);
        if (ctx !== reuseCtx) ctx.close().catch(()=>{});
        continue;
      }
      seenSinks.add(resolvedId);
      ctx.resume().catch(()=>{});
      if (!G.allCtxs.includes(ctx)) G.allCtxs.push(ctx);
      ctxEntries.push({ ctx, sink, targetId });
    }

    if (!ctxEntries.length) { G.hooked.delete(el); return false; }

    try {
      const primary = ctxEntries[0].ctx;

      // Capture source — or reuse existing one
      let source;
      if (reuseSource && reuseCtx === primary) {
        source = reuseSource; // reuse — no el.load(), no buffering
      } else {
        try {
          source = primary.createMediaElementSource(el);
        } catch (e) {
          // Element captured by a different (closed) context — must reload
          // This should rarely happen now that we reuse primary ctxs
          console.warn('[DualAudio] source capture conflict, reloading element');
          const wasPlaying = !el.paused, t = el.currentTime;
          el.load();
          if (wasPlaying) { el.currentTime = t; try { await el.play(); } catch (_) {} }
          source = primary.createMediaElementSource(el);
        }
      }

      // Build primary chain
      const primaryChain = buildChain(primary, ctxEntries[0].sink);
      source.connect(primaryChain.input);
      primaryChain.output.connect(primary.destination);

      // Build fork chains (secondary sinks)
      const forks = [];
      for (let i = 1; i < ctxEntries.length; i++) {
        const { ctx, sink } = ctxEntries[i];
        const streamOut = primary.createMediaStreamDestination();
        source.connect(streamOut);
        const streamIn = ctx.createMediaStreamSource(streamOut.stream);
        const chain    = buildChain(ctx, sink);
        streamIn.connect(chain.input);
        chain.output.connect(ctx.destination);
        forks.push({ streamOut, streamIn, chain, ctx });
      }

      G.hooked.set(el, { primaryCtx: primary, source, primaryChain, forks, allCtxs: ctxEntries.map(e => e.ctx) });
      console.log('[DualAudio] Routed →', ctxEntries.map(e => e.targetId||'default').join(' + '));
      return true;

    } catch (e) {
      // Only close non-primary contexts
      ctxEntries.slice(1).forEach(({ ctx }) => ctx.close().catch(()=>{}));
      G.hooked.delete(el);
      console.warn('[DualAudio] routeElement failed:', e.message);
      return false;
    }
  }

  // ── Swap effects live — no teardown, just rewire the effect sub-graph ─────────
  function swapEffects() {
    G.hooked.forEach((state) => {
      if (!state || state._keepAlive || typeof state === 'string') return;
      const sinks = G.config.sinks;

      // Swap primary effect
      if (sinks[0]) swapChainEffect(state.primaryCtx, state.primaryChain, sinks[0]);

      // Swap fork effects
      state.forks.forEach((fork, i) => {
        if (sinks[i + 1]) swapChainEffect(fork.ctx, fork.chain, sinks[i + 1]);
      });
    });
  }

  function swapChainEffect(ctx, chain, sink) {
    // Disconnect old effect from EQ → effect → gain
    try { chain.nodes.treble.disconnect(); } catch (_) {}
    try { chain.nodes.effectChain.output.disconnect(); } catch (_) {}

    // Build new effect
    const newEffect = buildEffect(ctx, sink.effect);
    chain.nodes.treble.connect(newEffect.input);
    newEffect.output.connect(chain.nodes.gainNode);
    chain.nodes.effectChain = newEffect;
  }

  // ── Build DSP chain: EQ → Effect → Gain ──────────────────────────────────────
  function buildChain(ctx, sink) {
    const { volume = 1, eq = {}, effect = { id: 'none', params: {} } } = sink;

    const bass = ctx.createBiquadFilter();
    bass.type = 'lowshelf'; bass.frequency.value = 200; bass.gain.value = eq.bass ?? 0;

    const mid = ctx.createBiquadFilter();
    mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 1.0; mid.gain.value = eq.mid ?? 0;

    const treble = ctx.createBiquadFilter();
    treble.type = 'highshelf'; treble.frequency.value = 8000; treble.gain.value = eq.treble ?? 0;

    const gainNode = ctx.createGain();
    gainNode.gain.value = volume;

    const effectChain = buildEffect(ctx, effect);

    bass.connect(mid);
    mid.connect(treble);
    treble.connect(effectChain.input);
    effectChain.output.connect(gainNode);

    return { input: bass, output: gainNode, nodes: { bass, mid, treble, gainNode, effectChain } };
  }

  // ── Wet/dry parallel mixer ────────────────────────────────────────────────────
  function makeWetDry(ctx, wetNodes, wetMix) {
    const input  = ctx.createGain();
    const dry    = ctx.createGain(); dry.gain.value  = 1 - wetMix;
    const wet    = ctx.createGain(); wet.gain.value  = wetMix;
    const output = ctx.createGain();
    input.connect(dry); dry.connect(output);
    input.connect(wetNodes[0]);
    for (let i = 0; i < wetNodes.length - 1; i++) wetNodes[i].connect(wetNodes[i+1]);
    wetNodes[wetNodes.length - 1].connect(wet); wet.connect(output);
    return { input, output };
  }

  // ── Effect DSP ────────────────────────────────────────────────────────────────
  function buildEffect(ctx, effectConfig) {
    const id     = typeof effectConfig === 'string' ? effectConfig : (effectConfig?.id   || 'none');
    const params = typeof effectConfig === 'object'  ? (effectConfig?.params || {})      : {};

    switch (id) {

      case '8d': {
        const speed  = params.speed  ?? 0.5;  // LFO rate
        const depth  = params.depth  ?? 0.7;  // pan sweep width
        const drift  = params.drift  ?? 0.5;  // orbit wander
        const reverb = params.reverb ?? 0.35; // room ambience mix
        const lofi   = params.lofi   ?? 0.0;  // lo-fi warmth (HF cut + saturation)

        // ── 1. Stereo panner with multi-LFO ──────────────────────────────────
        const panner  = ctx.createStereoPanner();
        const baseFreq = 0.07 + speed * 0.18;

        const mkLFO = (freq, amp, type = 'sine') => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = type; o.frequency.value = freq; g.gain.value = amp;
          o.connect(g); g.connect(panner.pan); return o;
        };
        const lfo1  = mkLFO(baseFreq,                                  depth * 0.60);
        const lfo2  = mkLFO(baseFreq * (2.27 + Math.random() * 0.18), depth * 0.22);
        const lfo3  = mkLFO(baseFreq * (5.13 + Math.random() * 0.40), depth * 0.09);
        const driftO = mkLFO(0.012 + Math.random() * 0.008,           drift * 0.28, 'triangle');
        const t = ctx.currentTime;
        [lfo1, lfo2, lfo3, driftO].forEach((o, i) => o.start(t + i * Math.random()));

        const vary = (osc, base, spread, lo, hi) => {
          const next = lo + Math.random() * (hi - lo);
          const nf   = base * (1 + (Math.random() - 0.5) * spread);
          try { osc.frequency.setTargetAtTime(nf, ctx.currentTime + next, 2.5); } catch (_) { return; }
          setTimeout(() => vary(osc, nf, spread, lo, hi), (next + 2.5) * 1000);
        };
        vary(lfo1, baseFreq, 0.35, 8, 14);
        vary(lfo2, lfo2.frequency.value, 0.25, 6, 11);

        // ── 2. Position-dependent pre-delay (simulates distance from center) ─
        // As pan sweeps left/right, a short delay increases slightly,
        // giving the sense of the sound moving further away at the extremes.
        const preDelay  = ctx.createDelay(0.04);
        preDelay.delayTime.value = 0.008;
        const delayLFO  = ctx.createOscillator();
        const delayGain = ctx.createGain();
        delayLFO.type = 'sine';
        delayLFO.frequency.value = baseFreq; // synced to pan speed
        delayGain.gain.value = 0.006; // subtle: ±6ms variation
        delayLFO.connect(delayGain);
        delayGain.connect(preDelay.delayTime);
        delayLFO.start(t);

        // ── 3. Room reverb for depth ──────────────────────────────────────────
        const convolver = ctx.createConvolver();
        convolver.buffer = makeIR(ctx, 1.4, 2.5, false); // medium room, fast decay
        const reverbWet  = ctx.createGain(); reverbWet.gain.value  = reverb;
        const reverbDry  = ctx.createGain(); reverbDry.gain.value  = 1 - reverb * 0.4;

        // ── 4. HRTF-approximation: high-freq rolloff at pan extremes ─────────
        // A low-pass filter whose cutoff dips when pan is far L/R.
        // Mimics how high frequencies attenuate around the head.
        const hpFilter  = ctx.createBiquadFilter();
        hpFilter.type = 'lowpass'; hpFilter.frequency.value = 18000; hpFilter.Q.value = 0.5;
        const hpLFO     = ctx.createOscillator();
        const hpLFOGain = ctx.createGain();
        hpLFO.type = 'sine'; hpLFO.frequency.value = baseFreq; // synced
        hpLFOGain.gain.value = -3500; // pan extreme → drop cutoff by 3.5kHz
        hpLFO.connect(hpLFOGain);
        hpLFOGain.connect(hpFilter.frequency);
        hpLFO.start(t);

        // ── 5. Lo-fi: gentle saturation + warmth LPF (optional) ──────────────
        const warmFilter = ctx.createBiquadFilter();
        warmFilter.type = 'lowshelf'; warmFilter.frequency.value = 400; warmFilter.gain.value = lofi * 3;
        const airFilter  = ctx.createBiquadFilter();
        airFilter.type = 'highshelf'; airFilter.frequency.value = 8000; airFilter.gain.value = -(lofi * 6);
        const saturate   = ctx.createWaveShaper();
        // Soft clip curve — barely audible at lofi=0, adds warmth at lofi=1
        const curve = new Float32Array(256);
        for (let i = 0; i < 256; i++) {
          const x = (i * 2) / 256 - 1;
          curve[i] = x / (1 + lofi * 1.5 * Math.abs(x));
        }
        saturate.curve = curve;

        // ── Wire everything ───────────────────────────────────────────────────
        // signal → preDelay → hpFilter → panner → [warmFilter → airFilter → saturate → dry] → out
        //                                        ↘ convolver → reverbWet →                  ↗ out
        const input  = ctx.createGain();
        const output = ctx.createGain();

        input.connect(preDelay);
        preDelay.connect(hpFilter);
        hpFilter.connect(panner);

        // Dry path: panner → warm → air → saturate → dry gain → output
        panner.connect(warmFilter);
        warmFilter.connect(airFilter);
        airFilter.connect(saturate);
        saturate.connect(reverbDry);
        reverbDry.connect(output);

        // Reverb path: panner → convolver → reverbWet → output
        panner.connect(convolver);
        convolver.connect(reverbWet);
        reverbWet.connect(output);

        return { input, output };
      }

      case 'concert':  { const c = ctx.createConvolver(); c.buffer = makeIR(ctx, 2.8, 2.2, false); return makeWetDry(ctx, [c], params.mix ?? 0.28); }
      case 'stadium':  { const c = ctx.createConvolver(); c.buffer = makeIR(ctx, 5.0, 2.8, false); return makeWetDry(ctx, [c], params.mix ?? 0.22); }
      case 'cave':     { const c = ctx.createConvolver(); c.buffer = makeIR(ctx, 1.6, 1.4, true);  return makeWetDry(ctx, [c], params.mix ?? 0.30); }
      case 'bathroom': { const c = ctx.createConvolver(); c.buffer = makeIR(ctx, 0.5, 0.9, true);  return makeWetDry(ctx, [c], params.mix ?? 0.25); }

      case 'club': {
        const c   = ctx.createConvolver(); c.buffer = makeIR(ctx, 1.0, 1.3, false);
        const sub = ctx.createBiquadFilter(); sub.type = 'lowshelf'; sub.frequency.value = 80; sub.gain.value = 4;
        c.connect(sub);
        return makeWetDry(ctx, [c, sub], params.mix ?? 0.25);
      }

      case 'telephone': {
        const lo   = ctx.createBiquadFilter(); lo.type  = 'highpass'; lo.frequency.value  = 800;
        const hi   = ctx.createBiquadFilter(); hi.type  = 'lowpass';  hi.frequency.value  = 3000;
        const dist = ctx.createWaveShaper();   dist.curve = makeDistCurve(12);
        lo.connect(hi); hi.connect(dist);
        return makeWetDry(ctx, [lo, hi, dist], params.mix ?? 0.80);
      }

      case 'bassboost': {
        const f = ctx.createBiquadFilter();
        f.type = 'lowshelf'; f.frequency.value = 150; f.gain.value = params.gain ?? 7;
        const input = ctx.createGain(); input.connect(f);
        return { input, output: f };
      }

      case 'vaporwave': {
        const mixAmt  = params.mix ?? 0.30;
        const mixIn   = ctx.createGain();
        const mixOut  = ctx.createGain();
        const dryG    = ctx.createGain(); dryG.gain.value = 1 - mixAmt;
        const wetG    = ctx.createGain(); wetG.gain.value = mixAmt * 0.5;
        mixIn.connect(dryG); dryG.connect(mixOut);

        const conv = ctx.createConvolver(); conv.buffer = makeIR(ctx, 2.0, 1.8, false);
        mixIn.connect(conv); conv.connect(wetG); wetG.connect(mixOut);

        const d1 = ctx.createDelay(0.08); d1.delayTime.value = 0.022;
        const d2 = ctx.createDelay(0.08); d2.delayTime.value = 0.038;
        const cLFO = ctx.createOscillator(); const cG = ctx.createGain();
        cLFO.frequency.value = 0.35; cG.gain.value = 0.004;
        cLFO.connect(cG); cG.connect(d1.delayTime); cG.connect(d2.delayTime); cLFO.start();
        const chG = ctx.createGain(); chG.gain.value = mixAmt * 0.5;
        mixIn.connect(d1); mixIn.connect(d2); d1.connect(chG); d2.connect(chG); chG.connect(mixOut);

        return { input: mixIn, output: mixOut };
      }

      case 'none': default: {
        const p = ctx.createGain(); return { input: p, output: p };
      }
    }
  }

  // ── Impulse response + distortion curve ──────────────────────────────────────
  function makeIR(ctx, dur, decay, reverse) {
    const rate = ctx.sampleRate, len = Math.floor(rate * dur);
    const buf  = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const n = reverse ? len - i : i;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - n / len, decay);
      }
    }
    return buf;
  }

  function makeDistCurve(amount) {
    const n = 256, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i*2)/n-1; c[i] = ((Math.PI+amount)*x)/(Math.PI+amount*Math.abs(x)); }
    return c;
  }

  // ── Live EQ/volume update (no graph rebuild) ──────────────────────────────────
  function updateLiveParams() {
    G.hooked.forEach(state => {
      if (!state || state._keepAlive || typeof state === 'string') return;
      const sinks = G.config.sinks;
      if (sinks[0]) updateChainParams(state.primaryChain, sinks[0]);
      state.forks.forEach((fork, i) => { if (sinks[i+1]) updateChainParams(fork.chain, sinks[i+1]); });
    });
  }

  function updateChainParams(chain, sink) {
    const { nodes } = chain;
    const eq = sink.eq || {}, vol = sink.volume ?? 1, now = nodes.bass.context.currentTime;
    nodes.bass.gain.setTargetAtTime(eq.bass ?? 0, now, 0.01);
    nodes.mid.gain.setTargetAtTime(eq.mid   ?? 0, now, 0.01);
    nodes.treble.gain.setTargetAtTime(eq.treble ?? 0, now, 0.01);
    nodes.gainNode.gain.setTargetAtTime(vol, now, 0.01);
  }

  // ── Hard teardown (only called on disable) ────────────────────────────────────
  async function hardTeardown() {
    G.hooked.forEach(state => {
      if (!state || typeof state === 'string') return;
      try { state.source?.disconnect(); } catch (_) {}
      state.forks?.forEach(f => { try { f.streamOut.disconnect(); } catch(_){} try { f.streamIn.disconnect(); } catch(_){} });
      state.allCtxs?.forEach(c => { try { c.close(); } catch(_){} });
    });
    G.hooked.clear();
    G.allCtxs = [];
  }

  // ── Patch play() ─────────────────────────────────────────────────────────────
  function patchPlay() {
    if (G.patched) return; G.patched = true;
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (G.config.enabled && !G.hooked.has(this)) {
        const el = this;
        setTimeout(() => routeElement(el).then(() => G.allCtxs.forEach(c => c.resume().catch(()=>{}))), 80);
      }
      return orig.apply(this, arguments);
    };
  }

  // ── DOM observer ──────────────────────────────────────────────────────────────
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
