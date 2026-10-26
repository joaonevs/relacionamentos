# Espelho — Análise de Relacionamentos

App web (Node.js + SQLite + OpenAI) que analisa conversas e situações de relacionamento:
intenções, interesse, presença, reciprocidade, quem inicia conflitos, agressividade, tempo de resposta e mais.

## Entradas
- Conversa colada/exportada do WhatsApp (as mensagens são salvas no SQLite e geram métricas reais)
- Prints (imagens lidas pela IA)
- Descrição livre da situação
- A IA pode fazer perguntas de contexto antes do relatório final

## Rodar
1. Instale Node.js 18+ (https://nodejs.org)
2. `npm install`
3. Copie `env.exemplo.txt` (ou `.env.example`, arquivo oculto) para um novo arquivo chamado `.env` e coloque sua `OPENAI_API_KEY`
4. `npm start` e abra http://localhost:3000

## Banco de dados (SQLite)
Arquivo: `data/relacionamentos.db` (criado automaticamente). Tabelas:
- `analyses` — cada análise (tipo, texto, descrição, perguntas, respostas, relatório JSON)
- `messages` — mensagens da conversa (remetente, data/hora, texto)
- `images` — prints enviados (BLOB)

Inspecione com `sqlite3 data/relacionamentos.db` ou DB Browser for SQLite.
Os dados ficam só na sua máquina (exceto o conteúdo enviado à API da OpenAI para análise).
Para apagar uma análise, use o botão "Excluir" no histórico.

## Observações
Leitura automatizada e probabilística, não é diagnóstico. Em casos de violência, procure apoio profissional (Brasil: Ligue 180).
