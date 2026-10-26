require('dotenv').config({ override: true });
const express = require('express'), multer = require('multer'), OpenAI = require('openai');
const db = require('./db');

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const client = new OpenAI(); // usa OPENAI_API_KEY do .env
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 5 } });

/* ---------- Parser de conversa do WhatsApp ---------- */
function parseWA(text) {
  const re = /^\[?(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::\d{2})?\]?\s*(?:-\s*)?([^:]{1,40}?):\s([\s\S]*)$/;
  const out = [];
  for (const line of (text || '').split('\n')) {
    const r = line.match(re);
    if (r) {
      let y = +r[3]; if (y < 100) y += 2000;
      out.push({ sender: r[6].trim(), sent_at: new Date(y, r[2] - 1, r[1], r[4], r[5]).getTime(), body: r[7].trim() });
    } else if (out.length) out[out.length - 1].body += ' ' + line;
  }
  return out;
}

/* ---------- Métricas reais calculadas do SQLite ---------- */
function computeLocal(id) {
  const m = db.prepare('SELECT sender, sent_at, body FROM messages WHERE analysis_id=? ORDER BY sent_at, id').all(id);
  const names = [...new Set(m.map(x => x.sender))].slice(0, 2);
  if (m.length < 4 || names.length < 2) return null;
  const o = { names, msgs: [0, 0], init: [0, 0], rt: [[], []] };
  m.forEach((x, i) => {
    const k = names.indexOf(x.sender); if (k < 0) return;
    o.msgs[k]++;
    const p = m[i - 1];
    if (!p || x.sent_at - p.sent_at > 6 * 36e5) o.init[k]++;
    if (p && p.sender !== x.sender && x.sent_at - p.sent_at < 24 * 36e5) o.rt[k].push((x.sent_at - p.sent_at) / 6e4);
  });
  const med = a => { if (!a.length) return null; a = [...a].sort((x, y) => x - y); return Math.round(a[a.length >> 1] * 10) / 10; };
  const total = o.init[0] + o.init[1] || 1;
  return { names, msgs: o.msgs, medRt: o.rt.map(med), initPct: o.init.map(v => Math.round(v / total * 100)) };
}

/* ---------- Prompts e IA ---------- */
const SYSTEM = `Você é um analista especializado em dinâmica de relacionamentos (românticos, amizades, família, trabalho), com olhar acolhedor, honesto e não sensacionalista. Responda sempre em português do Brasil. Analise intenção, interesse, presença, reciprocidade, quem inicia conflitos e quem é mais agressivo (tom, ironia, acusações, silêncio punitivo). Não faça diagnósticos clínicos, não demonize ninguém, aponte incertezas. Responda APENAS com JSON válido.`;
const SCHEMA = `{"relatorio":{"nomes":["pessoa A (o usuário, se identificável)","pessoa B"],"tipo":"tipo de relação","resumo":"2-3 frases","opiniao":"3 parágrafos curtos separados por \\n\\n com sua leitura honesta","metricas":{"conflitos_iniciados":[nA,nB],"agressividade":[0-100,0-100],"tempo_resposta_min":[mediaA,mediaB],"interesse":[0-100,0-100],"presenca":[0-100,0-100],"reciprocidade":0-100,"iniciativa_pct":[pctA,pctB]},"intencoes":"leitura das intenções de cada lado","evolucao":[{"rotulo":"fase/data","interesse":[0-100,0-100]}],"sinais_positivos":["..."],"alertas":["..."],"recomendacoes":["..."],"confianca":"baixa|media|alta","estimado":true}}`;

function material(a) {
  let s = `Tipo de relação informada: ${a.relation_type || 'não informado'}\n`;
  if (a.source_text) s += `\nCONVERSA:\n${a.source_text.slice(0, 28000)}\n`;
  if (a.description) s += `\nDESCRIÇÃO DO USUÁRIO:\n${a.description}\n`;
  const imgs = db.prepare('SELECT COUNT(*) n FROM images WHERE analysis_id=?').get(a.id).n;
  if (imgs) s += `\n(Prints anexados: leia as mensagens neles.)\n`;
  const l = computeLocal(a.id);
  if (l) s += `\nMÉTRICAS REAIS CALCULADAS: nomes ${JSON.stringify(l.names)}, mensagens ${l.msgs}, iniciativa ${l.initPct}%, tempo mediano de resposta (min) ${l.medRt}.\n`;
  return s;
}

