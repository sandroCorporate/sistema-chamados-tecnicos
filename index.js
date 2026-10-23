import dotenv from 'dotenv';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import db from './db.js';
import { MercadoPagoConfig, Payment } from 'mercadopago';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'chave_secreta_super_segura';

// URL do microserviço de WhatsApp dedicado (bridge local)
const WHATSAPP_SERVICE_URL = process.env.WHATSAPP_SERVICE_URL || 'http://localhost:3001';

// Token real do Mercado Pago integrado
const MP_TOKEN_REAL = 'APP_USR-5595843191696827-101213-f5e5271648f3f70353dbc57f81016599-332217735';

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN || MP_TOKEN_REAL,
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static('public'));

// ==========================================
// FUNÇÃO AUXILIAR: Envio via Microserviço WhatsApp
// ==========================================
async function enviarNotificacaoWhatsApp(telefone, mensagem) {
  if (!telefone || telefone.trim() === '') {
    console.log('[WhatsApp Skipped] Telefone não configurado.');
    return;
  }

  let numApenasDigitos = telefone.replace(/\D/g, '');
  if (numApenasDigitos.length === 10 || numApenasDigitos.length === 11) {
    numApenasDigitos = '55' + numApenasDigitos;
  }

  const jid = `${numApenasDigitos}@s.whatsapp.net`;

  try {
    const response = await fetch(`${WHATSAPP_SERVICE_URL}/enviar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid, mensagem })
    });
    
    if (!response.ok) {
      throw new Error(`Erro HTTP: ${response.status}`);
    }
    
    console.log(`[WhatsApp Sent] Requisição de envio encaminhada para o microserviço (${numApenasDigitos}).`);
  } catch (error) {
    console.error('[WhatsApp Error] Falha ao comunicar com o microserviço:', error.message);
  }
}

// ==========================================
// MIDDLEWARE: Autenticação JWT (Blindado contra HTML)
// ==========================================
function autenticarToken(req, res, next) {
  console.log(`[DEBUG REQ] ${req.method} ${req.originalUrl}`);
  
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1];

  // Salvaguarda extra: se não vier no header, tenta apanhar nos query params ou cookies se aplicável
  if (!token && req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Acesso negado. Token não fornecido.' });
  }

  try {
    const usuario = jwt.verify(token, JWT_SECRET);
    req.usuario = usuario;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Token inválido ou expirado.' });
  }
}

// ==========================================
// ROTAS DO SISTEMA
// ==========================================
app.get('/', (req, res) => {
  res.sendFile(process.cwd() + '/index.html');
});

app.post('/api/registro', async (req, res) => {
  const { nome, email, telefone, documento, senha } = req.body;

  if (!nome || !email || !telefone || !documento || !senha) {
    return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
  }

  let telLimpo = telefone.replace(/\D/g, '');
  if (telLimpo.length < 10) {
    return res.status(400).json({ error: 'Informe um número de WhatsApp válido com DDD.' });
  }

  try {
    const hashSenha = await bcrypt.hash(senha, 10);
    const query = `
      INSERT INTO usuarios (nome, email, telefone, documento, senha, senha_hash, tipo)
      VALUES ($1, $2, $3, $4, $5, $5, 'CLIENTE')
      RETURNING id, nome, email, telefone, tipo;
    `;
    const result = await db.query(query, [nome, email, telLimpo, documento, hashSenha]);
    return res.status(201).json({ message: 'Cliente cadastrado com sucesso!', usuario: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'E-mail ou CPF/CNPJ já cadastrado.' });
    }
    res.status(500).json({ error: 'Erro interno ao registrar: ' + error.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const { rows } = await db.query('SELECT * FROM usuarios WHERE email = $1', [email]);
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const usuario = rows[0];
    const hashGravado = usuario.senha || usuario.senha_hash;
    const senhaValida = await bcrypt.compare(senha, hashGravado);
    if (!senhaValida) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const tipo = usuario.tipo || usuario.perfil || 'CLIENTE';
    const payload = { id: usuario.id, email: usuario.email, tipo };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });

    res.json({
      token,
      usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email, tipo, telefone: usuario.telefone },
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao realizar login.' });
  }
});

// ==========================================
// ROTA: Trocar Senha (Restrita a Técnicos)
// ==========================================
app.post('/api/usuarios/:id/trocar-senha', autenticarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { novaSenha } = req.body;

    const tipoUsuario = String(req.usuario?.tipo || '').toUpperCase();

    if (tipoUsuario === 'CLIENTE') {
      return res.status(403).json({ error: 'Acesso negado. Apenas técnicos podem alterar senhas.' });
    }

    if (!novaSenha || novaSenha.trim() === '') {
      return res.status(400).json({ error: 'A nova senha deve ser informada.' });
    }

    const userCheck = await db.query('SELECT * FROM usuarios WHERE id = $1', [id]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Utilizador não encontrado.' });
    }

    const novoHash = await bcrypt.hash(novaSenha, 10);

    await db.query(
      'UPDATE usuarios SET senha = $1, senha_hash = $1 WHERE id = $2',
      [novoHash, id]
    );

    return res.json({ mensagem: 'Senha alterada com sucesso pelo técnico!' });
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao alterar senha: ' + error.message });
  }
});

app.get('/api/chamados', autenticarToken, async (req, res) => {
  try {
    const tipoUsuario = String(req.usuario.tipo || '').toUpperCase();
    if (tipoUsuario !== 'CLIENTE') {
      const { rows } = await db.query('SELECT * FROM chamados ORDER BY criado_em DESC');
      return res.json(rows);
    }

    let rows;
    try {
      const resQuery = await db.query('SELECT * FROM chamados WHERE usuario_id = $1 ORDER BY criado_em DESC', [req.usuario.id]);
      rows = resQuery.rows;
    } catch (err1) {
      try {
        const resQuery = await db.query('SELECT * FROM chamados WHERE cliente_id = $1 ORDER BY criado_em DESC', [req.usuario.id]);
        rows = resQuery.rows;
      } catch (err2) {
        const resQuery = await db.query('SELECT * FROM chamados WHERE usuarioid = $1 ORDER BY criado_em DESC', [req.usuario.id]);
        rows = resQuery.rows;
      }
    }
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar chamados.' });
  }
});

app.post('/api/chamados', autenticarToken, async (req, res) => {
  try {
    const { titulo, descricao, etiqueta_foto } = req.body;
    if (!titulo || !descricao) {
      return res.status(400).json({ error: 'Título e descrição são obrigatórios.' });
    }

    try { await db.query('ALTER TABLE chamados ADD COLUMN IF NOT EXISTS etiqueta_foto TEXT;'); } catch (e) {}

    let result;
    try {
      result = await db.query(
        'INSERT INTO chamados (titulo, descricao, usuario_id, status, etiqueta_foto) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [titulo, descricao, req.usuario.id, 'ABERTO', etiqueta_foto || null]
      );
    } catch (err1) {
      result = await db.query(
        'INSERT INTO chamados (titulo, descricao, cliente_id, status, etiqueta_foto) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [titulo, descricao, req.usuario.id, 'ABERTO', etiqueta_foto || null]
      );
    }

    const chamadoId = result.rows[0].id;
    const userRes = await db.query('SELECT nome, telefone FROM usuarios WHERE id = $1', [req.usuario.id]);
    const cliente = userRes.rows[0];

    if (cliente && cliente.telefone) {
      const msgAbertura = `🖥️ *LL TECH INFO - SUPORTE TÉCNICO*
----------------------------------------
Olá, *${cliente.nome}*!
O seu chamado foi registrado com sucesso.
📌 *Chamado:* #${String(chamadoId).substring(0, 8)}
📝 *Assunto:* ${titulo}
🟢 *Status:* ABERTO`;
      enviarNotificacaoWhatsApp(cliente.telefone, msgAbertura);
    }

    res.status(201).json({ mensagem: 'Chamado aberto com sucesso!', chamado: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao abrir chamado.' });
  }
});

app.post('/api/chamados/:id/pagar-pix', autenticarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { valor } = req.body;

    const chamadoRes = await db.query('SELECT * FROM chamados WHERE id = $1', [id]);
    if (chamadoRes.rows.length === 0) return res.status(404).json({ error: 'Chamado não encontrado.' });
    const chamado = chamadoRes.rows[0];

    const userRes = await db.query('SELECT nome, email, telefone, documento FROM usuarios WHERE id = $1', [req.usuario.id]);
    const cliente = userRes.rows[0] || {};

    let docLimpo = cliente.documento ? cliente.documento.replace(/\D/g, '') : '00000000000';
    if (docLimpo.length !== 11 && docLimpo.length !== 14) docLimpo = '12345678909';
    const tipoDoc = docLimpo.length === 14 ? 'CNPJ' : 'CPF';

    const payment = new Payment(mpClient);
    const body = {
      transaction_amount: Number(valor),
      description: `LL TECH INFO - Chamado #${String(chamado.id).substring(0, 8)}`,
      payment_method_id: 'pix',
      payer: {
        email: cliente.email || 'suporte@lltech.info',
        first_name: cliente.nome ? cliente.nome.split(' ')[0] : 'Cliente',
        last_name: cliente.nome ? cliente.nome.split(' ').slice(1).join(' ') || 'LL Tech' : 'LL Tech',
        identification: { type: tipoDoc, number: docLimpo }
      },
    };

    const response = await payment.create({ body });
    const qrCode = response?.point_of_interaction?.transaction_data?.qr_code;
    const qrCodeBase64 = response?.point_of_interaction?.transaction_data?.qr_code_base64;
    const pagamentoId = response?.id;

    await db.query(
      'UPDATE chamados SET status = $1, valor = $2, pagamento_id = $3 WHERE id = $4',
      ['AGUARDANDO PAGAMENTO', valor, String(pagamentoId), id]
    );

    if (cliente && cliente.telefone) {
      const msgPix = `🖥️ *LL TECH INFO - COBRANÇA PIX*
----------------------------------------
Cobrança gerada para o Chamado *#${String(chamado.id).substring(0, 8)}*.
💰 *Valor:* R$ ${Number(valor).toFixed(2)}
📌 *Pix Copia e Cola:*
${qrCode}`;
      enviarNotificacaoWhatsApp(cliente.telefone, msgPix);
    }

    return res.json({ mensagem: 'Cobrança Pix gerada!', pagamentoId, qrCode, qrCodeBase64 });
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao gerar Pix: ' + error.message });
  }
});

