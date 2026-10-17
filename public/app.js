'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const LEVELS = [
    { key: 'life', label: 'Life goals', hint: 'Who do you want to become? What matters most?' },
    { key: 'yearly', label: 'Yearly goals', hint: 'What will make this year a success?' },
    { key: 'monthly', label: 'Monthly goals', hint: 'Milestones for this month toward your yearly goals.' },
    { key: 'weekly', label: 'Weekly goals', hint: 'What will you focus on this week?' },
  ];

  const state = {
    conversation: null,
    busy: false,
    recorder: null,
    audio: null,
    aiConfigured: true,
  };

  // ---- Helpers -----------------------------------------------------------
  /** Creates a DOM element. Children may be strings (inserted as text) or nodes. */
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function svg(tag, attrs = {}, ...children) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    for (const child of children.flat()) {
      if (child === null || child === undefined) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function today() {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  const fmtDate = (date) =>
    new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const pct = (v) => (v === null || v === undefined ? '–' : `${Math.round(v * 100)}%`);

  function notify(message, isError = false) {
    const box = $('#notice');
    box.textContent = message;
    box.classList.toggle('error', isError);
    box.classList.toggle('hidden', !message);
  }

  async function api(path, options = {}) {
    const init = { ...options };
    if (init.json !== undefined) {
      init.body = JSON.stringify(init.json);
      init.headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
      delete init.json;
    }
    const res = await fetch(path, init);
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try {
        message = (await res.json()).error || message;
      } catch {
        /* ignore */
      }
      throw new Error(message);
    }
    if (res.status === 204) return null;
    const type = res.headers.get('content-type') || '';
    return type.includes('application/json') ? res.json() : res.blob();
  }

  function setBusy(busy, status = '') {
    state.busy = busy;
    $('#status').textContent = status;
    for (const id of ['#send', '#mic', '#end', '#start-morning', '#start-evening']) $(id).disabled = busy;
  }

  // ---- Tabs ----------------------------------------------------------------
  function showTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${name}`));
    if (name === 'history') loadHistory();
    if (name === 'progress') loadProgress();
    if (name === 'goals') loadGoals();
    if (name === 'today') loadToday();
  }
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

  // ---- Goal review banner ----------------------------------------------------
  function renderReviewBanner(review) {
    const banner = $('#review-banner');
    banner.replaceChildren();
    if (!review || !review.length) {
      banner.classList.add('hidden');
      return;
    }
    const first = review[0];
    const label = LEVELS.find((l) => l.key === first.level).label.toLowerCase();
    const text =
      first.reason === 'missing'
        ? `🎯 You haven't defined your ${label} yet. Bigger goals help your daily goals matter more. `
        : `🔄 It's been ${first.ageDays} days since you reviewed your ${label}. Do they still fit? `;
    banner.append(text, el('button', { class: 'link', onclick: () => showTab('goals') }, 'Review goals'));
    banner.classList.remove('hidden');
  }

  // ---- Today ---------------------------------------------------------------
  async function loadToday() {
    const date = today();
    $('#today-title').textContent = fmtDate(date);
    const hour = new Date().getHours();
    $('#today-subtitle').textContent =
      hour < 15
        ? 'Good morning! Start your day by talking through what you want to accomplish.'
        : 'Evening is a great time to reflect on what you did and what got in the way.';

    try {
      const [conversations, goalsRes] = await Promise.all([api('/api/conversations'), api('/api/goals')]);
      renderReviewBanner(goalsRes.review);
      const todays = conversations.filter((c) => c.date === date && c.endedAt);
      const morning = todays.find((c) => c.type === 'morning');
      const evening = todays.find((c) => c.type === 'evening');
      const box = $('#today-goals');
      box.replaceChildren();
      if (morning) {
        const outcomes = new Map(((evening && evening.outcomes) || []).map((o) => [o.goal, o.status]));
        box.append(
          el('h3', {}, "Today's goals"),
          el(
            'ul',
            { class: 'clean' },
            morning.goals.map((g) => el('li', {}, outcomes.has(g) ? el('span', { class: `badge ${outcomes.get(g)}` }, outcomes.get(g)) : '🎯 ', g))
          )
        );
      }
      if (evening) {
        box.append(el('p', { class: 'muted' }, `✅ Evening check-in completed at ${fmtTime(evening.endedAt)}.`));
      }
    } catch (err) {
      notify(err.message, true);
    }
  }

  function renderTranscript() {
    const box = $('#transcript');
    box.replaceChildren(
      ...state.conversation.messages.map((m) => el('div', { class: `msg ${m.role}` }, m.content, el('span', { class: 'time' }, fmtTime(m.at))))
    );
    box.scrollTop = box.scrollHeight;
  }

  async function startConversation(type) {
    notify('');
    $('#summary').classList.add('hidden');
    setBusy(true, 'Starting your check-in…');
    try {
      state.conversation = await api('/api/conversations', { method: 'POST', json: { type, date: today() } });
      $('#conversation-title').textContent = type === 'morning' ? '☀️ Morning check-in' : '🌙 Evening check-in';
      $('#conversation').classList.remove('hidden');
      renderTranscript();
      setBusy(false);
      const last = state.conversation.messages[state.conversation.messages.length - 1];
      if (last) speak(last.content);
      $('#message').focus();
    } catch (err) {
      setBusy(false);
      notify(err.message, true);
    }
  }

  async function sendMessage(text) {
    text = (text || '').trim();
    if (!text || !state.conversation || state.busy) return;
    stopSpeaking();
    $('#message').value = '';
    state.conversation.messages.push({ role: 'user', content: text, at: new Date().toISOString() });
    renderTranscript();
    setBusy(true, 'Thinking…');
    try {
      const { reply, conversation } = await api(`/api/conversations/${state.conversation.id}/messages`, { method: 'POST', json: { text } });
      state.conversation = conversation;
      renderTranscript();
      setBusy(false);
      speak(reply);
    } catch (err) {
      setBusy(false);
      notify(err.message, true);
    }
  }

  async function endConversation() {
    if (!state.conversation || state.busy) return;
    stopSpeaking();
    setBusy(true, 'Summarizing your conversation…');
    try {
      const conversation = await api(`/api/conversations/${state.conversation.id}/end`, { method: 'POST' });
      state.conversation = null;
      $('#conversation').classList.add('hidden');
      const summary = $('#summary');
      summary.replaceChildren(el('h2', {}, '📝 Summary'), renderConversationDetails(conversation, false));
      summary.classList.remove('hidden');
      setBusy(false);
      loadToday();
    } catch (err) {
      setBusy(false);
      notify(err.message, true);
    }
  }

  $('#start-morning').addEventListener('click', () => startConversation('morning'));
  $('#start-evening').addEventListener('click', () => startConversation('evening'));
  $('#send').addEventListener('click', () => sendMessage($('#message').value));
  $('#message').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage($('#message').value);
  });
  $('#end').addEventListener('click', endConversation);

  // ---- Voice: speech-to-text (OpenAI Whisper) -------------------------------
  async function toggleRecording() {
    if (state.recorder) {
      state.recorder.stop();
      return;
    }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      notify('Audio recording is not supported in this browser – please type instead.', true);
      return;
    }
    stopSpeaking();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks = [];
      recorder.addEventListener('dataavailable', (e) => e.data.size && chunks.push(e.data));
      recorder.addEventListener('stop', async () => {
        stream.getTracks().forEach((t) => t.stop());
        state.recorder = null;
        $('#mic').classList.remove('recording');
        const blob = new Blob(chunks, { type: (recorder.mimeType || 'audio/webm').split(';')[0] });
        if (!blob.size) return;
        setBusy(true, 'Transcribing…');
        try {
          const { text } = await api('/api/transcribe', { method: 'POST', body: blob, headers: { 'Content-Type': blob.type } });
          setBusy(false);
          if (text) await sendMessage(text);
          else notify("Sorry, I couldn't hear anything. Try again?");
        } catch (err) {
          setBusy(false);
          notify(err.message, true);
        }
      });
      recorder.start();
      state.recorder = recorder;
      $('#mic').classList.add('recording');
      $('#status').textContent = 'Listening… press 🎤 again when you are done.';
    } catch (err) {
      notify(`Microphone unavailable: ${err.message}`, true);
    }
  }
  $('#mic').addEventListener('click', toggleRecording);

  // ---- Voice: text-to-speech (OpenAI TTS, browser fallback) ------------------
  function stopSpeaking() {
    if (state.audio) {
      state.audio.pause();
      URL.revokeObjectURL(state.audio.src);
      state.audio = null;
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

  async function speak(text) {
    if (!$('#voice-replies').checked || !text) return;
    stopSpeaking();
    try {
      const blob = await api('/api/speech', { method: 'POST', json: { text } });
      const audio = new Audio(URL.createObjectURL(blob));
      state.audio = audio;
      await audio.play();
    } catch {
      if (window.speechSynthesis) window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    }
  }

  // ---- History -------------------------------------------------------------
  function renderConversationDetails(c, withTranscript = true) {
    const parts = [];
    if (c.summary) parts.push(el('p', {}, c.summary));
    if (c.goals && c.goals.length) {
      parts.push(el('h3', {}, '🎯 Goals for the day'), el('ul', { class: 'clean' }, c.goals.map((g) => el('li', {}, `• ${g}`))));
    }
    if (c.outcomes && c.outcomes.length) {
      parts.push(
        el('h3', {}, '📋 How the goals went'),
        el('ul', { class: 'clean' }, c.outcomes.map((o) => el('li', {}, el('span', { class: `badge ${o.status}` }, o.status), o.goal)))
      );
    }
    if (c.wins && c.wins.length) parts.push(el('h3', {}, '🏆 Wins'), el('ul', { class: 'clean' }, c.wins.map((w) => el('li', {}, `• ${w}`))));
    if (c.struggles && c.struggles.length) {
      parts.push(el('h3', {}, '🧗 Struggles'), el('ul', { class: 'clean' }, c.struggles.map((s) => el('li', {}, `• ${s}`))));
    }
    if (c.goalUpdates && Object.keys(c.goalUpdates).length) {
      parts.push(el('p', { class: 'muted' }, `🔄 Updated goals: ${Object.keys(c.goalUpdates).join(', ')}`));
    }
    if (withTranscript && c.messages.length) {
      parts.push(
        el(
          'details',
          {},
          el('summary', {}, `Full transcript (${c.messages.length} messages)`),
          el(
            'div',
            { class: 'transcript' },
            c.messages.map((m) => el('div', { class: `msg ${m.role}` }, m.content, el('span', { class: 'time' }, fmtTime(m.at))))
          )
        )
      );
    }
    return el('div', {}, parts);
  }

  async function loadHistory() {
    const list = $('#history-list');
    try {
      const conversations = (await api('/api/conversations')).filter((c) => c.endedAt);
      list.replaceChildren();
      if (!conversations.length) {
        list.append(el('div', { class: 'card muted' }, 'No conversations yet. Start a morning check-in on the Today tab!'));
        return;
      }
      const byDate = new Map();
      for (const c of conversations) {
        if (!byDate.has(c.date)) byDate.set(c.date, []);
        byDate.get(c.date).push(c);
      }
      for (const [date, items] of [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
        items.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
        list.append(
          el(
            'div',
            { class: 'day-group' },
            el('h3', {}, fmtDate(date)),
            items.map((c) => {
              const minutes = Math.max(1, Math.round((new Date(c.endedAt) - new Date(c.startedAt)) / 60000));
              return el(
                'div',
                { class: 'card' },
                el(
                  'div',
                  { class: 'row space' },
                  el(
                    'div',
                    {},
                    el('span', { class: `badge ${c.type}` }, c.type === 'morning' ? '☀️ Morning' : '🌙 Evening'),
                    el('span', { class: 'muted' }, `${fmtTime(c.startedAt)} – ${fmtTime(c.endedAt)} (${minutes} min)`)
                  ),
                  el(
                    'button',
                    {
                      class: 'danger',
                      title: 'Delete conversation',
                      onclick: async () => {
                        if (!confirm('Delete this conversation?')) return;
                        await api(`/api/conversations/${c.id}`, { method: 'DELETE' }).catch((err) => notify(err.message, true));
                        loadHistory();
                      },
                    },
                    '🗑'
                  )
                ),
                renderConversationDetails(c)
              );
            })
          )
        );
      }
    } catch (err) {
      notify(err.message, true);
    }
  }

  // ---- Progress ------------------------------------------------------------
  function motivationalMessage(stats) {
    if (!stats.totals.morning && !stats.totals.evening) return '👋 Welcome! Your first check-in is the first step of the journey.';
    if (stats.trend !== null && stats.trend > 0.05) return `📈 You're trending up – ${pct(stats.trend)} better than last week. Keep the momentum going!`;
    if (stats.currentStreak >= 7) return `🔥 ${stats.currentStreak} days in a row! Consistency is how big goals get done.`;
    if (stats.last7Completion !== null && stats.last7Completion >= 0.75) return '🌟 You are completing most of what you set out to do. Maybe it is time to stretch a bit further?';
    if (stats.last7Completion !== null && stats.last7Completion < 0.4) {
      return '🌱 Tough stretch? Try setting fewer, smaller goals tomorrow – small wins build momentum.';
    }
    if (stats.currentStreak > 0) return `💪 ${stats.currentStreak}-day check-in streak. Show up again tomorrow to grow it!`;
    return '🧭 Every day is a fresh start. Check in this morning to set your intentions.';
  }

  function renderChart(daily) {
    const width = 640;
    const height = 220;
    const pad = { top: 14, right: 10, bottom: 34, left: 36 };
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const slot = innerW / daily.length;
    const barW = Math.min(30, slot * 0.6);
    const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Daily goal completion chart' });

    for (const p of [0, 0.5, 1]) {
      const y = pad.top + innerH * (1 - p);
      root.append(
        svg('line', { x1: pad.left, x2: width - pad.right, y1: y, y2: y, stroke: '#e3e5ef' }),
        svg('text', { x: pad.left - 6, y: y + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#6b7088' }, `${p * 100}%`)
      );
    }

    daily.forEach((d, i) => {
      const x = pad.left + slot * i + (slot - barW) / 2;
      const total = d.done + d.partial + d.missed;
      let y = pad.top + innerH;
      if (total) {
        for (const [key, color] of [['done', '#2fb67c'], ['partial', '#f2c14e'], ['missed', '#e5616b']]) {
          const h = (d[key] / total) * innerH;
          if (!h) continue;
          y -= h;
          root.append(svg('rect', { x, y, width: barW, height: h, fill: color, rx: 2 }, svg('title', {}, `${d.date}: ${d[key]} ${key}`)));
        }
      } else if (d.morning) {
        root.append(svg('rect', { x, y: y - 4, width: barW, height: 4, fill: '#c9cdf2' }, svg('title', {}, `${d.date}: ${d.goalsSet} goals set`)));
      }
      const label = new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
      root.append(svg('text', { x: x + barW / 2, y: height - 14, 'text-anchor': 'middle', 'font-size': 10, fill: '#6b7088' }, label));
      if (d.morning || d.evening) {
        root.append(svg('text', { x: x + barW / 2, y: height - 2, 'text-anchor': 'middle', 'font-size': 9 }, `${d.morning ? '☀' : ''}${d.evening ? '☾' : ''}`));
      }
    });
    $('#completion-chart').replaceChildren(root);
  }

  function renderInsights(insights) {
    const box = $('#insights');
    box.replaceChildren();
    if (!insights) {
      box.append(el('p', { class: 'muted' }, 'Ask your coach for personalised suggestions on setting and accomplishing your goals.'));
      return;
    }
    box.append(insights.text, el('p', { class: 'muted' }, `Generated ${new Date(insights.generatedAt).toLocaleString()}`));
  }

  async function loadProgress() {
    try {
      const [stats, insights] = await Promise.all([api(`/api/stats?today=${today()}`), api('/api/insights')]);
      renderReviewBanner(stats.review);
      $('#motivation').textContent = motivationalMessage(stats);
      const trend = stats.trend === null ? '–' : `${stats.trend >= 0 ? '▲' : '▼'} ${pct(Math.abs(stats.trend))}`;
      const tiles = [
        ['🔥', stats.currentStreak, 'day check-in streak'],
        ['🏅', stats.longestStreak, 'longest streak'],
        ['📅', pct(stats.last7Completion), 'goals completed (7 days)'],
        ['📊', pct(stats.overallCompletion), 'goals completed (all time)'],
        ['📈', trend, 'vs. previous week'],
        ['✅', `${stats.totals.done}/${stats.totals.goalsSet}`, 'goals done / set'],
      ];
      $('#stat-tiles').replaceChildren(
        ...tiles.map(([icon, value, label]) => el('div', { class: 'tile' }, el('div', { class: 'value' }, `${icon} ${value}`), el('div', { class: 'label' }, label)))
      );
      renderChart(stats.daily);
      const struggles = $('#struggles');
      struggles.replaceChildren();
      if (!stats.topStruggles.length) {
        struggles.append(el('p', { class: 'muted' }, 'No struggles recorded yet – evening check-ins will surface patterns here.'));
      } else {
        const max = stats.topStruggles[0].count;
        for (const s of stats.topStruggles) {
          struggles.append(
            el(
              'div',
              { class: 'bar-row' },
              el('span', { class: 'name' }, s.text),
              el('span', { class: 'bar', style: `width:${Math.round((s.count / max) * 50)}%` }),
              el('span', { class: 'muted' }, `${s.count}×`)
            )
          );
        }
      }
      renderInsights(insights);
    } catch (err) {
      notify(err.message, true);
    }
  }

  $('#refresh-insights').addEventListener('click', async () => {
    const button = $('#refresh-insights');
    button.disabled = true;
    button.textContent = 'Thinking…';
    try {
      renderInsights(await api('/api/insights', { method: 'POST', json: { today: today() } }));
    } catch (err) {
      notify(err.message, true);
    } finally {
      button.disabled = false;
      button.textContent = '✨ Get fresh suggestions';
    }
  });

  // ---- Goals ---------------------------------------------------------------
  async function loadGoals() {
    try {
      const { goals, review } = await api('/api/goals');
      renderReviewBanner(review);
      const needsReview = new Set(review.map((r) => r.level));
      const form = $('#goals-form');
      form.replaceChildren(
        ...LEVELS.map(({ key, label, hint }) => {
          const g = goals[key];
          return el(
            'div',
            {},
            el('label', { for: `goal-${key}` }, label, el('span', { class: 'hint' }, g.updatedAt ? `last updated ${new Date(g.updatedAt).toLocaleDateString()}` : 'not set yet')),
            el('textarea', { id: `goal-${key}`, name: key, placeholder: hint, class: needsReview.has(key) ? 'stale' : undefined }, g.text)
          );
        }),
        el('div', { class: 'row' }, el('button', { type: 'submit', class: 'primary' }, 'Save goals'))
      );
    } catch (err) {
      notify(err.message, true);
    }
  }

  $('#goals-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {};
    for (const { key } of LEVELS) body[key] = $(`#goal-${key}`).value;
    try {
      await api('/api/goals', { method: 'PUT', json: body });
      notify('Goals saved. Your coach will use them to guide your daily check-ins.');
      loadGoals();
    } catch (err) {
      notify(err.message, true);
    }
  });

  // ---- Init ----------------------------------------------------------------
  api('/api/status')
    .then(({ aiConfigured }) => {
      state.aiConfigured = aiConfigured;
      if (!aiConfigured) notify('OPENAI_API_KEY is not configured on the server. Add it to your .env file to enable conversations.', true);
    })
    .catch(() => {});
  loadToday();
})();