async function ask(a, extra) {
  const imgs = db.prepare('SELECT mime, data FROM images WHERE analysis_id=?').all(a.id);
  const content = [{ type: 'text', text: material(a) + extra }];
  imgs.forEach(i => content.push({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data.toString('base64')}` } }));
  const res = await client.chat.completions.create({
    model: MODEL,
    response_format: { type: 'json_object' },
    max_tokens: 4000,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }]
  });
  const txt = res.choices[0].message.content || '';
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Resposta da IA sem JSON');
  return JSON.parse(m[0]);
}

function saveReport(id, r) {
  r = r.relatorio || r;
  const l = computeLocal(id);
  if (l) {
    r.nomes = l.names; r.estimado = false; r.local = l;
    r.metricas = { ...(r.metricas || {}), iniciativa_pct: l.initPct };
    if (l.medRt[0] != null && l.medRt[1] != null) r.metricas.tempo_resposta_min = l.medRt;
  }
  db.prepare("UPDATE analyses SET status='concluido', report=? WHERE id=?").run(JSON.stringify(r), id);
  return r;
}

/* ---------- API ---------- */
app.post('/api/analyses', upload.array('files', 5), async (req, res) => {
  try {
    const { ctx = '', txt = '', desc = '' } = req.body;
    if (!txt.trim() && !desc.trim() && !(req.files || []).length)
      return res.status(400).json({ erro: 'Envie uma conversa, prints ou uma descrição.' });
    const id = db.transaction(() => {
      const id = db.prepare('INSERT INTO analyses (relation_type, source_text, description) VALUES (?,?,?)').run(ctx, txt, desc).lastInsertRowid;
      const im = db.prepare('INSERT INTO messages (analysis_id, sender, sent_at, body) VALUES (?,?,?,?)');
      parseWA(txt).forEach(m => im.run(id, m.sender, m.sent_at, m.body));
      const ii = db.prepare('INSERT INTO images (analysis_id, mime, data) VALUES (?,?,?)');
      (req.files || []).forEach(f => ii.run(id, f.mimetype, f.buffer));
      return id;
    })();
    const a = db.prepare('SELECT * FROM analyses WHERE id=?').get(id);
    const r = await ask(a, `\n\nDecida se precisa de mais contexto. Se sim, responda APENAS JSON: {"perguntas":["..."]} com no máximo 4 perguntas curtas e específicas. Se o material já basta, responda APENAS JSON no formato: ${SCHEMA}`);
    if (r.perguntas && r.perguntas.length) {
      db.prepare("UPDATE analyses SET status='aguardando', questions=? WHERE id=?").run(JSON.stringify(r.perguntas), id);
      return res.json({ id, perguntas: r.perguntas });
    }
    res.json({ id, relatorio: saveReport(id, r) });
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Falha na análise: ' + e.message }); }
});

app.post('/api/analyses/:id/finish', async (req, res) => {
  try {
    const id = +req.params.id;
    const a = db.prepare('SELECT * FROM analyses WHERE id=?').get(id);
    if (!a) return res.status(404).json({ erro: 'Análise não encontrada.' });
    const answers = req.body.answers || [];
    db.prepare('UPDATE analyses SET answers=? WHERE id=?').run(JSON.stringify(answers), id);
    const qs = JSON.parse(a.questions || '[]');
    const extra = answers.length
      ? '\n\nRESPOSTAS DO USUÁRIO ÀS SUAS PERGUNTAS:\n' + qs.map((q, i) => `P: ${q}\nR: ${answers[i] || '(não respondeu)'}`).join('\n') : '';
    const r = await ask(a, extra + `\n\nAgora gere o relatório final. Responda APENAS JSON: ${SCHEMA}`);
    res.json({ id, relatorio: saveReport(id, r) });
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Falha ao gerar o relatório: ' + e.message }); }
});

app.get('/api/analyses', (_req, res) => {
  res.json(db.prepare(`SELECT a.id, a.created_at, a.relation_type, a.status,
    (SELECT COUNT(*) FROM messages m WHERE m.analysis_id=a.id) AS mensagens FROM analyses a ORDER BY a.id DESC`).all());
});
app.get('/api/analyses/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM analyses WHERE id=?').get(+req.params.id);
  if (!a) return res.status(404).json({ erro: 'Não encontrada.' });
  res.json({ id: a.id, status: a.status, created_at: a.created_at, perguntas: JSON.parse(a.questions || 'null'), relatorio: JSON.parse(a.report || 'null') });
});
app.delete('/api/analyses/:id', (req, res) => {
  db.prepare('DELETE FROM analyses WHERE id=?').run(+req.params.id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Espelho rodando em http://localhost:${PORT}`));
