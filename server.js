const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GROQ = 'https://api.groq.com/openai/v1';
const KEY = process.env.GROQ_API_KEY;
const STT_MODEL = process.env.STT_MODEL || 'whisper-large-v3-turbo';
const LLM_MODEL = process.env.LLM_MODEL || 'qwen/qwen3.8-27b';

// 'dk' trên giao diện = Danish, mã chuẩn là 'da'
const NAMES = { vi: 'Vietnamese', en: 'English', fr: 'French', zh: 'Chinese', da: 'Danish' };

app.use(express.static(path.join(__dirname, 'public')));

// 1) Âm thanh -> văn bản (Whisper)
app.post('/api/transcribe', express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
  try {
    if (!KEY) return res.status(500).json({ error: 'Thiếu biến môi trường GROQ_API_KEY' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'Không có âm thanh' });

    const mime = (req.headers['content-type'] || 'audio/webm').split(';')[0];
    const ext = mime.includes('mp4') ? 'mp4' : mime.includes('ogg') ? 'ogg' : 'webm';

    const form = new FormData();
    form.append('file', new Blob([req.body], { type: mime }), `speech.${ext}`);
    form.append('model', STT_MODEL);
    form.append('response_format', 'json');
    form.append('temperature', '0');
    // Nếu 2 menu giống nhau thì biết chắc ngôn ngữ -> gợi ý cho Whisper chính xác hơn
    if (req.query.lang && NAMES[req.query.lang]) form.append('language', req.query.lang);

    const r = await fetch(`${GROQ}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}` },
      body: form,
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Lỗi Groq STT' });
    res.json({ text: (data.text || '').trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 2) Văn bản -> dịch hoặc trả lời (LLM)
app.post('/api/respond', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    if (!KEY) return res.status(500).json({ error: 'Thiếu biến môi trường GROQ_API_KEY' });
    const { a, b, text, history = [] } = req.body;
    if (!NAMES[a] || !NAMES[b] || !text) return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });

    let messages;
    if (a === b) {
      // Chế độ chat với AI
      messages = [
        {
          role: 'system',
          content:
            `You are a friendly voice assistant. The user speaks ${NAMES[a]}. ` +
            `Always answer in ${NAMES[a]}, briefly and naturally (1-3 short sentences), ` +
            `as your answer will be read aloud: no markdown, no lists, no emojis. ` +
            `Reply ONLY with JSON: {"source":"${a}","output":"<your answer>"}`,
        },
        ...history.slice(-10),
        { role: 'user', content: text },
      ];
    } else {
      // Chế độ phiên dịch 2 chiều
      messages = [
        {
          role: 'system',
          content:
            `You are a live interpreter between ${NAMES[a]} (code "${a}") and ${NAMES[b]} (code "${b}"). ` +
            `The user message is a speech transcript (may contain recognition errors) in EITHER ${NAMES[a]} OR ${NAMES[b]}. ` +
            `1) Decide which of the two languages it is written in. ` +
            `2) Translate it faithfully and naturally into the OTHER language. Do not answer it, do not explain. ` +
            `If the text is not clearly in either language (noise, silence artifacts), set source to "none" and output to "". ` +
            `Reply ONLY with JSON: {"source":"<${a}|${b}|none>","output":"<translation>"}`,
        },
        { role: 'user', content: text },
      ];
    }

    const r = await fetch(`${GROQ}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages,
        temperature: a === b ? 0.6 : 0.1,
        max_tokens: 500,
        response_format: { type: 'json_object' },
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Lỗi Groq LLM' });

    let parsed;
    try {
      parsed = JSON.parse(data.choices[0].message.content);
    } catch {
      return res.status(502).json({ error: 'AI trả về dữ liệu không đúng định dạng' });
    }
    const source = parsed.source;
    const output = (parsed.output || '').trim();
    const target = a === b ? a : source === a ? b : source === b ? a : null;
    res.json({ source, target, output });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Server chạy tại http://localhost:${PORT}`));
