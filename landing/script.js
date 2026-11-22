(() => {
  "use strict";

  const REPO = "jhonadanil/Riff";

  // ---------- Tema ----------
  const root = document.documentElement;
  const isLight = () =>
    root.dataset.theme ? root.dataset.theme === "light" : matchMedia("(prefers-color-scheme: light)").matches;
  document.getElementById("theme")?.addEventListener("click", () => {
    const next = isLight() ? "dark" : "light";
    root.dataset.theme = next;
    try {
      localStorage.setItem("riff.landing.theme", next);
    } catch {
      // sin almacenamiento: el tema solo dura esta visita
    }
  });

  // ---------- Descarga: enlazar el instalador de la última release ----------
  const links = document.querySelectorAll("[data-download]");
  const versions = document.querySelectorAll("[data-version]");
  fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((rel) => {
      const exe = (rel.assets || []).find((a) => /\.exe$/i.test(a.name)) || (rel.assets || []).find((a) => /\.msi$/i.test(a.name));
      if (exe) links.forEach((a) => (a.href = exe.browser_download_url));
      const v = String(rel.tag_name || "").trim();
      if (v) versions.forEach((el) => (el.textContent = v.startsWith("v") ? v : `v${v}`));
    })
    .catch(() => {
      // Sin release publicada (o sin red): el botón se queda en la página de releases
    });

  // ---------- Maqueta de la interfaz ----------
  const mock = document.getElementById("mock");
  const frame = document.getElementById("frame");
  const stage = document.getElementById("demo");
  if (!mock || !frame || !stage) return;

  const PX = 54; // píxeles por segundo
  const SONG = 16; // segundos
  const BPM = 120;
  const BEAT = 60 / BPM;
  const TRACKS = [
    { name: "Guitarra", color: "#cba6f7", armed: true, chain: ["Overdrive", "Ampli"], clips: [{ s: 0, e: 5, n: "Riff A", d: 0.55, seed: 3 }] },
    { name: "Bajo", color: "#89b4fa", clips: [{ s: 0, e: 14.4, n: "Bajo", d: 0.42, seed: 11 }] },
    { name: "Batería", color: "#a6e3a1", clips: [{ s: 0, e: 16, n: "Batería", d: 0.8, seed: 7, punchy: true }] },
    { name: "Voz", color: "#fab387", clips: [{ s: 6.4, e: 14.4, n: "Voz", d: 0.5, seed: 19 }] },
  ];

  // Generador pseudoaleatorio con semilla: las formas de onda son siempre las mismas
  const rng = (seed) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

  /** Forma de onda como un solo trazo de líneas verticales. */
  function wave(width, height, d, seed, punchy) {
    const r = rng(seed * 977 + 13);
    const mid = height / 2;
    let path = "";
    let env = 0.5;
    for (let x = 1; x < width; x += 2) {
      const hit = punchy ? (Math.floor(x / PX / (BEAT / 2)) !== Math.floor((x - 2) / PX / (BEAT / 2)) ? 1 : 0) : 0;
      env = punchy ? Math.max(0.18, env * 0.88 + hit * 0.9) : Math.min(1, Math.max(0.15, env + (r() - 0.5) * 0.5));
      const a = Math.min(1, env) * d * mid * (0.55 + r() * 0.45);
      path += `M${x} ${(mid - a).toFixed(1)}V${(mid + a).toFixed(1)}`;
    }
    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><path d="${path}" stroke-width="1.4" fill="none"/></svg>`;
  }

  const clipEl = (track, c) => {
    const el = document.createElement("div");
    el.className = "m-clip";
    el.style.cssText = `left:${c.s * PX}px;width:${(c.e - c.s) * PX}px;border-color:${track.color};background:color-mix(in oklch, ${track.color} 18%, transparent)`;
    const w = Math.round((c.e - c.s) * PX);
    el.innerHTML = `<b style="background:color-mix(in oklch, ${track.color} 35%, transparent)">${c.n}</b>${wave(w, 40, c.d, c.seed, c.punchy)}`;
    el.querySelector("path").setAttribute("stroke", track.color);
    return el;
  };

  // Regla
  const ruler = document.getElementById("m-ruler");
  for (let b = 0; b < SONG / (BEAT * 4); b++) {
    const s = document.createElement("span");
    s.style.left = `${b * BEAT * 4 * PX}px`;
    s.textContent = String(b + 1);
    ruler.appendChild(s);
  }
  const loopBand = document.createElement("div");
  loopBand.className = "m-loopband";
  loopBand.style.cssText = `left:${0}px;width:${4 * BEAT * 4 * PX}px`;
  ruler.appendChild(loopBand);

  // Pistas
  const tracksEl = document.getElementById("m-tracks");
  const lanes = [];
  for (const t of TRACKS) {
    const row = document.createElement("div");
    row.className = "m-track";
    row.innerHTML = `<div class="m-head"><i style="background:${t.color}"></i><span class="m-id"><span class="m-name">${t.name}</span>${t.chain ? `<span class="m-chain">${t.chain.map((c) => `<span>${c}</span>`).join("")}</span>` : ""}</span><u>M</u><u>S</u><u class="${t.armed ? "is-armed" : ""}">R</u></div>`;
    const lane = document.createElement("div");
    lane.className = "m-lane";
    for (const c of t.clips) lane.appendChild(clipEl(t, c));
    row.appendChild(lane);
    tracksEl.appendChild(row);
    lanes.push(lane);
  }

  // Mezclador
  const mixer = document.getElementById("m-mixer");
  const meters = [];
  const strip = (name, color, extra = "") => {
    const el = document.createElement("div");
    el.className = `m-strip ${extra}`;
    el.innerHTML = `<div class="m-pan"></div><div class="m-fader"><div class="m-track-bar"><div class="m-thumb" style="top:18%"></div></div><div class="m-meter"><i><b></b></i><i><b></b></i></div></div><span class="m-sname" style="color:${color}">${name}</span>`;
    mixer.appendChild(el);
    return [...el.querySelectorAll(".m-meter b")];
  };
  TRACKS.forEach((t) => meters.push(strip(t.name, t.color)));
  const masterMeters = strip("Master", "var(--foreground)", "m-master");

  // ---------- Escala: la maqueta mide 1040 px lógicos y se ajusta al ancho disponible ----------
  const fit = () => {
    // Nunca más pequeña que 0,62: por debajo el texto no se lee, y en su lugar se desliza con el dedo
    const k = Math.max(0.62, frame.clientWidth / 1040);
    mock.style.zoom = String(k);
  };
  new ResizeObserver(fit).observe(frame);
  fit();

  // ---------- Estado y bucle de animación ----------
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const timeEl = document.getElementById("m-time");
  const playhead = document.getElementById("m-playhead");
  const metroEl = document.getElementById("m-metro");
  const loopEl = document.getElementById("m-loop");
  const state = { playing: false, recording: false, metro: false, loop: false, pos: 0, live: null, takes: 0, lastBeat: -1 };
  const levels = new Array(TRACKS.length).fill(0);
  let last = performance.now();
  let audio = null;

  /** Un clic corto del metrónomo (Web Audio, solo tras un gesto del usuario). */
  const tick = (accent) => {
    try {
      audio ??= new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = "square";
      o.frequency.value = accent ? 1046 : 784;
      g.gain.setValueAtTime(0.05, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.05);
      o.connect(g).connect(audio.destination);
      o.start();
      o.stop(audio.currentTime + 0.06);
    } catch {
      // sin audio: la maqueta sigue siendo visual
    }
  };

  const fmt = (s) => {
    const beat = s / BEAT;
    const bar = Math.floor(beat / 4) + 1;
    const b = Math.floor(beat % 4) + 1;
    return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}  ·  ${bar}.${b}`;
  };

  function render() {
    mock.classList.toggle("is-playing", state.playing);
    mock.classList.toggle("is-recording", state.recording);
    metroEl.classList.toggle("is-on", state.metro);
    loopEl.classList.toggle("is-on", state.loop);
    loopBand.style.opacity = state.loop ? "1" : "0";
    playhead.style.transform = `translateX(${state.pos * PX}px)`;
    timeEl.textContent = fmt(state.pos);
  }

  function frameStep(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (state.playing) {
      state.pos += dt;
      const loopEnd = state.loop ? 4 * BEAT * 4 : SONG;
      if (state.pos >= loopEnd) {
        state.pos = 0;
        if (state.recording && state.live) stopRecording(); // el loop corta la toma
      }
      if (state.metro) {
        const beat = Math.floor(state.pos / BEAT);
        if (beat !== state.lastBeat) {
          state.lastBeat = beat;
          tick(beat % 4 === 0);
        }
      }
      if (state.live) {
        const w = Math.max(2, (state.pos - state.live.s) * PX);
        state.live.el.style.width = `${w}px`;
      }
    }
    // Medidores: suben donde hay un clip bajo el cursor y caen solos
    TRACKS.forEach((t, i) => {
      const active = state.playing && t.clips.some((c) => state.pos >= c.s && state.pos < c.e);
      const target = active ? 0.35 + Math.random() * (t.clips[0].punchy ? 0.55 : 0.3) : 0;
      levels[i] = Math.max(target, levels[i] - dt * 1.4);
      const h = `${Math.round(levels[i] * 100)}%`;
      meters[i].forEach((b, k) => {
        b.style.height = k ? `${Math.round(levels[i] * 92)}%` : h;
        b.style.background = levels[i] > 0.85 ? "var(--rec)" : levels[i] > 0.6 ? "var(--warn)" : "var(--ok)";
      });
    });
    const sum = Math.min(1, levels.reduce((a, b) => a + b, 0) * 0.55);
    masterMeters.forEach((b, k) => {
      b.style.height = `${Math.round(sum * (k ? 90 : 100))}%`;
      b.style.background = sum > 0.85 ? "var(--rec)" : sum > 0.6 ? "var(--warn)" : "var(--ok)";
    });
    render();
    requestAnimationFrame(frameStep);
  }

  // ---------- Acciones ----------
  function play() {
    state.playing = true;
    state.lastBeat = -1;
  }
  function pause() {
    state.playing = false;
    if (state.recording) stopRecording();
  }
  function startRecording() {
    // La toma se graba en la pista armada, justo después del clip que ya tiene
    state.pos = 5.2;
    const el = document.createElement("div");
    el.className = "m-clip is-live";
    el.style.cssText = `left:${state.pos * PX}px;width:2px`;
    el.innerHTML = `<b>Grabando…</b>`;
    lanes[0].appendChild(el);
    state.live = { el, s: state.pos };
    state.recording = true;
    play();
  }
  function stopRecording() {
    const live = state.live;
    state.recording = false;
    state.live = null;
    if (!live) return;
    const end = Math.max(live.s + 0.5, state.pos > live.s ? state.pos : SONG);
    live.el.remove();
    if (end - live.s < 0.6) return;
    state.takes += 1;
    const t = TRACKS[0];
    lanes[0].appendChild(clipEl(t, { s: live.s, e: Math.min(end, SONG), n: `Toma ${state.takes}`, d: 0.6, seed: 30 + state.takes }));
  }
  const toggleRec = () => (state.recording ? (stopRecording(), pause()) : startRecording());
  const togglePlay = () => (state.playing ? pause() : play());

  mock.querySelector('[data-act="play"]').addEventListener("click", togglePlay);
  mock.querySelector('[data-act="rec"]').addEventListener("click", toggleRec);
  mock.querySelector('[data-act="rewind"]').addEventListener("click", () => {
    if (state.recording) stopRecording();
    state.pos = 0;
  });
  // Los botones de la maqueta no son foco de teclado (la maqueta es una ilustración),
  // pero se pueden pulsar con el ratón o el dedo.
  mock.setAttribute("aria-hidden", "true");

  // ---------- Teclado: la maqueta reacciona y las teclas de la sección «Teclado» se hunden ----------
  let demoVisible = false;
  new IntersectionObserver(([e]) => (demoVisible = e.intersectionRatio > 0.45), { threshold: [0, 0.45, 1] }).observe(stage);

  const caps = [...document.querySelectorAll(".cap")];
  const capFor = (e) => {
    const key = e.key === " " ? " " : e.key.toLowerCase();
    return caps.find((c) => c.dataset.key === key && (c.hasAttribute("data-ctrl") ? e.ctrlKey || e.metaKey : !e.ctrlKey && !e.metaKey));
  };

  addEventListener("keydown", (e) => {
    if (e.altKey || e.repeat) return;
    if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select, button, a, [role=button], [contenteditable]")) return;
    const cap = capFor(e);
    cap?.classList.add("is-down");
    const key = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) return;
    if (key === "r") toggleRec();
    else if (key === "m") state.metro = !state.metro;
    else if (key === "l") state.loop = !state.loop;
    else if (e.key === " " && demoVisible) {
      e.preventDefault(); // solo mientras se ve la maqueta: el resto del tiempo Espacio sigue desplazando la página
      togglePlay();
    }
  });
  addEventListener("keyup", (e) => capFor(e)?.classList.remove("is-down"));
  addEventListener("blur", () => caps.forEach((c) => c.classList.remove("is-down")));
  // También se pueden pulsar con el ratón o el dedo
  const press = (c) => {
    const k = c.dataset.key;
    if (k === "r") toggleRec();
    else if (k === " ") togglePlay();
    else if (k === "m") state.metro = !state.metro;
    else if (k === "l") state.loop = !state.loop;
  };
  caps.forEach((c) => {
    c.tabIndex = 0;
    c.setAttribute("role", "button");
    c.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      e.stopPropagation();
      c.classList.add("is-down");
      press(c);
    });
    c.addEventListener("keyup", () => c.classList.remove("is-down"));
    c.addEventListener("pointerdown", () => c.classList.add("is-down"));
    c.addEventListener("pointerup", () => {
      c.classList.remove("is-down");
      press(c);
    });
    c.addEventListener("pointerleave", () => c.classList.remove("is-down"));
  });

  // Arranque: con movimiento permitido, la maqueta empieza sola al verse; si no, queda quieta a mitad de canción
  state.pos = reduce ? 3 : 0;
  render();
  requestAnimationFrame(frameStep);
  if (!reduce) {
    new IntersectionObserver(
      (entries, obs) => {
        if (entries[0].isIntersecting) {
          setTimeout(() => !state.recording && play(), 400);
          obs.disconnect();
        }
      },
      { threshold: 0.6 },
    ).observe(stage);
  }
})();