app.post('/api/webhook/mercadopago', async (req, res) => {
  try {
    const { action, type, data } = req.body;
    const paymentId = data?.id || req.query['data.id'] || req.query.id;

    if (paymentId && (type === 'payment' || action?.includes('payment'))) {
      const payment = new Payment(mpClient);
      const paymentInfo = await payment.get({ id: paymentId });

      if (paymentInfo && paymentInfo.status === 'approved') {
        const updateRes = await db.query(
          "UPDATE chamados SET status = 'EM ATENDIMENTO' WHERE pagamento_id = $1 RETURNING *",
          [String(paymentId)]
        );

        if (updateRes.rows.length > 0) {
          const ch = updateRes.rows[0];
          const userId = ch.usuario_id || ch.cliente_id || ch.usuarioid;
          const userRes = await db.query('SELECT nome, telefone FROM usuarios WHERE id = $1', [userId]);
          const cliente = userRes.rows[0];

          if (cliente && cliente.telefone) {
            enviarNotificacaoWhatsApp(cliente.telefone, `🖥️ *LL TECH INFO - PAGAMENTO APROVADO*
O pagamento do chamado *#${String(ch.id).substring(0, 8)}* foi confirmado! Status: EM ATENDIMENTO.`);
          }
        }
      }
    }
    return res.status(200).send('OK');
  } catch (error) {
    return res.status(200).send('OK');
  }
});

app.get('/api/chamados/:id/verificar-pagamento', autenticarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const chamadoRes = await db.query('SELECT * FROM chamados WHERE id = $1', [id]);
    if (chamadoRes.rows.length === 0) return res.status(404).json({ error: 'Chamado não encontrado.' });
    const chamado = chamadoRes.rows[0];

    if (chamado.pagamento_id && chamado.status === 'AGUARDANDO PAGAMENTO') {
      const payment = new Payment(mpClient);
      const paymentInfo = await payment.get({ id: chamado.pagamento_id });
      if (paymentInfo && paymentInfo.status === 'approved') {
        await db.query("UPDATE chamados SET status = 'EM ATENDIMENTO' WHERE id = $1", [id]);
        return res.json({ status: 'EM ATENDIMENTO', pago: true });
      }
    }
    return res.json({ status: chamado.status, pago: chamado.status !== 'AGUARDANDO PAGAMENTO' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ==========================================
// FUNÇÃO CENTRALIZADA: Lógica de Atualização de Chamados
// ==========================================
async function processarAtualizacaoChamado(req, res) {
  try {
    const { id } = req.params;
    const { status, valor, titulo, descricao } = req.body;
    
    const tipoUsuario = String(req.usuario?.tipo || '').toUpperCase();

    const chamadoAtualRes = await db.query('SELECT * FROM chamados WHERE id = $1', [id]);
    if (chamadoAtualRes.rows.length === 0) {
      return res.status(404).json({ error: 'Chamado não encontrado.' });
    }
    const chamadoAtual = chamadoAtualRes.rows[0];

    if (tipoUsuario === 'CLIENTE') {
      const donoId = chamadoAtual.usuario_id || chamadoAtual.cliente_id || chamadoAtual.usuarioid;
      if (donoId !== req.usuario.id) {
        return res.status(403).json({ error: 'Acesso negado.' });
      }
      
      if (String(chamadoAtual.status).toUpperCase() !== 'ABERTO') {
        return res.status(400).json({ error: 'Este chamado já não está aberto e não pode ser editado.' });
      }

      if (status !== undefined || valor !== undefined) {
        return res.status(403).json({ error: 'Clientes não podem alterar o status ou valor do chamado.' });
      }
    }

    if (String(chamadoAtual.status).toUpperCase() === 'CONCLUÍDO') {
      return res.status(400).json({ error: 'Este chamado já está concluído e não pode ser editado.' });
    }

    try { await db.query('ALTER TABLE chamados ADD COLUMN IF NOT EXISTS valor NUMERIC(10,2) DEFAULT 0.00;'); } catch (e) {}

    let campos = [];
    let params = [];
    let idx = 1;

    if (tipoUsuario === 'CLIENTE') {
      if (titulo !== undefined) { campos.push(`titulo = $${idx++}`); params.push(titulo); }
      if (descricao !== undefined) { campos.push(`descricao = $${idx++}`); params.push(descricao); }
      if (campos.length === 0) {
        return res.status(400).json({ error: 'Nenhum campo válido fornecido para atualização.' });
      }
    } else {
      if (status !== undefined) { campos.push(`status = $${idx++}`); params.push(status); }
      if (valor !== undefined) { campos.push(`valor = $${idx++}`); params.push(valor); }
      if (titulo !== undefined) { campos.push(`titulo = $${idx++}`); params.push(titulo); }
      if (descricao !== undefined) { campos.push(`descricao = $${idx++}`); params.push(descricao); }
    }

    params.push(id);
    const query = `UPDATE chamados SET ${campos.join(', ')} WHERE id = $${idx} RETURNING *`;

    const result = await db.query(query, params);
    const chamadoAtualizado = result.rows[0];

    if (status && String(status).toUpperCase() === 'CONCLUÍDO') {
      const userId = chamadoAtualizado.usuario_id || chamadoAtualizado.cliente_id || chamadoAtualizado.usuarioid;
      const userRes = await db.query('SELECT nome, telefone FROM usuarios WHERE id = $1', [userId]);
      const cliente = userRes.rows[0];

      if (cliente && cliente.telefone) {
        const msgConclusao = `🖥️ *LL TECH INFO - ATENDIMENTO CONCLUÍDO*
----------------------------------------
Olá, *${cliente.nome}*!
O seu chamado *#${String(chamadoAtualizado.id).substring(0, 8)}* foi concluído com sucesso.
🟢 *Status:* CONCLUÍDO`;
        enviarNotificacaoWhatsApp(cliente.telefone, msgConclusao);
      }
    }

    return res.json({ mensagem: 'Chamado atualizado com sucesso!', chamado: chamadoAtualizado });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// ==========================================
// REGISTO DE ROTAS DE ATUALIZAÇÃO (Blindagem Total de Métodos e Caminhos)
// ==========================================
app.patch('/api/chamados/:id', autenticarToken, processarAtualizacaoChamado);
app.put('/api/chamados/:id', autenticarToken, processarAtualizacaoChamado);
app.post('/api/chamados/:id', autenticarToken, processarAtualizacaoChamado);

app.patch('/chamados/:id', autenticarToken, processarAtualizacaoChamado);
app.put('/chamados/:id', autenticarToken, processarAtualizacaoChamado);
app.post('/chamados/:id', autenticarToken, processarAtualizacaoChamado);

// ==========================================
// SALVAGUARDA DE ERROS JSON (Evita retorno HTML inesperado)
// ==========================================
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: `Endpoint de API não encontrado: ${req.method} ${req.originalUrl}` });
});

// ==========================================
// INICIALIZAÇÃO DA API PRINCIPAL
// ==========================================
app.listen(PORT, () => {
  console.log(`Servidor LL TECH INFO rodando na porta ${PORT}`);
});
